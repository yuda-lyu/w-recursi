import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import _ from 'lodash-es'
import { createRsi, extractTurning, makeRegistry, specHash } from '../src/index.mjs'
import { reportOf } from '../src/loop/report.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//轉折點提取之三種提案之產生端守門(2026-10-04;search/turning.mjs 之 opt.proposalBlock)
//  情境 SCN(玩具領域;與夾具 fixtures/turnGenOldSnapshot.json 之擷取同):a0 → a(P.x +2)、a0 → b(P.y −2)、p1 → c1(P.x +2)、p2 / p3 為他父;搬移相容鉤子擋目標父 y > 4
//  PB01 未給 / null ⇒ 回傳與改前逐字同(JSON 快照;無 nProposalBlocked);回 null 之鉤子 ⇒ 提案 / blocked 逐字同, 另帶 nProposalBlocked 0
//  PB02 三分支皆呼叫;ctx 之 op / origin / byId / parent / parents / kidOp
//  PB03 擋下者入 blocked(by proposalBlock、from = origin.from)、計 nProposalBlocked;不入去重集 ⇒ 同規格經他路徑(交叉)照提;搬移相容鉤子之列不變
//  PB04 次序:normSpec → 已占用 / 已提 → validateSpec → 鉤子(已占用、正規化後 = 已占用、不合法者皆不問鉤子)
//  PB05 報告:兩種擋下分列;無守門之列時「轉折點提取」段與改前逐字同(快照);外推之列(from 兩節點)照列
//  PB06 createRsi().turning 與 explore 皆傳 domain.proposalBlock(玩具:擋全部外推 ⇒ 前緣無 T.extrapolate、報告列守門行);opt 覆寫 proposalBlock: null ⇒ 舊行為
const FX = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'turnGenOldSnapshot.json'), 'utf8'))
let P = (x, y) => ({ kind: 'point', x, y })
let reg = makeRegistry({ operators: toy.operators, validateSpec: toy.validateSpec, familyRank: toy.familyRank })
let N = (id, spec, S, { parent = 'root', op = null, ladder = 1, round = 1 } = {}) => ({ id, parent, round, status: 'executed', spec, specHash: specHash(spec), origin: { operator: op }, children: [], aliasOf: null, score: { S, ladder, flags: { vetoed: false } } })
let scenario = () => {
    let a0 = N('a0', P(0, 0), 50), a = N('a', P(2, 0), 70, { parent: 'a0', op: 'P.x' }), b = N('b', P(0, -2), 75, { parent: 'a0', op: 'P.y' })
    let p1 = N('p1', P(-6, 0), 80), c1 = N('c1', P(-4, 0), 90, { parent: 'p1', op: 'P.x' }), p2 = N('p2', P(-6, -4), 85), p3 = N('p3', P(-6, 6), 84)
    return [a0, a, b, p1, c1, p2, p3]
}
let tb = (ctx) => (ctx.to.spec.y > 4 ? '目標父 y > 4' : null)
let base = (extra = {}) => ({ registry: reg, validateSpec: toy.validateSpec, transferBlock: tb, topParents: 8, ...extra })
let sec = (s, head) => { let i = s.indexOf(head); if (i < 0) { return null } let j = s.indexOf('\n## ', i + head.length); return s.slice(i, j < 0 ? s.length : j) }
let rsiStub = () => ({ domain: toy.makeDomain(), cfg: {}, store: { getNode: () => null } })

describe('search/turning:三種提案之產生端守門 proposalBlock(2026-10-04)', function () {
    it('PB01 未給 / null ⇒ 回傳與改前逐字同;回 null 之鉤子 ⇒ 提案與 blocked 逐字同, 另帶 nProposalBlocked 0', () => {
        let t0 = extractTurning(scenario(), base())
        assert.equal(JSON.stringify(t0), FX.turningJson, '未給 ⇒ 與改前之回傳 JSON 逐字同')
        assert.ok(!('nProposalBlocked' in t0))
        assert.equal(JSON.stringify(extractTurning(scenario(), base({ proposalBlock: null }))), FX.turningJson, 'null ⇒ 未給')
        let t1 = extractTurning(scenario(), base({ proposalBlock: () => null }))
        assert.equal(t1.nProposalBlocked, 0)
        assert.equal(JSON.stringify(_.omit(t1, ['nProposalBlocked'])), FX.turningJson, '回 null 之鉤子 ⇒ 其餘逐字同')
    })
    it('PB02 三分支皆呼叫;ctx 之 op / origin / byId / parent / parents / kidOp', () => {
        let seen = []
        extractTurning(scenario(), base({ proposalBlock: (spec, ctx) => { seen.push({ spec, ctx }); return ctx.op === 'T.transfer' && _.isEqual(spec, P(2, -2)) ? '擋搬移之 P(2,-2)' : null } }))
        let byOp = _.groupBy(seen, (x) => x.ctx.op)
        assert.deepEqual(_.sortBy(_.keys(byOp)), ['T.crossover', 'T.extrapolate', 'T.transfer'], JSON.stringify(_.mapValues(byOp, (v) => v.length)))
        for (let { spec, ctx } of seen) {
            assert.equal(ctx.op, ctx.origin.operator)
            assert.ok(ctx.byId instanceof Map && ctx.byId.size === 7 && ctx.byId.get('a0').id === 'a0', 'byId = 本次提取之已執行節點')
            assert.deepEqual(ctx.parents.map((n) => n.id), ctx.origin.from, 'parents = origin.from 之節點(同序)')
            assert.doesNotThrow(() => toy.validateSpec(spec), '鉤子收到之規格已過 validateSpec')
        }
        for (let { ctx } of byOp['T.transfer']) { assert.equal(ctx.parent.id, ctx.origin.from[2], '搬移之 parent = 目標父'); assert.equal(ctx.kidOp, ctx.origin.op) }
        for (let { ctx } of byOp['T.extrapolate']) { assert.equal(ctx.parent.id, ctx.origin.from[1], '外推之 parent = 邊之子'); assert.equal(ctx.kidOp, ctx.byId.get(ctx.origin.from[1]).origin.operator, 'kidOp = 邊之算子') }
        for (let { ctx } of byOp['T.crossover']) { assert.ok(!('parent' in ctx) && !('kidOp' in ctx)); assert.equal(ctx.parents.length, 3) }
    })
    it('PB03 擋下者入 blocked(by proposalBlock)、計 nProposalBlocked;不入去重集 ⇒ 同規格經交叉照提;搬移相容鉤子之列不變', () => {
        let t = extractTurning(scenario(), base({ proposalBlock: (spec, ctx) => (ctx.op === 'T.transfer' && _.isEqual(spec, P(2, -2)) ? '擋搬移之 P(2,-2)' : null) }))
        let pb = t.blocked.filter((b) => b.by === 'proposalBlock')
        assert.deepEqual(pb, [{ op: 'T.transfer', params: { y: -2 }, from: ['a0', 'b', 'a'], specHash: specHash(P(2, -2)), why: '擋搬移之 P(2,-2)', by: 'proposalBlock' }], '同規格之第二條搬移路徑不重列')
        assert.equal(t.nProposalBlocked, 1); assert.equal(t.nBlocked, 2)
        assert.ok(!t.proposals.some((x) => x.origin.operator === 'T.transfer' && _.isEqual(x.spec, P(2, -2))))
        assert.deepEqual(t.proposals.filter((x) => x.origin.operator === 'T.crossover').map((x) => [x.spec, x.origin.from]), [[P(2, -2), ['a0', 'b', 'a']]], '不入去重集 ⇒ 交叉照提(ctx 不同)')
        assert.deepEqual(t.blocked.filter((b) => b.by !== 'proposalBlock'), JSON.parse(FX.turningJson).blocked, '搬移相容鉤子之列逐字同')
        //外推之擋下:from 兩節點
        let t2 = extractTurning(scenario(), base({ proposalBlock: (spec, ctx) => (ctx.op === 'T.extrapolate' && spec.x === 4 ? '外推越域' : null) }))
        assert.deepEqual(t2.blocked.filter((b) => b.by === 'proposalBlock'), [{ op: 'T.extrapolate', params: null, from: ['a0', 'a'], specHash: specHash(P(4, 0)), why: '外推越域', by: 'proposalBlock' }])
        assert.ok(!t2.proposals.some((x) => _.isEqual(x.spec, P(4, 0))))
        assert.deepEqual(_.sortBy(t2.proposals.map((x) => x.specHash)), _.sortBy(JSON.parse(FX.turningJson).proposals.map((x) => x.specHash).filter((h) => h !== specHash(P(4, 0)))), '其餘提案不變')
    })
    it('PB04 次序:已占用 / 正規化後已占用 / validateSpec 不過者不問鉤子', () => {
        let calls = []
        let hook = (s) => { calls.push(s); return null }
        let extra = [N('q1', P(18, 0), 60), N('q2', P(20, 0), 70, { parent: 'q1', op: 'P.x' })]
        extractTurning([...scenario(), ...extra], base({ occupied: new Set([specHash(P(4, 0))]), proposalBlock: hook }))
        assert.ok(calls.length > 0)
        assert.ok(!calls.some((s) => _.isEqual(s, P(4, 0))), '已占用者不問鉤子')
        assert.ok(!calls.some((s) => s.x > 20), 'validateSpec 不過者(22)不問鉤子')
        //normSpec:外推 P(20, 0) 正規化為 P(10, 0) = 子(已執行)⇒ 不問鉤子
        let calls2 = []
        let clamp = (s) => (s && s.kind === 'point' && s.x > 10 ? { ...s, x: 10 } : s)
        extractTurning([N('p', P(0, 0), 60), N('c', P(10, 0), 70, { parent: 'p', op: 'P.x' })], { registry: reg, validateSpec: toy.validateSpec, normSpec: clamp, proposalBlock: (s, ctx) => { calls2.push([ctx.op, s]); return null } })
        assert.ok(!calls2.some(([op, s]) => op === 'T.extrapolate'), JSON.stringify(calls2))
    })
    it('PB05 報告:無守門之列 ⇒「轉折點提取」段與改前逐字同;有之 ⇒ 兩種擋下分列(外推之列 from 兩節點)', () => {
        let r0 = reportOf(rsiStub(), 1, { expand: [], novelty: [] }, [], [], { turning: extractTurning(scenario(), base()) })
        assert.equal(sec(r0, '## 轉折點提取'), FX.turningReportSection)
        let r0b = reportOf(rsiStub(), 1, { expand: [], novelty: [] }, [], [], { turning: extractTurning(scenario(), base({ proposalBlock: () => null })) })
        assert.equal(sec(r0b, '## 轉折點提取'), FX.turningReportSection, '鉤子回 null ⇒ 同')
        let t = extractTurning(scenario(), base({ proposalBlock: (spec, ctx) => (ctx.op === 'T.extrapolate' && spec.x === 4 ? '外推越域' : null) }))
        let s1 = sec(reportOf(rsiStub(), 1, { expand: [], novelty: [] }, [], [], { turning: t }), '## 轉折點提取')
        assert.match(s1, /^- 搬移相容鉤子擋下 1:P\.x \{"x":-4\} p1 ⇒ p3\(目標父 y > 4\)$/m)
        assert.match(s1, /^- 產生端守門\(proposalBlock\)擋下 1:\[T\.extrapolate\] a0 → a\(外推越域\)$/m)
        //只有守門之列(無搬移相容鉤子之列)⇒ 不出「搬移相容鉤子擋下」行
        let t2 = extractTurning(scenario(), base({ transferBlock: () => null, proposalBlock: (spec, ctx) => (ctx.op === 'T.extrapolate' ? '一律擋外推' : null) }))
        let s2 = sec(reportOf(rsiStub(), 1, { expand: [], novelty: [] }, [], [], { turning: t2 }), '## 轉折點提取')
        assert.doesNotMatch(s2, /搬移相容鉤子擋下/)
        assert.match(s2, /^- 產生端守門\(proposalBlock\)擋下 3:/m)
    })
    it('PB06 createRsi().turning 與 explore 皆傳 domain.proposalBlock;opt 覆寫 null ⇒ 舊行為', async function () {
        this.timeout(120000)
        let t = makeTmp('proposalBlock')
        try {
            let rsi = createRsi({ root: t.dir, domain: toy.makeDomain({ proposalBlock: (spec, ctx) => (ctx.op === 'T.extrapolate' ? '玩具:不外推' : null) }), budget: { arms: 8, novelty: 3, workers: 4 }, turning: { minGain: 0.01 } }).init()
            let exs = []
            for (let i = 0; i < 3; i++) { exs.push(await rsi.explore({})) }
            assert.ok(!rsi.store.listFrontier().some((f) => _.get(f, 'origin.operator') === 'T.extrapolate'), 'explore 傳鉤子 ⇒ 前緣無外推臂')
            let off = rsi.turning({ proposalBlock: null })
            let on = rsi.turning({})
            let exOff = off.proposals.filter((x) => x.origin.operator === 'T.extrapolate')
            assert.ok(exOff.length >= 1, `情境須有外推提案(無鉤子):${off.proposals.length} 提案`)
            assert.ok(!('nProposalBlocked' in off), 'opt 覆寫 null ⇒ 舊行為之回傳')
            assert.equal(on.proposals.filter((x) => x.origin.operator === 'T.extrapolate').length, 0, 'createRsi().turning 傳鉤子')
            assert.ok(on.nProposalBlocked >= exOff.length)
            assert.ok(exOff.every((x) => on.blocked.some((b) => b.by === 'proposalBlock' && b.specHash === x.specHash) || on.nBlocked > 10), '被擋之外推皆列於 blocked')
            //報告:有守門之列之輪 ⇒ 報告列守門行
            let withPb = exs.filter((e) => e.turning && e.turning.nProposalBlocked > 0)
            assert.ok(withPb.length >= 1, '三輪中須有守門擋下之輪')
            for (let e of withPb) { assert.match(fs.readFileSync(path.join(e.fd, 'report.md'), 'utf8'), /- 產生端守門\(proposalBlock\)擋下 \d+:\[T\.extrapolate\] /) }
        }
        finally { t.cleanup() }
    })
})
