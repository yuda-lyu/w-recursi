import assert from 'assert'
import _ from 'lodash-es'
import { createRsi, simulate, evaluatePolicy, accept } from '../src/index.mjs'
import policyV0 from '../src/search/policyV0.mjs'
import nullPolicy from './tools/nullPolicy.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


describe('sim/replay:夢境模擬器與單調接受', function () {
    let t, rsi, nodes, env
    before(async function () {
        this.timeout(90000)
        t = makeTmp('replay')
        rsi = createRsi({ root: t.dir, domain: makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 } }).init()
        for (let i = 0; i < 3; i++) { await rsi.explore({}) }
        nodes = rsi.store.loadNodes()
        env = { viewOf: rsi.view.policyViewOfNode, aliasOf: rsi.view.aliasOf, makeCtx: rsi.makeCtx }
    })
    after(() => { t.cleanup() })

    it('空策略:J = 0(無揭露、無成本、無利用)', () => {
        let r = simulate(nullPolicy, nodes, env, { rounds: 3, arms: 6 })
        assert.deepEqual(_.pick(r, ['J', 'revealed', 'unknown', 'cost', 'util']), { J: 0, revealed: 0, unknown: 0, cost: 0, util: 0 })
    })
    it('全知策略(一輪提出全部既有規格):揭露全部、成本 = Σ replays、bestS = 最大 S、回溯全中', () => {
        let exec = nodes.filter((n) => n.status === 'executed')
        let greedy = () => ({ expand: exec.map((n) => ({ parentId: 'root', op: 'g', spec: n.spec, specHash: n.specHash })), novelty: [] })
        let targets = exec.filter((n) => n.score.ladder >= 3).map((n) => n.id)
        let r = simulate(greedy, nodes, env, { rounds: 1, arms: exec.length, targetIds: targets })
        assert.equal(r.revealed, exec.length)
        assert.equal(r.cost, _.sum(exec.map((n) => n.cost.replays)))
        assert.equal(r.bestS, _.max(exec.map((n) => n.score.S)))
        assert.equal(r.unknown, 0)
        assert.equal(r.util, 1)
        assert(_.every(r.targets, (v) => v !== null && v > 0))
        assert.equal(r.J, _.round(r.bestS - r.cost / 1000 + 2, 4))
    })
    it('未知規格只扣預設成本不揭露', () => {
        let unknownPol = () => ({ expand: [{ parentId: 'root', op: 'u', spec: { kind: 'point', x: 19, y: 19 } }], novelty: [] })
        let r = simulate(unknownPol, nodes, env, { rounds: 2, arms: 4, defaultReplays: 7 })
        assert.equal(r.revealed, 0); assert.equal(r.unknown, 2); assert.equal(r.cost, 14)
    })
    it('時間切分:startRound = 1 時第 1 輪節點起始可見, 不會被「揭露」', () => {
        let r1ids = new Set(nodes.filter((n) => n.round === 1).map((n) => n.id))
        let r = simulate(policyV0, nodes, env, { rounds: 3, arms: 6, novelty: 2, startRound: 1 })
        assert(r.revealedIds.every((id) => !r1ids.has(id)))
        assert(r.revealed >= 1, 'v0 從第 1 輪之父展開應能揭露第 2 / 3 輪之節點')
    })
    it('時間切分不外洩未來:視圖之 children 只含可見節點(子數上限不因隱藏之子而提前觸發)', () => {
        let r1 = nodes.filter((n) => n.round === 1 && _.some(n.children || [], (c) => _.get(_.find(nodes, { id: c }), 'round', 0) > 1))
        assert(r1.length >= 1, '前置:須有第 1 輪節點之子落在較晚輪次')
        let seen = []
        let spy = (view) => { if (view.round === 1) { seen.push(...view.nodes) } return { expand: [], novelty: [] } }
        simulate(spy, nodes, env, { rounds: 1, arms: 6, startRound: 1 })
        let vis = new Set(nodes.filter((n) => (n.round || 0) <= 1).map((n) => n.id))
        assert(seen.length >= 1)
        for (let v of seen) { assert((v.children || []).every((c) => vis.has(c)), `${v.id} 之 children 含不可見節點`) }
        let p = _.find(seen, { id: r1[0].id })
        assert(p && p.children.length < r1[0].children.length, '有較晚之子的節點, 其視圖 children 應被截短')
        //子數已滿之父:把第 1 輪某節點之 children 灌到上限以上(全為隱藏之較晚節點), 策略仍可展開它
        let later = nodes.filter((n) => (n.round || 0) > 1).map((n) => n.id)
        let fat = nodes.map((n) => (n.id === r1[0].id ? { ...n, children: [...(n.children || []), ...later, ...later.map((x) => `${x}_x`)] } : n))
        let r = simulate(policyV0, fat, env, { rounds: 3, arms: 6, novelty: 2, startRound: 1 })
        let r0 = simulate(policyV0, nodes, env, { rounds: 3, arms: 6, novelty: 2, startRound: 1 })
        assert.deepEqual(r.revealedIds, r0.revealedIds, '隱藏之子不得改變重放結果')
    })
    it('evaluatePolicy:切分數 = 輪數 − 1;留出為各切分 J 均;回溯目標 = ladder ≥ 3 且非別名者', () => {
        let s = evaluatePolicy(policyV0, nodes, env, { rounds: 3, arms: 6, novelty: 2 })
        assert.equal(s.nCuts, 2)
        assert.deepEqual(s.timeSplits.map((x) => x.startRound), [1, 2])
        assert.equal(s.heldOutMean, _.round(_.mean(s.timeSplits.map((x) => x.J)), 4))
        let alias = env.aliasOf(nodes.filter((n) => n.status === 'executed' && n.score))
        assert.equal(s.nTargets, nodes.filter((n) => n.status === 'executed' && n.score.ladder >= 3 && !alias.has(n.id)).length)
        assert(s.targetsFound <= s.nTargets * s.nCuts)
        assert(_.isFinite(s.inSample.J))
    })
    //2026-09-27(探索之全域 / 局部失衡修正):global 臂、樹外成本之可見中位、探索保底、視圖之 QD
    it('plan.global 之臂計入重放(利用率 / 樹外);未給 global 之策略不變', () => {
        let g = () => ({ expand: [], novelty: [], global: [{ spec: { kind: 'point', x: 19, y: 18 } }, { spec: { kind: 'point', x: 18, y: 19 } }] })
        let r = simulate(g, nodes, env, { rounds: 2, arms: 4, defaultReplays: 5 })
        assert.equal(r.unknown, 4); assert.equal(r.cost, 20); assert.equal(r.util, _.round(4 / 8, 3))
    })
    it("defaultReplays 'visibleMedian':樹外臂之成本 = 該輪可見已執行節點之成本中位(只用可見量)", () => {
        let unknownPol = () => ({ expand: [{ parentId: 'root', op: 'u', spec: { kind: 'point', x: 19, y: 19 } }], novelty: [] })
        let exec = nodes.filter((n) => n.status === 'executed' && n.score)
        let med = (a) => { let s = _.sortBy(a); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }
        let maxR = _.max(exec.map((n) => n.round || 0))
        let rAll = simulate(unknownPol, nodes, env, { rounds: 1, arms: 4, defaultReplays: 'visibleMedian', startRound: maxR })
        assert.equal(rAll.cost, med(exec.map((n) => n.cost.replays)), '切分於最後一輪 ⇒ 可見 = 全部已執行')
        let r1 = simulate(unknownPol, nodes, env, { rounds: 1, arms: 4, defaultReplays: 'visibleMedian', startRound: 1 })
        assert.equal(r1.cost, med(exec.filter((n) => (n.round || 0) <= 1).map((n) => n.cost.replays)), '時間切分只用切分前之可見節點')
        let r0 = simulate(unknownPol, nodes, env, { rounds: 1, arms: 4, defaultReplays: 'visibleMedian' })
        assert.equal(r0.cost, 24, '全樣本(startRound −1)起始無可見之已執行節點 ⇒ 退回 24')
    })
    it('探索保底 minGlobal:plan.global 不足之輪記 globalShort;evaluatePolicy 彙總;accept 拒升', () => {
        let r = simulate(policyV0, nodes, env, { rounds: 3, arms: 6, novelty: 2, minGlobal: 2 })
        assert.equal(r.globalShort, 3, 'v0 不回 plan.global ⇒ 3 輪皆不足')
        let s = evaluatePolicy(policyV0, nodes, env, { rounds: 3, arms: 6, novelty: 2, minGlobal: 2 })
        assert.equal(s.globalShort, 3 * (1 + s.nCuts)); assert.equal(s.minGlobal, 2)
        let cur = { heldOutMean: 10, inSample: { J: 10 } }
        let d = accept(cur, { heldOutMean: 20, inSample: { J: 20 }, globalShort: 1, minGlobal: 2 })
        assert.equal(d.ok, false); assert.match(d.why, /探索保底不足/)
        assert.equal(simulate(policyV0, nodes, env, { rounds: 3, arms: 6, novelty: 2 }).globalShort, 0, 'minGlobal 0(預設)⇒ 不記')
    })
    it('視圖有行為格(score.cell)⇒ J 之品質項 = 各格「階梯 ≥ targetLadder」之最高 S 之和(QD);分數讀視圖(遮蔽後)而非原始 S', () => {
        let exec = nodes.filter((n) => n.status === 'executed' && n.score)
        let cellOf = (n) => (n.spec.x >= 5 ? 'A' : 'B')
        let env2 = { ...env, viewOf: (n, a) => { let v = env.viewOf(n, a); return { ...v, score: { ...v.score, S: (n.score.S || 0) + 1, ladder: 1, cell: cellOf(n) } } } }
        let greedy = () => ({ expand: exec.map((n) => ({ parentId: 'root', op: 'g', spec: n.spec, specHash: n.specHash })), novelty: [] })
        let r = simulate(greedy, nodes, env2, { rounds: 1, arms: exec.length, targetLadder: 1 })
        let qd = _.sum(_.map(_.groupBy(exec, cellOf), (g) => _.max(g.map((n) => (n.score.S || 0) + 1))))
        assert.equal(r.qd, _.round(qd, 3)); assert.equal(r.nCells, _.uniq(exec.map(cellOf)).length)
        assert.equal(r.bestS, _.max(exec.map((n) => (n.score.S || 0) + 1)), 'bestS 讀視圖之 S')
        assert.equal(r.J, _.round(qd - r.cost / 1000 + 2, 4))
        let s = evaluatePolicy(greedy, nodes, env2, { rounds: 1, arms: exec.length, targetLadder: 1 })
        let alias = env.aliasOf(exec)
        assert.equal(s.nTargets, exec.filter((n) => !alias.has(n.id)).length, '目標以視圖之階梯判(全部視圖階梯 1)')
    })
    it('策略拋錯:J = −∞ 並附錯誤', () => {
        let r = simulate(() => { throw new Error('bad policy') }, nodes, env, {})
        assert.equal(r.J, -Infinity); assert.match(r.error, /bad policy/)
    })
    it('accept:同分不升;留出優 5% 且全樣本 ≥ 90% 才升;負分以絕對量比', () => {
        let cur = { heldOutMean: 10, inSample: { J: 10 } }
        assert.equal(accept(cur, { heldOutMean: 10, inSample: { J: 10 } }).ok, false)
        assert.equal(accept(cur, { heldOutMean: 10.6, inSample: { J: 9.5 } }).ok, true)
        assert.equal(accept(cur, { heldOutMean: 11, inSample: { J: 8 } }).ok, false)
        assert.equal(accept(cur, { heldOutMean: 10.4, inSample: { J: 12 } }).ok, false)
        let neg = { heldOutMean: -10, inSample: { J: -10 } }
        assert.equal(accept(neg, { heldOutMean: -9, inSample: { J: -10 } }).ok, true)
        assert.equal(accept(neg, { heldOutMean: -9.6, inSample: { J: -10 } }).ok, false)
        assert.equal(accept(null, { heldOutMean: 1, inSample: { J: 1 } }).ok, true)
        assert.equal(accept(cur, null).ok, false)
        assert.equal(accept(cur, { heldOutMean: 10.2, inSample: { J: 10 } }, { margin: 0.01 }).ok, true, 'margin 可調')
    })
})
