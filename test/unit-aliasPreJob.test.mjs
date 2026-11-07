import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi, simulate, parentIdsOf, aliasPreOf, isAliasShort } from '../src/index.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//父指紋提示之派工協定(2026-09-29;評估器端之行為別名短路由領域之評估器實作, 本套件只組協定與計數)
describe('loop/explore:父指紋提示(cfg.aliasPre)與行為別名短路之計數(2026-09-29)', function () {
    let t
    before(() => { t = makeTmp('aliasPreJob') })
    after(() => { t.cleanup() })

    it('parentIdsOf / aliasPreOf(純函式):parentId(≠ root)、parents、origin.from 全收(去 root、去重);指紋 null 者略過, 全無 ⇒ null', () => {
        assert.deepEqual(parentIdsOf({ parentId: 'p1' }), ['p1'])
        assert.deepEqual(parentIdsOf({ parentId: 'root', origin: { operator: 'T.transfer', from: ['a', 'b', 'c'] } }), ['a', 'b', 'c'])
        assert.deepEqual(parentIdsOf({ parentId: 'p1', parents: ['p2', 'p1'], origin: { from: ['p2', 'root', null] } }), ['p1', 'p2'])
        assert.deepEqual(parentIdsOf({ parentId: 'root' }), [])
        assert.deepEqual(parentIdsOf(null), [])
        let fpOf = (id) => ({ a: 'fa', c: 'fc' }[id] || null)
        assert.deepEqual(aliasPreOf({ origin: { from: ['a', 'b', 'c'] } }, fpOf), { fps: [{ id: 'a', fp: 'fa' }, { id: 'c', fp: 'fc' }] })
        assert.equal(aliasPreOf({ parentId: 'b' }, fpOf), null)
        assert.equal(aliasPreOf({ parentId: 'root' }, fpOf), null)
        assert.equal(isAliasShort({ raw: { sameDose: { skipped: 'aliasPre' } } }), true)
        assert.equal(isAliasShort({ raw: { sameDose: { skipped: 'condBranch' } } }), false)
    })

    it('cfg.aliasPre:展開臂之 job 協定附 aliasPre.fps(父之指紋 = domain.fingerprint(父.raw));新區域不附;未設 ⇒ 不附;summary.nAliasShort 與報告計評估器之短路', async function () {
        this.timeout(120000)
        let seen = []
        //玩具評估器:收到 fps 且本臂指紋 ∈ fps ⇒ 標記短路(模擬領域評估器之行為別名判定)
        let evaluate = async (spec, ctx, protocol) => {
            let raw = await toy.evaluate(spec, ctx, protocol)
            let fps = _.get(protocol, 'aliasPre.fps', null)
            seen.push({ s: toy.summarize(spec), fps })
            let hit = fps && fps.find((x) => x.fp === toy.fingerprint(raw))
            return hit ? { ...raw, sameDose: { skipped: 'aliasPre', aliasOf: hit.id } } : raw
        }
        //2026-10-01:短路之判定由領域鉤子 aliasShortOf 提供(引擎不再讀領域原料之固定欄位);hook = false ⇒ 不給鉤子
        let aliasShortOf = (n) => (_.get(n, 'raw.sameDose.skipped') === 'aliasPre' ? { of: _.get(n, 'raw.sameDose.aliasOf', null), what: '玩具之虛無' } : null)
        let mk = (name, cfg = {}, { hook = true } = {}) => createRsi({ root: path.join(t.dir, name), domain: toy.makeDomain({ evaluator: { mode: 'inProcess', evaluate, createContext: toy.createContext }, ...(hook ? { aliasShortOf } : {}) }), budget: { arms: 6, novelty: 2, workers: 3 }, turning: { enabled: false }, ...cfg }).init()
        //第 2 輪之策略:對載體 origin 展開其 T.tag 子(無效變異 ⇒ 行為 = 父)與一個 P.x 子(行為不同)
        let useTagPolicy = (rsi) => {
            fs.writeFileSync(path.join(rsi.paths.policies, 'vt.mjs'), "export const meta = { name: 'vt' }\nexport default function policy(view, budget, ctx) { let p = view.nodes.find((n) => n.spec.kind === 'point' && n.spec.x === 0 && n.spec.y === 0); let kids = p ? ctx.childrenOf(p.spec).filter((k) => k.op === 'T.tag' || (k.op === 'P.x' && k.spec.x === 1)) : []; return { expand: kids.map((k) => ({ parentId: p.id, op: k.op, spec: k.spec, specHash: k.specHash, reason: k.reason })), novelty: [], notes: [] } }\n")
            fs.writeFileSync(rsi.paths.current, "export { default, meta } from './vt.mjs'\n")
        }
        let rsi = mk('on', { aliasPre: true })
        let e1 = await rsi.explore({})
        assert(seen.length && seen.every((x) => x.fps === null), '第 1 輪:新區域(載體)⇒ 不附')
        assert.equal(e1.summary.nAliasShort, 0)
        useTagPolicy(rsi)
        seen = []
        let e2 = await rsi.explore({})
        let exp = e2.items.filter((it) => it.kindOf === 'expand')
        assert.equal(exp.length, 2, JSON.stringify(exp.map((x) => x.op)))
        let par = rsi.store.getNode(exp[0].parentId)
        for (let it of exp) { assert.deepEqual(seen.find((x) => x.s === toy.summarize(it.spec)).fps, [{ id: par.id, fp: toy.fingerprint(par.raw) }], `${it.op} 附父之指紋`) }
        let tagKid = e2.nodes.find((n) => n.spec.tag), pxKid = e2.nodes.find((n) => !n.spec.tag)
        assert(isAliasShort(tagKid), '無效變異之子(本臂指紋 = 父)⇒ 短路'); assert.equal(tagKid.raw.sameDose.aliasOf, par.id)
        assert(!isAliasShort(pxKid), '行為不同之子不短路')
        assert.equal(e2.summary.nAliasShort, 1)
        let rep = fs.readFileSync(path.join(e2.fd, 'report.md'), 'utf8')
        assert(rep.includes('行為別名短路 1') && rep.includes('⇒ 略過玩具之虛無'), '報告之用語取自鉤子之 what')
        assert(rep.includes(`${tagKid.id.slice(0, 8)} ≡ ${par.id.slice(0, 8)}`), '報告列出短路之節點與其父')
        //未給鉤子:評估器照樣於原料記標記, 但引擎不讀領域原料之欄位 ⇒ 計 0(2026-10-01 起;判定權在領域)
        seen = []
        let nh = mk('noHook', { aliasPre: true }, { hook: false })
        await nh.explore({})
        useTagPolicy(nh)
        let h2 = await nh.explore({})
        assert(h2.nodes.some(isAliasShort), '評估器仍記短路標記')
        assert.equal(h2.summary.nAliasShort, 0, '無鉤子 ⇒ 不計')
        let rep0 = fs.readFileSync(path.join(h2.fd, 'report.md'), 'utf8')
        assert(rep0.includes('行為別名短路 0') && rep0.includes('⇒ 略過部分計算'), '無鉤子 ⇒ 中性用語')
        seen = []
        let off = mk('off')
        await off.explore({})
        useTagPolicy(off)
        let o2 = await off.explore({})
        assert(seen.length && seen.every((x) => x.fps === null), '未設 cfg.aliasPre ⇒ 不附')
        assert.equal(o2.summary.nAliasShort, undefined, '未設 ⇒ summary 不加欄')
        assert(!o2.nodes.some(isAliasShort))
    })

    it('做夢之成本:0 回放之節點(如已驗載體之原料複製)計 0;defaultReplays visibleMedian 時 J 為有限數(原式把 0 當缺而回字串 ⇒ NaN)', async function () {
        this.timeout(60000)
        let rsi = createRsi({ root: path.join(t.dir, 'cost0'), domain: toy.makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 } }).init()
        for (let i = 0; i < 2; i++) { await rsi.explore({}) }
        let ex = rsi.store.listIndex().filter((r) => r.status === 'executed')
        rsi.store.updateNode(ex[0].id, (n) => { n.cost = { replays: 0, wallSec: 0 } })
        let nodes = rsi.store.loadNodes()
        let env = { viewOf: rsi.view.policyViewOfNode, aliasOf: rsi.view.aliasOf, makeCtx: rsi.makeCtx }
        let all = nodes.filter((n) => n.status === 'executed' && n.score)
        let greedy = () => ({ expand: all.map((n) => ({ parentId: 'root', op: 'g', spec: n.spec, specHash: n.specHash })), novelty: [] })
        let r = simulate(greedy, nodes, env, { rounds: 1, arms: all.length, defaultReplays: 'visibleMedian' })
        assert.equal(typeof r.cost, 'number'); assert(_.isFinite(r.J), `J ${r.J}`)
        assert.equal(r.cost, _.sum(all.map((n) => n.cost.replays)), '0 回放者計 0')
        let r2 = simulate(greedy, nodes, env, { rounds: 1, arms: all.length, defaultReplays: 24 })
        assert.equal(r2.cost, r.cost, '數值 defaultReplays 亦計 0(不再以 0 為缺)')
    })
})
