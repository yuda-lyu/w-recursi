import assert from 'assert'
import _ from 'lodash-es'
import { createRsi, simulate, evaluatePolicy } from '../src/index.mjs'
import { makeDomain, carriers } from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//做夢重放之別名(2026-09-25):別名 = 原料指紋同較早之正本;被提出時記成本,
//  正本已可見 ⇒ duplicates、不算揭露(不計 bestS / 目標);正本未可見 ⇒ 以正本計揭露;回溯目標不含別名
//  玩具:T.tag 為無效變異(P(0,0)#a 與 P(0,0) 行為相同 ⇒ 別名);以前緣 arm 把它送進樹
describe('sim/replay:別名之揭露', function () {
    let t, rsi, nodes, env, orig, tagged, alias
    before(async function () {
        this.timeout(60000)
        t = makeTmp('replayAlias')
        rsi = createRsi({ root: t.dir, domain: makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 } }).init()
        await rsi.explore({}) //第 1 輪:載體 origin / far
        let spec = { ...carriers.origin, tag: 'a' }
        rsi.store.pushFrontier([{ kind: 'arm', spec, specHash: rsi.specHash(spec), reason: '別名測試', priority: 0 }])
        await rsi.explore({}) //第 2 輪:含 P(0,0)#a
        nodes = rsi.store.loadNodes()
        env = { viewOf: rsi.view.policyViewOfNode, aliasOf: rsi.view.aliasOf, makeCtx: rsi.makeCtx }
        orig = nodes.find((n) => n.specHash === rsi.specHash(carriers.origin))
        tagged = nodes.find((n) => n.specHash === rsi.specHash(spec))
        alias = env.aliasOf(nodes.filter((n) => n.status === 'executed' && n.score))
    })
    after(() => { t.cleanup() })

    it('前置:P(0,0)#a 為 P(0,0) 之別名', () => {
        assert(orig && tagged, '兩節點皆須在樹')
        assert.equal(alias.get(tagged.id), orig.id)
    })
    it('正本已可見(startRound 1):提出別名只記成本, duplicates 1、不揭露、不影響 bestS', () => {
        let pol = () => ({ expand: [{ parentId: orig.id, op: 'T.tag', spec: tagged.spec, specHash: tagged.specHash }], novelty: [] })
        let r = simulate(pol, nodes, env, { rounds: 1, arms: 1, startRound: 1 })
        assert.equal(r.duplicates, 1); assert.equal(r.revealed, 0); assert.equal(r.bestS, 0)
        assert.equal(r.cost, tagged.cost.replays)
    })
    it('正本未可見(startRound 0):提出別名 ⇒ 以正本計揭露(revealedIds = [正本])、正本若為目標則記成本', () => {
        let pol = () => ({ expand: [{ parentId: 'root', op: 'T.tag', spec: tagged.spec, specHash: tagged.specHash }], novelty: [] })
        let r = simulate(pol, nodes, env, { rounds: 1, arms: 1, startRound: 0, targetIds: [orig.id] })
        assert.deepEqual(r.revealedIds, [orig.id]); assert.equal(r.duplicates, 0)
        assert.equal(r.bestS, orig.score.S)
        assert.equal(r.targets[orig.id], tagged.cost.replays)
        //之後再提正本:已可見 ⇒ 不重複揭露、不計成本
        let pol2 = () => ({ expand: [{ parentId: 'root', op: 'T.tag', spec: tagged.spec, specHash: tagged.specHash }, { parentId: 'root', op: 'x', spec: orig.spec, specHash: orig.specHash }], novelty: [] })
        let r2 = simulate(pol2, nodes, env, { rounds: 1, arms: 2, startRound: 0 })
        assert.deepEqual(r2.revealedIds, [orig.id]); assert.equal(r2.cost, tagged.cost.replays)
    })
    it('evaluatePolicy 之回溯目標不含別名(即使其 ladder ≥ 目標階)', () => {
        let s = evaluatePolicy(() => ({ expand: [], novelty: [] }), nodes, env, { rounds: 1, arms: 1, targetLadder: 0 })
        let exec = nodes.filter((n) => n.status === 'executed' && n.score)
        assert.equal(s.nTargets, exec.length - _.size([...alias.keys()]))
    })
})
