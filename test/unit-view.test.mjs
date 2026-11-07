import assert from 'assert'
import { policyViewOfNode, checkPolicySource, omitMask, makeView } from '../src/tree/view.mjs'
import { aliasMapOf } from '../src/tree/alias.mjs'
import { makeNode } from '../src/tree/node.mjs'
import { makePaths } from '../src/core/paths.mjs'
import { makeStore } from '../src/tree/store.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


let P = (x, y, tag) => (tag ? { kind: 'point', x, y, tag } : { kind: 'point', x, y })

describe('tree/view + tree/alias:策略視圖之遮蔽、靜態檢查、行為別名', () => {
    let domain = toy.makeDomain()
    it('視圖依領域 mask 去除留出段數值, 其餘分數欄位保留', async () => {
        let raw = await toy.evaluate(P(1, 1), null)
        let node = makeNode({ id: 'n1', spec: P(1, 1), raw }, domain)
        assert('backtest' in node.score)
        let v = policyViewOfNode(node, null, domain)
        assert(!('backtest' in v.score))
        assert.equal(v.score.S, node.score.S)
        assert.equal(v.summary, 'P(1,1)'); assert.equal(v.carrier, 'point'); assert.equal(v.aliasOf, null)
        assert(!('raw' in v), '視圖不含原料')
    })
    it('omitMask 深路徑', () => { assert.deepEqual(omitMask(['a.b'])({ a: { b: 1, c: 2 }, d: 3 }), { a: { c: 2 }, d: 3 }) })
    it('checkPolicySource:擋子程序 / 樹寫入 / 暫存 / 領域禁字;乾淨碼通過', () => {
        assert(checkPolicySource(`import { spawn } from 'child_process'`).length > 0)
        assert(checkPolicySource(`store.putNode(x)`).length > 0)
        assert(checkPolicySource(`fs.readFileSync('./tmp/x')`).length > 0)
        assert(checkPolicySource(`let v = n.score.backtest.eqYr`, toy.forbidden).length > 0)
        assert.equal(checkPolicySource(`export default (view, budget, ctx) => ({ expand: [], novelty: [] })`, toy.forbidden).length, 0)
    })
    it('aliasMapOf:同指紋之較晚節點 → 別名指向較早者;錨點與無指紋者不參與', async () => {
        let ra = await toy.evaluate(P(2, 2), null), rb = await toy.evaluate(P(2, 2, 'a'), null), rc = await toy.evaluate(P(3, 3), null)
        let a = makeNode({ id: 'a', spec: P(2, 2), raw: ra, round: 1 }, domain)
        let b = makeNode({ id: 'b', spec: P(2, 2, 'a'), raw: rb, round: 2 }, domain)
        let c = makeNode({ id: 'c', spec: P(3, 3), raw: rc, round: 2 }, domain)
        let anchor = makeNode({ id: 'z', spec: { kind: 'anchor', x: 2, y: 2 }, raw: ra, round: 0 }, domain)
        let noRaw = makeNode({ id: 'n', spec: P(2, 2), raw: null, round: 3, status: 'executed' }, domain)
        let m = aliasMapOf([c, b, a, anchor, noRaw], { fingerprint: toy.fingerprint, isAnchor: toy.isAnchor })
        assert.deepEqual([...m.entries()], [['b', 'a']])
        let m2 = aliasMapOf([b, a], { fingerprint: toy.fingerprint, isAnchor: (n) => n.id === 'a' })
        assert.equal(m2.size, 0, '正本為錨點時不成立別名(錨點不參與)')
    })
    it('makeView.policyView 對全樹附 aliasOf', async () => {
        let t = makeTmp('view')
        try {
            let paths = makePaths(t.dir); paths.ensure()
            let store = makeStore({ paths, domain })
            store.putNode(makeNode({ id: 'a', spec: P(2, 2), raw: await toy.evaluate(P(2, 2), null), round: 1 }, domain))
            store.putNode(makeNode({ id: 'b', spec: P(2, 2, 'a'), raw: await toy.evaluate(P(2, 2, 'a'), null), round: 2 }, domain))
            let view = makeView(store, domain)
            let vs = view.policyView()
            assert.equal(vs.find((v) => v.id === 'b').aliasOf, 'a')
            assert.equal(vs.find((v) => v.id === 'a').aliasOf, null)
            let sub = view.policyView(new Set(['b']))
            assert.equal(sub.length, 1); assert.equal(sub[0].aliasOf, 'a', '只取子集仍以全樹判別名')
        }
        finally { t.cleanup() }
    })
})
