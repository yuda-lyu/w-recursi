import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import * as S from '../src/core/slots.mjs' //命名空間匯入:改前之碼無 slotAuxOf 時本檔仍可載入(其餘案以斷言失敗)
import { readOwner } from '../src/core/proc.mjs'
import { makeTmp, FD_TEST, FD_PACK } from './tools/tmpdir.mjs'


//原子建槽(2026-10-09;已觀察之上限違反:某次驗收 peak 5 > 4;審查)
//  成因(機制屬實、觸發為推測):舊碼 mkdir(s{i}) 後才寫 owner;他方見「無 owner 且 mtime 逾 2 秒」即判死刪之再取 ⇒ 建槽者寫 owner 被延遲 > 2 秒時兩方同持一槽
//  SA01 同程序決定性重現:於「第一次寫 owner」注入延遲(槽夾之 mtime 撥早 3 秒)並於其間由他方試取 ⇒ 同時持有數 ≤ max(改前 2 > 1)
//  SA02 真程序之決定性重現:A 寫 owner 前凍結 4.5 秒, 其間起 B ⇒ 兩者之持有區間不重疊(改前:B 判 A 之槽死而重取, A 醒後把 owner 蓋入 B 之槽 ⇒ 峰值 2)
//  SA03 多程序併搶:6 程序 × 4 輪 × 各要 2 槽、max 4、寫 owner 前隨機 0 ~ 30 ms ⇒ 任一時刻總持有 ≤ 4、皆 exit 0、無殘留
//  SA04 回收之核對:判死後、移走前他方已回收並重取(新持有者存活)⇒ 不得刪新持有者之槽(改前:判死後 rmSync 刪之)
//  SA05 死槽 / 舊形(無 owner)之回收:pid 已死 ⇒ 回收並取得;舊形於 2 秒寬限內不回收、逾寬限回收;皆不留輔助夾
//  SA06 輔助夾之殘留:名內 pid 已死者於 reclaimDeadSlots / 取槽時刪(不依時間);存活者之輔助夾不論多舊皆不動;不計入占用與上限;slotAuxOf 列之
//  SA07 rename 之暫時失敗(Windows 之 EPERM:暫存內之檔被他程序短暫開啟)而目標不存在 ⇒ 重試後取得;持續失敗 ⇒ 本輪不取(不拋錯)、不留暫存
//  SA08 釋放:先移走再刪 ⇒ 無 s{i} 與輔助夾殘留;CLI --status 另印輔助夾一行
let run = (args, env = {}) => new Promise((resolve) => { let p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }); let out = '', err = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d }); p.on('exit', (code) => resolve({ code, out, err })) })
let sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let waitFor = async (pred, ms) => { let t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) { throw new Error('等待逾時') } await sleep(20) } }
let readLog = (fp) => fs.readFileSync(fp, 'utf8').trim().split('\n').filter(Boolean).map((l) => { let [pid, t0, t1, n] = l.split(' ').map(Number); return { pid, t0, t1, n } })
//掃描線:同一時刻持有總數之峰值(同時刻先釋放後取得)
let peakOf = (rows) => { let ev = []; for (let r of rows) { ev.push([r.t0, +r.n]); ev.push([r.t1, -r.n]) } ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); let cur = 0, peak = 0; for (let [, d] of ev) { cur += d; peak = Math.max(peak, cur) } return peak }
let auxNames = (dir) => fs.readdirSync(dir).filter((f) => /^s\d+\.(tmp|rel|dead)-/.test(f))
const CHILD = path.join(FD_TEST, 'tools', 'slotDelayChild.mjs')

describe('core/slots:原子建槽', function () {
    let t
    before(() => { t = makeTmp('slotsAtomic') })
    after(() => { t.cleanup() })

    it('SA01 同程序注入「寫 owner 前之延遲」:延遲中他方試取 ⇒ 同時持有數 ≤ max(改前:他方判死重取 ⇒ 兩方同持 s0)', () => {
        let dir = path.join(t.dir, 'sa01')
        fs.mkdirSync(dir, { recursive: true })
        let orig = fs.writeFileSync
        let other = null, fired = false
        fs.writeFileSync = function (fp, ...rest) {
            if (!fired && path.basename(String(fp)) === 'owner' && path.resolve(String(fp)).startsWith(path.resolve(dir) + path.sep)) {
                fired = true
                //模擬:本程序於建槽與寫 owner 之間被凍結 3 秒(E 核排程飢餓)⇒ 夾之 mtime 已逾 2 秒寬限;其間他 session 試取(同程序以 token 區分持有者)
                let old = new Date(Date.now() - 3000)
                for (let f of fs.readdirSync(dir)) { if (f.startsWith('s')) { fs.utimesSync(path.join(dir, f), old, old) } }
                other = S.tryAcquireSlots(dir, { want: 1, max: 1 })
            }
            return orig.call(fs, fp, ...rest)
        }
        let mine = null
        try { mine = S.tryAcquireSlots(dir, { want: 1, max: 1 }) }
        finally { fs.writeFileSync = orig }
        assert(fired, '注入點未觸發')
        let total = mine.length + other.length
        let tokens = [...mine, ...other].map((h) => h.token)
        let ownerTok = (readOwner(path.join(dir, 's0')) || {}).token
        S.releaseSlots(mine); S.releaseSlots(other)
        assert(total <= 1, `同時持有 ${total} > max 1(本方 ${mine.length}、他方 ${other.length};s0 之 owner token ${ownerTok}, 持有者 ${tokens.join(' / ')})`)
        assert.equal(other.length, 1, '本方延遲期間槽未出現 ⇒ 他方取得')
        assert.equal(S.slotsInUse(dir, { max: 1 }), 0)
        assert.deepEqual(auxNames(dir), [], '無輔助夾殘留')
    })

    it('SA02 真程序:A 寫 owner 前凍結 4.5 秒, 其間起 B ⇒ 持有區間不重疊(改前:B 判 A 之槽死重取 ⇒ 峰值 2 > 1)', async function () {
        this.timeout(90000)
        let dir = path.join(t.dir, 'sa02'), log = path.join(t.dir, 'sa02.log'), mark = path.join(t.dir, 'sa02.mark')
        let pA = run([CHILD, dir, '1', '1', '3000', log, '4500', mark])
        await waitFor(() => fs.existsSync(mark), 30000)
        let pB = run([CHILD, dir, '1', '1', '3000', log])
        let [rA, rB] = await Promise.all([pA, pB])
        assert.deepEqual([rA.code, rB.code], [0, 0], `${rA.err}\n${rB.err}`)
        let rows = readLog(log)
        assert.equal(rows.length, 2)
        assert(rows.every((r) => r.n === 1))
        assert(peakOf(rows) <= 1, `峰值 ${peakOf(rows)} > max 1:${JSON.stringify(rows)}`)
        assert.equal(S.slotsInUse(dir, { max: 1 }), 0)
        assert.deepEqual(fs.readdirSync(dir).filter((f) => /^s\d/.test(f)), [], '無殘留之槽 / 輔助夾')
    })

    it('SA03 多程序併搶:6 程序 × 4 輪 × 各要 2 槽、max 4 ⇒ 任一時刻總持有 ≤ 4、皆 exit 0、無殘留', async function () {
        this.timeout(180000)
        let dir = path.join(t.dir, 'sa03'), log = path.join(t.dir, 'sa03.log')
        let rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => run([CHILD, dir, '4', '2', '150', log, '0', '', '4', '30'])))
        assert.deepEqual(rs.map((r) => r.code), [0, 0, 0, 0, 0, 0], rs.map((r) => r.err).join('\n'))
        let rows = readLog(log)
        assert.equal(rows.length, 24)
        for (let r of rows) { assert(r.n >= 1 && r.n <= 2, `held ${r.n}`) }
        assert(peakOf(rows) <= 4, `峰值 ${peakOf(rows)} > 4`)
        assert.equal(S.slotsInUse(dir, { max: 4 }), 0)
        assert.deepEqual(fs.readdirSync(dir).filter((f) => /^s\d/.test(f)), [], '無殘留之槽 / 輔助夾')
    })

    it('SA04 回收之核對:判死後、移走前他方已回收並重取(新持有者存活)⇒ 不得取得、新持有者之槽原封(改前:判死後 rmSync 刪之)', () => {
        let dir = path.join(t.dir, 'sa04')
        fs.mkdirSync(path.join(dir, 's0'), { recursive: true })
        fs.writeFileSync(path.join(dir, 's0', 'owner'), `999999 ${new Date(Date.now() - 60000).toISOString()} deadTok`)
        let live = `${process.pid} ${new Date().toISOString()} liveTok`
        let s0 = path.resolve(path.join(dir, 's0'))
        let swapped = false
        //注入點:對 s0 之第一次 rename(新碼之移走)或 rm(舊碼之判死後刪除)之前, 由「他方」換成存活之持有者
        let swap = (p) => { if (!swapped && path.resolve(String(p)) === s0) { swapped = true; fs.writeFileSync(path.join(s0, 'owner'), live) } }
        let oRen = fs.renameSync, oRm = fs.rmSync
        fs.renameSync = function (a, ...r) { swap(a); return oRen.call(fs, a, ...r) }
        fs.rmSync = function (a, ...r) { swap(a); return oRm.call(fs, a, ...r) }
        let got = null
        try { got = S.tryAcquireSlots(dir, { want: 1, max: 1 }) }
        finally { fs.renameSync = oRen; fs.rmSync = oRm }
        assert(swapped, '注入點未觸發')
        let o = readOwner(s0)
        S.releaseSlots(got)
        assert.equal(got.length, 0, '新持有者存活 ⇒ 不得取得')
        assert(o && o.token === 'liveTok', `新持有者之槽須原封(現 owner ${JSON.stringify(o)})`)
        assert.deepEqual(auxNames(dir), [], '無輔助夾殘留(移回)')
    })

    it('SA05 死槽 / 舊形之回收:pid 已死 ⇒ 回收並取得;舊形(無 owner)寬限內不回收、逾寬限回收;皆不留輔助夾', () => {
        let dir = path.join(t.dir, 'sa05')
        fs.mkdirSync(path.join(dir, 's0'), { recursive: true })
        fs.writeFileSync(path.join(dir, 's0', 'owner'), `999999 ${new Date(Date.now() - 60000).toISOString()} t`)
        let h = S.tryAcquireSlots(dir, { want: 1, max: 1 })
        assert.equal(h.length, 1); assert.equal(h[0].i, 0)
        assert.equal(readOwner(path.join(dir, 's0')).token, h[0].token)
        S.releaseSlots(h)
        fs.mkdirSync(path.join(dir, 's0'), { recursive: true }) //舊形:無 owner
        assert.equal(S.tryAcquireSlots(dir, { want: 1, max: 1 }).length, 0, '寬限內不回收')
        assert.equal(S.reclaimDeadSlots(dir, { max: 1 }), 0)
        let old = new Date(Date.now() - 3000)
        fs.utimesSync(path.join(dir, 's0'), old, old)
        assert.equal(S.reclaimDeadSlots(dir, { max: 1 }), 1, '逾寬限 ⇒ 回收')
        assert(!fs.existsSync(path.join(dir, 's0')))
        assert.deepEqual(auxNames(dir), [])
    })

    it('SA06 輔助夾之殘留:名內 pid 已死者刪(不依時間);存活者不論多舊皆不動;不計入占用與上限;slotAuxOf 列之', () => {
        let dir = path.join(t.dir, 'sa06')
        let mk = (name, ageMs = 0) => { let fd = path.join(dir, name); fs.mkdirSync(fd, { recursive: true }); fs.writeFileSync(path.join(fd, 'owner'), `1 ${new Date().toISOString()} x`); if (ageMs) { let d = new Date(Date.now() - ageMs); fs.utimesSync(fd, d, d) } }
        let alive = `s1.tmp-${process.pid}.a.b`
        mk('s0.tmp-999999.a.b'); mk(alive, 86400e3); mk('s2.rel-999999.a.b'); mk('s3.dead-999999.a.b'); mk('s4.bak')
        assert.equal(S.slotsInUse(dir, { max: 8 }), 0, '輔助夾不計入占用')
        assert.equal(S.maxOfDir(dir), 8, '輔助夾不影響上限之推算')
        assert.deepEqual(S.slotAuxOf(dir).map((x) => `${x.name}:${x.kind}:${x.alive}`).sort(), [`${alive}:tmp:true`, 's0.tmp-999999.a.b:tmp:false', 's2.rel-999999.a.b:rel:false', 's3.dead-999999.a.b:dead:false'].sort())
        assert.equal(S.reclaimDeadSlots(dir, { max: 8 }), 0, '回收數只計死槽')
        assert.deepEqual(fs.readdirSync(dir).sort(), [alive, 's4.bak'].sort(), '死者之輔助夾已刪;存活者(1 日前)與他名不動')
        mk('s5.tmp-999999.c.d')
        let h = S.tryAcquireSlots(dir, { want: 1, max: 8 })
        assert.equal(h.length, 1)
        assert(!fs.existsSync(path.join(dir, 's5.tmp-999999.c.d')), '取槽時亦掃除')
        S.releaseSlots(h)
        fs.rmSync(path.join(dir, alive), { recursive: true, force: true })
    })

    it('SA07 rename 之暫時失敗而目標不存在 ⇒ 重試後取得;持續失敗 ⇒ 本輪不取(不拋錯)、不留暫存', () => {
        let dir = path.join(t.dir, 'sa07')
        fs.mkdirSync(dir, { recursive: true })
        let oRen = fs.renameSync
        let nFail = 0, budget = 2
        fs.renameSync = function (a, b, ...r) { if (/\.tmp-/.test(path.basename(String(a))) && budget > 0) { budget--; nFail++; let e = new Error('EPERM: operation not permitted(模擬)'); e.code = 'EPERM'; throw e } return oRen.call(fs, a, b, ...r) }
        let h = null
        try { h = S.tryAcquireSlots(dir, { want: 1, max: 1 }) } finally { fs.renameSync = oRen }
        assert.equal(nFail, 2); assert.equal(h.length, 1, '暫時失敗 2 次後取得')
        S.releaseSlots(h)
        budget = 1e9
        fs.renameSync = function (a, b, ...r) { if (/\.tmp-/.test(path.basename(String(a)))) { let e = new Error('EPERM(模擬)'); e.code = 'EPERM'; throw e } return oRen.call(fs, a, b, ...r) }
        let h2 = null
        try { h2 = S.tryAcquireSlots(dir, { want: 1, max: 1 }) } finally { fs.renameSync = oRen }
        assert.equal(h2.length, 0, '持續失敗 ⇒ 不取(不拋錯)')
        assert.deepEqual(fs.readdirSync(dir).filter((f) => /^s\d/.test(f)), [], '不留暫存 / 槽')
    })

    it('SA08 釋放先移走再刪 ⇒ 無殘留;CLI --status 另印輔助夾一行', async function () {
        this.timeout(30000)
        let dir = path.join(t.dir, 'sa08')
        let hs = S.acquireSlots(dir, { want: 3, max: 4 })
        assert.equal(hs.length, 3)
        S.releaseSlots(hs)
        assert.deepEqual(fs.readdirSync(dir).sort(), ['.max'], '只剩上限記錄')
        let aux = path.join(dir, `s0.tmp-${process.pid}.x.y`)
        fs.mkdirSync(aux, { recursive: true })
        let r = await run([path.join(FD_PACK, 'src', 'core', 'slots.mjs'), '--status', dir])
        assert.equal(r.code, 0, r.err)
        assert.match(r.out, /占用 0 \/ 4/)
        assert.match(r.out, /輔助夾 1/, r.out)
        fs.rmSync(aux, { recursive: true, force: true })
        let r2 = spawnSync(process.execPath, [path.join(FD_PACK, 'src', 'core', 'slots.mjs'), '--status', dir], { encoding: 'utf8' })
        assert(!/輔助夾/.test(r2.stdout), '無輔助夾 ⇒ 不印')
    })
})
