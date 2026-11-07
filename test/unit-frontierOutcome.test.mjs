import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi, OCCUPIED, frontierOutcomesOf } from '../src/index.mjs'
import { makePaths } from '../src/core/paths.mjs'
import { makeStore } from '../src/tree/store.mjs'
import { makeNode } from '../src/tree/node.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


let P = (x, y) => ({ kind: 'point', x, y })

//前緣結案(2026-09-29:原不分成敗一律標 executed ⇒ 只經前緣進入之臂評估錯誤後永不重試)
//閘門拒絕存根(2026-09-29:原以 putNode 直接覆寫 ⇒ 可蓋掉已執行節點)
describe('loop/explore + tree/store:前緣結案與閘門拒絕存根(2026-09-29)', function () {
    let t
    before(() => { t = makeTmp('frontierOutcome') })
    after(() => { t.cleanup() })
    let fresh = (name, over = {}) => createRsi({ root: path.join(t.dir, name), domain: toy.makeDomain(over.domain || {}), budget: { arms: 6, novelty: 2, workers: 3 }, turning: { enabled: false }, ...(over.cfg || {}) }).init()

    it('前緣結案:評估錯誤之前緣臂維持 proposed、retries 遞增、原因入 note;第 2 次 status blocked, 之後不再被提', async function () {
        this.timeout(90000)
        let rsi = fresh('retry', { domain: { evaluator: { mode: 'inProcess', evaluate: toy.evaluate, createContext: toy.createContext, ctxOpt: { failIf: 'P\\(7,7\\)' } } } })
        let h = rsi.specHash(P(7, 7)), id = rsi.idOf(P(7, 7))
        rsi.store.pushFrontier([{ kind: 'arm', spec: P(7, 7), specHash: h, reason: '會錯', priority: 0 }])
        let row = () => rsi.store.listFrontier().find((f) => f.specHash === h)
        let e1 = await rsi.explore({})
        assert(e1.nodes.some((n) => n.id === id && n.status === 'error'))
        assert.equal(row().status, 'proposed', '未達上限 ⇒ 維持 proposed'); assert.equal(row().retries, 1)
        assert.match(row().note, /r001 評估錯誤 #1/); assert.match(row().note, /模擬評估失敗/)
        assert.equal(e1.frontierRes.retried, 1); assert.equal(e1.frontierRes.blocked, 0)
        let e2 = await rsi.explore({})
        assert(e2.items.some((it) => it.id === id), 'error 不占用 ⇒ 下一輪重提')
        assert.equal(row().status, 'blocked'); assert.equal(row().retries, 2); assert.match(row().note, /#2/); assert(row().resolvedAt)
        assert.equal(e2.frontierRes.blocked, 1)
        assert.match(fs.readFileSync(path.join(e2.fd, 'report.md'), 'utf8'), /## 前緣結案/)
        let e3 = await rsi.explore({})
        assert(!e3.items.some((it) => it.id === id), 'blocked ⇒ 不再被提')
        //成功之前緣臂照舊標 executed
        let hGood = rsi.specHash(P(6, 6))
        rsi.store.pushFrontier([{ kind: 'arm', spec: P(6, 6), specHash: hGood, reason: '好', priority: 0 }])
        await rsi.explore({})
        assert.equal(rsi.store.listFrontier().find((f) => f.specHash === hGood).status, 'executed')
    })
    it('前緣結案:後閘拒絕之前緣臂 ⇒ rejectedByGate(附理由;原標 executed);前閘拒絕(驗證不過)之前緣臂 ⇒ rejectedByGate(原維持 proposed)', async function () {
        this.timeout(60000)
        let rsi = fresh('gate', { domain: { gates: { post: (n) => (n.spec.x === 8 ? { ok: false, why: 'x=8 拒' } : { ok: true }) } } })
        rsi.store.pushFrontier([{ kind: 'arm', spec: P(8, 8), specHash: rsi.specHash(P(8, 8)), reason: 'post', priority: 0 }, { kind: 'arm', spec: P(99, 0), specHash: rsi.specHash(P(99, 0)), reason: 'pre', priority: 1 }])
        let e = await rsi.explore({})
        let f = (s) => rsi.store.listFrontier().find((r) => r.specHash === rsi.specHash(s))
        assert.equal(f(P(8, 8)).status, 'rejectedByGate'); assert.match(f(P(8, 8)).note, /x=8 拒/)
        assert.equal(f(P(99, 0)).status, 'rejectedByGate'); assert.match(f(P(99, 0)).note, /超出範圍/)
        assert.equal(e.frontierRes.rejected, 2)
    })
    it('閘門拒絕存根:不覆寫已執行節點(同 id;原料 / 輪次不變, 報告附註);未占用者照寫存根', async function () {
        this.timeout(60000)
        let gate = false
        let rsi = fresh('stub', { domain: { gates: { pre: (spec) => (gate && spec.kind === 'point' && spec.x === 0 && spec.y === 0 ? { ok: false, why: '收緊後拒' } : { ok: true }) } } })
        await rsi.explore({}) //載體 origin = P(0, 0) 已執行
        let id0 = rsi.idOf(P(0, 0))
        let before0 = rsi.store.getNode(id0)
        assert.equal(before0.status, 'executed')
        //策略重提已執行之規格(不看 ctx.executed)且前閘已收緊;另提一個會被前閘拒之新規格(未占用 ⇒ 照寫存根)
        fs.writeFileSync(path.join(rsi.paths.policies, 'vr.mjs'), "export const meta = { name: 'vr' }\nexport default function policy(view, budget, ctx) { return { expand: [], novelty: [{ spec: { kind: 'point', x: 0, y: 0 }, reason: '重提' }, { spec: { kind: 'point', x: 11, y: 11 }, reason: '新' }], notes: [] } }\n")
        fs.writeFileSync(rsi.paths.current, "export { default, meta } from './vr.mjs'\n")
        gate = true
        let e = await rsi.explore({})
        let after0 = rsi.store.getNode(id0)
        assert.equal(after0.status, 'executed', '已執行節點不被拒絕存根覆寫')
        assert.deepEqual(after0.raw, before0.raw); assert.equal(after0.round, 1)
        let rj = e.rejected.find((r) => r.id === id0)
        assert(rj && rj.stubSkipped === 'executed', JSON.stringify(e.rejected))
        assert.match(fs.readFileSync(path.join(e.fd, 'report.md'), 'utf8'), /拒絕存根未寫/)
        assert.equal(rsi.store.getNode(rsi.idOf(P(11, 11))).status, 'executed')
        let plan = JSON.parse(fs.readFileSync(path.join(e.fd, 'plan.json'), 'utf8'))
        assert.equal(plan.rejected.find((r) => r.id === id0).stubSkipped, 'executed')
    })
    it('store.putNode 之 skipIfStatus(鎖內;index 列或節點檔之狀態 ∈ 集合 ⇒ 不寫、回 null);resolveFrontier 之邊界(error 只動 proposed、maxRetries、查無列)', () => {
        let domain = toy.makeDomain()
        let paths = makePaths(path.join(t.dir, 'st')); paths.ensure()
        let store = makeStore({ paths, domain })
        store.putNode(makeNode({ id: 'e1', spec: P(1, 1), status: 'executed' }, domain))
        assert.equal(store.putNode(makeNode({ id: 'e1', spec: P(1, 1), status: 'rejectedByGate' }, domain), { skipIfStatus: OCCUPIED }), null)
        assert.equal(store.getNode('e1').status, 'executed')
        store.putNode(makeNode({ id: 'r1', spec: P(2, 2), status: 'error' }, domain))
        assert(store.putNode(makeNode({ id: 'r1', spec: P(2, 2), status: 'rejectedByGate' }, domain), { skipIfStatus: OCCUPIED }), 'error 不在 OCCUPIED ⇒ 照寫')
        assert.equal(store.getNode('r1').status, 'rejectedByGate')
        assert(store.putNode(makeNode({ id: 'n1', spec: P(3, 3), status: 'rejectedByGate' }, domain), { skipIfStatus: [...OCCUPIED] }), '不存在 ⇒ 照寫(陣列亦可)')
        assert(store.putNode(makeNode({ id: 'e1', spec: P(1, 1), status: 'executed' }, domain)), '未給 opt ⇒ 舊行為(覆寫)')
        store.pushFrontier([{ specHash: 'a', spec: P(1, 1) }, { specHash: 'b', spec: P(2, 2) }, { specHash: 'c', spec: P(3, 3), status: 'implementing' }])
        let r = store.resolveFrontier([{ specHash: 'a', status: 'error', why: 'boom' }, { specHash: 'b', status: 'executed' }, { specHash: 'c', status: 'error', why: 'x' }, { specHash: 'zz', status: 'executed' }], { maxRetries: 1, round: 3 })
        assert.deepEqual(r, { executed: 1, rejected: 0, retried: 0, blocked: 1 })
        let byH = _.keyBy(store.listFrontier(), 'specHash')
        assert.equal(byH.a.status, 'blocked'); assert.match(byH.a.note, /r003 評估錯誤 #1:boom/)
        assert.equal(byH.b.status, 'executed')
        assert.equal(byH.c.status, 'implementing', 'error 只動 proposed 之列'); assert.equal(byH.c.retries, undefined)
        assert.deepEqual(store.resolveFrontier([]), { executed: 0, rejected: 0, retried: 0, blocked: 0 })
        //frontierOutcomesOf:存根未寫之前閘拒絕不動前緣
        let outs = frontierOutcomesOf([{ spec: P(1, 1), status: 'executed' }, { spec: P(2, 2), status: 'error', notes: { error: 'e' } }], [{ spec: P(3, 3), why: 'w' }, { spec: P(4, 4), why: 'w', stubSkipped: 'executed' }])
        assert.deepEqual(outs.map((o) => o.status), ['executed', 'error', 'rejectedByGate'])
        assert.equal(outs[1].why, 'e')
    })
})
