import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import _ from 'lodash-es'
import { createRsi, makePaths } from '../src/index.mjs'
import { readJson, writeJson } from '../src/core/jsonl.mjs'
import { reportOf } from '../src/loop/report.mjs'
import * as GEN from '../src/loop/generation.mjs' //名稱空間匯入:現行版缺新函式時各述語個別失敗(抓力之證), 而非整檔載入失敗
let { generationCheck } = GEN
let requestBaseOf = (...a) => GEN.requestBaseOf(...a), requestMustOf = (...a) => GEN.requestMustOf(...a)
import * as toy from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//生成請求之早退分支內嵌現行文(2026-10-04;loop/generation.mjs 之 earlyEmbedOf、loop/report.mjs)
//  原:早退(他 session 之有效標記)之報告只轉印 why 與升級行, 升級行指向持有輪之請求文 —— 該文寫於持有輪當時, 其「本輪必須做的事」可早於升級 / 領域之改寫
//      (某次實測:某輪之第 1 級請求文至多輪後仍被各輪報告所指, 而前緣已有 blocked 之飽和標記 ⇒ 與飽和模式相反)
//  GE01 requestBaseOf = 改前寫新請求之底稿(夾具 turnGenOldSnapshot 之 genRequestMd);requestMustOf 取「本輪必須做的事」段(至下一個「## 」前、去尾空白;無 ⇒ null)
//  GE02 早退 + 未升級 + 領域未改寫該段 ⇒ 回傳無 embed(鍵同改前)、報告之「新區域額度」段與改前逐字同(夾具 genEmbedOldSnapshot 之 plain)
//  GE03 早退 + 升級(streak 3)⇒ embed.must = 一般段(domainMust false);報告:升級行之前段同改前、改指內嵌段, 內嵌段逐字(引用區塊)且其後留空行
//  GE04 早退 + 未升級 + 領域改寫該段(玩具之飽和模式)⇒ embed(domainMust)、報告內嵌領域之段;不寫任何輪夾(本輪 / 持有輪)、標記只更新 debt / streak
//  GE05 領域之文字拋錯 ⇒ 早退照常回傳 embed.error(不拋)、報告一行;寫新請求之分支不受 earlyEmbedOf 影響(同一底稿)
//  GE06 explore 整合(玩具):他 session 之活標記期間, 未升級之輪報告無內嵌(同改前)、達 3 輪之輪報告有內嵌段;本輪夾無 GENERATION_REQUEST.md
const FD_FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const FX = JSON.parse(fs.readFileSync(path.join(FD_FX, 'genEmbedOldSnapshot.json'), 'utf8'))
const FX0 = JSON.parse(fs.readFileSync(path.join(FD_FX, 'turnGenOldSnapshot.json'), 'utf8'))
const DEBT = { need: 2, got: 0, debt: 2 }
const SUMS2 = [{ noveltyDebt: 0 }, { noveltyDebt: 1 }]
const SUMS3 = [{ noveltyDebt: 0 }, { noveltyDebt: 1 }, { noveltyDebt: 2 }]
const SAT_MUST = '## 本輪必須做的事(玩具飽和模式;缺一輪不算完成)\n\n1. 只回應終點層之請求.'
//玩具之「飽和模式」:把底稿之「本輪必須做的事」段換成 SAT_MUST(與領域之 generationText 同形:只換該段, 餘文照留)
let satText = (o) => { let b = String(o.base), i = b.indexOf('## 本輪必須做的事'), j = b.indexOf('\n## ', i + 1); return `${b.slice(0, i)}${SAT_MUST}\n${b.slice(j)}` }
let sec = (s, head = '## 新區域額度') => { let i = s.indexOf(head); if (i < 0) { return null } let j = s.indexOf('\n## ', i + head.length); return s.slice(i, j < 0 ? s.length : j) }
let rsiStub = () => ({ domain: toy.makeDomain(), cfg: {}, store: { getNode: () => null } })
let repOf = (g) => reportOf(rsiStub(), 14, { expand: [], novelty: [] }, [], [], { debt: DEBT, generation: g })
let lsR = (fd) => (fs.existsSync(fd) ? fs.readdirSync(fd).sort() : [])

describe('loop/generation + report:早退內嵌現行請求文(2026-10-04)', function () {
    let t
    before(() => { t = makeTmp('genEmbed') })
    after(() => { t.cleanup() })
    //他 session 之有效標記 r010(輪夾已完成 ⇒ 持有者已死亦有效;at 固定 = 夾具, ttlMs 極大)
    let setup = (name, domain = toy.makeDomain()) => {
        let paths = makePaths(path.join(t.dir, name))
        paths.ensure()
        let fdM = path.join(paths.rounds, 'r010')
        fs.mkdirSync(fdM, { recursive: true })
        fs.writeFileSync(path.join(fdM, 'summary.json'), '{}')
        let m0 = { at: FX.markerAt, round: 'r010', roundDir: fdM, fp: path.join(fdM, 'GENERATION_REQUEST.md'), by: 'pid999999', pid: 999999, pidStartedAt: 'S0', debt: 1, streak: 1 }
        writeJson(paths.genRequest, m0)
        let fdR = path.join(paths.rounds, 'r014')
        fs.mkdirSync(fdR, { recursive: true })
        return { paths, m0, fdM, fdR, rsi: { paths, domain, cfg: { generation: { ttlMs: 1e15 } } } }
    }

    it('GE01 requestBaseOf = 改前之底稿;requestMustOf', () => {
        let plan = { requests: [{ kind: 'operator', topic: 't1', title: '題一', priority: 2, needs: 'x', reason: '理由一' }] }
        let streak = GEN.debtStreakOf(FX0.genSums)
        assert.equal(requestBaseOf({ debt: { debt: 2, need: 2 }, turning: null, plan, streak, escalateRounds: 3 }), FX0.genRequestMd, '底稿與改前寫新請求之文逐字同(玩具無 generationText)')
        let must = requestMustOf(FX0.genRequestMd)
        assert.equal(must, '## 本輪必須做的事(缺一輪不算完成)\n\n1. 由下列前緣請求(依優先)或 lore 之重啟條件, 實作 **至少一個** 新的生成型算子 / 新載體 / 新條件變數, 以規格入樹(不是既有算子換參數).\n2. 入樹後在報告記:生成了什麼、依據哪個轉折 / 線索、預期它帶來哪一類新資訊.\n3. 若判斷無可生成(空間已飽和), 在報告明寫理由並登前緣 `blocked`, 供裁示.')
        assert.equal(requestMustOf('# 題\n\n- 無此段\n'), null)
        assert.equal(requestMustOf('# 題\n\n## 本輪必須做的事(x)\n\n1. a\n\n'), '## 本輪必須做的事(x)\n\n1. a', '段在文末 ⇒ 至文末(去尾空白)')
    })
    it('GE02 早退 + 未升級 + 領域未改寫 ⇒ 無 embed、報告段與改前逐字同', () => {
        let { rsi, fdR, fdM } = setup('plain')
        let g = generationCheck(rsi, fdR, { debt: DEBT, sums: SUMS2 })
        assert.equal(g.streak, 2); assert.equal(g.escalate, false)
        assert.ok(!('embed' in g), JSON.stringify(Object.keys(g)))
        assert.deepEqual(Object.keys(g), FX.plain.keys, '回傳鍵同改前')
        assert.equal(sec(repOf(g)), FX.plain.section, '報告之新區域額度段與改前逐字同')
        //領域之 generationText 未改寫該段(只附加其後之段)⇒ 同
        let { rsi: rsi2, fdR: fdR2 } = setup('plainDomain', toy.makeDomain({ generationText: (o) => `${o.base}\n## 領域之生成方式\n\n- x\n` }))
        let g2 = generationCheck(rsi2, fdR2, { debt: DEBT, sums: SUMS2 })
        assert.ok(!('embed' in g2)); assert.equal(sec(repOf(g2)), FX.plain.section)
        assert.deepEqual(lsR(fdR), [], '本輪夾不寫'); assert.deepEqual(lsR(fdM), ['summary.json'], '持有輪夾不寫')
    })
    it('GE03 早退 + 升級 ⇒ embed = 一般段;報告改指內嵌段', () => {
        let { rsi, fdR, fdM } = setup('esc')
        let g = generationCheck(rsi, fdR, { debt: DEBT, sums: SUMS3 })
        assert.equal(g.streak, 3); assert.equal(g.escalate, true)
        assert.ok(g.embed && !g.embed.error, JSON.stringify(g.embed))
        assert.equal(g.embed.domainMust, false)
        assert.equal(g.embed.must, requestMustOf(requestBaseOf({ debt: DEBT, streak: 3, escalateRounds: 3 })))
        assert.ok(g.embed.must.startsWith('## 本輪必須做的事(缺一輪不算完成)'))
        let s = sec(repOf(g))
        let old = FX.escalate.section
        let cut = '之 debt / streak 已更新;'
        assert.ok(s.startsWith(old.slice(0, old.indexOf(cut) + cut.length)), '需 / 得 / 欠一行與升級行之前段同改前')
        assert.ok(!s.includes('請求文見該輪夾之 GENERATION_REQUEST.md'), '不再指向持有輪之舊請求文')
        assert.ok(s.includes(`${cut}本輪必須做的事見下列現行文)`))
        assert.match(s, /^- 現行請求文之「本輪必須做的事」\(早退不寫請求文 ⇒ 以本輪之連續欠額 3 輪與前緣即時產生;全域生成請求標記 r010 之請求文寫於 2026-10-03T07:12:50\.597Z, 與下列不同者以下列為準\):$/m)
        let quoted = g.embed.must.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')
        assert.ok(s.includes(`\n\n${quoted}\n\n`), '內嵌段逐字(引用區塊), 前後各一空行')
        assert.deepEqual(lsR(fdR), []); assert.deepEqual(lsR(fdM), ['summary.json'])
    })
    it('GE04 早退 + 未升級 + 領域改寫該段 ⇒ embed(domainMust);不寫輪夾、標記只更新 debt / streak', () => {
        let { rsi, fdR, fdM, paths, m0 } = setup('sat', toy.makeDomain({ generationText: satText }))
        let g = generationCheck(rsi, fdR, { debt: DEBT, sums: SUMS2 })
        assert.equal(g.escalate, false)
        assert.deepEqual(g.embed, { must: SAT_MUST, domainMust: true })
        let s = sec(repOf(g))
        assert.ok(s.startsWith(FX.plain.section), '需 / 得 / 欠一行同改前(未升級 ⇒ 無升級行)')
        assert.doesNotMatch(s, /連續欠額 \d+ 輪 ⇒/)
        assert.ok(s.includes(';領域已改寫此段;'))
        assert.ok(s.includes('\n> ## 本輪必須做的事(玩具飽和模式;缺一輪不算完成)\n>\n> 1. 只回應終點層之請求.\n'))
        let m1 = readJson(paths.genRequest)
        assert.deepEqual(_.omit(m1, ['debt', 'streak']), _.omit(m0, ['debt', 'streak']), '標記之 at / round / pid / roundDir / fp 不改')
        assert.deepEqual(_.pick(m1, ['debt', 'streak']), { debt: 2, streak: 2 })
        assert.deepEqual(lsR(fdR), [], '本輪夾不寫'); assert.deepEqual(lsR(fdM), ['summary.json'], '持有輪夾不寫(輪夾之所有權)')
        //升級 + 改寫 ⇒ 升級行改指 + 內嵌領域之段
        let { rsi: rsi2, fdR: fdR2 } = setup('satEsc', toy.makeDomain({ generationText: satText }))
        let g2 = generationCheck(rsi2, fdR2, { debt: DEBT, sums: SUMS3 })
        let s2 = sec(repOf(g2))
        assert.equal(g2.embed.must, SAT_MUST)
        assert.ok(s2.includes('連續欠額 3 輪 ⇒ **已達 3 輪') && s2.includes('本輪必須做的事見下列現行文)') && s2.includes('> ## 本輪必須做的事(玩具飽和模式'))
    })
    it('GE05 領域之文字拋錯 ⇒ embed.error、不拋;寫新請求之分支照舊', () => {
        let boom = toy.makeDomain({ generationText: () => { throw new Error('玩具:文字失敗') } })
        let { rsi, fdR } = setup('boom', boom)
        let g = null
        assert.doesNotThrow(() => { g = generationCheck(rsi, fdR, { debt: DEBT, sums: SUMS2 }) })
        assert.equal(g.fp, null); assert.deepEqual(g.embed, { error: '玩具:文字失敗' })
        let s = sec(repOf(g))
        assert.ok(s.includes('- 現行請求文未能產生(玩具:文字失敗);本輪必須做的事以全域生成請求標記 r010 之請求文與主代理通知為準'))
        //earlyEmbedOf 之純判定
        assert.equal(GEN.earlyEmbedOf(toy.makeDomain(), { debt: DEBT, streak: 2, escalate: false }), null, '未升級且無改寫 ⇒ null')
        assert.equal(GEN.earlyEmbedOf(null, { debt: DEBT, streak: 3, escalate: true }).domainMust, false, '無領域 ⇒ 以底稿')
        //寫新請求(無標記)⇒ 與改前逐字同(玩具無 generationText;夾具 turnGenOldSnapshot)
        let paths = makePaths(path.join(t.dir, 'fresh'))
        paths.ensure()
        let fdRound = path.join(paths.rounds, 'r005')
        fs.mkdirSync(fdRound, { recursive: true })
        let g2 = generationCheck({ paths, domain: {}, cfg: {} }, fdRound, { debt: { debt: 2, need: 2 }, turning: null, plan: { requests: [{ kind: 'operator', topic: 't1', title: '題一', priority: 2, needs: 'x', reason: '理由一' }] }, sums: FX0.genSums })
        assert.equal(fs.readFileSync(g2.fp, 'utf8'), FX0.genRequestMd)
        assert.ok(!('embed' in g2))
    })
    it('GE06 explore 整合:未升級之輪無內嵌、達 3 輪之輪有內嵌段;本輪夾無 GENERATION_REQUEST.md', async function () {
        this.timeout(120000)
        let rsi = createRsi({ root: path.join(t.dir, 'explore'), domain: toy.makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 }, turning: { enabled: false } }).init()
        let rep = (ex) => fs.readFileSync(path.join(ex.fd, 'report.md'), 'utf8')
        await rsi.explore({}) //r001 冷啟動
        let e2 = await rsi.explore({}) //r002 欠 ⇒ 寫標記(streak 1)
        assert.ok(e2.generation && e2.generation.fp)
        let e3 = await rsi.explore({}) //r003 早退:streak 2 ⇒ 無內嵌
        assert.equal(e3.generation.streak, 2); assert.ok(!('embed' in e3.generation))
        assert.doesNotMatch(rep(e3), /現行請求文之「本輪必須做的事」/)
        let e4 = await rsi.explore({}) //r004 早退:streak 3 ⇒ 升級 + 內嵌
        assert.equal(e4.generation.escalate, true)
        let s4 = sec(rep(e4))
        assert.ok(s4.includes('本輪必須做的事見下列現行文)') && s4.includes('\n> ## 本輪必須做的事(缺一輪不算完成)\n'), s4)
        assert.equal(fs.existsSync(path.join(e4.fd, 'GENERATION_REQUEST.md')), false)
        assert.ok(fs.readFileSync(path.join(e2.fd, 'GENERATION_REQUEST.md'), 'utf8').includes('連續欠額 1 輪'), '持有輪之請求文不被重寫')
    })
})
