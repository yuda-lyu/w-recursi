import assert from 'assert'
import fs from 'fs'
import path from 'path'
import * as P from '../src/core/paths.mjs' //命名空間匯入:改前之碼無新匯出時本檔仍可載入(RI04 / RI05 以既有 API 於改前之碼上以斷言失敗)
import { createRsi, roundDirs, peekRound, allocateRound, loadSummaries } from '../src/index.mjs'
import { debtStreakOf } from '../src/loop/generation.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//輪夾之名與數值序(2026-10-09;審查:explore 之 roundDirs 原以字典序排 ⇒ r1000 起 [r1000, r998, r999] 之末為 r999, 摘要之序亂)
//  RI01 isRoundDir:正規名(r001 … r999、r1000 …)是;r000、4 位以上之前導零(r0999 / r01000)、r52 / r1、大寫、空白、非數字、空、非字串 否
//  RI02 雙射:n = 1 … 12,000 之 roundNameOf 皆為輪夾名且 roundNumOf 還原;r + 3 ~ 5 位數字之全部字串(111,000 個)⇒ isRoundDir ⟺ (數值 ≥ 1 ∧ roundNameOf(數值) = 原字串);ROUND_NAME_SRC 可組他形
//  RI03 listRoundDirs:r998 / r999 / r1000 / r1001 與非正規名、他檔 ⇒ [r998, r999, r1000, r1001];夾不存在 ⇒ []
//  RI04 roundDirs / peekRound / allocateRound / loadSummaries 跨 r1000:依輪號(peek 1002、取號 r1002、摘要 998 → 1001);fdRound 與 roundNameOf 同式
//  RI05 消費者:連續欠額 debtStreakOf(loadSummaries) 以輪號序之末尾計(字典序之末為 r999 ⇒ 欠額之連續中斷);createRsi 之 summaries() 同序
describe('core/paths:輪夾之名與數值序', function () {
    let { ROUND_NAME_SRC, isRoundDir, roundNumOf, roundNameOf, listRoundDirs, makePaths } = P
    let t
    before(() => { t = makeTmp('roundId') })
    after(() => { t.cleanup() })
    let mkRounds = (root, specs) => {
        let paths = makePaths(root)
        paths.ensure()
        for (let [name, sum] of specs) { let fd = path.join(paths.rounds, name); fs.mkdirSync(fd, { recursive: true }); if (sum) { fs.writeFileSync(path.join(fd, 'summary.json'), JSON.stringify(sum)) } }
        return paths
    }

    it('RI01 isRoundDir:正規名是、前導零 / r000 / 非法名否', () => {
        for (let s of ['r001', 'r052', 'r099', 'r100', 'r177', 'r999', 'r1000', 'r1001', 'r12345', 'r999999999999999']) { assert.equal(isRoundDir(s), true, s) }
        for (let s of ['r000', 'r0000', 'r0001', 'r0999', 'r01000', 'r52', 'r1', 'r', 'R052', ' r052', 'r052 ', 'r05a', 'r1000.tmp', 'rr100', '052', '', 'r1000000000000000', 'r-01', 'r1e3']) { assert.equal(isRoundDir(s), false, JSON.stringify(s)) }
        for (let x of [null, undefined, 52, ['r052'], { r: 1 }]) { assert.equal(isRoundDir(x), false, String(x)); assert.equal(roundNumOf(x), null) }
        assert.equal(roundNumOf('r0999'), null)
        assert.equal(roundNumOf('r1000'), 1000)
    })
    it('RI02 雙射:roundNameOf ↔ roundNumOf;3 ~ 5 位之全部字串與正規形之判定一致;ROUND_NAME_SRC 可組他形', () => {
        for (let n = 1; n <= 12000; n++) { let s = roundNameOf(n); assert.equal(isRoundDir(s), true, s); assert.equal(roundNumOf(s), n) }
        let nOk = 0
        for (let len = 3; len <= 5; len++) {
            for (let k = 0; k < 10 ** len; k++) {
                let s = `r${String(k).padStart(len, '0')}`
                let want = k >= 1 && roundNameOf(k) === s
                if (isRoundDir(s) !== want) { assert.fail(`${s}:isRoundDir ${isRoundDir(s)} ≠ 正規形判定 ${want}`) }
                if (want) { nOk++ }
            }
        }
        assert.equal(nOk, 999 + 9000 + 90000, '3 位 999 個(r001 ~ r999)+ 4 位 9,000 個 + 5 位 90,000 個')
        let re = new RegExp(`^(${ROUND_NAME_SRC})_(\\d+)\\.log$`)
        assert.deepEqual('r1000_123.log'.match(re).slice(1), ['r1000', '123'])
        assert.equal(re.test('r0999_1.log'), false)
    })
    it('RI03 listRoundDirs:依輪號升冪;非正規名與他檔不列;夾不存在 ⇒ []', () => {
        let fd = path.join(t.dir, 'list')
        for (let d of ['r1001', 'r998', 'r1000', 'r999', 'r0999', 'r000', 'notes', 'r1000.tmp']) { fs.mkdirSync(path.join(fd, d), { recursive: true }) }
        fs.writeFileSync(path.join(fd, 'r997'), 'x') //同名之檔亦列(與舊行為同:只依名)
        assert.deepEqual(listRoundDirs(fd), ['r997', 'r998', 'r999', 'r1000', 'r1001'])
        assert.deepEqual(listRoundDirs(path.join(t.dir, 'nope')), [])
    })
    it('RI04 roundDirs / peekRound / allocateRound / loadSummaries 跨 r1000(字典序會取 r999 為末)', () => {
        let paths = mkRounds(path.join(t.dir, 'cross'), [['r998', { round: 998 }], ['r999', { round: 999 }], ['r1000', { round: 1000 }], ['r1001', { round: 1001 }]])
        assert.deepEqual(roundDirs(paths), ['r998', 'r999', 'r1000', 'r1001'])
        assert.equal(peekRound(paths), 1002)
        let a = allocateRound(paths)
        assert.equal(a.round, 1002); assert.equal(path.basename(a.fd), 'r1002'); assert(fs.existsSync(a.fd))
        assert.equal(paths.fdRound(1002), path.join(paths.rounds, roundNameOf(1002)))
        assert.equal(path.basename(paths.fdRound(7)), 'r007')
        assert.deepEqual(loadSummaries(paths).map((s) => s.round), [998, 999, 1000, 1001], '無 summary 之 r1002 不列;其餘依輪號')
        //r999 → r1000 之交界:只有 r999 時 peek = 1000、取號 r1000
        let p2 = mkRounds(path.join(t.dir, 'edge'), [['r998', { round: 998 }], ['r999', { round: 999 }]])
        assert.equal(peekRound(p2), 1000)
        assert.equal(path.basename(allocateRound(p2).fd), 'r1000')
        assert.equal(peekRound(p2), 1001)
    })
    it('RI05 消費者:連續欠額以輪號序之末尾計;createRsi().summaries() 同序', () => {
        let root = path.join(t.dir, 'streak')
        mkRounds(root, [['r998', { round: 998, noveltyDebt: 1 }], ['r999', { round: 999, noveltyDebt: 0 }], ['r1000', { round: 1000, noveltyDebt: 2 }], ['r1001', { round: 1001, noveltyDebt: 3 }]])
        let rsi = createRsi({ root, domain: makeDomain() })
        let sums = rsi.summaries()
        assert.deepEqual(sums.map((s) => s.round), [998, 999, 1000, 1001])
        assert.equal(debtStreakOf(sums), 3, '末尾 r1001 / r1000 皆欠 ⇒ 2 + 本輪 1;字典序之末為 r999(欠 0)⇒ 1')
    })
})
