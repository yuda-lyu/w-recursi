import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { runJobs } from '../src/eval/runner.mjs'
import { makeTmp, FD_TEST } from './tools/tmpdir.mjs'


let P = (x, y) => ({ kind: 'point', x, y })
const TOY = path.join(FD_TEST, 'tools', 'toy.mjs')
let evals = (fp) => (fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(' ').slice(3).join(' ')) : [])

//續跑之失敗列(2026-10-02):runJobs 之同 tag 續跑原把 ok:false 之列亦當已完成 ⇒ 失敗之 job 於同指令重跑時不重試
//  opt.retryFailed(預設 false = 舊行為):true ⇒ runner 之 doneKeys 與 worker 之 done 只收 ok 列;讀回時同 job 鍵有 ok 列者以 ok 列為準(與檔序無關)
//  失敗之注入:toy 評估器之 ctx.failIf(ctx 不入 job 鍵 ⇒ 兩次呼叫之 job 鍵相同 = 同 tag 之續跑)
describe('eval/runner:續跑之失敗列(retryFailed;2026-10-02)', function () {
    let t
    before(() => { t = makeTmp('runnerRetry') })
    after(() => { t.cleanup() })
    let jobs = [{ id: 'a', spec: P(1, 1) }, { id: 'b', spec: P(2, 2) }]
    it('預設(retryFailed 未給)⇒ 失敗列視為已完成, 同 tag 重跑不重試(舊行為)', async function () {
        this.timeout(60000)
        let logFile = path.join(t.dir, 'r0.log')
        let o = { mode: 'spawn', evaluatorModule: TOY, workers: 1, tmpDir: t.dir, tag: 'r0' }
        let r1 = await runJobs(jobs, { ...o, ctxOpt: { failIf: '^P\\(1,1\\)$', logFile } })
        assert.equal(r1.results.get('a').ok, false)
        assert.equal(r1.results.get('b').ok, true)
        let r2 = await runJobs(jobs, { ...o, ctxOpt: { logFile } })
        assert.equal(r2.results.get('a').ok, false, '失敗列沿用')
        assert.equal(evals(logFile).length, 1, '第二次無任何評估(b 已完成、a 之失敗列算完成)')
    })
    it('retryFailed true ⇒ 只重算失敗之 job;讀回以 ok 列為準', async function () {
        this.timeout(60000)
        let logFile = path.join(t.dir, 'r1.log')
        let o = { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'r1', retryFailed: true }
        let r1 = await runJobs(jobs, { ...o, ctxOpt: { failIf: '^P\\(1,1\\)$', logFile } })
        assert.equal(r1.results.get('a').ok, false)
        let n1 = evals(logFile).length
        let r2 = await runJobs(jobs, { ...o, workers: 1, ctxOpt: { logFile } })
        assert.equal(r2.results.get('a').ok, true, '失敗之 a 重算後為 ok')
        assert.equal(r2.results.get('b').ok, true)
        assert.equal(evals(logFile).length, n1 + 1, '第二次只評估 a 一次(b 不重算)')
        //第三次:全部已 ok ⇒ 不再評估
        let r3 = await runJobs(jobs, { ...o, ctxOpt: { logFile } })
        assert.equal(r3.results.get('a').ok, true)
        assert.equal(evals(logFile).length, n1 + 1)
    })
})
