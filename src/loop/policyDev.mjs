import fs from 'fs'
import path from 'path'
import every from 'lodash-es/every.js'
import get from 'lodash-es/get.js'
import isFunction from 'lodash-es/isFunction.js'
import { withLock } from '../core/lock.mjs'
import { readJson, writeJson } from '../core/jsonl.mjs'
import { nowIso } from '../core/canonical.mjs'
import { assertWriteRoot } from '../core/writeRoot.mjs'


//changelog 之末次改版時刻(2026-09-29;純函式):
//  原以 slice(2, 26) 取末列 ⇒ 人工手寫列「- 2026-09-28 v2 2.2.0(同檔…」被當時刻, 字串比較時 'T' > ' ' ⇒ 該日所有輪都算「改版後」
//  改為:自末列往前, 取第一個「列首(`- ` 之後)為完整 ISO 時刻」之列之 ISO;列首無 ISO 之列(手寫之日期列 / 備註)略過;全無 ⇒ null
//  (手寫之改版列請寫完整 ISO, 如「- 2026-09-28T10:54:00.000Z v2 2.2.0 …」, 否則不計為改版時刻)
const RE_ROW_ISO = /^\s*-\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/
/**
 * changelog 之末次改版時刻(純函式):自末列往前,取第一個「列首(`- ` 之後)為完整 ISO 時刻」之列之 ISO;列首無 ISO 之列(手寫之日期列、備註)略過;全無 ⇒ null
 *
 * @param {String} text 輸入 changelog.md 內容
 * @returns {String|null} 回傳 ISO 時刻或 null
 * @example
 * let text = '- 2026-09-28 v2 手寫列\n- 2026-09-29T01:02:03.000Z v3 ← c1:ok\n- 2026-09-30 備註\n'
 * console.log(lastChangeAtOf(text), lastChangeAtOf(''))
 * // => 2026-09-29T01:02:03.000Z null
 */
export let lastChangeAtOf = (text) => {
    let ls = String(text || '').split(/\r?\n/)
    for (let i = ls.length - 1; i >= 0; i--) { let m = RE_ROW_ISO.exec(ls[i]); if (m && Number.isFinite(Date.parse(m[1]))) { return m[1] } }
    return null
}

//策略開發觸發(由代理執行;此處只判定並寫請求):連續兩輪無階梯≥1 之新節點, 或距上次策略改版 ≥ minRounds 輪
//  全域單一請求:policies/.dev_request.json 存在且未逾時 ⇒ 他 session 已請求, 不重複(接受新策略時由 dream 清除)
/**
 * 策略開發觸發:連續兩輪無階梯 ≥ 1 之新節點,或距上次策略改版 ≥ minRounds 輪 ⇒ 寫 POLICY_DEV_REQUEST.md(領域可以 domain.policyDevText 改寫);全域單一請求(policies/.dev_request.json 存在且未逾時 ⇒ 不重複);此處只判定並寫請求,不派工
 *
 * @param {Object} rsi 輸入實例
 * @param {String} fdRound 輸入本輪夾
 * @param {Array} sums 輸入輪次摘要
 * @param {Object} [opt={}] 輸入 { minRounds:Number(3), ttlMs:Number(86400000) }(併 cfg.policyDev)
 * @returns {String|null} 回傳請求檔路徑;未達觸發條件或已有請求 ⇒ null
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 * import { createRsi } from 'w-recursi/src/index.mjs'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let domain = {
 *     name: 'toy',
 *     score: (raw) => ({ S: raw.v, ladder: raw.v >= 2 ? 1 : 0, flags: {} }),
 *     validateSpec: (s) => { if (typeof s.x !== 'number') { throw new Error('x 須為數字') } },
 *     operators: [{ name: 'inc', family: 'f', applies: () => true, children: (s) => [{ spec: { x: s.x + 1 }, params: { by: 1 } }] }],
 *     carriers: { root: { x: 0 } },
 *     evaluator: { mode: 'inProcess', evaluate: async (spec) => ({ v: spec.x }) },
 * }
 * let rsi = createRsi({ root: dir, domain, budget: { arms: 2, novelty: 1 } }).init()
 * let ex = await rsi.explore()
 * let fp = policyDevCheck(rsi, ex.fd, rsi.summaries(), { minRounds: 1 })
 * console.log(path.basename(fp))
 * // => POLICY_DEV_REQUEST.md
 * console.log(policyDevCheck(rsi, ex.fd, rsi.summaries(), { minRounds: 1 }))
 * // => null
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let policyDevCheck = (rsi, fdRound, sums, opt = {}) => {
    let { paths, domain } = rsi
    let O = { minRounds: 3, ttlMs: 24 * 3600000, ...(get(rsi.cfg, 'policyDev', {}) || {}), ...opt }
    let last2 = sums.slice(-2)
    let stalled = last2.length === 2 && every(last2, (s) => (s.ladderGe1 || 0) === 0 && (s.nExecuted || 0) > 0)
    //距上次改版之輪數:summary.at 晚於末次改版時刻者(以時刻比較, 非字串);無可解析之改版時刻 ⇒ 全部輪次
    let lastIso = fs.existsSync(paths.changelog) ? lastChangeAtOf(fs.readFileSync(paths.changelog, 'utf8')) : null
    let tChange = lastIso ? Date.parse(lastIso) : NaN
    let sinceChange = sums.filter((s) => !Number.isFinite(tChange) || Date.parse(s.at) > tChange).length
    if (!stalled && sinceChange < O.minRounds) { return null }
    return withLock(() => {
        let m = readJson(paths.devRequest, null)
        if (m && Date.now() - Date.parse(m.at) < O.ttlMs) { return null }
        let fp = path.join(fdRound, 'POLICY_DEV_REQUEST.md')
        let why = `${stalled ? '連續兩輪無階梯≥1 之新節點' : ''}${stalled && sinceChange >= O.minRounds ? ';' : ''}${sinceChange >= O.minRounds ? `距上次策略改版已 ${sinceChange} 輪` : ''}`
        let text = isFunction(domain.policyDevText) ? domain.policyDevText({ why, fdRound, paths }) : [
            '# 策略開發請求(R4;任一 LLM agent 執行;全域同時只有一份)', '', `- 觸發:${why}`, '',
            '## 作業', '', `1. 讀 \`${paths.current}\`(當前策略)、\`${paths.scores}\`(歷次夢分數)、status 之樹統計;方向性摘要不注入(只看樹)。`,
            '2. 以 dream 取得當前策略之全樣本 / 留出 / 回溯分數與揭露軌跡(策略視圖已遮蔽;策略碼不得讀被遮蔽之欄位, 靜態檢查會擋)。',
            `3. 改寫 2 ~ 5 個候選策略至 \`${paths.candidates}/<name>.mjs\`(純函式;介面同 v0.mjs;只改分配:展開哪些節點、用哪些算子、開幾個、何時停、新區域額度)。`,
            '4. dream --accept:只有留出分數優於當前達 margin 且全樣本不劣於 floor 者升版;當前策略恆在池中(單調不退化)。',
            '5. 於本輪 report.md 末尾附一段:改了什麼、為何、夢分數、是否升版。', ''].join('\n')
        assertWriteRoot(fp, { what: 'POLICY_DEV_REQUEST.md' }) //寫域守門(2026-10-09;未設 ⇒ 不檢;標記之 writeJson 另經原語守)
        fs.writeFileSync(fp, text)
        writeJson(paths.devRequest, { at: nowIso(), round: path.basename(fdRound), fp, by: `pid${process.pid}`, why })
        return fp
    }, { dir: paths.policies, name: 'policies' })
}

export default policyDevCheck
