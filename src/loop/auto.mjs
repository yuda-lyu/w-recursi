import fs from 'fs'
import path from 'path'
import get from 'lodash-es/get.js'
import isFunction from 'lodash-es/isFunction.js'
import round from 'lodash-es/round.js'
import { loadSummaries } from './explore.mjs'
import { policyDevCheck } from './policyDev.mjs'
import { reportOf } from './report.mjs'
import { lastDreamAt } from '../sim/dream.mjs'
import { tryAcquireSlots, releaseSlots, slotsStatus } from '../core/slots.mjs'
import { hookFailureOf } from '../core/hookResult.mjs'
import { assertWriteRoot } from '../core/writeRoot.mjs'


//每輪標準動作:探索 → 做夢快照(寫 scores.jsonl;可設 dream.everyRound=false 或 minIntervalMs 交由獨立排程)→ 領域鉤子(如自動衍生處理)→ 策略開發觸發判定 → 報告
//  接受新策略(dream --accept)刻意不在此:那是單一寫者步驟, 由策略開發 agent 另行執行
//  鉤子失敗(拋錯, 或回傳 { failed: true, errors })⇒ 結果之 hook.failed = true;CLI 以非 0 結束(2026-09-26 審查:原只寫進報告, 離開碼 0)
//    拋錯之結果形 = core/hookResult.mjs 之 hookFailureOf(2026-10-09:與領域之尾段續跑同一來源)
//  做夢之略過(2026-09-29:每輪兩 session 各做一次全量做夢, 樹大時 1 ~ 18 分):
//    cfg.dream.minIntervalMs > 0(0 或未設 = 每輪)且距 scores.jsonl 末列不足 ⇒ 本輪略過(同批之另一 session 已做);opt.accept(明示之升版請求)不略過
//    略過之理由記於結果之 dreamSkip 與報告之「做夢」節(「略過:同批已做」)
//  結果另附 stagesSec = { explore, dream, hook, policyDev }(各段牆鐘秒;供呼叫端之完成紀錄)
//  同批互斥(2026-10-01):上一判定讀 scores.jsonl 末列 = 做夢**結束**之時刻 ⇒ 兩 session 同時結束探索段時皆判「該做」而各做一次(每批多 16 ~ 29 分)
//    ⇒ minIntervalMs > 0 時, 做夢前以槽位租約 policies/.mtx_dream(max 1;沿用 core/slots 之 pid / ISO / token 持有者列、半寫寬限、死者回收)登記「進行中」:
//       取不到 ⇒ 他 session 正在做 ⇒ 略過「同批進行中」;取得後再讀一次末列(他方可能剛做完)⇒ 間隔不足即略過「同批已做」;finally 釋放
//    opt.accept(明示之升版請求)與 minIntervalMs 0(每輪做夢)不經互斥(舊行為)
//  輪之截止點(2026-10-09;截止點與預留之單一來源在領域端):opt.deadlineAt(毫秒;**未給 ⇒ 行為逐位同改前**)
//    做夢開工前判(在「--no-dream / 同批已做 / 同批進行中」之後 —— 本輪本不做夢者不記為延期;取得做夢互斥且重判間隔之後):
//      opt.mayStart('dream') ⇒ { ok, why, needMs?, leftMs? }(呼叫端注入「現在 + 做夢之預留 ≤ 截止點」之判讀);未注入 ⇒ 引擎之預設判 = 截止點未過(預留 0)
//      不可 ⇒ 不做夢, dreamSkip = { why: DEADLINE_WHY, detail, at, deadlineAt, needSec?, leftSec? }(報告之做夢節照現形:「略過:輪截止點」);opt.accept 亦受之(截止點為時間之硬限)
//    鉤子:afterRound({ rsi, ...ex, deadlineAt })(領域自判其子步驟之開工, 如每個子步驟之前;未給 ⇒ 不帶此鍵 = 改前)
/**
 * 做夢同批互斥之槽位租約夾名(policies 下;cfg.dream.minIntervalMs > 0 時用)
 *
 * @type {String}
 */
export const DREAM_MUTEX = '.mtx_dream'
/**
 * 輪之截止點略過做夢時 dreamSkip.why 之固定字樣
 *
 * @type {String}
 */
export const DEADLINE_WHY = '輪截止點'
//opt ⇒ 做夢之截止點判讀(未給 deadlineAt ⇒ null)
let deadlineGateOf = (opt) => {
    if (opt.deadlineAt === undefined || opt.deadlineAt === null) { return null }
    let at = Number(opt.deadlineAt)
    if (!Number.isFinite(at)) { throw new Error(`auto:opt.deadlineAt 須為毫秒之數(收到 ${JSON.stringify(opt.deadlineAt)})`) }
    return { at, gate: (stage) => { let g = isFunction(opt.mayStart) ? (opt.mayStart(stage) || {}) : { ok: Date.now() <= at, why: '截止點已過' }; return { ...g, ok: g.ok !== false } } }
}
let deadlineSkipOf = (g, at) => ({ why: DEADLINE_WHY, detail: g.why || '截止點已過', at: new Date().toISOString(), deadlineAt: new Date(at).toISOString(), ...(Number.isFinite(g.needMs) ? { needSec: Math.round(g.needMs / 1000) } : {}), ...(Number.isFinite(g.leftMs) ? { leftSec: Math.round(g.leftMs / 1000) } : {}) })
/**
 * 每輪標準動作工廠(createRsi 以之組 rsi.auto):探索 → 做夢快照(寫 scores.jsonl;可設 dream.everyRound = false 或 minIntervalMs 交由獨立排程)→ 領域鉤子(afterRound;失敗 ⇒ hook.failed)→ 策略開發觸發判定 → 報告。接受新策略(dream --accept)刻意不在此(單一寫者步驟,由策略開發代理另行執行)。opt.deadlineAt(毫秒)給出時,做夢開工前判截止點
 *
 * @param {Object} rsi 輸入實例
 * @returns {Function} 回傳 async (opt) => { ...explore 之結果, dream, dreamSkip, hook, policyDev, stagesSec };opt: explore 之 opt + { accept, noDream, deadlineAt, mayStart }
 * @throws {Error} opt.deadlineAt 非有限數時於探索前拋出
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
 * let r = await rsi.auto({ noDream: true })
 * console.log(r.round, r.dream, r.dreamSkip.why, Object.keys(r.stagesSec).join(','))
 * // => 1 null --no-dream explore,dream,hook,policyDev
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let makeAuto = (rsi) => async (opt = {}) => {
    let { paths, domain } = rsi
    let sec = (t) => round((Date.now() - t) / 1000, 1)
    let DL = deadlineGateOf(opt)
    let t0 = Date.now()
    let ex = await rsi.explore(opt)
    let stagesSec = { explore: sec(t0) }
    if (ex.dry) { return { ...ex, dream: null, dreamSkip: null, hook: null, policyDev: null, stagesSec } }
    let d = null, dreamSkip = null
    let dcfg = get(rsi.cfg, 'dream', {}) || {}
    let every = dcfg.everyRound !== false && !opt.noDream
    let minMs = Number(dcfg.minIntervalMs) || 0
    let last = every && minMs > 0 && !opt.accept ? lastDreamAt(paths) : null
    let gapMs = last ? Date.now() - Date.parse(last) : NaN
    let tDream = Date.now()
    if (!every) { dreamSkip = { why: opt.noDream ? '--no-dream' : 'dream.everyRound = false' } }
    else if (last && Number.isFinite(gapMs) && gapMs < minMs) { dreamSkip = { why: '同批已做', last, gapMin: round(gapMs / 60000, 1), minIntervalMin: round(minMs / 60000, 1) } }
    else {
        let fdMtx = path.join(paths.policies, DREAM_MUTEX)
        let h = minMs > 0 && !opt.accept ? tryAcquireSlots(fdMtx, { want: 1, max: 1 }) : null
        if (h && !h.length) {
            let hold = slotsStatus(fdMtx, { max: 1 }).find((s) => !s.dead)
            dreamSkip = { why: '同批進行中', holder: hold ? `pid ${hold.pid} 自 ${hold.at}` : null }
        }
        else {
            try {
                let last2 = h ? lastDreamAt(paths) : null
                let gap2 = last2 ? Date.now() - Date.parse(last2) : NaN
                let dg = null
                if (last2 && Number.isFinite(gap2) && gap2 < minMs) { dreamSkip = { why: '同批已做', last: last2, gapMin: round(gap2 / 60000, 1), minIntervalMin: round(minMs / 60000, 1) } }
                else if (DL && !(dg = DL.gate('dream')).ok) { dreamSkip = deadlineSkipOf(dg, DL.at) } //輪之截止點:做夢開工前判
                else { d = await rsi.dream({ accept: !!opt.accept, currentOnly: !opt.accept }) } //輪內做夢只打當前(--accept 照舊打全部;2026-10-07)
            }
            finally { if (h) { releaseSlots(h) } }
        }
    }
    stagesSec.dream = sec(tDream)
    let tHook = Date.now()
    let hook = null
    if (isFunction(get(domain, 'hooks.afterRound'))) {
        try { hook = await domain.hooks.afterRound({ rsi, ...ex, ...(DL ? { deadlineAt: DL.at } : {}) }) }
        catch (e) { hook = hookFailureOf(e) }
    }
    stagesSec.hook = sec(tHook)
    let tDev = Date.now()
    let sums = loadSummaries(paths)
    let req = ex.fd ? policyDevCheck(rsi, ex.fd, sums) : null
    stagesSec.policyDev = sec(tDev)
    if (ex.fd) { assertWriteRoot(path.join(ex.fd, 'report.md'), { what: 'auto(report.md)' }) } //寫域守門(2026-10-09;未設 ⇒ 不檢)
    if (ex.fd) { fs.writeFileSync(path.join(ex.fd, 'report.md'), reportOf(rsi, ex.round, ex.plan, ex.nodes, ex.rejected, { skipped: ex.skipped, items: ex.items, replans: ex.replans, by: ex.summary && ex.summary.by, turning: ex.turning, debt: ex.debt, generation: ex.generation, genClear: ex.genClear, frontierRes: ex.frontierRes, aliasShort: ex.summary ? ex.summary.nAliasShort : undefined, dream: d, dreamSkip, hook, policyDev: req, stagesSec })) }
    return { ...ex, dream: d, dreamSkip, hook, policyDev: req, stagesSec }
}

export default makeAuto
