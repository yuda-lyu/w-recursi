import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi, simulate } from '../src/index.mjs'
import policyV0 from '../src/search/policyV0.mjs'
import { makeDomain, carriers } from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//展開鉤子 domain.childBlock(2026-09-25):makeCtx(executed, views) 以父之視圖過濾參數型展開之子;未給鉤子 / 未傳 views 時與原行為逐字相同
//  玩具:T.tag 為無效變異(子與父行為相同 ⇒ 別名)—— 領域鉤子擋之;另以「父之訓練分數」判 P.x(驗證鉤子收到的是父之視圖)
describe('search/childBlock:策略展開之領域鉤子', function () {
    let t
    before(() => { t = makeTmp('childBlock') })
    after(() => { t.cleanup() })
    let fresh = (name, domainOver = {}) => createRsi({ root: path.join(t.dir, name), domain: makeDomain(domainOver), budget: { arms: 6, novelty: 2, workers: 3 } }).init()
    let blockTag = ({ op }) => (op === 'T.tag' ? '無效變異(與父同行為)' : null)

    it('未給鉤子:childrenOf 即 registry.childrenOf(views 有無皆同);blockedChildren 空', () => {
        let rsi = fresh('none')
        let views = [{ id: 'p', spec: carriers.origin, score: { components: { train: 1 } } }]
        for (let ctx of [rsi.makeCtx(new Set()), rsi.makeCtx(new Set(), views)]) {
            assert.equal(ctx.childrenOf, rsi.registry.childrenOf)
            assert.deepEqual(ctx.blockedChildren, [])
        }
    })
    it('給鉤子但未傳 views:不過濾(舊呼叫端逐字不變)', () => {
        let rsi = fresh('noViews', { childBlock: blockTag })
        let ctx = rsi.makeCtx(new Set())
        assert.equal(ctx.childrenOf, rsi.registry.childrenOf)
        assert(ctx.childrenOf(carriers.origin).some((k) => k.op === 'T.tag'))
    })
    it('給鉤子與 views:擋下之子不回傳、其餘逐列同;記 blockedChildren(父 id、算子、理由);已執行之子不記', () => {
        let rsi = fresh('views', { childBlock: blockTag })
        let views = [{ id: 'p0', spec: carriers.origin, score: { components: { train: 1 } } }]
        let all = rsi.registry.childrenOf(carriers.origin)
        let ctx = rsi.makeCtx(new Set(), views)
        let got = ctx.childrenOf(carriers.origin)
        assert.deepEqual(got, all.filter((k) => k.op !== 'T.tag'))
        assert.equal(ctx.blockedChildren.length, 1)
        assert.deepEqual(_.pick(ctx.blockedChildren[0], ['parentId', 'op', 'why']), { parentId: 'p0', op: 'T.tag', why: '無效變異(與父同行為)' })
        let tagHash = all.find((k) => k.op === 'T.tag').specHash
        let ctx2 = rsi.makeCtx(new Set([tagHash]), views)
        assert(!ctx2.childrenOf(carriers.origin).some((k) => k.op === 'T.tag'))
        assert.equal(ctx2.blockedChildren.length, 0, '已執行者不列')
    })
    it('鉤子收到父之視圖(以 specHash 查得);查不到父時只給 { spec };鉤子拋錯視同不擋', () => {
        let seen = []
        let rsi = fresh('parentView', { childBlock: ({ op, parent }) => { seen.push(parent); if (op !== 'P.x') { return null } return _.get(parent, 'score.components.train', 0) > 50 ? '父訓練分數 > 50' : null } })
        let hi = { id: 'hi', spec: { kind: 'point', x: 3, y: -5 }, score: { components: { train: 99 } } }
        let lo = { id: 'lo', spec: { kind: 'point', x: -15, y: 15 }, score: { components: { train: 10 } } }
        let ctx = rsi.makeCtx(new Set(), [hi, lo])
        assert(!ctx.childrenOf(hi.spec).some((k) => k.op === 'P.x'))
        assert(ctx.childrenOf(lo.spec).some((k) => k.op === 'P.x'))
        assert(seen.includes(hi) && seen.includes(lo))
        seen = []
        ctx.childrenOf({ kind: 'point', x: 1, y: 1 })
        assert(seen.length > 0 && seen.every((p) => !p.id && p.spec.x === 1), '查不到父 ⇒ { spec }')
        let rsiErr = fresh('throw', { childBlock: () => { throw new Error('boom') } })
        let ctxE = rsiErr.makeCtx(new Set(), [hi])
        assert.deepEqual(ctxE.childrenOf(hi.spec), rsiErr.registry.childrenOf(hi.spec))
    })
    it('譜系 byId(2026-09-25):給 lineage 時以之建(可含 views 以外之節點, 如別名), 否則以 views 建;同一 ctx 只建一次', () => {
        let got = []
        let rsi = fresh('lineage', { childBlock: ({ byId }) => { got.push(byId); return null } })
        let gp = { id: 'gp', parent: 'root', spec: { kind: 'point', x: 0, y: 0 }, score: { components: { train: 1 } } }
        let hi = { id: 'hi', parent: 'gp', spec: { kind: 'point', x: 3, y: -5 }, score: { components: { train: 99 } } }
        rsi.makeCtx(new Set(), [hi], [hi, gp]).childrenOf(hi.spec)
        assert(got.length > 1 && got.every((m) => m === got[0]), '同一 ctx 共用一個 Map')
        assert(got[0] instanceof Map && got[0].get('gp') === gp && got[0].get('hi') === hi)
        got = []
        rsi.makeCtx(new Set(), [hi]).childrenOf(hi.spec)
        assert(got[0] instanceof Map && got[0].size === 1 && got[0].get('hi') === hi && !got[0].has('gp'), '未給 lineage ⇒ 以 views 建')
        //鉤子據 byId 查父之父而擋(如領域之「同一改動已於父之父大跌」)
        let rsi2 = fresh('lineageBlock', { childBlock: ({ op, parent, byId }) => (op === 'P.x' && byId && byId.get(parent.parent) && byId.get(parent.parent).id === 'gp' ? '父之父為 gp' : null) })
        assert(!rsi2.makeCtx(new Set(), [hi], [hi, gp]).childrenOf(hi.spec).some((k) => k.op === 'P.x'))
        assert(rsi2.makeCtx(new Set(), [hi]).childrenOf(hi.spec).some((k) => k.op === 'P.x'), 'views 不含 gp ⇒ 查不到 ⇒ 不擋')
    })
    it('規格級(2026-09-25):同一子規格經兩父可達(P.x / P.y 可交換), 只在其一路徑被擋 ⇒ 兩路徑皆不出;記錄沿用擋下路徑;同一列只記一次;已執行者不列', () => {
        //a = (1, 0) 施 P.y +1 被擋(路徑理由);b = (0, 1) 施 P.x +1 本身不擋 —— 兩者皆得 c = (1, 1)
        let hook = ({ op, parent, child }) => (op === 'P.y' && parent.spec.x === 1 && child.spec.y === parent.spec.y + 1 ? '同一改動於父之父已大跌(玩具)' : null)
        let rsi = fresh('specLevel', { childBlock: hook })
        let a = { id: 'a', spec: { kind: 'point', x: 1, y: 0 }, score: { components: { train: 1 } } }
        let b = { id: 'b', spec: { kind: 'point', x: 0, y: 1 }, score: { components: { train: 1 } } }
        let cHash = rsi.registry.childrenOf(b.spec).find((k) => k.op === 'P.x' && k.spec.x === 1).specHash
        let ctx = rsi.makeCtx(new Set(), [a, b])
        assert(!ctx.childrenOf(b.spec).some((k) => k.specHash === cHash), '經 b 之 P.x 亦不出')
        assert(!ctx.childrenOf(a.spec).some((k) => k.specHash === cHash), '經 a 之 P.y 不出')
        ctx.childrenOf(b.spec)
        let rows = ctx.blockedChildren.filter((r) => r.specHash === cHash)
        assert.equal(rows.length, 1, '同一(父, 算子, 規格)只記一次')
        assert.deepEqual(_.pick(rows[0], ['parentId', 'op', 'why']), { parentId: 'a', op: 'P.y', why: '同一改動於父之父已大跌(玩具)' })
        //其餘子逐列同 registry(只少被擋者)
        assert.deepEqual(ctx.childrenOf(b.spec), rsi.registry.childrenOf(b.spec).filter((k) => k.specHash !== cHash))
        //視圖不含 a ⇒ 無擋下路徑 ⇒ 經 b 照常展開(與路徑級同)
        assert(rsi.makeCtx(new Set(), [b]).childrenOf(b.spec).some((k) => k.specHash === cHash))
        //已執行:不出、不列
        let ctxE = rsi.makeCtx(new Set([cHash]), [a, b])
        assert(!ctxE.childrenOf(b.spec).some((k) => k.specHash === cHash))
        assert.equal(ctxE.blockedChildren.filter((r) => r.specHash === cHash).length, 0)
    })
    it('explore:三輪皆無 T.tag 之子入樹;計畫之策略備註列出擋下數', async function () {
        this.timeout(60000)
        let rsi = fresh('explore', { childBlock: blockTag })
        let notes = []
        for (let i = 0; i < 3; i++) { let ex = await rsi.explore({}); notes.push(...JSON.parse(fs.readFileSync(path.join(ex.fd, 'plan.json'), 'utf8')).notes || []) }
        assert(rsi.store.loadNodes().every((n) => _.get(n, 'origin.operator') !== 'T.tag'))
        assert(notes.some((s) => /^展開鉤子擋下 \d+ 子/.test(s)), JSON.stringify(notes))
    })
    it('做夢之重放:makeCtx 收到視圖(鉤子生效), 被擋之子不被提出', async function () {
        this.timeout(60000)
        let rsi = fresh('replay', { childBlock: blockTag })
        for (let i = 0; i < 2; i++) { await rsi.explore({}) }
        let nodes = rsi.store.loadNodes()
        let ctxs = []
        let env = { viewOf: rsi.view.policyViewOfNode, aliasOf: rsi.view.aliasOf, makeCtx: (ex, views, lineage) => { let c = rsi.makeCtx(ex, views, lineage); ctxs.push({ c, views, lineage }); return c } }
        let proposed = []
        let spy = (view, budget, ctx) => { let p = policyV0(view, budget, ctx); proposed.push(...(p.expand || [])); return p }
        simulate(spy, nodes, env, { rounds: 2, arms: 6 })
        assert(ctxs.length > 0 && ctxs.every((x) => _.isArray(x.views)), 'replay 須傳 views')
        //譜系:可見節點全部(views ⊆ lineage)
        assert(ctxs.every((x) => _.isArray(x.lineage) && x.views.every((v) => x.lineage.some((l) => l.id === v.id))), 'replay 須傳 lineage ⊇ views')
        assert(ctxs.some((x) => x.c.blockedChildren.length > 0))
        assert(proposed.every((it) => it.op !== 'T.tag'))
    })
})
