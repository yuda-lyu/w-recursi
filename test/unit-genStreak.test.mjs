import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import _ from 'lodash-es'
import { createRsi, makePaths } from '../src/index.mjs'
import { readJson, writeJson } from '../src/core/jsonl.mjs'
import * as GEN from '../src/loop/generation.mjs' //名稱空間匯入:現行版缺 debtStreakOf 時各述語個別失敗(抓力之證), 而非整檔載入失敗
let { generationCheck, clearGenRequest, readGenRequest } = GEN
let debtStreakOf = (...a) => GEN.debtStreakOf(...a)
import * as toy from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//生成請求之早退亦計連續欠額(2026-10-04;loop/generation.mjs)
//  原:他 session 已有有效標記 ⇒ 早退、不讀 sums、不改標記 ⇒ 某次連續 6 輪欠額而標記之 streak 停在 1, 升級規則(連續 3 輪 ⇒ 路線須重構)被遮蔽
//  GS01 debtStreakOf:末尾連續欠額輪數 + 1(缺 noveltyDebt 視同 0)
//  GS02 有效標記 + 本輪欠 ⇒ 回傳 streak = debtStreakOf(sums)、escalate;標記之 at / round / pid / roundDir / fp 不變而 debt / streak 更新;值未變不寫;不寫請求文
//  GS03 無標記 ⇒ 寫檔內容(請求文與標記之 round / debt / streak)與改前逐字同(夾具 fixtures/turnGenOldSnapshot.json)
//  GS04 clearGenRequest 之 seen 判定不受 debt / streak 更新影響(只比 at / round)
//  GS05 explore 整合:他 session 之活標記期間, 標記之 streak 逐輪增;達 3 輪之輪之報告有升級行, 未達者無(與改前同)
const FX = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'turnGenOldSnapshot.json'), 'utf8'))
const DEAD = 999999
let iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()

describe('loop/generation:早退亦計連續欠額(2026-10-04)', function () {
    let t
    before(() => { t = makeTmp('genStreak') })
    after(() => { t.cleanup() })
    //標記之輪夾已完成(有 summary.json)⇒ 持有者已死亦有效(markerStale 之「完成之輪」)
    let setup = (name, m = {}) => {
        let paths = makePaths(path.join(t.dir, name))
        paths.ensure()
        let fdM = path.join(paths.rounds, 'r010')
        fs.mkdirSync(fdM, { recursive: true })
        fs.writeFileSync(path.join(fdM, 'summary.json'), '{}')
        let m0 = { at: iso(60000), round: 'r010', roundDir: fdM, fp: path.join(fdM, 'GENERATION_REQUEST.md'), by: `pid${DEAD}`, pid: DEAD, pidStartedAt: 'S0', debt: 1, streak: 1, ...m }
        writeJson(paths.genRequest, m0)
        let fdR = path.join(paths.rounds, 'r014')
        fs.mkdirSync(fdR, { recursive: true })
        return { paths, m0, fdR, rsi: { paths, domain: {}, cfg: {} } }
    }

    it('GS01 debtStreakOf', () => {
        assert.equal(debtStreakOf([]), 1)
        assert.equal(debtStreakOf(), 1)
        assert.equal(debtStreakOf([{ noveltyDebt: 2 }, { noveltyDebt: 0 }]), 1)
        assert.equal(debtStreakOf([{ noveltyDebt: 0 }, { noveltyDebt: 1 }, { noveltyDebt: 2 }]), 3)
        assert.equal(debtStreakOf([{ noveltyDebt: 1 }, {}, { noveltyDebt: 1 }]), 2, '缺 noveltyDebt 視同 0')
        assert.equal(debtStreakOf(FX.genSums), FX.genMarker.streak, '與改前寫新標記之式同(夾具)')
    })
    it('GS02 有效標記 + 本輪欠 ⇒ streak / escalate;標記只更新 debt / streak;值未變不寫;不寫請求文', () => {
        let { paths, m0, fdR, rsi } = setup('valid')
        let sums = [{ noveltyDebt: 0 }, { noveltyDebt: 1 }, { noveltyDebt: 2 }, { noveltyDebt: 2 }]
        let g = generationCheck(rsi, fdR, { debt: { debt: 2, need: 2 }, sums })
        assert.equal(g.fp, null)
        assert.equal(g.why, `他 session 已有生成請求(r010, ${m0.at})`, 'why 與改前逐字同')
        assert.equal(g.streak, 4); assert.equal(g.escalate, true); assert.equal(g.escalateRounds, 3)
        let m1 = readJson(paths.genRequest)
        assert.deepEqual(_.omit(m1, ['debt', 'streak']), _.omit(m0, ['debt', 'streak']), 'at / round / pid / roundDir / fp / by 不變')
        assert.equal(m1.debt, 2); assert.equal(m1.streak, 4)
        assert.deepEqual(g.existing, m1, 'existing = 更新後之標記')
        assert.ok(!fs.existsSync(path.join(fdR, 'GENERATION_REQUEST.md')), '早退不寫請求文')
        //值未變 ⇒ 不寫(檔之 mtime 不動)
        let st0 = fs.statSync(paths.genRequest).mtimeMs
        let until = Date.now() + 30; while (Date.now() < until) { /* 等 mtime 之解析度 */ }
        let g2 = generationCheck(rsi, fdR, { debt: { debt: 2, need: 2 }, sums })
        assert.equal(g2.streak, 4); assert.equal(fs.statSync(paths.genRequest).mtimeMs, st0, '值未變不寫')
        //未達門檻 ⇒ escalate false;欠額降 ⇒ 標記之 debt 隨之
        let g3 = generationCheck(rsi, fdR, { debt: { debt: 1, need: 2 }, sums: [{ noveltyDebt: 0 }, { noveltyDebt: 1 }] })
        assert.equal(g3.streak, 2); assert.equal(g3.escalate, false)
        assert.deepEqual(_.pick(readJson(paths.genRequest), ['round', 'at', 'debt', 'streak']), { round: 'r010', at: m0.at, debt: 1, streak: 2 })
        //本輪不欠 ⇒ 舊行為(null;標記不動)
        assert.equal(generationCheck(rsi, fdR, { debt: { debt: 0, need: 2 }, sums }), null)
        assert.equal(readJson(paths.genRequest).streak, 2)
        //鎖已釋放
        assert.ok(!fs.existsSync(path.join(paths.policies, '.lock_policies')))
    })
    it('GS03 無標記 ⇒ 寫檔內容與改前逐字同', () => {
        let paths = makePaths(path.join(t.dir, 'fresh'))
        paths.ensure()
        let fdRound = path.join(paths.rounds, 'r005')
        fs.mkdirSync(fdRound, { recursive: true })
        let g = generationCheck({ paths, domain: {}, cfg: {} }, fdRound, { debt: { debt: 2, need: 2 }, turning: null, plan: { requests: [{ kind: 'operator', topic: 't1', title: '題一', priority: 2, needs: 'x', reason: '理由一' }] }, sums: FX.genSums })
        assert.equal(fs.readFileSync(g.fp, 'utf8'), FX.genRequestMd, '請求文逐字同')
        assert.deepEqual(_.pick(readJson(paths.genRequest), ['round', 'debt', 'streak']), FX.genMarker)
        assert.equal(g.streak, FX.genMarker.streak)
        assert.ok(!('escalate' in g) && !('existing' in g), '寫新標記之回傳鍵同改前')
    })
    it('GS04 clearGenRequest 之 seen 判定不受 debt / streak 更新影響', () => {
        let { paths, m0, fdR, rsi } = setup('clear')
        let seen = readGenRequest(paths)
        generationCheck(rsi, fdR, { debt: { debt: 2, need: 2 }, sums: [{ noveltyDebt: 2 }, { noveltyDebt: 2 }] })
        assert.equal(readJson(paths.genRequest).streak, 3)
        assert.equal(clearGenRequest(rsi, { round: 'r099', seen: { ...seen, at: iso(1) } }).cleared, false, 'at 不同 ⇒ 非本輪所見')
        let r = clearGenRequest(rsi, { round: 'r014', seen })
        assert.equal(r.cleared, true, JSON.stringify(r)); assert.equal(r.marker.round, m0.round)
        assert.ok(!fs.existsSync(paths.genRequest))
    })
    it('GS05 explore 整合:活標記期間 streak 逐輪增;達 3 輪之報告有升級行', async function () {
        this.timeout(120000)
        let rsi = createRsi({ root: path.join(t.dir, 'explore'), domain: toy.makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 }, turning: { enabled: false } }).init()
        let rep = (ex) => fs.readFileSync(path.join(ex.fd, 'report.md'), 'utf8')
        await rsi.explore({}) //r001 冷啟動
        let e2 = await rsi.explore({}) //r002 欠 ⇒ 寫標記(streak 1)
        assert.ok(e2.generation && e2.generation.fp)
        let m2 = readJson(rsi.paths.genRequest)
        let e3 = await rsi.explore({}) //r003 早退:streak 2
        assert.ok(e3.generation && !e3.generation.fp && /已有生成請求/.test(e3.generation.why))
        assert.equal(e3.generation.streak, 2); assert.equal(e3.generation.escalate, false)
        assert.doesNotMatch(rep(e3), /連續欠額 \d+ 輪 ⇒/, '未達門檻 ⇒ 無升級行(同改前)')
        let e4 = await rsi.explore({}) //r004 早退:streak 3 ⇒ 升級
        assert.equal(e4.generation.streak, 3); assert.equal(e4.generation.escalate, true)
        assert.match(rep(e4), /- 連續欠額 3 輪 ⇒ \*\*已達 3 輪, 路線須重構\(換載體 \/ 換終點層\), 不得只換參數再跑\*\*\(全域生成請求標記 r002 之 debt \/ streak 已更新/)
        let m4 = readJson(rsi.paths.genRequest)
        assert.deepEqual(_.omit(m4, ['debt', 'streak']), _.omit(m2, ['debt', 'streak'])); assert.equal(m4.streak, 3)
        assert.equal(fs.existsSync(path.join(e4.fd, 'GENERATION_REQUEST.md')), false)
    })
})
