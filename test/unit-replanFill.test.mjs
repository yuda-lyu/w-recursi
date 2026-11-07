import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi } from '../src/index.mjs'
import { replanFillOf } from '../src/loop/explore.mjs'
import { readJson } from '../src/core/jsonl.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//認領衝突之重計畫只補被他 session 先領之額(2026-10-02;loop/explore.mjs 之 cfg.claims.replanFillOnly 與純函式 replanFillOf)
//  為何:重計畫之策略依整份預算重出計畫, 舊行為新臂全收 ⇒ 實計畫臂數 = 已認領 + 整份新計畫(某些輪超出預算 2 ~ 4 臂, 各流額比失真);
//    plan.json 之策略備註只取第一次計畫 ⇒ 有重計畫之輪, 報告所讀之備註(如領域之族分布)不含重計畫之臂
//  RF01 replanFillOf(純函式):先補各流之缺、再依原序補足;總數已足 ⇒ [];新臂不足 ⇒ 全收
//  RF02 / RF03 固定策略之真競態(r001;空樹):第一次計畫 = 新區域 n1 n2 + 全域 g1 ~ g4(6 臂 = 預算);他 session 於過閘時先領 g1 g2
//    ⇒ 重計畫之新臂 = n3 n4 g5 ~ g8(整份 6 臂);opt 開 ⇒ 只補 2 臂且補全域(g5 g6;依原序會補 n3 n4)⇒ 實得 6、組成同第一次計畫;opt 關 ⇒ 新臂全收(實得 10)
//    r002(無競態)⇒ 無重計畫:plan.json 無 notesReplans / replanFillOnly、報告無重計畫行
//  RF04 reportExtra 之第三參數(items = 實得之計畫項、getNode 讀樹)—— explore 之報告與 auto 之重繪皆傳
let P = (x, y) => ({ kind: 'point', x, y })
const NOV = _.range(1, 9).map((y) => P(1, y))
const GLO = _.range(1, 13).map((y) => P(2, y))
//固定策略:新區域取 NOV 之前 2 個未占用者、全域取 GLO 之前(預算 − 2)個未占用者(ctx.executed = 已執行 ∪ 本輪已占用;重計畫時含被領走者與本 session 已認領者)
const POLICY = `export const meta = { name: 'fixedRF', version: '0' }
const NOV = ${JSON.stringify(NOV)}
const GLO = ${JSON.stringify(GLO)}
export default function policy(view, budget, ctx) {
    let free = (xs) => xs.filter((s) => !ctx.executed.has(ctx.specHash(s)))
    let nov = free(NOV).slice(0, 2), glo = free(GLO).slice(0, budget.arms - 2)
    return { round: view.round, expand: [], novelty: nov.map((spec) => ({ spec, reason: 'nov' })), global: glo.map((spec) => ({ spec, reason: 'glo' })), requests: [], stop: [], notes: ['fixedRF ' + (nov.length + glo.length) + ' 臂'] }
}
`
describe('loop/explore:認領衝突之重計畫只補被先領之額(cfg.claims.replanFillOnly)', function () {
    let t
    before(() => { t = makeTmp('replanFill') })
    after(() => { t.cleanup() })

    it('RF01 replanFillOf:先補各流之缺、再依原序補足;總數已足 ⇒ [];新臂不足 ⇒ 全收', () => {
        let it = (id, kindOf) => ({ id, kindOf })
        let target = [it('e1', 'expand'), it('e2', 'expand'), it('n1', 'novelty'), it('n2', 'novelty'), it('g1', 'global'), it('g2', 'global')]
        let got = [it('e1', 'expand'), it('g1', 'global')]
        //缺:展開 1、新區域 2、全域 1;新臂之原序 e3 e4 e5 n3 g3 g4 ⇒ 先依流:e3(展開)、n3(新區域;只有 1 個)、g3(全域)⇒ 3 臂, 再依原序補 e4
        let fresh = [it('e3', 'expand'), it('e4', 'expand'), it('e5', 'expand'), it('n3', 'novelty'), it('g3', 'global'), it('g4', 'global')]
        assert.deepEqual(replanFillOf(fresh, target, got).map((x) => x.id), ['e3', 'e4', 'n3', 'g3'], '依流補足後依原序補;輸出保持新計畫之原序')
        //被領走者全為全域 ⇒ 只補全域(原序在前之展開 / 新區域不取)
        let got2 = target.filter((x) => x.kindOf !== 'global')
        assert.deepEqual(replanFillOf(fresh, target, got2).map((x) => x.id), ['g3', 'g4'])
        assert.deepEqual(replanFillOf(fresh, target, target), [], '總數已足 ⇒ []')
        assert.deepEqual(replanFillOf([it('x', 'global')], target, got2).map((x) => x.id), ['x'], '新臂不足 ⇒ 全收')
        assert.deepEqual(replanFillOf([], target, got), [])
        //已得之某流多於目標(前次補額以他流代補)⇒ 該流不再補, 其餘流照缺補
        let got3 = [it('e1', 'expand'), it('e2', 'expand'), it('e9', 'expand'), it('n1', 'novelty')]
        assert.deepEqual(replanFillOf(fresh, target, got3).map((x) => x.id), ['n3', 'g3'])
    })

    let scenario = async (name, { fill = undefined, auto = false } = {}) => {
        let rsi, armed = false, raced = 0, rx = []
        //競態:r001 之第一次計畫逐臂過前置閘時, 他 session 先領 g1 g2(第一次計畫之全域之首 2 臂;空樹故確定)
        let pre = () => {
            if (armed && !raced) { raced++; rsi.store.claimNodes(GLO.slice(0, 2).map((s) => ({ id: rsi.idOf(s), spec: s, specHash: rsi.specHash(s), parentId: 'root' })), { round: 99, by: 'other' }) }
            return { ok: true }
        }
        let reportExtra = (nodes, plan, x) => { rx.push({ round: plan.round, x }); return ['## RX', `- items ${x && _.isArray(x.items) ? x.items.length : 'null'}`] }
        rsi = createRsi({ root: path.join(t.dir, name), domain: makeDomain({ gates: { pre }, reportExtra }), budget: { arms: 6, novelty: 2, workers: 3 }, turning: { enabled: false }, ...(fill === undefined ? {} : { claims: { replanFillOnly: fill } }), dream: { everyRound: false, targetLadder: 1 } }).init()
        fs.writeFileSync(path.join(rsi.paths.policies, 'fixedRF.mjs'), POLICY)
        fs.writeFileSync(rsi.paths.current, "export { default, meta } from './fixedRF.mjs'\n")
        let run = (o) => (auto ? rsi.auto({ ...o, noDream: true }) : rsi.explore(o))
        let dry = await rsi.explore({ dry: true })
        armed = true
        let e1 = await run({ by: 'me' })
        armed = false
        let e2 = await run({ by: 'me' })
        let rd = (ex, f) => fs.readFileSync(path.join(ex.fd, f), 'utf8')
        return { rsi, raced, rx, dry, e1, e2, plan1: readJson(path.join(e1.fd, 'plan.json')), plan2: readJson(path.join(e2.fd, 'plan.json')), rep1: rd(e1, 'report.md'), rep2: rd(e2, 'report.md') }
    }
    let ids = (rsi, specs) => specs.map((s) => rsi.idOf(s))

    it('RF02 opt 開:他 session 先領 2 全域臂 ⇒ 重計畫只補 2 臂且補全域(實得 6 = 第一次計畫、組成同);plan.json 之 notesReplans / replanFillOnly;無重計畫之輪不寫', async function () {
        this.timeout(120000)
        let s = await scenario('on', { fill: true })
        let { rsi, e1, plan1, rep1, dry } = s
        assert.equal(s.raced, 1, '競態注入一次')
        assert.deepEqual(_.countBy(dry.items, 'kindOf'), { novelty: 2, global: 4 }, `第一次計畫 = 新區域 2 + 全域 4:${JSON.stringify(_.countBy(dry.items, 'kindOf'))}`)
        assert.deepEqual(ids(rsi, GLO.slice(0, 2)), dry.items.filter((x) => x.kindOf === 'global').slice(0, 2).map((x) => x.id), '他 session 所領 = 第一次計畫之全域之首 2 臂')
        assert.equal(e1.replans, 1)
        assert.equal(e1.items.length, dry.items.length, `實得 ${e1.items.length} = 第一次計畫之通過臂數 ${dry.items.length}(= 預算 6)`)
        assert.deepEqual(_.countBy(e1.items, 'kindOf'), _.countBy(dry.items, 'kindOf'), `組成同第一次計畫:${JSON.stringify(_.countBy(e1.items, 'kindOf'))}`)
        let got = new Set(e1.items.map((x) => x.id))
        assert.deepEqual(ids(rsi, [...NOV.slice(0, 2), ...GLO.slice(2, 6)]).filter((id) => got.has(id)).length, 6, '實得 = n1 n2 g3 g4 g5 g6')
        assert(ids(rsi, NOV.slice(2, 4)).every((id) => !got.has(id)), '重計畫之新區域臂(依原序在前)不取:被領走者為全域')
        assert(ids(rsi, GLO.slice(0, 2)).every((id) => !got.has(id) && rsi.store.getNode(id).claim.by === 'other'), '他 session 之認領原封不動')
        assert.equal(plan1.items.length, 6)
        assert.deepEqual(plan1.notes, ['fixedRF 6 臂'], 'plan.notes = 第一次計畫之備註(照舊)')
        assert.deepEqual(plan1.notesReplans, [['fixedRF 6 臂']], '重計畫之備註(整份新計畫:n3 n4 g5 ~ g8)')
        assert.equal(plan1.replanFillOnly, true)
        assert.match(rep1, /- 重計畫 1 次\(認領衝突;只補被他 session 先領之額\):實得 6 臂\(展開 0 \/ 新區域 2 \/ 全域 4\)/)
        //r002(無競態)⇒ 無重計畫
        assert.equal(s.e2.replans, 0)
        assert(!('notesReplans' in s.plan2) && !('replanFillOnly' in s.plan2), JSON.stringify(_.keys(s.plan2)))
        assert(!/- 重計畫 /.test(s.rep2))
    })

    it('RF03 opt 關(未設與明設 false):新臂全收(實得 10 > 預算 6;舊行為);plan.json 之 notesReplans 照寫、replanFillOnly false', async function () {
        this.timeout(120000)
        for (let fill of [undefined, false]) {
            let s = await scenario(`off_${fill}`, { fill })
            let { e1, plan1, rep1 } = s
            assert.equal(s.raced, 1)
            assert.equal(e1.replans, 1)
            assert.equal(e1.items.length, 10, `${fill}:實得 ${e1.items.length}(4 + 整份新計畫 6)`)
            assert.deepEqual(_.countBy(e1.items, 'kindOf'), { novelty: 4, global: 6 })
            assert.deepEqual(plan1.notesReplans, [['fixedRF 6 臂']])
            assert.equal(plan1.replanFillOnly, false)
            assert.match(rep1, /- 重計畫 1 次\(認領衝突;新計畫之臂全收\):實得 10 臂/)
        }
    })

    it('RF04 reportExtra 之第三參數:items = 實得之計畫項(含 kindOf / parentId / spec)、getNode 讀樹(缺 ⇒ null);explore 之報告與 auto 之重繪皆傳', async function () {
        this.timeout(120000)
        for (let auto of [false, true]) {
            let s = await scenario(`rx_${auto}`, { fill: true, auto })
            let { e1, rx, rep1 } = s
            let r1 = rx.filter((c) => c.round === 1)
            assert.equal(r1.length, auto ? 2 : 1, `r001 之報告產出次數(explore 1;auto 另重繪 1):${r1.length}`)
            assert.equal(rx.length, auto ? 4 : 2)
            for (let { x } of r1) {
                assert(x && _.isArray(x.items), `第三參數 ${JSON.stringify(x && _.keys(x))}`)
                assert.deepEqual(x.items.map((y) => y.id), e1.items.map((y) => y.id), '= 實得(含重計畫補額之臂)')
                assert(x.items.every((y) => y.kindOf && 'parentId' in y && y.spec), JSON.stringify(x.items[0]))
                let n = x.getNode(x.items[0].id)
                assert(n && n.id === x.items[0].id, 'getNode 讀樹')
                assert.equal(x.getNode('nope'), null, '缺 ⇒ null')
            }
            assert.match(rep1, /## RX\n- items 6/, `auto ${auto}:報告尾段由第三參數產出`)
        }
    })
})
