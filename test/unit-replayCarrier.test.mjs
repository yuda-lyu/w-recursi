import assert from 'assert'
import _ from 'lodash-es'
import { createRsi, simulate } from '../src/index.mjs'
import { makeDomain, carriers } from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//做夢重放之載體時間切分(2026-09-25):ctx.carriers 由領域自現存工件推導、不依時間切分(如自既有工件推導, 含由節點自動建立者)⇒
//  規格 = 由搜尋所得(origin.topic ≠ 'carrier')而於切分時尚不可見之節點者不提供(否則經新區域額度提前揭露未來之發現);carrier 起源之節點與不在樹上之規格照常提供
//  玩具:載體 origin / far 於第 1 輪經新區域額度入樹(origin.topic 'carrier');第 2 ~ 3 輪展開所得之節點 N 事後被登為載體 derived(模擬「由節點建立後推導出載體」)
describe('sim/replay:載體之時間切分', function () {
    let t, rsi, nodes, env, extra = {}, N, seen
    //只提載體之策略(同 v0 之新區域段):記下每輪所見之載體名
    let carrierPolicy = (view, budget, ctx) => { seen.push(_.keys(ctx.carriers).sort()); return { expand: [], novelty: _.map(ctx.carriers, (spec) => ({ spec, specHash: ctx.specHash(spec) })) } }
    before(async function () {
        this.timeout(90000)
        t = makeTmp('replayCarrier')
        rsi = createRsi({ root: t.dir, domain: { ...makeDomain(), carriers: () => ({ ...carriers, ...extra }) }, budget: { arms: 6, novelty: 2, workers: 3 } }).init()
        for (let i = 0; i < 3; i++) { await rsi.explore({}) }
        nodes = rsi.store.loadNodes()
        env = { viewOf: rsi.view.policyViewOfNode, aliasOf: rsi.view.aliasOf, makeCtx: rsi.makeCtx }
        let alias = env.aliasOf(nodes.filter((n) => n.status === 'executed' && n.score))
        N = _.maxBy(nodes.filter((n) => n.status === 'executed' && n.score && (n.round || 0) >= 2 && _.get(n, 'origin.topic') !== 'carrier' && !alias.has(n.id)), (n) => n.score.S)
        extra.derived = N ? N.spec : null
    })
    after(() => { t.cleanup() })

    it('前置:載體 origin / far 之節點起源為 carrier(第 1 輪);N 由展開所得(第 ≥ 2 輪)', () => {
        let o = nodes.find((n) => n.specHash === rsi.specHash(carriers.origin))
        let f = nodes.find((n) => n.specHash === rsi.specHash(carriers.far))
        assert(o && f && N, '三節點皆須在樹')
        assert.equal(_.get(o, 'origin.topic'), 'carrier'); assert.equal(_.get(f, 'origin.topic'), 'carrier')
        assert.equal(o.round, 1); assert(N.round >= 2)
        assert.notEqual(_.get(N, 'origin.topic'), 'carrier')
    })
    it('N 尚不可見之切分:由 N 推導之載體不提供 ⇒ 不經載體揭露 N;carrier 起源者照常提供並揭露', () => {
        seen = []
        let r = simulate(carrierPolicy, nodes, env, { rounds: 1, arms: 6, startRound: 0 })
        assert.deepEqual(seen[0], ['far', 'origin'])
        assert(!r.revealedIds.includes(N.id))
        let o = nodes.find((n) => n.specHash === rsi.specHash(carriers.origin))
        assert(r.revealedIds.includes(o.id))
        seen = []
        let r1 = simulate(carrierPolicy, nodes, env, { rounds: 1, arms: 6, startRound: N.round - 1 })
        assert(!seen[0].includes('derived'))
        assert(!r1.revealedIds.includes(N.id))
    })
    it('N 已可見之切分:載體照常提供(已執行 ⇒ 提出亦不重複揭露)', () => {
        seen = []
        let r = simulate(carrierPolicy, nodes, env, { rounds: 1, arms: 6, startRound: N.round })
        assert(seen[0].includes('derived'))
        assert(!r.revealedIds.includes(N.id))
    })
    it('規格不在樹上之載體照常提供(提出即 unknown)', () => {
        extra.novel = { kind: 'point', x: 19, y: -19 }
        try {
            seen = []
            let r = simulate(carrierPolicy, nodes, env, { rounds: 1, arms: 6, startRound: 0 })
            assert(seen[0].includes('novel'))
            assert.equal(r.unknown, 1)
        }
        finally { delete extra.novel }
    })
    it('全樣本(startRound −1):由搜尋所得之節點推導之載體亦不提供', () => {
        seen = []
        simulate(carrierPolicy, nodes, env, { rounds: 1, arms: 6 })
        assert(!seen[0].includes('derived'))
    })
})
