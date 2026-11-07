import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi } from '../src/index.mjs'
import { runJobs, reclaimJobDirs } from '../src/eval/runner.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp, FD_TEST } from './tools/tmpdir.mjs'


let P = (x, y) => ({ kind: 'point', x, y })
const TOY = path.join(FD_TEST, 'tools', 'toy.mjs')
let ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : null)

//runner 工作夾之提交與回收(2026-09-29;提交界線:讀回結果 ≠ 已持久化 ⇒ 由呼叫端 commit() 才刪)
describe('eval/runner:工作夾之提交與回收(2026-09-29)', function () {
    let t
    before(() => { t = makeTmp('runnerCleanup') })
    after(() => { t.cleanup() })

    it('預設(keepDir 未給)⇒ 夾保留(舊行為);commit() 不刪', async function () {
        this.timeout(60000)
        let r = await runJobs([{ id: 'a', spec: P(1, 1) }], { mode: 'spawn', evaluatorModule: TOY, workers: 1, tmpDir: t.dir, tag: 'k0' })
        assert(r.results.get('a').ok)
        assert.deepEqual(r.commit(), { removed: false, why: 'keepDir' })
        assert(fs.existsSync(path.join(t.dir, 'jobs', 'k0', 'out_w0.jsonl')))
        let ip = await runJobs([{ id: 'a', spec: P(1, 1) }], { mode: 'inProcess', evaluate: async () => ({ ok: 1 }) })
        assert.equal(ip.commit().removed, false, 'inProcess 無工作夾')
    })
    it('keepDir false:讀回後未提交 ⇒ 夾與進行中標記仍在;commit() ⇒ 日誌歸檔後刪夾;重複 commit 回同結果;鎖已釋放', async function () {
        this.timeout(60000)
        let logDir = path.join(t.dir, 'logs')
        let r = await runJobs([{ id: 'a', spec: P(1, 1) }, { id: 'b', spec: P(2, 2) }], { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'c1', keepDir: false, logDir, reclaimDays: 0 })
        let fd = path.join(t.dir, 'jobs', 'c1')
        assert(r.results.get('a').ok && r.results.get('b').ok)
        assert(fs.existsSync(fd), '提交前保留(呼叫端尚未持久化)')
        assert.equal(ls(fd).filter((f) => f.startsWith('.active_')).length, 1)
        let c = r.commit()
        assert.equal(c.removed, true, JSON.stringify(c)); assert(!fs.existsSync(fd))
        assert.equal(r.commit(), c, '重複呼叫回同一結果')
        let log = fs.readFileSync(path.join(logDir, 'c1.log'), 'utf8')
        assert.match(log, /== c1 /); assert.match(log, /--- w0\.log ---/); assert.match(log, /worker ready/)
        assert(!ls(path.join(t.dir, 'jobs')).some((f) => f.startsWith('.lock_')), '鎖已釋放')
    })
    it('keepDir false 而有失敗之 job ⇒ commit 不刪夾、撤標記', async function () {
        this.timeout(60000)
        let r = await runJobs([{ id: 'ok', spec: P(1, 2) }, { id: 'bad', spec: P(9, 9) }], { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'c2', keepDir: false, reclaimDays: 0, protocol: { failIf: 'P\\(9,9\\)' } })
        assert.equal(r.results.get('bad').ok, false)
        let c = r.commit()
        assert.equal(c.removed, false); assert.match(c.why, /有失敗/)
        let fd = path.join(t.dir, 'jobs', 'c2')
        //動態佇列(2026-09-25):先就緒之 worker 可吃完全部 job ⇒ 不指定 w0(2026-10-02 偶發失敗:負載下 w1 認領兩項, out_w0.jsonl 不存在);驗夾仍在且有 runner 產物
        assert(fs.existsSync(fd) && ls(fd).some((f) => /^out_w\d+\.jsonl$/.test(f)), JSON.stringify(ls(fd)))
        assert.equal(ls(fd).filter((f) => f.startsWith('.active_')).length, 0, '撤本次之標記')
    })
    it('同 tag 併行(同程序兩次呼叫):先提交者不刪(他方未提交), 最後提交者清;兩方結果皆完整', async function () {
        this.timeout(60000)
        let o = { mode: 'spawn', evaluatorModule: TOY, workers: 1, tmpDir: t.dir, tag: 'c3', keepDir: false, reclaimDays: 0 }
        let pa = runJobs([{ id: 'x', spec: P(3, 1), protocol: { delayMs: 200 } }], o)
        await new Promise((r) => setTimeout(r, 30))
        let pb = runJobs([{ id: 'y', spec: P(3, 2), protocol: { delayMs: 1500 } }], o)
        let [a, b] = await Promise.all([pa, pb])
        assert(a.results.get('x').ok, JSON.stringify(a.results.get('x'))); assert(b.results.get('y').ok, JSON.stringify(b.results.get('y')))
        let ca = a.commit()
        assert.equal(ca.removed, false); assert.match(ca.why, /進行中/)
        let cb = b.commit()
        assert.equal(cb.removed, true, JSON.stringify(cb)); assert(!fs.existsSync(path.join(t.dir, 'jobs', 'c3')))
    })
    it('逾期回收:只回收含 runner 產物、逾 N 日未動、無存活標記之夾(先歸檔日誌);_logs、非 runner 夾、近期夾、他人存活標記之夾不動', () => {
        let fdJobs = path.join(t.dir, 'rc', 'jobs')
        let mk = (name, files, ageDays) => {
            let d = path.join(fdJobs, name)
            fs.mkdirSync(d, { recursive: true })
            let ts = new Date(Date.now() - ageDays * 86400e3)
            for (let [f, s] of files) { fs.writeFileSync(path.join(d, f), s); fs.utimesSync(path.join(d, f), ts, ts) }
            return d
        }
        let old = mk('old', [['out_w0.jsonl', '{}\n'], ['w0.log', 'worker ready\n']], 9)
        let young = mk('young', [['out_w0.jsonl', '{}\n']], 1)
        let other = mk('other', [['notes.txt', 'x']], 30)
        let logs = mk('_logs', [['x.log', 'x']], 30)
        let held = mk('held', [['queue_a.json', '[]'], [`.active_${process.pid}_zz`, 't']], 30)
        let deadM = mk('deadMarker', [['queue_b.json', '[]'], ['.active_999999_zz', 't']], 30)
        let logDir = path.join(t.dir, 'rc', 'logs')
        let r = reclaimJobDirs(fdJobs, { days: 7, logDir })
        assert.deepEqual(r.removed.sort(), ['deadMarker', 'old'])
        assert(!fs.existsSync(old) && !fs.existsSync(deadM))
        for (let d of [young, other, logs, held]) { assert(fs.existsSync(d), d) }
        assert.deepEqual(r.kept.map((k) => k.name), ['held'])
        assert.match(fs.readFileSync(path.join(logDir, 'old.log'), 'utf8'), /回收/)
        assert.deepEqual(reclaimJobDirs(path.join(t.dir, 'rc', 'nope'), { days: 7 }), { removed: [], kept: [] }, 'jobs 夾不存在 ⇒ 空')
    })
    it('explore 於入樹後自動提交(cfg.runner.keepDir false ⇒ 夾刪、日誌歸檔);cfg.runner 未設 ⇒ 保留(舊行為)', async function () {
        this.timeout(120000)
        let mk = (name, runner) => createRsi({ root: path.join(t.dir, name), domain: makeDomain({ evaluator: { mode: 'spawn', module: TOY } }), budget: { arms: 6, novelty: 2, workers: 2, maxGlobalWorkers: 4 }, ...(runner ? { runner } : {}) }).init()
        let a = mk('exKeep', null)
        let ea = await a.explore({})
        assert.equal(ea.summary.nExecuted, 2)
        assert(fs.existsSync(path.join(a.paths.tmp, 'jobs', `r001_${process.pid}`)), '未設 ⇒ 保留')
        assert.equal(ea.jobsCommit.removed, false)
        let logDir = path.join(t.dir, 'exLogs')
        let b = mk('exClean', { keepDir: false, logDir, reclaimDays: 0 })
        assert.equal(b.runnerOpt().keepDir, false)
        let eb = await b.explore({})
        assert.equal(eb.summary.nExecuted, 2)
        assert.equal(eb.jobsCommit.removed, true, JSON.stringify(eb.jobsCommit))
        assert(!fs.existsSync(path.join(b.paths.tmp, 'jobs', `r001_${process.pid}`)))
        assert(fs.existsSync(path.join(logDir, `r001_${process.pid}.log`)))
    })
})
