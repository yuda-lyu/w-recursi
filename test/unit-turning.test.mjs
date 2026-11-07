import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi, specDiff, applyDiff, extractTurning, noveltyDebtOf, makeRegistry, specHash } from '../src/index.mjs'
import { readJson } from '../src/core/jsonl.mjs'
import { isGenerationFulfilled } from '../src/loop/generation.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


let P = (x, y) => ({ kind: 'point', x, y })
let reg = makeRegistry({ operators: toy.operators, validateSpec: toy.validateSpec, familyRank: toy.familyRank })
let N = (id, spec, S, { parent = 'root', op = null, ladder = 1, vetoed = false, round = 1 } = {}) => ({ id, parent, round, status: 'executed', spec, specHash: specHash(spec), origin: { operator: op }, children: [], aliasOf: null, score: { S, ladder, flags: { vetoed } } })

describe('search/turning + loop/generation:轉折點提取與欠額觸發生成', function () {
    it('specDiff / applyDiff:葉層差異與套用(含巢狀、刪除)', () => {
        let a = { kind: 'point', x: 1, y: 2, o: { t: 0.25, g: 9 } }, b = { kind: 'point', x: 3, y: 2, o: { t: 0.25 } }
        let d = specDiff(a, b)
        assert.deepEqual(_.sortBy(d, 'path'), [{ path: 'o.g', from: 9, to: undefined }, { path: 'x', from: 1, to: 3 }])
        assert.deepEqual(applyDiff(a, d), b)
    })
    it('① 搬移:某算子在父上有效 ⇒ 對其他高分父施同一算子同一參數', () => {
        let p1 = N('p1', P(0, 0), 80), c1 = N('c1', P(2, 0), 90, { parent: 'p1', op: 'P.x' }), p2 = N('p2', P(0, -4), 85)
        let t = extractTurning([p1, c1, p2], { registry: reg, validateSpec: toy.validateSpec })
        let tr = t.proposals.filter((x) => x.origin.operator === 'T.transfer')
        assert(tr.length >= 1, JSON.stringify(t))
        assert(tr.some((x) => _.isEqual(x.spec, P(2, -4))), '對 p2 施 x+2')
        assert.deepEqual(tr[0].origin.params, { x: 2 })
        assert.equal(t.nProductive, 1)
    })
    it('② 外推:單一數值路徑之改變且子更好 ⇒ 同方向再走一步;超出範圍者由 validateSpec 擋', () => {
        let p = N('p', P(0, 0), 60), c = N('c', P(2, 0), 70, { parent: 'p', op: 'P.x' })
        let t = extractTurning([p, c], { registry: reg, validateSpec: toy.validateSpec })
        let ex = t.proposals.find((x) => x.origin.operator === 'T.extrapolate')
        assert(ex && _.isEqual(ex.spec, P(4, 0)), JSON.stringify(t.proposals))
        assert.equal(ex.origin.path, 'x'); assert.equal(ex.origin.step, 2)
        let p2 = N('p2', P(18, 0), 60), c2 = N('c2', P(20, 0), 70, { parent: 'p2', op: 'P.x' })
        let t2 = extractTurning([p2, c2], { registry: reg, validateSpec: toy.validateSpec })
        assert(!t2.proposals.some((x) => x.origin.operator === 'T.extrapolate'), '外推到 22 超出 ±20, 應被擋')
    })
    it('③ 交叉:兩高分節點相對共同祖先之差異在不同路徑 ⇒ 合併;同路徑則不合併;搬移已提同規格時交叉去重', () => {
        //子節點無 origin.operator(如人工 / 回填之臂)⇒ 搬移與外推無從施力, 只有交叉
        let a0 = N('a0', P(0, 0), 50), a = N('a', P(2, 0), 70, { parent: 'a0' }), b = N('b', P(0, -2), 75, { parent: 'a0' })
        let t = extractTurning([a0, a, b], { registry: reg, validateSpec: toy.validateSpec })
        let cr = t.proposals.find((x) => x.origin.operator === 'T.crossover')
        assert(cr && _.isEqual(cr.spec, P(2, -2)), JSON.stringify(t.proposals))
        assert.deepEqual(cr.origin.from, ['a0', 'b', 'a'])
        let c = N('c', P(1, 0), 72, { parent: 'a0' })
        let t2 = extractTurning([a0, a, c], { registry: reg, validateSpec: toy.validateSpec })
        assert(!t2.proposals.some((x) => x.origin.operator === 'T.crossover'), '同路徑 x 之差異不交叉')
        //同一規格若已由搬移提出, 交叉不重複(以 specHash 去重)
        let a2 = N('a', P(2, 0), 70, { parent: 'a0', op: 'P.x' }), b2 = N('b', P(0, -2), 75, { parent: 'a0', op: 'P.y' })
        let t3 = extractTurning([a0, a2, b2], { registry: reg, validateSpec: toy.validateSpec })
        assert.equal(t3.proposals.filter((x) => _.isEqual(x.spec, P(2, -2))).length, 1)
    })
    it('normSpec 鉤子(2026-09-30):提案先正規化再判占用 —— 外推越過領域哨兵之子與已在樹之規格同一 ⇒ 不提;未給鉤子逐字不變', () => {
        let p = N('p', P(0, 0), 60), c = N('c', P(10, 0), 70, { parent: 'p', op: 'P.x' })
        let clamp = (s) => (s && s.kind === 'point' && s.x > 10 ? { ...s, x: 10 } : s)
        let t0 = extractTurning([p, c], { registry: reg, validateSpec: toy.validateSpec })
        assert(t0.proposals.some((x) => x.origin.operator === 'T.extrapolate' && _.isEqual(x.spec, P(20, 0))), '無鉤子 ⇒ 外推至 20')
        let t1 = extractTurning([p, c], { registry: reg, validateSpec: toy.validateSpec, normSpec: clamp })
        assert(!t1.proposals.some((x) => x.origin.operator === 'T.extrapolate'), '有鉤子 ⇒ 20 正規化為 10 = c(已占用)⇒ 不提')
    })
    it('已占用規格不提;別名 / excludeParent / parentOk 不過之節點不作來源;否決旗標不再篩(2026-09-27);負向轉折列入 avoid', () => {
        let p = N('p', P(0, 0), 60), c = N('c', P(2, 0), 70, { parent: 'p', op: 'P.x' }), bad = N('bad', P(-2, 0), 10, { parent: 'p', op: 'P.x' })
        let t = extractTurning([p, c, bad], { registry: reg, validateSpec: toy.validateSpec, occupied: new Set([specHash(P(4, 0))]) })
        assert(!t.proposals.some((x) => _.isEqual(x.spec, P(4, 0))))
        assert(t.avoid.some((a) => a.childId === 'bad'))
        //2026-09-27:留出段只作否決, 不擇優 ⇒ 引擎不讀 score.flags.vetoed(領域之視圖本不給旗標);視圖之父條件改由 parentOk(領域:如只取某類節點)
        let cv = N('cv', P(2, 0), 70, { parent: 'p', op: 'P.x', vetoed: true })
        assert.equal(extractTurning([p, cv], { registry: reg, validateSpec: toy.validateSpec }).nProductive, 1, '否決旗標不再篩來源邊')
        assert.equal(extractTurning([p, cv], { registry: reg, validateSpec: toy.validateSpec, parentOk: (n) => n.id !== 'cv' }).nProductive, 0, 'parentOk 不過之子不作有效邊')
        assert.equal(extractTurning([p, c], { registry: reg, validateSpec: toy.validateSpec, excludeParent: () => true }).proposals.filter((x) => x.origin.operator === 'T.transfer').length, 0)
    })
    it('① 搬移之相容鉤子 transferBlock:擋下者不提案、列於 blocked(附理由);未給鉤子或回 null 時與原行為逐字相同;交叉 / 外推不受影響', () => {
        let p1 = N('p1', P(0, 0), 80), c1 = N('c1', P(2, 0), 90, { parent: 'p1', op: 'P.x' }), p2 = N('p2', P(0, -4), 85), p3 = N('p3', P(0, 6), 84)
        let base = extractTurning([p1, c1, p2, p3], { registry: reg, validateSpec: toy.validateSpec })
        let trOf = (t) => t.proposals.filter((x) => x.origin.operator === 'T.transfer').map((x) => x.spec)
        assert.deepEqual(_.sortBy(trOf(base), 'y'), [P(2, -4), P(2, 6)])
        assert.equal(base.nBlocked, 0); assert.deepEqual(base.blocked, [])
        //回 null 之鉤子 ⇒ 提案逐字相同
        let same = extractTurning([p1, c1, p2, p3], { registry: reg, validateSpec: toy.validateSpec, transferBlock: () => null })
        assert.deepEqual(same.proposals, base.proposals)
        //鉤子收到之 ctx:來源父 / 子 / 目標父為節點、spec 為欲提之子規格;擋 y < 0 之目標父
        let seen = []
        let t = extractTurning([p1, c1, p2, p3], { registry: reg, validateSpec: toy.validateSpec, transferBlock: (ctx) => { seen.push(ctx); return ctx.to.spec.y < 0 ? '目標父 y < 0' : null } })
        assert.deepEqual(trOf(t), [P(2, 6)])
        assert.equal(t.nBlocked, 1)
        assert.deepEqual(t.blocked[0], { op: 'P.x', params: { x: 2 }, from: ['p1', 'c1', 'p2'], specHash: specHash(P(2, -4)), why: '目標父 y < 0' })
        assert(seen.every((x) => x.from.id === 'p1' && x.child.id === 'c1' && ['p2', 'p3'].includes(x.to.id) && x.op === 'P.x' && _.isEqual(x.params, { x: 2 })))
        //ctx.byId(2026-09-25):本次提取之已執行節點 Map, 供領域查目標父之譜系
        assert(seen.every((x) => x.byId instanceof Map && x.byId.get('p1') === p1 && x.byId.get('p2') === p2 && x.byId.size === 4))
        assert(seen.some((x) => _.isEqual(x.spec, P(2, -4))))
        //已占用之規格不問鉤子、不計入 blocked
        let t2 = extractTurning([p1, c1, p2, p3], { registry: reg, validateSpec: toy.validateSpec, occupied: new Set([specHash(P(2, -4))]), transferBlock: () => '一律擋' })
        assert.equal(t2.nBlocked, 1)
        assert.deepEqual(t2.blocked.map((b) => b.from[2]), ['p3'])
        //外推不經鉤子(同一組節點:c1 之外推 P(4, 0) 仍在)
        assert(t2.proposals.some((x) => x.origin.operator === 'T.extrapolate' && _.isEqual(x.spec, P(4, 0))))
    })
    it('整合:探索數輪後前緣出現 turning 臂, 且被策略之新區域額度取用(origin.topic = turning)', async function () {
        this.timeout(120000)
        let t = makeTmp('turning')
        try {
            let rsi = createRsi({ root: t.dir, domain: toy.makeDomain(), budget: { arms: 8, novelty: 3, workers: 4 }, turning: { minGain: 0.01 } }).init()
            for (let i = 0; i < 3; i++) { await rsi.explore({}) }
            let fr = rsi.store.listFrontier().filter((f) => _.get(f, 'origin.topic') === 'turning')
            assert(fr.length >= 1, '前緣應有轉折點提案')
            let ex = await rsi.explore({})
            assert(ex.turning && ex.turning.nEdges > 0)
            let used = ex.nodes.filter((n) => _.get(n, 'origin.topic') === 'turning')
            assert(used.length >= 1 || fr.every((f) => f.status !== 'proposed'), '轉折點臂被新區域額度取用')
            let rep = fs.readFileSync(path.join(ex.fd, 'report.md'), 'utf8')
            assert(rep.includes('轉折點提取') && rep.includes('新區域額度'))
            let dry = await rsi.explore({ dry: true })
            assert(dry.turning && Array.isArray(dry.turning.proposals), '乾跑亦回提案(不寫前緣)')
        }
        finally { t.cleanup() }
    })
    it('欠額觸發生成:新區域填不滿 ⇒ 寫 GENERATION_REQUEST 全域一份;生成節點入樹後清除', async function () {
        this.timeout(120000)
        let t = makeTmp('gen')
        try {
            let rsi = createRsi({ root: t.dir, domain: toy.makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 }, turning: { enabled: false } }).init()
            let e1 = await rsi.explore({})
            assert.equal(e1.debt.debt, 0, '冷啟動是播種, 不算欠額')
            assert(e1.debt.coldStart)
            let e2 = await rsi.explore({})
            assert.equal(e2.debt.need, 2); assert.equal(e2.debt.got, 0); assert.equal(e2.debt.debt, 2)
            assert(e2.generation && e2.generation.fp && fs.existsSync(e2.generation.fp), '應寫生成請求')
            assert(fs.existsSync(rsi.paths.genRequest))
            assert.equal(readJson(path.join(e2.fd, 'summary.json')).noveltyDebt, 2)
            let e3 = await rsi.explore({})
            assert(e3.generation && !e3.generation.fp && /已有生成請求/.test(e3.generation.why), '全域只留一份')
            assert(fs.readFileSync(path.join(e2.fd, 'GENERATION_REQUEST.md'), 'utf8').includes('至少一個'))
            //生成兌現:以 origin.topic = generated 之前緣臂入樹 ⇒ 清除標記
            rsi.store.pushFrontier([{ kind: 'arm', spec: P(9, -9), specHash: specHash(P(9, -9)), reason: 'gen', priority: 0, origin: { topic: 'generated', operator: 'G.new' } }])
            let e4 = await rsi.explore({})
            assert(e4.nodes.some((n) => _.get(n, 'origin.topic') === 'generated'))
            assert(!fs.existsSync(rsi.paths.genRequest), '生成兌現後清除')
        }
        finally { t.cleanup() }
    })
    it('isGenerationFulfilled:generated 臂或經新區域之 operator 臂 ⇒ 兌現;operator kind 之父被參數型展開(kindOf expand)⇒ 不兌現(2026-09-27)', () => {
        let op = (id) => ({ id, spec: { kind: 'operator', module: 'blendPools' }, origin: { topic: 'policy', operator: 'H.dayCap' } })
        assert.equal(isGenerationFulfilled([op('a')], new Map([['a', 'expand']])), false, '配比父之參數型展開不算生成')
        assert.equal(isGenerationFulfilled([op('b')], new Map([['b', 'novelty']])), true, '經新區域之 operator 臂算生成')
        assert.equal(isGenerationFulfilled([op('c')]), true, '查無計畫項 ⇒ 舊行為(算)')
        assert.equal(isGenerationFulfilled([{ id: 'd', spec: { kind: 'mech' }, origin: { topic: 'generated' } }], new Map([['d', 'novelty']])), true)
        assert.equal(isGenerationFulfilled([{ id: 'e', spec: { kind: 'mech' }, origin: { topic: 'policy' } }], new Map([['e', 'expand']])), false)
        assert.equal(isGenerationFulfilled([]), false)
    })
    it('noveltyDebtOf:冷啟動不算欠額, 否則以 novelty 計', () => {
        assert.deepEqual(noveltyDebtOf({ expand: [], novelty: [{}, {}], notes: ['冷啟動:…'] }, { arms: 6, novelty: 2 }), { need: 2, got: 2, debt: 0, coldStart: true, fromFrontier: 0 })
        assert.deepEqual(noveltyDebtOf({ expand: [{}], novelty: [], notes: [] }, { arms: 6, novelty: 2 }), { need: 2, got: 0, debt: 2, coldStart: false, fromFrontier: 0 })
        assert.deepEqual(noveltyDebtOf({ expand: [{}], novelty: [{}], notes: [] }, { arms: 6, novelty: 2 }), { need: 2, got: 1, debt: 1, coldStart: false, fromFrontier: 0 })
        //前緣提案被展開先取走仍算兌現
        assert.deepEqual(noveltyDebtOf({ expand: [{ specHash: 'h1' }, { specHash: 'h9' }], novelty: [], notes: [] }, { arms: 6, novelty: 2 }, new Set(['h1'])), { need: 2, got: 1, debt: 1, coldStart: false, fromFrontier: 1 })
    })
})
