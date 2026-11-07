import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi, roundDirs, STATUS } from '../src/index.mjs'
import { makeDomain, evaluate, createContext, carriers } from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


let P = (x, y) => ({ kind: 'point', x, y })

describe('loop/explore:一輪探索之全流程', function () {
    let t
    before(() => { t = makeTmp('explore') })
    after(() => { t.cleanup() })
    let fresh = (name, over = {}) => createRsi({ root: path.join(t.dir, name), domain: makeDomain(over.domain || {}), budget: { arms: 6, novelty: 2, workers: 3 }, ...(over.cfg || {}) }).init()

    it('plan.global(2026-09-27):全域臂以 kindOf global 入樹(根節點, origin.topic global、originExtra 併入);不計入新區域欠額(生成請求照常);ctxExtra 併入策略 ctx', async () => {
        let rsi = fresh('global', { domain: { ctxExtra: () => ({ sampleGlobal: (n) => _.range(n).map((i) => ({ spec: P(3 + i, 3), specHash: rsi.specHash(P(3 + i, 3)), op: 'G.sample', reason: 'g', origin: { topic: 'global', operator: 'G.sample' }, originExtra: { sampler: { mode: 'uniform', draw: i } } })) }) }, cfg: { budget: { arms: 6, novelty: 2, global: 2, workers: 3 } } })
        fs.writeFileSync(path.join(rsi.paths.policies, 'vg.mjs'), "export const meta = { name: 'vg' }\nexport default function policy(view, budget, ctx) { return { expand: [], novelty: [], global: ctx.sampleGlobal(budget.global, { round: view.round }), notes: [] } }\n")
        fs.writeFileSync(rsi.paths.current, "export { default, meta } from './vg.mjs'\n")
        let ex = await rsi.explore({ by: 'me' })
        assert.equal(ex.items.length, 2); assert(ex.items.every((it) => it.kindOf === 'global' && it.parentId === 'root'))
        for (let i of [0, 1]) {
            let n = rsi.store.getNode(rsi.idOf(P(3 + i, 3)))
            assert.equal(n.status, 'executed'); assert.equal(n.parent, 'root')
            assert.equal(n.origin.topic, 'global'); assert.equal(n.origin.operator, 'G.sample'); assert.equal(n.origin.sampler.draw, i)
        }
        let plan = JSON.parse(fs.readFileSync(path.join(ex.fd, 'plan.json'), 'utf8'))
        assert(plan.items.every((it) => it.kindOf === 'global'))
        assert.equal(ex.debt.need, 2); assert.equal(ex.debt.got, 0); assert.equal(ex.debt.debt, 2, '全域臂不抵新區域額度')
        assert(fs.existsSync(path.join(ex.fd, 'GENERATION_REQUEST.md')), '欠額 ⇒ 生成請求照常')
        assert.match(fs.readFileSync(path.join(ex.fd, 'report.md'), 'utf8'), /全域 2/)
    })
    it('乾跑:不建輪次夾、不寫節點、不認領;計畫仍可見', async () => {
        let rsi = fresh('dry')
        let ex = await rsi.explore({ dry: true })
        assert(ex.dry); assert.equal(ex.round, 1); assert.equal(ex.items.length, 2)
        assert.equal(roundDirs(rsi.paths).length, 0)
        assert.equal(rsi.store.listIndex().length, 0)
    })
    it('第一輪:輪號 r001;plan / summary / report 落地;id = idOf(spec);節點 executed 且 claim 清空', async () => {
        let rsi = fresh('one')
        let ex = await rsi.explore({ by: 'me' })
        assert.equal(ex.round, 1)
        assert(fs.existsSync(path.join(ex.fd, 'plan.json')) && fs.existsSync(path.join(ex.fd, 'summary.json')) && fs.existsSync(path.join(ex.fd, 'report.md')))
        assert.equal(ex.summary.nExecuted, 2); assert.equal(ex.summary.by, 'me')
        for (let n of ex.nodes) { assert.equal(n.id, rsi.idOf(n.spec)); assert.equal(n.status, 'executed'); assert.equal(n.claim, null); assert.equal(n.round, 1); assert.equal(n.origin.policy.name, 'v0') }
        assert.equal(rsi.store.getNode(rsi.idOf(carriers.origin)).origin.operator, 'root')
        let rep = fs.readFileSync(path.join(ex.fd, 'report.md'), 'utf8')
        assert(rep.includes('P(0,0)') && rep.includes('| train |'), '報告含領域加欄')
        //第二輪:不重提已執行;展開有父;輪號 r002
        let ex2 = await rsi.explore({})
        assert.equal(ex2.round, 2)
        let firstHashes = new Set(ex.nodes.map((n) => n.specHash))
        assert(ex2.items.every((it) => !firstHashes.has(it.specHash)))
        assert(ex2.nodes.every((n) => n.parent !== 'root'))
        assert(ex2.nodes.every((n) => _.includes(rsi.store.getNode(n.parent).children, n.id)), '父之 children 含子')
        assert.deepEqual(roundDirs(rsi.paths), ['r001', 'r002'])
    })
    it('前緣:無效規格 → rejectedByGate 節點(附理由);有效 arm 被執行並標 executed', async () => {
        let rsi = fresh('frontier')
        rsi.store.pushFrontier([{ kind: 'arm', spec: P(99, 0), specHash: rsi.specHash(P(99, 0)), reason: 'bad', priority: 1 }, { kind: 'arm', spec: P(7, 7), specHash: rsi.specHash(P(7, 7)), reason: 'good', priority: 2 }])
        let ex = await rsi.explore({})
        let rej = rsi.store.listIndex().find((r) => r.status === STATUS.REJECTED)
        assert(rej, '應有 rejectedByGate 節點'); assert.match(rsi.store.getNode(rej.id).notes.why, /超出範圍/)
        assert.equal(ex.rejected.length, 1)
        let good = rsi.store.getNode(rsi.idOf(P(7, 7)))
        assert.equal(good.status, 'executed'); assert.equal(good.origin.topic, 'policy')
        assert.equal(rsi.store.listFrontier().find((f) => f.specHash === rsi.specHash(P(7, 7))).status, 'executed')
    })
    it('評估失敗 → error 節點(附錯誤);error 不占用規格, 下輪可重提', async () => {
        let rsi = fresh('err', { domain: { evaluator: { mode: 'inProcess', evaluate, createContext, ctxOpt: { failIf: 'P\\(-15,15\\)' } } } })
        let ex = await rsi.explore({})
        assert.equal(ex.summary.nError, 1); assert.equal(ex.summary.nExecuted, 1)
        let far = rsi.store.getNode(rsi.idOf(carriers.far))
        assert.equal(far.status, 'error'); assert.match(far.notes.error, /模擬評估失敗/)
        let ex2 = await rsi.explore({})
        assert(ex2.items.some((it) => it.id === far.id), 'error 節點下輪重提')
        assert.equal(rsi.store.getNode(far.id).status, 'error')
    })
    it('post gate 拒絕 → rejectedByGate(不入已執行)', async () => {
        let rsi = fresh('post', { domain: { gates: { post: (n) => (n.score.components.train < -50 ? { ok: false, why: 'train 太低' } : { ok: true }) } } })
        let ex = await rsi.explore({})
        let far = rsi.store.getNode(rsi.idOf(carriers.far))
        assert.equal(far.status, STATUS.REJECTED); assert.equal(far.notes.why, 'train 太低')
        assert.equal(rsi.store.getNode(rsi.idOf(carriers.origin)).status, 'executed')
        assert.equal(ex.summary.nExecuted, 1)
    })
    it('評估層整體失敗:認領釋放為 stale, 例外上拋;之後可被正常實例重新認領', async () => {
        let root = path.join(t.dir, 'fail')
        let bad = createRsi({ root, domain: makeDomain({ evaluator: { mode: 'spawn', module: null } }), budget: { arms: 6, novelty: 2, workers: 2 } }).init()
        await assert.rejects(bad.explore({}), /evaluatorModule/)
        let rows = bad.store.listIndex()
        assert.equal(rows.length, 2); assert(rows.every((r) => r.status === STATUS.STALE && r.claim === null))
        let good = createRsi({ root, domain: makeDomain(), budget: { arms: 6, novelty: 2, workers: 2 } }).init()
        let ex = await good.explore({})
        assert.equal(ex.summary.nExecuted, 2); assert.equal(ex.round, 2)
        assert(good.store.listIndex().every((r) => r.status === 'executed'))
    })
    it('認領衝突(真競態):計畫算好、認領前被他 session 領走 ⇒ 以更新之已占用集合重新出計畫, 不空轉', async () => {
        //以 pre gate 注入競態:本輪計畫出來後(逐臂過閘時)才由「他 session」搶先認領全部臂
        let rsi, dry = null, raced = false
        let pre = () => { if (dry && !raced) { raced = true; rsi.store.claimNodes(dry.items.map((it) => ({ id: it.id, spec: it.spec, specHash: it.specHash, parentId: it.parentId })), { round: 99, by: 'other' }) } return { ok: true } }
        rsi = fresh('replan', { domain: { gates: { pre } } })
        await rsi.explore({})
        dry = await rsi.explore({ dry: true })
        assert(dry.items.length >= 3)
        let ex = await rsi.explore({})
        assert(raced)
        assert(ex.skipped.length >= dry.items.length, '第一次計畫全部被跳過')
        assert(ex.replans >= 1)
        assert(ex.items.length > 0 && ex.summary.nExecuted > 0, '重新出計畫後仍有臂可跑')
        let dryIds = new Set(dry.items.map((it) => it.id))
        assert(ex.items.every((it) => !dryIds.has(it.id)), '重出之臂與被領走者互斥')
        assert(dry.items.every((it) => rsi.store.getNode(it.id).claim.by === 'other'), '他 session 之認領原封不動')
    })
    it('遺留認領(死行程)於下輪開始時回收並可重提', async () => {
        let rsi = fresh('stale')
        let id = rsi.idOf(P(9, 9))
        rsi.store.claimNodes([{ id, spec: P(9, 9) }], { round: 99, by: 'ghost' })
        let n = rsi.store.getNode(id); n.claim.pid = 999999; rsi.store.putNode(n)
        let ex = await rsi.explore({})
        assert.deepEqual(ex.reclaimed, [id])
        assert.equal(rsi.store.getNode(id).status, STATUS.STALE)
        rsi.store.pushFrontier([{ kind: 'arm', spec: P(9, 9), specHash: rsi.specHash(P(9, 9)), reason: 'retry', priority: 0 }])
        let ex2 = await rsi.explore({})
        assert(ex2.nodes.some((x) => x.id === id && x.status === 'executed'))
    })
    it('載體可為函式(每次出計畫時求值;領域自既有工件自動登錄):其成員被新區域額度取用並執行', async () => {
        let calls = 0
        let rsi = fresh('carrierFn', { domain: { carriers: () => { calls++; return { dyn: P(5, 5), far: P(-15, 15) } } } })
        assert.deepEqual(_.keys(rsi.carriers()).sort(), ['dyn', 'far'])
        assert(_.has(rsi.makeCtx().carriers, 'dyn'))
        let ex = await rsi.explore({})
        assert(calls >= 3, '每次 makeCtx 皆重新求值')
        let dyn = rsi.store.getNode(rsi.idOf(P(5, 5)))
        assert(dyn && dyn.status === 'executed' && dyn.origin.operator === 'root', '函式載體之成員作為新區域根被執行')
        assert.equal(ex.summary.nExecuted, 2)
        //非物件回傳 ⇒ 視為無載體(不拋錯)
        let r0 = fresh('carrierBad', { domain: { carriers: () => null } })
        assert.deepEqual(r0.carriers(), {})
    })
})
