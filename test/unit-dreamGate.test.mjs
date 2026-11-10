import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi, evaluatePolicy, aliasMapOfNodes } from '../src/index.mjs'
import { readJsonl } from '../src/core/jsonl.mjs'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { DREAM_MUTEX } from '../src/loop/auto.mjs'
import { tryAcquireSlots, releaseSlots, slotsStatus } from '../src/core/slots.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp, FD_TEST, FD_PACK } from './tools/tmpdir.mjs'


//做夢之維護判定、同批略過與別名表備忘(2026-09-29)
describe('sim/dream + loop/auto:維護中不寫分數、minIntervalMs 略過、別名表一次做夢只算一次', function () {
    let t
    before(() => { t = makeTmp('dreamGate') })
    after(() => { t.cleanup() })
    let fresh = (name, cfg = {}, dom = {}) => createRsi({ root: path.join(t.dir, name), domain: toy.makeDomain(dom), budget: { arms: 6, novelty: 2, workers: 3 }, ...cfg }).init()

    it('維護判定:cfg.maintenance 回理由 ⇒ 做夢只印不寫 scores.jsonl(scoresSkipped)、--accept 不升版;回 null ⇒ 照寫並可升版;判定拋錯 ⇒ 視同維護中', async function () {
        this.timeout(120000)
        let mt = '測試維護'
        let rsi = fresh('mt', { maintenance: () => mt })
        await rsi.explore({}); await rsi.explore({})
        let d = await rsi.dream({})
        assert.match(d.scoresSkipped, /維護中:測試維護/)
        assert.deepEqual(readJsonl(rsi.paths.scores), [], '維護中不寫分數')
        //當前換成空策略、候選為 v0 ⇒ 平時會升版;維護中不升
        fs.copyFileSync(path.join(FD_TEST, 'tools', 'nullPolicy.mjs'), path.join(rsi.paths.policies, 'null.mjs'))
        fs.writeFileSync(rsi.paths.current, "export { default, meta } from './null.mjs'\n")
        fs.copyFileSync(path.join(FD_PACK, 'src', 'search', 'policyV0.mjs'), path.join(rsi.paths.candidates, 'cand.mjs'))
        let d2 = await rsi.dream({ accept: true })
        assert.equal(d2.decision.ok, false); assert.match(d2.decision.why, /維護中不升版/)
        assert(!fs.existsSync(path.join(rsi.paths.policies, 'v1.mjs')))
        mt = null
        let d3 = await rsi.dream({ accept: true })
        assert.equal(d3.scoresSkipped, null)
        assert.equal(readJsonl(rsi.paths.scores).length, 2, '退維護後照寫(當前 + 候選)')
        assert.equal(d3.decision.ok, true, JSON.stringify(d3.decision)); assert(fs.existsSync(path.join(rsi.paths.policies, 'v1.mjs')))
        let rsi2 = fresh('mtThrow', { maintenance: () => { throw new Error('壞') } })
        await rsi2.explore({})
        assert.match((await rsi2.dream({})).scoresSkipped, /維護判定拋錯/)
        assert.deepEqual(readJsonl(rsi2.paths.scores), [])
    })

    it('同批略過:minIntervalMs 內略過做夢(dreamSkip「同批已做」;報告「略過:同批已做」;summary 不載做夢 ⇒ 不矛盾);--accept 不略過;0 = 每輪;auto 回傳各段牆鐘', async function () {
        this.timeout(180000)
        let rsi = fresh('iv', { dream: { minIntervalMs: 1e9 } })
        let a1 = await rsi.auto({})
        assert(a1.dream && !a1.dreamSkip)
        let a2 = await rsi.auto({})
        assert.equal(a2.dream, null); assert.equal(a2.dreamSkip.why, '同批已做'); assert(a2.dreamSkip.last)
        let rep = fs.readFileSync(path.join(a2.fd, 'report.md'), 'utf8')
        assert(rep.includes('略過:同批已做'), rep.slice(-600))
        assert.equal(JSON.parse(fs.readFileSync(path.join(a2.fd, 'summary.json'), 'utf8')).dream, undefined, 'summary 不載做夢')
        let a3 = await rsi.auto({ accept: true })
        assert(a3.dream && a3.dream.decision, '--accept 不略過')
        for (let k of ['explore', 'dream', 'hook', 'policyDev']) { assert(_.isFinite(a3.stagesSec[k]), k) }
        assert.match(fs.readFileSync(path.join(a3.fd, 'report.md'), 'utf8'), /## 各段牆鐘/)
        let a4 = await rsi.auto({ noDream: true })
        assert.equal(a4.dream, null); assert.equal(a4.dreamSkip.why, '--no-dream')
        let r0 = fresh('iv0', { dream: { minIntervalMs: 0 } })
        await r0.auto({})
        let b2 = await r0.auto({})
        assert(b2.dream, 'minIntervalMs 0 ⇒ 每輪做夢')
    })

    it('同批互斥(2026-10-01) —— 他方持做夢租約 ⇒ 略過「同批進行中」且不寫分數;--accept 不經互斥;持有者已死 ⇒ 回收並做夢、做完釋放;minIntervalMs 0 不經互斥', async function () {
        this.timeout(180000)
        let cfgMx = { dream: { minIntervalMs: 1e9, targetLadder: 3 } }
        //① 他方持有中(以本程序所取之槽代表存活之他 session)
        let rsi = fresh('mx', cfgMx)
        let fdMtx = path.join(rsi.paths.policies, DREAM_MUTEX)
        let h = tryAcquireSlots(fdMtx, { want: 1, max: 1 })
        assert.equal(h.length, 1)
        let a1 = await rsi.auto({})
        assert.equal(a1.dream, null); assert.equal(a1.dreamSkip.why, '同批進行中'); assert.match(String(a1.dreamSkip.holder), /pid \d+/)
        assert.deepEqual(readJsonl(rsi.paths.scores), [], '略過者不寫分數')
        assert(fs.readFileSync(path.join(a1.fd, 'report.md'), 'utf8').includes('略過:同批進行中'))
        //② --accept(明示升版請求)不經互斥
        let a2 = await rsi.auto({ accept: true })
        assert(a2.dream, '--accept 不略過')
        releaseSlots(h)
        //③ 持有者已死:子程序取槽後不釋放即退出 ⇒ 下一次 auto 回收死槽並做夢, 做完釋放
        let rsi2 = fresh('mx2', cfgMx)
        let fdMtx2 = path.join(rsi2.paths.policies, DREAM_MUTEX)
        let slotsUrl = pathToFileURL(path.join(FD_PACK, 'src', 'core', 'slots.mjs')).href
        let ch = spawnSync(process.execPath, ['--input-type=module', '-e', `import { tryAcquireSlots } from ${JSON.stringify(slotsUrl)}; let h = tryAcquireSlots(${JSON.stringify(fdMtx2)}, { want: 1, max: 1 }); console.log(h.length)`], { encoding: 'utf8', windowsHide: true })
        assert.equal(String(ch.stdout).trim(), '1', ch.stderr)
        assert.equal(slotsStatus(fdMtx2, { max: 1 }).filter((s) => s.dead).length, 1, '子程序已退出 ⇒ 死槽')
        let b1 = await rsi2.auto({})
        assert(b1.dream && !b1.dreamSkip, `死槽回收後做夢(${JSON.stringify(b1.dreamSkip)})`)
        assert.equal(slotsStatus(fdMtx2, { max: 1 }).filter((s) => !s.dead).length, 0, '做完即釋放')
        //④ minIntervalMs 0(每輪做夢)不經互斥:他方持有中亦做
        let r0 = fresh('mx0', { dream: { minIntervalMs: 0, targetLadder: 3 } })
        let h0 = tryAcquireSlots(path.join(r0.paths.policies, DREAM_MUTEX), { want: 1, max: 1 })
        let c1 = await r0.auto({})
        assert(c1.dream, 'minIntervalMs 0 ⇒ 不經互斥')
        releaseSlots(h0)
    })

    it('別名表備忘:別名表於一次做夢只算一次(當前 + 候選 × 全樣本 + 各切分共用);分數與逐次重算逐位同', async function () {
        this.timeout(120000)
        let nFp = 0
        let rsi = fresh('memo', {}, { fingerprint: (raw) => { nFp++; return toy.fingerprint(raw) } })
        for (let i = 0; i < 3; i++) { await rsi.explore({}) }
        fs.copyFileSync(path.join(FD_PACK, 'src', 'search', 'policyV0.mjs'), path.join(rsi.paths.candidates, 'c1.mjs'))
        let nodes = rsi.store.loadNodes()
        let nExec = nodes.filter((n) => n.status === 'executed' && n.score).length
        nFp = 0
        let d = await rsi.dream({ nodes })
        assert.equal(nFp, nExec, `指紋呼叫 ${nFp} 次(= 一張別名表之 ${nExec};原為每策略 × (全樣本 + 切分數 + 1) 次)`)
        let env = { viewOf: rsi.view.policyViewOfNode, aliasOf: rsi.view.aliasOf, makeCtx: rsi.makeCtx }
        let pol = (await rsi.loadPolicy()).fn
        let simOpt = _.pick(rsi.budget, ['rounds', 'arms', 'novelty', 'global'])
        let a = evaluatePolicy(pol, nodes, env, simOpt)
        let b = evaluatePolicy(pol, nodes, env, { ...simOpt, aliasMap: aliasMapOfNodes(nodes, env) })
        assert.deepEqual(a, b, '給與不給 aliasMap 逐位同')
        assert.equal(d.rows[0].score.heldOutMean, a.heldOutMean)
        assert.deepEqual(d.rows[1].score, d.rows[0].score, '候選 = v0 之副本 ⇒ 同分')
    })
})
