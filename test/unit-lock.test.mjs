import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { withLock } from '../src/core/lock.mjs'
import { makeTmp, FD_TEST } from './tools/tmpdir.mjs'
import { spawnWatch } from './tools/childEvents.mjs'


let run = (args) => new Promise((resolve) => { let p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let out = '', err = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d }); p.on('exit', (code) => resolve({ code, out, err })) })
let ownerFp = (fd) => path.join(fd, 'owner')
let isoNow = () => new Date().toISOString()
//他方之取得檔名(owner.dead-<pid>.<時戳 36 進位>.<亂碼>;同 core/lock.mjs 之 RE_TAKEN)
let takenName = (pid, kind = 'dead') => `owner.${kind}-${pid}.${Date.now().toString(36)}.zz${Math.random().toString(36).slice(2, 6)}`

//規格出處:規則帳本 REC-01(2026-11-14 第 456 項:持有者檔為持有之憑證;回收與釋放皆先改名取得持有者檔再核對)
describe('core/lock:跨程序寫入鎖', function () {
    let t
    before(() => { t = makeTmp('lock') })
    after(() => { t.cleanup() })

    it('5 程序 × 40 次鎖內「讀 → +1 → 寫」= 200(無遺失)', async function () {
        this.timeout(120000)
        let fp = path.join(t.dir, 'counter.txt')
        fs.writeFileSync(fp, '0')
        let rs = await Promise.all([1, 2, 3, 4, 5].map(() => run([path.join(FD_TEST, 'tools', 'lockChild.mjs'), t.dir, fp, '40'])))
        assert.deepEqual(rs.map((r) => r.code), [0, 0, 0, 0, 0], rs.map((r) => r.err).join('\n'))
        assert.equal(Number(fs.readFileSync(fp, 'utf8')), 200)
        assert(!fs.existsSync(path.join(t.dir, '.lock_cnt')), '鎖應已釋放')
    })
    it('他程序持鎖時逾時拋錯(不靜默略過)', () => {
        let fd = path.join(t.dir, '.lock_x')
        fs.mkdirSync(fd)
        assert.throws(() => withLock(() => 1, { dir: t.dir, name: 'x', timeoutMs: 300, staleMs: 1e9 }), /逾時/)
        fs.rmSync(fd, { recursive: true, force: true })
    })
    it('死鎖(超過 staleMs)自動清除後可取得', () => {
        let fd = path.join(t.dir, '.lock_y')
        fs.mkdirSync(fd)
        let old = (Date.now() - 10000) / 1000
        fs.utimesSync(fd, old, old)
        assert.equal(withLock(() => 42, { dir: t.dir, name: 'y', timeoutMs: 2000, staleMs: 1000 }), 42)
        assert(!fs.existsSync(fd))
    })
    it('建鎖夾回 EPERM / EACCES / EBUSY(Windows:同名夾刪除待決)⇒ 視同被占用而等候重試;持續則逾時拋錯並附錯誤碼;非暫時性錯誤即時拋出(2026-11-14;第 429 項同族)', () => {
        //注入:攔截 fs.mkdirSync 對指定鎖夾之呼叫(真實之刪除待決無法決定性重現;次數由注入決定, 不依時間)
        let orig = fs.mkdirSync
        let inject = (name, plan) => { let n = 0; fs.mkdirSync = function (p, ...rest) { if (String(p).endsWith(`.lock_${name}`) && n < plan.length) { let code = plan[n++]; throw Object.assign(new Error(`${code}: injected, mkdir`), { code }) } return orig.call(this, p, ...rest) }; return () => n }
        try {
            let nOf = inject('busy', ['EPERM', 'EACCES', 'EBUSY'])
            assert.equal(withLock(() => 7, { dir: t.dir, name: 'busy' }), 7, '暫時性失敗後取得鎖並執行臨界區')
            assert.equal(nOf(), 3)
            assert(!fs.existsSync(path.join(t.dir, '.lock_busy')), '鎖應已釋放')
            let ran = false
            inject('busy2', Array(100000).fill('EPERM'))
            assert.throws(() => withLock(() => { ran = true }, { dir: t.dir, name: 'busy2', timeoutMs: 200 }), (e) => /逾時/.test(e.message) && /EPERM/.test(e.message))
            assert.equal(ran, false, '未取得鎖 ⇒ 臨界區未執行')
            inject('busy3', ['ENOTDIR'])
            assert.throws(() => withLock(() => { ran = true }, { dir: t.dir, name: 'busy3' }), (e) => e.code === 'ENOTDIR')
            assert.equal(ran, false)
        }
        finally { fs.mkdirSync = orig }
    })
    it('臨界區拋錯仍釋放鎖', () => {
        assert.throws(() => withLock(() => { throw new Error('boom') }, { dir: t.dir, name: 'z' }), /boom/)
        assert(!fs.existsSync(path.join(t.dir, '.lock_z')))
        assert.equal(withLock(() => 'ok', { dir: t.dir, name: 'z' }), 'ok')
    })
    it('持有者已死 ⇒ 立即回收(不必等 staleMs);持有者存活且未逾 staleMs ⇒ 等(2026-09-26)', () => {
        let fd = path.join(t.dir, '.lock_d')
        fs.mkdirSync(fd); fs.writeFileSync(path.join(fd, 'owner'), `999999 ${new Date().toISOString()} tokX`)
        let t0 = Date.now()
        assert.equal(withLock(() => 7, { dir: t.dir, name: 'd', timeoutMs: 5000, staleMs: 1e9 }), 7)
        assert(Date.now() - t0 < 2000, '死持有者立即回收')
        fs.mkdirSync(fd); fs.writeFileSync(path.join(fd, 'owner'), `${process.pid} ${new Date().toISOString()} tokY`)
        assert.throws(() => withLock(() => 1, { dir: t.dir, name: 'd', timeoutMs: 300, staleMs: 1e9 }), /逾時.*存活/)
        fs.rmSync(fd, { recursive: true, force: true })
    })
    it('死鎖之回收持續失敗(取得持有者檔之改名持續 EPERM)⇒ 仍依 timeoutMs 逾時拋錯、臨界區未執行(2026-11-14;外審 terra #13:原無視逾時而持續重試;第 456 項後回收不刪夾, 失敗點改為取得持有者檔)', () => {
        let fd = path.join(t.dir, '.lock_s2')
        fs.mkdirSync(fd); fs.writeFileSync(ownerFp(fd), `999999 ${isoNow()} tokS`)
        let orig = fs.renameSync, n = 0, ran = false
        fs.renameSync = function (a, b) { if (path.resolve(String(a)) === path.resolve(ownerFp(fd))) { n++; throw Object.assign(new Error('EPERM: injected, rename'), { code: 'EPERM' }) } return orig.call(this, a, b) }
        try { assert.throws(() => withLock(() => { ran = true }, { dir: t.dir, name: 's2', timeoutMs: 300, staleMs: 1e9 }), /逾時/) }
        finally { fs.renameSync = orig }
        assert.ok(n >= 1 && ran === false, `取得嘗試 ${n} 次`)
        assert.equal(fs.readFileSync(ownerFp(fd), 'utf8').endsWith('tokS'), true, '死持有者之檔未被動到')
        fs.rmSync(fd, { recursive: true, force: true })
    })
    it('死鎖回收之競態(第 456 項):持有者已死之鎖 + 兩個同時等候者;A 判定死鎖之後、動作之前, B 已回收並進入臨界區 ⇒ A 不得刪除或接手 B 之鎖, 兩臨界區不重疊(兩真程序;事件同步, 不以延時)', async function () {
        this.timeout(120000)
        let d = path.join(t.dir, 'race456'), flags = path.join(d, 'flags')
        fs.mkdirSync(flags, { recursive: true })
        let fd = path.join(d, '.lock_race')
        fs.mkdirSync(fd); fs.writeFileSync(ownerFp(fd), `999999 ${isoNow()} tokDead`)
        let holder = path.join(d, 'holder'), child = path.join(FD_TEST, 'tools', 'lockRaceChild.mjs')
        let A = spawnWatch([child, d, 'race', 'A', flags, holder]), B = null
        try {
            //① A 已讀到死持有者之檔(判定之讀取)並停住
            await A.waitFor((c) => c.out.includes('A:judged'), 'A:judged')
            //② B 起:回收死鎖並進入臨界區(停在臨界區內)
            B = spawnWatch([child, d, 'race', 'B', flags, holder])
            await B.waitFor((c) => c.out.includes('B:in'), 'B:in')
            //③ 放行 A:以其判定時所讀之死持有者動作;修前 ⇒ 刪 B 之鎖夾而進臨界區(A:in + overlap);修後 ⇒ 取得之持有者檔已非判定時之原文 ⇒ 移回、回到等候迴圈再判定(A:judged2)
            fs.writeFileSync(path.join(flags, 'goA'), '')
            await A.waitFor((c) => /A:in|A:judged2/.test(c.out), 'A:in 或 A:judged2')
            //④ 放行 B 離開臨界區;兩者結束
            fs.writeFileSync(path.join(flags, 'goB'), '')
            await Promise.all([A.closed, B.closed])
        }
        finally { A.kill(); if (B) { B.kill() } }
        assert.deepEqual([A.code, B.code], [0, 0], `A:${A.out}${A.err} B:${B.out}${B.err}`)
        assert.ok(!/overlap/.test(A.out + B.out), `兩臨界區重疊:A=${A.out} B=${B.out}`)
        assert.ok(A.out.indexOf('A:judged2') >= 0 && A.out.indexOf('A:judged2') < A.out.indexOf('A:in'), `A 先回到等候(再判定)後才進臨界區:${A.out}`)
        assert.ok(A.out.includes('A:done') && B.out.includes('B:done'))
        assert.equal(fs.existsSync(fd), false, '鎖已釋放')
        assert.equal(fs.existsSync(holder), false)
    })
    //—— 外審 Argon(2026-11-14)之交錯:以 tools/lockStepChild.mjs 之步進鉤子停在指定之 fs 呼叫, 父程序以標記檔放行(事件同步);
    //    判準:A 不得於他方動作之窗內(回收者核對中 / 釋放者取得持有者檔與刪夾之間)以 wx 寫入而進臨界區;任何時序兩臨界區不重疊
    let STEP = path.join(FD_TEST, 'tools', 'lockStepChild.mjs')
    let stepEnv = (tag) => {
        let d = path.join(t.dir, tag), flags = path.join(d, 'flags')
        fs.mkdirSync(flags, { recursive: true })
        let fd = path.join(d, '.lock_x')
        let flag = (f) => fs.writeFileSync(path.join(flags, f), '')
        let spawnRole = (role, o) => {
            let fp = path.join(d, `spec-${role}.json`)
            fs.writeFileSync(fp, JSON.stringify({ dir: d, name: 'x', flags, holder: path.join(d, 'holder'), role, timeoutMs: 20000, staleMs: 60000, rounds: [{}], hooks: [], ...o }))
            return spawnWatch([STEP, fp])
        }
        return { d, fd, flag, spawnRole, ownerP: path.join('.lock_x', 'owner'), fdP: '.lock_x' }
    }
    let has = (s) => (c) => c.out.includes(s)
    let either = (...ps) => { for (let p of ps) { p.catch(() => {}) } return Promise.race(ps) }
    let noOverlap = (...cs) => assert.ok(!cs.some((c) => /overlap/.test(c.out)), `兩臨界區重疊:\n${cs.map((c) => c.out).join('\n---\n')}`)
    it('外審 Argon #1(機制 A):取得者已死之取得檔 + 三等候者;A 判定後、C 核對中暫時取走 B 之持有者檔之窗內 A 以 wx 寫入 ⇒ A 須撤回、不與 B 重疊', async function () {
        this.timeout(120000)
        let E = stepEnv('ar1a')
        fs.mkdirSync(E.fd); fs.writeFileSync(path.join(E.fd, 'owner'), `999998 ${isoNow()} tokDead`)
        let cs = []
        try {
            let C = E.spawnRole('C', { hooks: [
                { fn: 'readFileSync', path: E.ownerP, nth: 1, when: 'after', emit: 'C:judged', wait: 'goC1' },
                { fn: 'renameSync', path: E.ownerP, to: 'owner.dead-', nth: 1, when: 'after', emit: 'C:took', wait: 'goC2' }] })
            cs.push(C)
            await C.waitFor(has('C:judged'), 'C:judged')
            //模擬:另一回收者取得死持有者檔後異常結束 ⇒ 夾內只有取得者已死之取得檔
            fs.renameSync(path.join(E.fd, 'owner'), path.join(E.fd, takenName(999999)))
            let A = E.spawnRole('A', { rounds: [{ hold: 'goAexit' }], hooks: [
                { fn: 'readdirSync', path: E.fdP, nth: 1, when: 'after', emit: 'A:judged', wait: 'goA1' },
                { fn: 'readdirSync', path: E.fdP, nth: 2, when: 'after', emit: 'A:readyWx', wait: 'goA2' },
                { fn: 'mkdirSync', path: E.fdP, nth: 2, when: 'after', emit: 'A:loop2' }] })
            cs.push(A)
            await A.waitFor(has('A:judged'), 'A:judged')
            let B = E.spawnRole('B', { rounds: [{ hold: 'goBexit' }] })
            cs.push(B)
            await B.waitFor(has('B:in1'), 'B:in1')
            E.flag('goA1'); await A.waitFor(has('A:readyWx'), 'A:readyWx')
            E.flag('goC1'); await C.waitFor(has('C:took'), 'C:took')
            E.flag('goA2'); await A.waitFor((c) => /A:in1|A:loop2/.test(c.out), 'A:in1 或 A:loop2')
            assert.ok(!A.out.includes('A:in1'), `A 於 C 暫時取走 B 之持有者檔之窗內進入臨界區:${A.out}`)
            E.flag('goC2'); E.flag('goBexit'); E.flag('goAexit')
            await Promise.all(cs.map((c) => c.closed))
            noOverlap(A, B, C)
            assert.deepEqual(cs.map((c) => c.code), [0, 0, 0], cs.map((c) => c.out + c.err).join('\n'))
            assert.ok(cs.every((c) => /:in1/.test(c.out)) && !cs.some((c) => /:err/.test(c.out)), cs.map((c) => c.out).join('\n'))
        }
        finally { cs.forEach((c) => c.kill()) }
    })
    for (let [tag, title, setup, aHook] of [
        ['ar1b', '外審 Argon #1(機制 B):取得者已死之取得檔 + 兩等候者', (E) => { fs.mkdirSync(E.fd); fs.writeFileSync(path.join(E.fd, takenName(999999)), `999998 ${isoNow()} tokDead`) },
            (E) => [{ fn: 'readdirSync', path: E.fdP, nth: 1, when: 'after', emit: 'A:judged', wait: 'goA1' }, { fn: 'readdirSync', path: E.fdP, nth: 2, when: 'after', emit: 'A:readyWx', wait: 'goA2' }]],
        ['ar1c', '外審 Argon #1(機制 C):無主之空鎖夾(mtime 逾 staleMs)+ 兩等候者', (E) => { fs.mkdirSync(E.fd); let old = (Date.now() - 600000) / 1000; fs.utimesSync(E.fd, old, old) },
            (E) => [{ fn: 'statSync', path: E.fdP, nth: 1, when: 'after', emit: 'A:judged', wait: 'goA1' }]],
    ]) {
        it(`${title};B 釋放之「取得持有者檔」與「刪夾」之間 A 以 wx 寫入 ⇒ A 須撤回、不與 B 之再取得重疊`, async function () {
            this.timeout(120000)
            let E = stepEnv(tag)
            setup(E)
            let cs = []
            try {
                let A = E.spawnRole('A', { rounds: [{ hold: 'goAexit' }], hooks: [...aHook(E), { fn: 'mkdirSync', path: E.fdP, nth: 2, when: 'after', emit: 'A:loop2' }] })
                cs.push(A)
                await A.waitFor(has('A:judged'), 'A:judged')
                let B = E.spawnRole('B', { rounds: [{ hold: 'goBexit' }, { hold: 'goB2exit' }], hooks: [{ fn: 'renameSync', path: E.ownerP, to: 'owner.rel-', nth: 1, when: 'after', emit: 'B:tookRel', wait: 'goB1' }] })
                cs.push(B)
                await B.waitFor(has('B:in1'), 'B:in1')
                if (tag === 'ar1b') { E.flag('goA1'); await A.waitFor(has('A:readyWx'), 'A:readyWx') }
                E.flag('goBexit'); await B.waitFor(has('B:tookRel'), 'B:tookRel')
                E.flag(tag === 'ar1b' ? 'goA2' : 'goA1')
                await A.waitFor((c) => /A:in1|A:loop2/.test(c.out), 'A:in1 或 A:loop2')
                assert.ok(!A.out.includes('A:in1'), `A 於 B 釋放之窗內進入臨界區:${A.out}`)
                E.flag('goB1')
                await either(B.waitFor(has('B:in2'), 'B:in2'), A.waitFor(has('A:in1'), 'A:in1'))
                E.flag('goB2exit'); E.flag('goAexit')
                await Promise.all(cs.map((c) => c.closed))
                noOverlap(A, B)
                assert.deepEqual(cs.map((c) => c.code), [0, 0], cs.map((c) => c.out + c.err).join('\n'))
                assert.ok(A.out.includes('A:in1') && B.out.includes('B:in2') && !/:err/.test(A.out + B.out), A.out + B.out)
                assert.equal(fs.existsSync(E.fd), false, '最後之持有者釋放後鎖夾不在')
            }
            finally { cs.forEach((c) => c.kill()) }
        })
    }
    it('外審 Argon #4:釋放之取得(ENOENT:回收者核對中)與列舉之間回收者已移回 ⇒ 仍須釋放(不遺留至 staleMs;持有者程序於釋放後仍存活)', async function () {
        this.timeout(120000)
        let E = stepEnv('ar4')
        fs.mkdirSync(E.fd); fs.writeFileSync(path.join(E.fd, 'owner'), `999998 ${isoNow()} tokDead`)
        let cs = []
        try {
            let A = E.spawnRole('A', { timeoutMs: 8000, hooks: [
                { fn: 'readFileSync', path: E.ownerP, nth: 1, when: 'after', emit: 'A:judged', wait: 'goA1' },
                { fn: 'renameSync', path: E.ownerP, to: 'owner.dead-', nth: 1, when: 'after', emit: 'A:took', wait: 'goA2' },
                { fn: 'renameSync', from: 'owner.dead-', toEnds: E.ownerP, nth: 1, when: 'after', emit: 'A:putBack' }] })
            cs.push(A)
            await A.waitFor(has('A:judged'), 'A:judged')
            let B = E.spawnRole('B', { stay: 'goBstay', rounds: [{ hold: 'goBexit' }], hooks: [{ fn: 'renameSync', path: E.ownerP, to: 'owner.rel-', nth: 1, when: 'after', emit: 'B:take', wait: 'goB2' }] })
            cs.push(B)
            await B.waitFor(has('B:in1'), 'B:in1')
            E.flag('goA1'); await A.waitFor(has('A:took'), 'A:took')
            E.flag('goBexit'); await B.waitFor(has('B:take:ENOENT'), 'B:take:ENOENT')
            E.flag('goA2'); await A.waitFor(has('A:putBack'), 'A:putBack')
            E.flag('goB2'); await B.waitFor(has('B:released'), 'B:released')
            //B 已釋放而仍存活:A 須能取得(修前:B 之持有者檔留著、B 存活 ⇒ A 逾時)
            await A.waitFor((c) => /A:in1|A:err1/.test(c.out), 'A:in1 或 A:err1')
            E.flag('goBstay')
            await Promise.all(cs.map((c) => c.closed))
            assert.ok(A.out.includes('A:in1') && !A.out.includes('A:err1'), A.out)
            assert.deepEqual(cs.map((c) => c.code), [0, 0], cs.map((c) => c.out + c.err).join('\n'))
        }
        finally { cs.forEach((c) => c.kill()) }
    })
    //外審 hydrogen 第二輪 #1:A 於「確認持有」中途(第 2 次讀持有者檔後)停住, 其間釋放者刪夾並再取得(1-A)/ 核對者移回覆蓋 A 之列(1-B)⇒ A 不得進臨界區
    it('外審 hydrogen #1-A:無主空夾;A 以 wx 寫入後於確認持有之中途停住,B 刪夾並再取得 ⇒ A 不得與 B 之再取得重疊', async function () {
        this.timeout(120000)
        let E = stepEnv('hy1a')
        fs.mkdirSync(E.fd); let old = (Date.now() - 600000) / 1000; fs.utimesSync(E.fd, old, old)
        let cs = []
        try {
            let A = E.spawnRole('A', { rounds: [{ hold: 'goAexit' }], hooks: [
                { fn: 'statSync', path: E.fdP, nth: 1, when: 'after', emit: 'A:judged', wait: 'goA1' },
                { fn: 'readFileSync', path: E.ownerP, nth: 2, when: 'after', emit: 'A:readCur', wait: 'goA2' },
                { fn: 'mkdirSync', path: E.fdP, nth: 2, when: 'after', emit: 'A:loop2' }] })
            cs.push(A)
            await A.waitFor(has('A:judged'), 'A:judged')
            let B = E.spawnRole('B', { rounds: [{ hold: 'goBexit' }, { hold: 'goB2exit' }], hooks: [{ fn: 'renameSync', path: E.ownerP, to: 'owner.rel-', nth: 1, when: 'after', emit: 'B:tookRel', wait: 'goB1' }] })
            cs.push(B)
            await B.waitFor(has('B:in1'), 'B:in1')
            E.flag('goBexit'); await B.waitFor(has('B:tookRel'), 'B:tookRel')
            E.flag('goA1'); await A.waitFor(has('A:readCur'), 'A:readCur')
            E.flag('goB1'); await B.waitFor(has('B:in2'), 'B:in2')
            E.flag('goA2'); await A.waitFor((c) => /A:in1|A:loop2/.test(c.out), 'A:in1 或 A:loop2')
            assert.ok(!A.out.includes('A:in1'), `A 與 B 之再取得重疊:${A.out}`)
            E.flag('goB2exit'); E.flag('goAexit')
            await Promise.all(cs.map((c) => c.closed))
            noOverlap(A, B)
            assert.deepEqual(cs.map((c) => c.code), [0, 0], cs.map((c) => c.out + c.err).join('\n'))
            assert.ok(A.out.includes('A:in1') && !/:err/.test(A.out + B.out), A.out + B.out)
        }
        finally { cs.forEach((c) => c.kill()) }
    })
    it('外審 hydrogen #1-B:取得者已死之取得檔 + 三等候者;A 於確認持有之中途停住,C 移回 B 之列(覆蓋 A 之列)⇒ A 不得與 B 重疊', async function () {
        this.timeout(120000)
        let E = stepEnv('hy1b')
        fs.mkdirSync(E.fd); fs.writeFileSync(path.join(E.fd, 'owner'), `999998 ${isoNow()} tokDead`)
        let cs = []
        try {
            let C = E.spawnRole('C', { hooks: [
                { fn: 'readFileSync', path: E.ownerP, nth: 1, when: 'after', emit: 'C:judged', wait: 'goC1' },
                { fn: 'renameSync', path: E.ownerP, to: 'owner.dead-', nth: 1, when: 'after', emit: 'C:took', wait: 'goC2' },
                { fn: 'renameSync', from: 'owner.dead-', toEnds: E.ownerP, nth: 1, when: 'after', emit: 'C:putBack' }] })
            cs.push(C)
            await C.waitFor(has('C:judged'), 'C:judged')
            fs.renameSync(path.join(E.fd, 'owner'), path.join(E.fd, takenName(999999)))
            let A = E.spawnRole('A', { rounds: [{ hold: 'goAexit' }], hooks: [
                { fn: 'readdirSync', path: E.fdP, nth: 1, when: 'after', emit: 'A:judged', wait: 'goA1' },
                { fn: 'readdirSync', path: E.fdP, nth: 2, when: 'after', emit: 'A:readyWx', wait: 'goA2' },
                { fn: 'readFileSync', path: E.ownerP, nth: 2, when: 'after', emit: 'A:readCur', wait: 'goA3' },
                { fn: 'mkdirSync', path: E.fdP, nth: 2, when: 'after', emit: 'A:loop2' }] })
            cs.push(A)
            await A.waitFor(has('A:judged'), 'A:judged')
            let B = E.spawnRole('B', { rounds: [{ hold: 'goBexit' }] })
            cs.push(B)
            await B.waitFor(has('B:in1'), 'B:in1')
            E.flag('goA1'); await A.waitFor(has('A:readyWx'), 'A:readyWx')
            E.flag('goC1'); await C.waitFor(has('C:took'), 'C:took')
            E.flag('goA2'); await A.waitFor(has('A:readCur'), 'A:readCur')
            E.flag('goC2'); await C.waitFor(has('C:putBack'), 'C:putBack')
            E.flag('goA3'); await A.waitFor((c) => /A:in1|A:loop2/.test(c.out), 'A:in1 或 A:loop2')
            assert.ok(!A.out.includes('A:in1'), `A 與 B 重疊:${A.out}`)
            E.flag('goBexit'); E.flag('goAexit')
            await Promise.all(cs.map((c) => c.closed))
            noOverlap(A, B, C)
            assert.deepEqual(cs.map((c) => c.code), [0, 0, 0], cs.map((c) => c.out + c.err).join('\n'))
        }
        finally { cs.forEach((c) => c.kill()) }
    })
    it('空夾(無持有者檔、無取得檔)逾 2 秒寬限即可占下(不必等 staleMs;持有者檔只以 wx 建立, 寬限後才寫之建夾者只會 EEXIST);寬限內 ⇒ 等', () => {
        let fd = path.join(t.dir, '.lock_gr')
        fs.mkdirSync(fd)
        assert.throws(() => withLock(() => 1, { dir: t.dir, name: 'gr', timeoutMs: 200, staleMs: 1e9 }), /逾時/, '寬限內不占')
        let old = (Date.now() - 5000) / 1000
        fs.utimesSync(fd, old, old)
        let t0 = Date.now()
        assert.equal(withLock(() => 'g', { dir: t.dir, name: 'gr', timeoutMs: 5000, staleMs: 1e9 }), 'g')
        assert.ok(Date.now() - t0 < 2000 && !fs.existsSync(fd))
    })
    it('外審 hydrogen #2-D:釋放時取得之持有者檔暫時讀不到 ⇒ 移回後重試、釋放完成(不遺留)', () => {
        let fd = path.join(t.dir, '.lock_rd')
        let orig = fs.readFileSync, n = 0
        try {
            withLock(() => {
                fs.readFileSync = function (p, ...rest) { if (String(p).includes(`${path.basename(fd)}${path.sep}owner.rel-`) && n < 5) { n++; throw Object.assign(new Error('EBUSY: injected, read'), { code: 'EBUSY' }) } return orig.call(this, p, ...rest) }
            }, { dir: t.dir, name: 'rd' })
        }
        finally { fs.readFileSync = orig }
        assert.ok(n === 5, `讀取失敗 ${n} 次`)
        assert.equal(fs.existsSync(fd), false, '重試後已釋放')
    })
    it('外審 Argon #2A:取得者已死之取得檔讀不到(暫時性)⇒ 不判死、改回原名,不得接手(其內可能為存活持有者之列)', () => {
        let fd = path.join(t.dir, '.lock_ur')
        let nm = takenName(999999)
        fs.mkdirSync(fd); fs.writeFileSync(path.join(fd, nm), `${process.pid} ${isoNow()} tokLive`)
        let orig = fs.readFileSync, n = 0, ran = false
        fs.readFileSync = function (p, ...rest) { let s = String(p); if (s.includes(`${path.basename(fd)}${path.sep}owner.dead-`) && !s.endsWith(nm)) { n++; throw Object.assign(new Error('EBUSY: injected, read'), { code: 'EBUSY' }) } return orig.call(this, p, ...rest) }
        try { assert.throws(() => withLock(() => { ran = true }, { dir: t.dir, name: 'ur', timeoutMs: 300, staleMs: 1e9 }), /逾時/) }
        finally { fs.readFileSync = orig }
        assert.ok(n >= 1 && ran === false, `讀取失敗 ${n} 次`)
        assert.equal(fs.readFileSync(path.join(fd, nm), 'utf8').endsWith('tokLive'), true, '取得檔改回原名、內容不變')
        fs.rmSync(fd, { recursive: true, force: true })
    })
    it('釋放時持有者檔不在而鎖夾為他方新建(建夾後、寫持有者檔前)⇒ 不刪(2026-11-14 第 456 項之檢討:原「持有者不可讀即刪」會刪掉他方之新鎖)', () => {
        let fd = path.join(t.dir, '.lock_rn')
        withLock(() => {
            //模擬:本方之鎖已被回收而他方剛建新夾、尚未寫持有者檔
            fs.rmSync(fd, { recursive: true, force: true })
            fs.mkdirSync(fd)
        }, { dir: t.dir, name: 'rn' })
        assert.equal(fs.existsSync(fd), true, '他方之新夾保留')
        fs.rmSync(fd, { recursive: true, force: true })
    })
    it('釋放時持有者檔被回收者暫時取得(核對中)⇒ 等其移回後再釋放(不提前刪、亦不遺留)', () => {
        let fd = path.join(t.dir, '.lock_rw')
        let origR = fs.renameSync, origD = fs.readdirSync, taken = null, nTake = 0, nList = 0, listedMine = false
        try {
            withLock(() => {
                //釋放之第一次取得前, 他方(存活之回收者:本程序 pid)已取得本方之持有者檔;第二次取得前, 他方核對後移回
                fs.renameSync = function (a, b) {
                    if (path.resolve(String(a)) === path.resolve(ownerFp(fd)) && String(b).includes('owner.rel-')) {
                        let k = nTake++
                        if (k === 0) { taken = path.join(fd, takenName(process.pid)); origR.call(fs, ownerFp(fd), taken) }
                        if (k === 1) { origR.call(fs, taken, ownerFp(fd)) }
                    }
                    return origR.call(this, a, b)
                }
                //觀察:釋放於兩次取得之間列舉鎖夾(見本方之列在他方之取得檔內而等候)
                fs.readdirSync = function (p, ...rest) {
                    let r = origD.call(this, p, ...rest)
                    if (path.resolve(String(p)) === path.resolve(fd)) { nList++; listedMine = listedMine || r.includes(path.basename(taken || '?')) }
                    return r
                }
            }, { dir: t.dir, name: 'rw' })
        }
        finally { fs.renameSync = origR; fs.readdirSync = origD }
        assert.ok(nTake === 2 && nList >= 1 && listedMine, `取得 ${nTake} 次、列舉 ${nList} 次`)
        assert.equal(fs.existsSync(fd), false, '移回後已釋放')
    })
    it('建夾後以 wx 寫持有者檔遇 EEXIST(回收者已占下此無主之夾)⇒ 不進臨界區(2026-11-14 第 456 項)', () => {
        let fd = path.join(t.dir, '.lock_wx')
        let orig = fs.mkdirSync, ran = false
        //注入:本方建夾成功之後、寫持有者檔之前, 他方(存活)已以 wx 占下
        fs.mkdirSync = function (p, ...rest) { let r = orig.call(this, p, ...rest); if (path.resolve(String(p)) === path.resolve(fd)) { fs.writeFileSync(ownerFp(fd), `${process.pid} ${isoNow()} claimer`) } return r }
        try { assert.throws(() => withLock(() => { ran = true }, { dir: t.dir, name: 'wx', timeoutMs: 300, staleMs: 1e9 }), /逾時/) }
        finally { fs.mkdirSync = orig }
        assert.equal(ran, false, '臨界區未執行')
        assert.ok(fs.readFileSync(ownerFp(fd), 'utf8').endsWith('claimer'), '他方之持有者檔未被覆寫')
        fs.rmSync(fd, { recursive: true, force: true })
    })
    it('無有效持有者檔而有他方之取得檔:取得者存活 ⇒ 等;取得者已死且其內為死持有者 ⇒ 接手;取得者已死而其內為存活持有者 ⇒ 移回、不接手', () => {
        let fd = path.join(t.dir, '.lock_tk')
        //(a)取得者存活(回收 / 釋放進行中)⇒ 非死鎖
        fs.mkdirSync(fd); fs.writeFileSync(path.join(fd, takenName(process.pid)), `999999 ${isoNow()} tokDead`)
        let ran = false
        assert.throws(() => withLock(() => { ran = true }, { dir: t.dir, name: 'tk', timeoutMs: 300, staleMs: 1e9 }), /逾時/)
        assert.equal(ran, false)
        fs.rmSync(fd, { recursive: true, force: true })
        //(b)取得者已死、其內為死持有者 ⇒ 接手;釋放後鎖夾不在
        fs.mkdirSync(fd); fs.writeFileSync(path.join(fd, takenName(999999)), `999998 ${isoNow()} tokDead`)
        assert.equal(withLock(() => 'b', { dir: t.dir, name: 'tk', timeoutMs: 5000, staleMs: 1e9 }), 'b')
        assert.equal(fs.existsSync(fd), false)
        //(c)取得者已死、其內為存活持有者(取得者於核對中死亡)⇒ 移回原處、不接手
        fs.mkdirSync(fd); fs.writeFileSync(path.join(fd, takenName(999999)), `${process.pid} ${isoNow()} tokLive`)
        assert.throws(() => withLock(() => { ran = true }, { dir: t.dir, name: 'tk', timeoutMs: 300, staleMs: 1e9 }), /逾時/)
        assert.equal(ran, false)
        assert.ok(fs.readFileSync(ownerFp(fd), 'utf8').endsWith('tokLive'), '存活持有者之檔已移回')
        fs.rmSync(fd, { recursive: true, force: true })
    })
    it('接手時以 wx 寫本方持有者檔暫時失敗(EPERM)⇒ 已取得之檔移回原名(仍判死)、下一輪再接手;不留無主之夾而等 staleMs', () => {
        let orig = fs.writeFileSync
        let inject = (fd) => { let n = 0; fs.writeFileSync = function (p, d, o) { if (path.resolve(String(p)) === path.resolve(ownerFp(fd)) && o && o.flag === 'wx' && n++ === 0) { throw Object.assign(new Error('EPERM: injected, open'), { code: 'EPERM' }) } return orig.call(this, p, d, o) }; return () => n }
        try {
            //(a)持有者已死
            let fd = path.join(t.dir, '.lock_wf')
            fs.mkdirSync(fd); fs.writeFileSync(ownerFp(fd), `999999 ${isoNow()} tokDead`)
            let nOf = inject(fd)
            let t0 = Date.now()
            assert.equal(withLock(() => 'a', { dir: t.dir, name: 'wf', timeoutMs: 3000, staleMs: 1e9 }), 'a')
            assert.ok(nOf() >= 2 && !fs.existsSync(fd), `wx ${nOf()} 次`)
            assert.ok(Date.now() - t0 < 1500, `下一輪即接手(不經空夾之 2 秒寬限):${Date.now() - t0} ms`)
            //(b)取得者已死之取得檔
            fs.mkdirSync(fd); fs.writeFileSync(path.join(fd, takenName(999999)), `999998 ${isoNow()} tokDead`)
            nOf = inject(fd)
            assert.equal(withLock(() => 'b', { dir: t.dir, name: 'wf', timeoutMs: 3000, staleMs: 1e9 }), 'b')
            assert.ok(nOf() >= 2 && !fs.existsSync(fd), `wx ${nOf()} 次`)
        }
        finally { fs.writeFileSync = orig }
    })
    it('釋放時取得持有者檔持續失敗(Windows 之暫時性占用)⇒ 有界重試後以「核對為本方後刪除」收尾(不遺留)', () => {
        let fd = path.join(t.dir, '.lock_rf')
        let orig = fs.renameSync, n = 0
        try {
            withLock(() => {
                fs.renameSync = function (a, b) { if (path.resolve(String(a)) === path.resolve(ownerFp(fd))) { n++; throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' }) } return orig.call(this, a, b) }
            }, { dir: t.dir, name: 'rf' })
        }
        finally { fs.renameSync = orig }
        assert.ok(n >= 1, `取得嘗試 ${n} 次`)
        assert.equal(fs.existsSync(fd), false)
    })
    it('釋放只刪自己的鎖:臨界區內鎖被他方回收並取得 ⇒ 本方結束時不刪其鎖(2026-09-26)', () => {
        let fd = path.join(t.dir, '.lock_o')
        withLock(() => { fs.writeFileSync(path.join(fd, 'owner'), `${process.pid} ${new Date().toISOString()} someoneElse`) }, { dir: t.dir, name: 'o' })
        assert(fs.existsSync(fd), '他方之鎖保留')
        fs.rmSync(fd, { recursive: true, force: true })
    })
})
