import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { acquireSlots, tryAcquireSlots, releaseSlots, slotsInUse, pidAlive, maxOfDir } from '../src/core/slots.mjs'
import { makeTmp, FD_TEST, FD_PACK } from './tools/tmpdir.mjs'


let run = (args) => new Promise((resolve) => { let p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d }); p.on('exit', (code) => resolve({ code, out, err })) })

describe('core/slots:全域 worker 槽位(跨 session 計數信號量)', function () {
    let t
    before(() => { t = makeTmp('slots') })
    after(() => { t.cleanup() })

    it('pidAlive:自己活著、不存在之 pid 為死', () => { assert(pidAlive(process.pid)); assert(!pidAlive(999999)) })
    it('同程序:max 4, 先取 3 再要 3 只得 1;釋放後歸零', () => {
        let dir = path.join(t.dir, 'a')
        let a = acquireSlots(dir, { want: 3, max: 4 })
        assert.equal(a.length, 3)
        let b = acquireSlots(dir, { want: 3, max: 4, timeoutMs: 2000 })
        assert.equal(b.length, 1)
        assert.equal(slotsInUse(dir, { max: 4 }), 4)
        releaseSlots(a); releaseSlots(b)
        assert.equal(slotsInUse(dir, { max: 4 }), 0)
    })
    it('全部占用時逾時拋錯', () => {
        let dir = path.join(t.dir, 'b')
        let a = acquireSlots(dir, { want: 2, max: 2 })
        assert.throws(() => acquireSlots(dir, { want: 1, max: 2, timeoutMs: 400 }), /逾時/)
        releaseSlots(a)
    })
    it('死行程遺留之槽可回收', () => {
        let dir = path.join(t.dir, 'c')
        fs.mkdirSync(path.join(dir, 's0'), { recursive: true })
        fs.writeFileSync(path.join(dir, 's0', 'owner'), `999999 ${new Date(Date.now() - 60000).toISOString()}`)
        assert.equal(slotsInUse(dir, { max: 1 }), 0)
        let h = acquireSlots(dir, { want: 1, max: 1, timeoutMs: 2000 })
        assert.equal(h[0].i, 0)
        releaseSlots(h)
    })
    it('owner 空檔 / 半寫(他程序建槽之瞬間)不視為死槽;逾 2 秒寬限才回收(2026-09-25 修同槽雙持有之競態)', () => {
        let dir = path.join(t.dir, 'e')
        fs.mkdirSync(path.join(dir, 's0'), { recursive: true })
        fs.writeFileSync(path.join(dir, 's0', 'owner'), '')
        assert.equal(slotsInUse(dir, { max: 1 }), 1, '空 owner 於寬限內算占用')
        assert.equal(tryAcquireSlots(dir, { want: 1, max: 1 }).length, 0, '不得回收他人剛建之槽')
        //寫到一半之每個截斷位置(含「2026」「2026-09-2」等可被 Date.parse 解析為較早日期者)皆不得回收;他程序之 pid 用 999999(死)亦同
        for (let pid of [process.pid, 999999]) {
            let full = `${pid} ${new Date().toISOString()}`
            for (let n = 0; n < full.length; n++) {
                fs.writeFileSync(path.join(dir, 's0', 'owner'), full.slice(0, n))
                assert.equal(tryAcquireSlots(dir, { want: 1, max: 1 }).length, 0, `半寫 '${full.slice(0, n)}' 被回收`)
            }
        }
        let old = new Date(Date.now() - 3000)
        fs.utimesSync(path.join(dir, 's0'), old, old)
        let h = tryAcquireSlots(dir, { want: 1, max: 1 })
        assert.equal(h.length, 1, '逾寬限 ⇒ 視為遺留而回收')
        releaseSlots(h)
    })
    it('租約:存活之持有者不論持有多久皆不回收;釋放只刪自己的槽(token);want / max 非整數即拋錯(2026-09-26)', () => {
        let dir = path.join(t.dir, 'lease')
        fs.mkdirSync(path.join(dir, 's0'), { recursive: true })
        fs.writeFileSync(path.join(dir, 's0', 'owner'), `${process.pid} ${new Date(Date.now() - 7 * 3600e3).toISOString()} tokOld`)
        assert.equal(tryAcquireSlots(dir, { want: 1, max: 1 }).length, 0, '存活者持有 7 小時仍不被奪')
        fs.rmSync(path.join(dir, 's0'), { recursive: true, force: true })
        let h = tryAcquireSlots(dir, { want: 1, max: 1 })
        assert.equal(h.length, 1)
        fs.writeFileSync(path.join(dir, 's0', 'owner'), `${process.pid} ${new Date().toISOString()} notMine`) //模擬:槽被他方回收並取得
        releaseSlots(h)
        assert(fs.existsSync(path.join(dir, 's0')), '他方之槽保留')
        fs.rmSync(path.join(dir, 's0'), { recursive: true, force: true })
        assert.throws(() => acquireSlots(dir, { want: NaN, max: 4, timeoutMs: 100 }), /want/)
        assert.throws(() => tryAcquireSlots(dir, { want: 1, max: NaN }), /max/)
    })
    it('上限記錄(2026-09-25;某次回報):取槽記 .max, CLI 未帶 --max 時據之顯示與回收(s8 / s9 可見);無記錄時取現存最大槽號 + 1 與 8 之大者', async function () {
        this.timeout(30000)
        let dir = path.join(t.dir, 'm')
        assert.equal(maxOfDir(dir), 8, '目錄不存在 ⇒ 預設 8')
        let h = tryAcquireSlots(dir, { want: 10, max: 10 })
        assert.equal(h.length, 10)
        assert.equal(fs.readFileSync(path.join(dir, '.max'), 'utf8'), '10')
        assert.equal(maxOfDir(dir), 10)
        let cli = path.join(FD_PACK, 'src', 'core', 'slots.mjs')
        let r = await run([cli, '--status', dir])
        assert.equal(r.code, 0, r.err)
        assert(/占用 10 \/ 10/.test(r.out) && /\bs9 pid/.test(r.out), r.out)
        releaseSlots(h)
        //無記錄:遺留之 s9(死行程)⇒ 上限推為 10, --reclaim 回收得到
        let dir2 = path.join(t.dir, 'm2')
        fs.mkdirSync(path.join(dir2, 's9'), { recursive: true })
        fs.writeFileSync(path.join(dir2, 's9', 'owner'), `999999 ${new Date(Date.now() - 60000).toISOString()}`)
        assert.equal(maxOfDir(dir2), 10)
        let r2 = await run([cli, '--reclaim', dir2])
        assert(/回收死槽 1 個/.test(r2.out), r2.out)
        assert(!fs.existsSync(path.join(dir2, 's9')))
        //明示 --max 優先
        let r3 = await run([cli, '--status', dir, '--max', '4'])
        assert(/\/ 4/.test(r3.out), r3.out)
    })
    it('跨程序:3 子程序各要 3 槽、max 4 → 任一時刻總持有 ≤ 4, 且每個都拿到 ≥ 1', async function () {
        this.timeout(60000)
        let dir = path.join(t.dir, 'd')
        let log = path.join(t.dir, 'd.log')
        let rs = await Promise.all([1, 2, 3].map(() => run([path.join(FD_TEST, 'tools', 'slotChild.mjs'), dir, '4', '3', '500', log])))
        assert.deepEqual(rs.map((r) => r.code), [0, 0, 0], rs.map((r) => r.err).join('\n'))
        let rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => { let [pid, t0, t1, n] = l.split(' ').map(Number); return { pid, t0, t1, n } })
        assert.equal(rows.length, 3)
        for (let r of rows) { assert(r.n >= 1 && r.n <= 3, `held ${r.n}`) }
        //掃描線:同一時刻持有總數 ≤ 4(同時刻先釋放後取得)
        let ev = []
        for (let r of rows) { ev.push([r.t0, +r.n]); ev.push([r.t1, -r.n]) }
        ev.sort((a, b) => a[0] - b[0] || a[1] - b[1])
        let cur = 0, peak = 0
        for (let [, d] of ev) { cur += d; peak = Math.max(peak, cur) }
        assert(peak <= 4, `peak ${peak}`)
        assert.equal(slotsInUse(dir, { max: 4 }), 0)
    })
})
