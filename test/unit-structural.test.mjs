import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi, simulate, evaluatePolicy, accept } from '../src/index.mjs'
import { readJsonl } from '../src/core/jsonl.mjs'
import policyV0 from '../src/search/policyV0.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp, FD_TEST, FD_PACK } from './tools/tmpdir.mjs'


//結構保底(2026-10-02;sim/replay.mjs ⑥、sim/dream.mjs):O.structural(plan, { view, round }) → 違規數;違規之重放輪計 structuralShort;違規之候選不得升版
//  為何:做夢之重放偏向現任之軌跡(他策略之偏離只成樹外未知臂)⇒ 領域之結構約束(如每輪每族 ≤ 1)不可交由分數撤銷
describe('sim/replay ⑥ + sim/dream:結構保底', function () {
    let t, rsi, nodes, env
    before(async function () {
        this.timeout(90000)
        t = makeTmp('structural')
        rsi = createRsi({ root: path.join(t.dir, 'base'), domain: toy.makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 } }).init()
        for (let i = 0; i < 3; i++) { await rsi.explore({}) }
        nodes = rsi.store.loadNodes()
        env = { viewOf: rsi.view.policyViewOfNode, aliasOf: rsi.view.aliasOf, makeCtx: rsi.makeCtx }
    })
    after(() => { t.cleanup() })

    it('ST01 違規之輪計 structuralShort;鉤子收到 plan / view / round;拋錯計違規;回 0 或未給 ⇒ 0', () => {
        let seen = []
        let r = simulate(policyV0, nodes, env, { rounds: 3, arms: 6, novelty: 2, structural: (plan, o) => { seen.push([_.isPlainObject(plan), _.isArray(o.view.nodes), o.round]); return 2 } })
        assert.equal(r.structuralShort, 3)
        assert.deepEqual(seen.map((x) => x[2]), [1, 2, 3])
        assert(seen.every((x) => x[0] && x[1]))
        assert.equal(simulate(policyV0, nodes, env, { rounds: 3, arms: 6, novelty: 2, structural: () => { throw new Error('x') } }).structuralShort, 3, '拋錯 ⇒ 計違規')
        assert.equal(simulate(policyV0, nodes, env, { rounds: 3, arms: 6, novelty: 2, structural: () => 0 }).structuralShort, 0)
        assert.equal(simulate(policyV0, nodes, env, { rounds: 3, arms: 6, novelty: 2 }).structuralShort, 0, '未給 ⇒ 0')
    })
    it('ST02 evaluatePolicy 彙總(全樣本 + 各切分)且標 structural;accept 對 structuralShort > 0 拒升', () => {
        let s = evaluatePolicy(policyV0, nodes, env, { rounds: 2, arms: 6, novelty: 2, structural: () => 1 })
        assert.equal(s.structuralShort, 2 * (1 + s.nCuts))
        assert.equal(s.structural, true)
        assert.equal(evaluatePolicy(policyV0, nodes, env, { rounds: 2, arms: 6, novelty: 2 }).structural, false)
        let cur = { heldOutMean: 1, inSample: { J: 1 } }
        let d = accept(cur, { heldOutMean: 20, inSample: { J: 20 }, structuralShort: 1 })
        assert.equal(d.ok, false)
        assert.match(d.why, /結構保底不符/)
        assert.equal(accept(cur, { heldOutMean: 20, inSample: { J: 20 }, structuralShort: 0 }).ok, true)
    })
    it('ST03 做夢:cfg.dream.structural 違規之候選不升版、scores.jsonl 記 structuralShort;不違規照常升版', async function () {
        this.timeout(180000)
        for (let [name, fn, expectOk] of [['bad', () => 1, false], ['good', () => 0, true]]) {
            let r = createRsi({ root: path.join(t.dir, name), domain: toy.makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 }, dream: { structural: fn } }).init()
            await r.explore({})
            await r.explore({})
            //當前 = 空策略、候選 = v0(平時會升版;同 unit-dreamGate 維護判定之設)
            fs.copyFileSync(path.join(FD_TEST, 'tools', 'nullPolicy.mjs'), path.join(r.paths.policies, 'null.mjs'))
            fs.writeFileSync(r.paths.current, "export { default, meta } from './null.mjs'\n")
            fs.copyFileSync(path.join(FD_PACK, 'src', 'search', 'policyV0.mjs'), path.join(r.paths.candidates, 'cand.mjs'))
            let d = await r.dream({ accept: true })
            assert.equal(d.decision.ok, expectOk, `${name}:${JSON.stringify(d.decision)}`)
            if (!expectOk) { assert.match(d.decision.why, /結構保底/) }
            assert.equal(fs.existsSync(path.join(r.paths.policies, 'v1.mjs')), expectOk)
            let cand = readJsonl(r.paths.scores).find((x) => x.name === 'cand.mjs')
            assert(cand && cand.sim && cand.sim.structural === true, JSON.stringify(cand))
            assert.equal(cand.structuralShort > 0, !expectOk)
        }
    })
})
