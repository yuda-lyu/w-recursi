import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi, noveltyDebtOf } from '../src/index.mjs'
import { readJson } from '../src/core/jsonl.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


let P = (x, y) => ({ kind: 'point', x, y })

//新區域欠額於認領之後計(2026-10-02;loop/explore.mjs 之 cfg.generation.debtAfterClaims)
//  為何:原於第一次計畫計「得」⇒ 新區域臂被他 session 先認領、重計畫補不回(供給告罄)時仍記欠 0 ⇒ 生成請求不寫、連續欠額(streak)歸零
//    (某次實測:需 2、第一次計畫之新區域 2 臂已被他輪認領、重計畫以全域臂補 ⇒ 實得 0 而記欠 0)
//  情境(玩具領域;轉折點提取關閉以控制前緣;generation.ttlMs 0 ⇒ 每個欠額輪皆自寫請求而不被前一輪之標記吸收, streak 逐輪可見):
//    r001 冷啟動(載體 origin / far 入樹, 不算欠額);r002 新區域無供給 ⇒ 欠 2(請求 streak 1)
//    r003 前緣恰 2 個新區域臂 A / B ⇒ 第一次計畫之新區域 = A / B;計畫後、認領前(前置閘注入真競態)他 session 認領 A / B
//      ⇒ 重計畫:A / B 已占用、載體皆已入樹、無其他前緣臂 ⇒ 新區域補不回(只補得展開臂)
//    r004 新區域仍無供給 ⇒ 欠 2;其 streak 是否承接 r003 即見遮蔽與否(escalateRounds 3 ⇒「已達 3 輪, 路線須重構」)
//  對稱之兩案:DC03 重計畫補得回(前緣另有 C / D)⇒ opt 開亦欠 0;DC04 新區域臂被閘門拒絕(validateSpec)⇒ 未認領 ⇒ opt 開計為未填(欠 1;舊式仍計得)
//  DC05:noveltyDebtOf 之 items 與計畫同一定義(純函式)
const A = P(7, 7), B = P(8, 8), C = P(9, 9), D = P(10, 10), BAD = P(99, 0)
describe('loop/explore:新區域欠額於認領之後計(cfg.generation.debtAfterClaims)', function () {
    let t
    before(() => { t = makeTmp('debtClaims') })
    after(() => { t.cleanup() })
    //arms:r003 前之前緣新區域臂(依序 priority 0, 1, …);race:r003 之他 session 先認領者
    let scenario = async (name, gen = {}, { arms = [A, B], race = [A, B] } = {}) => {
        let rsi, armed = false, raced = 0
        //競態:r003 之第一次計畫出來後(逐臂過前置閘時)才由「他 session」搶先認領 race(與 unit-explore 之真競態同法)
        let pre = () => {
            if (armed && !raced) { raced++; if (race.length) { rsi.store.claimNodes(race.map((s) => ({ id: rsi.idOf(s), spec: s, specHash: rsi.specHash(s), parentId: 'root' })), { round: 99, by: 'other' }) } }
            return { ok: true }
        }
        rsi = createRsi({ root: path.join(t.dir, name), domain: makeDomain({ gates: { pre } }), budget: { arms: 6, novelty: 2, workers: 3 }, turning: { enabled: false }, generation: { ttlMs: 0, ...gen } }).init()
        let mk = () => (fs.existsSync(rsi.paths.genRequest) ? readJson(rsi.paths.genRequest) : null)
        let e1 = await rsi.explore({ by: 'me' })
        let e2 = await rsi.explore({ by: 'me' })
        let m2 = mk()
        rsi.store.pushFrontier(arms.map((s, i) => ({ kind: 'arm', spec: s, specHash: rsi.specHash(s), reason: `新區域臂 ${i}`, priority: i, origin: { topic: 'turning', operator: 'T.transfer' } })))
        let dry = await rsi.explore({ dry: true })
        armed = true
        let e3 = await rsi.explore({ by: 'me' })
        armed = false
        let m3 = mk()
        let e4 = await rsi.explore({ by: 'me' })
        let m4 = mk()
        return { rsi, raced, e1, e2, m2, dry, e3, m3, e4, m4 }
    }
    let sumOf = (ex) => readJson(path.join(ex.fd, 'summary.json'))
    let reqOf = (ex) => { let fp = path.join(ex.fd, 'GENERATION_REQUEST.md'); return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null }
    let repOf = (ex) => fs.readFileSync(path.join(ex.fd, 'report.md'), 'utf8')
    const PLAN_VALUE = { need: 2, got: 2, debt: 0, coldStart: false, fromFrontier: 0 } //r003 之第一次計畫(新區域 A / B)
    //兩模式共通之前提:競態確實發生、第一次計畫之新區域 = A / B、重計畫補不回新區域(否則本案不成立)
    let checkRace = (s) => {
        let { rsi, raced, dry, e3 } = s
        assert.equal(raced, 1, '競態注入一次')
        let ids = [A, B].map((x) => rsi.idOf(x))
        assert.deepEqual(dry.debt, PLAN_VALUE, `乾跑(無認領)恆為計畫值:${JSON.stringify(dry.debt)}`)
        assert.deepEqual(e3.plan.novelty.map((x) => x.specHash), [A, B].map((x) => rsi.specHash(x)), '第一次計畫之新區域 = A / B')
        assert(ids.every((id) => e3.skipped.some((k) => k.id === id)), '認領時 A / B 已被他 session 領走而跳過')
        assert(e3.replans >= 1, `replans ${e3.replans}`)
        assert(e3.items.length > 0 && e3.items.every((it) => it.kindOf === 'expand'), `重計畫補不回新區域:${JSON.stringify(_.countBy(e3.items, 'kindOf'))}`)
        assert(ids.every((id) => rsi.store.getNode(id).claim.by === 'other'), '他 session 之認領原封不動')
        assert.equal(sumOf(s.e2).noveltyDebt, 2, 'r002 欠 2')
        assert(s.e2.generation && s.e2.generation.fp && s.e2.generation.streak === 1, `r002 寫請求 streak 1:${JSON.stringify(_.pick(s.e2.generation, ['fp', 'streak', 'why']))}`)
        assert.equal(s.m2.round, 'r002')
    }

    it('DC01 opt 開:後到者實得 0 ⇒ noveltyDebt 2(= need)、noveltyDebtPlan 0;認領後寫生成請求且 streak 承接(r003 為 2、r004 為 3 ⇒ 升級文字)', async function () {
        this.timeout(60000)
        let s = await scenario('on', { debtAfterClaims: true })
        checkRace(s)
        let { e1, e3, m3, e4, m4 } = s
        //r003:以認領 / 重計畫後之實得計(後到者實得 0 ⇒ 欠 = need)
        let s3 = sumOf(e3)
        assert.equal(s3.noveltyDebt, 2, `r003 之 summary.noveltyDebt ${s3.noveltyDebt}(實得 0 ⇒ 應 = need 2)`)
        assert.equal(s3.noveltyNeed, 2); assert.equal(s3.noveltyDebtPlan, 0, '第一次計畫之值(得 2、欠 0)另記')
        assert.equal(e3.debt.at, 'claims')
        assert.deepEqual(_.pick(e3.debt, ['need', 'got', 'debt', 'fromFrontier']), { need: 2, got: 0, debt: 2, fromFrontier: 0 })
        assert.deepEqual(e3.debt.firstPlan, _.pick(PLAN_VALUE, ['need', 'got', 'debt', 'fromFrontier']), '第一次計畫之值並記')
        assert(e3.generation && e3.generation.fp === path.join(e3.fd, 'GENERATION_REQUEST.md') && fs.existsSync(e3.generation.fp), `r003 寫生成請求:${JSON.stringify(_.pick(e3.generation, ['fp', 'why']))}`)
        assert.equal(s3.generation, e3.generation.fp)
        assert.equal(e3.generation.streak, 2, 'streak 承接 r002')
        assert.equal(m3.round, 'r003'); assert.equal(m3.debt, 2); assert.equal(m3.streak, 2)
        assert.match(reqOf(e3), /欠 2 \/ 2/); assert.match(reqOf(e3), /連續欠額 2 輪/); assert.doesNotMatch(reqOf(e3), /已達/)
        assert.match(repOf(e3), /- 需 2、得 0、欠 2\(以認領 \/ 重計畫後之實得計;第一次計畫得 2、欠 0\);\*\*已寫生成請求\*\*/)
        //r004:streak 連續第 3 輪(r002 / r003 / r004)⇒ 升級文字
        let s4 = sumOf(e4)
        assert.equal(s4.noveltyDebt, 2); assert.equal(s4.noveltyDebtPlan, 2)
        assert.equal(e4.generation.streak, 3); assert.equal(m4.round, 'r004'); assert.equal(m4.streak, 3)
        assert.match(reqOf(e4), /連續欠額 3 輪 ⇒ \*\*已達 3 輪, 路線須重構/)
        //冷啟動:認領後計亦不算欠額(播種);opt 開之 summary 恆有 noveltyDebtPlan
        assert.equal(e1.debt.coldStart, true); assert.equal(e1.debt.debt, 0); assert.equal(sumOf(e1).noveltyDebt, 0); assert.equal(sumOf(e1).noveltyDebtPlan, 0); assert.equal(e1.generation, null)
    })

    it('DC02 opt 關(預設 = 舊行為):以第一次計畫計 ⇒ 欠 0、summary 無 noveltyDebtPlan、不寫請求;streak 於 r003 歸零(r004 只計 1 輪)', async function () {
        this.timeout(60000)
        let s = await scenario('off')
        checkRace(s)
        let { e1, e3, m3, e4, m4 } = s
        assert.deepEqual(e1.debt, { need: 2, got: 2, debt: 0, coldStart: true, fromFrontier: 0 }, '冷啟動(舊式之回傳無 at / firstPlan)')
        assert(!('noveltyDebtPlan' in sumOf(e1)))
        //r003:舊行為 = 第一次計畫之值(新區域臂被他 session 取走仍記得 2、欠 0)
        assert.deepEqual(e3.debt, PLAN_VALUE, `舊式之回傳(無 at / firstPlan):${JSON.stringify(e3.debt)}`)
        let s3 = sumOf(e3)
        assert.equal(s3.noveltyDebt, 0); assert.equal(s3.noveltyNeed, 2); assert(!('noveltyDebtPlan' in s3), 'opt 關 ⇒ summary 無 noveltyDebtPlan')
        assert.equal(e3.generation, null); assert.equal(s3.generation, null)
        assert.equal(reqOf(e3), null, 'r003 不寫生成請求')
        assert.equal(m3.round, 'r002', '全域標記仍為 r002 所寫')
        assert.match(repOf(e3), /^- 需 2、得 2、欠 0$/m); assert.doesNotMatch(repOf(e3), /第一次計畫/)
        //r004:r003 記欠 0 ⇒ streak 歸零, 只計 1 輪(遮蔽:實質為連續第 3 輪)
        assert.equal(sumOf(e4).noveltyDebt, 2)
        assert.equal(e4.generation.streak, 1); assert.equal(m4.round, 'r004'); assert.equal(m4.streak, 1)
        assert.match(reqOf(e4), /連續欠額 1 輪/); assert.doesNotMatch(reqOf(e4), /已達/)
    })

    it('DC03 對稱:新區域臂被他 session 先領走而重計畫補得回(前緣另有 C / D)⇒ opt 開亦欠 0(實得 = 補回之 C / D;不誤報)', async function () {
        this.timeout(60000)
        let s = await scenario('backfill', { debtAfterClaims: true }, { arms: [A, B, C, D], race: [A, B] })
        let { rsi, raced, e3 } = s
        assert.equal(raced, 1)
        assert.deepEqual(e3.plan.novelty.map((x) => x.specHash), [A, B].map((x) => rsi.specHash(x)), '第一次計畫之新區域 = A / B')
        assert([A, B].every((x) => e3.skipped.some((k) => k.id === rsi.idOf(x))), 'A / B 被他 session 領走')
        assert.deepEqual(e3.items.filter((it) => it.kindOf === 'novelty').map((it) => it.specHash), [C, D].map((x) => rsi.specHash(x)), '重計畫補回 C / D')
        assert.deepEqual(_.pick(e3.debt, ['need', 'got', 'debt', 'at']), { need: 2, got: 2, debt: 0, at: 'claims' })
        let s3 = sumOf(e3)
        assert.equal(s3.noveltyDebt, 0); assert.equal(s3.noveltyDebtPlan, 0)
        assert.equal(e3.generation, null); assert.equal(reqOf(e3), null, '補得回 ⇒ 不寫生成請求')
    })

    it('DC04 新區域臂被閘門拒絕(validateSpec;無競態)⇒ 未認領:opt 開計為未填(欠 1、寫請求);opt 關(舊式)仍以計畫計得 2、欠 0', async function () {
        this.timeout(60000)
        for (let [name, gen, want] of [['rejOn', { debtAfterClaims: true }, { debt: 1, plan: 0, req: true }], ['rejOff', {}, { debt: 0, plan: undefined, req: false }]]) {
            let s = await scenario(name, gen, { arms: [BAD, A], race: [] })
            let { rsi, e3 } = s
            assert.deepEqual(e3.plan.novelty.map((x) => x.specHash), [BAD, A].map((x) => rsi.specHash(x)), `${name}:第一次計畫之新區域 = BAD / A`)
            assert(e3.rejected.some((r) => r.id === rsi.idOf(BAD)) && !e3.items.some((it) => it.id === rsi.idOf(BAD)), `${name}:BAD 被閘門拒絕、未認領`)
            assert(e3.items.some((it) => it.kindOf === 'novelty' && it.id === rsi.idOf(A)), `${name}:A 已認領`)
            let s3 = sumOf(e3)
            assert.equal(s3.noveltyDebt, want.debt, `${name}:noveltyDebt ${s3.noveltyDebt}`)
            assert.equal(s3.noveltyDebtPlan, want.plan, `${name}:noveltyDebtPlan ${s3.noveltyDebtPlan}`)
            assert.equal(!!reqOf(e3), want.req, `${name}:生成請求 ${!!reqOf(e3)}`)
        }
    })

    it('DC05 noveltyDebtOf 之 items:與計畫同一定義(novelty 項 + 取自前緣之展開;global 不計);空 ⇒ 全欠;冷啟動 need = got;計畫轉成項 ⇒ 逐值同不給 items', () => {
        let plan = { expand: [{ specHash: 'h1' }, { specHash: 'h9' }], novelty: [{}, {}], notes: [] }
        let fh = new Set(['h1', 'h2'])
        assert.deepEqual(noveltyDebtOf(plan, { novelty: 2 }, fh), { need: 2, got: 3, debt: 0, coldStart: false, fromFrontier: 1 }, '未給 items ⇒ 以計畫計(舊式)')
        let mine = [{ kindOf: 'novelty', specHash: 'n1' }, { kindOf: 'global', specHash: 'h1' }, { kindOf: 'expand', specHash: 'h2' }, { kindOf: 'expand', specHash: 'h9' }]
        assert.deepEqual(noveltyDebtOf(plan, { novelty: 3 }, fh, mine), { need: 3, got: 2, debt: 1, coldStart: false, fromFrontier: 1 }, 'global 臂即使 ∈ 前緣亦不計;非前緣之展開不計')
        assert.deepEqual(noveltyDebtOf(plan, { novelty: 2 }, fh, []), { need: 2, got: 0, debt: 2, coldStart: false, fromFrontier: 0 }, '認領全被取走 ⇒ 全欠')
        assert.deepEqual(noveltyDebtOf(plan, { novelty: 2 }, null, mine), { need: 2, got: 1, debt: 1, coldStart: false, fromFrontier: 0 }, '無前緣集 ⇒ 只計 novelty 項')
        assert.deepEqual(noveltyDebtOf({ expand: [], novelty: [{}, {}], notes: ['冷啟動:…'] }, { novelty: 2 }, null, [{ kindOf: 'novelty' }]), { need: 1, got: 1, debt: 0, coldStart: true, fromFrontier: 0 }, '冷啟動是播種:need = 實得')
        let asItems = [...plan.expand.map((x) => ({ kindOf: 'expand', specHash: x.specHash })), ...plan.novelty.map(() => ({ kindOf: 'novelty' }))]
        assert.deepEqual(noveltyDebtOf(plan, { novelty: 2 }, fh, asItems), noveltyDebtOf(plan, { novelty: 2 }, fh), '同一定義')
    })
})
