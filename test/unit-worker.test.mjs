import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { runJobs, jobKey } from '../src/eval/runner.mjs'
import { slotsInUse } from '../src/core/slots.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp, FD_TEST } from './tools/tmpdir.mjs'


let P = (x, y) => ({ kind: 'point', x, y })
const TOY = path.join(FD_TEST, 'tools', 'toy.mjs')

describe('eval/runner + eval/worker:子程序評估', function () {
    let t
    before(() => { t = makeTmp('worker') })
    after(() => { t.cleanup() })

    it('spawn 模式:結果與同程序一致;失敗 job 被捕捉;槽位用畢釋放', async function () {
        this.timeout(60000)
        let jobs = [P(1, 1), P(2, 2), P(9, 9), P(-3, 4)].map((s) => ({ id: toy.summarize(s), spec: s }))
        let slots = { dir: path.join(t.dir, 'slots'), max: 2 }
        let r = await runJobs(jobs, { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'w1', slots, protocol: { failIf: 'P\\(9,9\\)' } })
        assert.equal(r.nWorkers, 2)
        assert.deepEqual(r.exits, [0, 0])
        for (let j of jobs) {
            let res = r.results.get(j.id)
            if (j.id === 'P(9,9)') { assert.equal(res.ok, false); assert.match(res.error, /模擬評估失敗/); continue }
            assert.equal(res.ok, true)
            let local = await toy.evaluate(j.spec, null)
            assert.deepEqual(res.raw, local)
            assert(res.meta && res.meta.pid !== process.pid, 'meta 來自子程序')
        }
        assert.equal(slotsInUse(slots.dir, { max: 2 }), 0)
    })
    it('續跑:out 檔已有之列在 job 鍵(id + 規格 + 協定)相同時沿用, 不同時不沿用', async function () {
        this.timeout(60000)
        let fd = path.join(t.dir, 'jobs', 'w2')
        fs.mkdirSync(fd, { recursive: true })
        let j1 = { id: 'j1', spec: P(1, 1) }
        //鍵相同 ⇒ 沿用;另一列鍵不同(舊協定)⇒ 忽略
        fs.writeFileSync(path.join(fd, 'out_w0.jsonl'), JSON.stringify({ id: 'j1', key: jobKey(j1), ok: true, raw: { train: 12345 } }) + '\n' + JSON.stringify({ id: 'j2', key: 'stale', ok: true, raw: { train: -1 } }) + '\n')
        let r = await runJobs([j1, { id: 'j2', spec: P(2, 2) }], { mode: 'spawn', evaluatorModule: TOY, workers: 1, tmpDir: t.dir, tag: 'w2' })
        assert.equal(r.results.get('j1').raw.train, 12345)
        assert.equal(r.results.get('j2').ok, true); assert.notEqual(r.results.get('j2').raw.train, -1)
    })
    it('同 tag 重複呼叫:舊列不污染新結果(同 id 換協定 / 換桶;不在本次之 id 不出現)', async function () {
        this.timeout(60000)
        let a = await runJobs([{ id: 'a', spec: P(1, 1) }, { id: 'b', spec: P(2, 2) }], { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'w4' })
        assert.equal(a.results.get('b').raw.cost.wallSec, 0)
        //第二次:b 換協定(delay 300 ⇒ wallSec .3)且與 c 同批, 桶序可能與第一次不同
        //順序 [b, c] 使 b 落到 w0(第一次在 w1):舊 out_w1 之 b 列(wallSec 0)在讀回時排在新列之後, 修正前會蓋掉新結果
        let b = await runJobs([{ id: 'b', spec: P(2, 2), protocol: { delayMs: 300 } }, { id: 'c', spec: P(3, 3), protocol: { delayMs: 300 } }], { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'w4' })
        assert.equal(b.results.size, 2); assert(!b.results.has('a'))
        assert.equal(b.results.get('b').raw.cost.wallSec, 0.3, '同 id 之新結果不被舊列蓋掉')
        assert.equal(b.results.get('c').raw.cost.wallSec, 0.3)
    })
    it('槽位逐 worker 釋放:快的 worker 結束即歸還其槽位, 不等最慢者(多 session 併跑時他人可立即取用)', async function () {
        this.timeout(60000)
        let slots = { dir: path.join(t.dir, 'slots_rel'), max: 2 }
        let run = runJobs([{ id: 'fast', spec: P(1, 1) }, { id: 'slow', spec: P(2, 2), protocol: { delayMs: 4000 } }], { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'w5', slots })
        //快者約 0.3 ~ 1 秒內結束(含啟動);慢者須 4 秒以上
        let mid = null
        for (let k = 0; k < 30; k++) { await new Promise((r) => setTimeout(r, 100)); let n = slotsInUse(slots.dir, { max: 2 }); if (n === 1) { mid = n; break } }
        let r = await run
        assert.equal(mid, 1, '快者結束後槽位應降為 1(慢者仍在跑)')
        assert(r.results.get('fast').ok && r.results.get('slow').ok)
        assert.equal(slotsInUse(slots.dir, { max: 2 }), 0, '全部結束後槽位歸零')
    })
    it('評估器模組缺 evaluate:全部 job 回 error(worker 無結果), 不拋例外', async function () {
        this.timeout(60000)
        let r = await runJobs([{ id: 'a', spec: P(1, 1) }], { mode: 'spawn', evaluatorModule: path.join(FD_TEST, 'tools', 'nullPolicy.mjs'), workers: 1, tmpDir: t.dir, tag: 'w3' })
        assert.equal(r.results.get('a').ok, false); assert.match(r.results.get('a').error, /worker 無結果/)
        assert.notEqual(r.exits[0], 0)
    })
    it('同程序模式:workers 上限 = job 數;createContext 一次', async () => {
        let n = 0
        let r = await runJobs([{ id: 'a', spec: P(1, 1) }, { id: 'b', spec: P(2, 2) }], { mode: 'inProcess', evaluate: toy.evaluate, createContext: async () => { n++; return {} }, workers: 8 })
        assert.equal(r.nWorkers, 2); assert.equal(n, 1)
        assert(r.results.get('a').ok && r.results.get('b').ok)
        let e = await runJobs([{ id: 'a', spec: P(1, 1) }], { mode: 'inProcess', evaluate: async () => { throw new Error('x') } })
        assert.equal(e.results.get('a').ok, false)
    })
    it('空 job 清單直接回空', async () => { let r = await runJobs([], { mode: 'spawn' }); assert.equal(r.results.size, 0); assert.equal(r.nWorkers, 0) })
})
