import filter from 'lodash-es/filter.js'
import fromPairs from 'lodash-es/fromPairs.js'
import get from 'lodash-es/get.js'
import groupBy from 'lodash-es/groupBy.js'
import isArray from 'lodash-es/isArray.js'
import isFinite from 'lodash-es/isFinite.js'
import isFunction from 'lodash-es/isFunction.js'
import isNumber from 'lodash-es/isNumber.js'
import isPlainObject from 'lodash-es/isPlainObject.js'
import map from 'lodash-es/map.js'
import max from 'lodash-es/max.js'
import mean from 'lodash-es/mean.js'
import pickBy from 'lodash-es/pickBy.js'
import round from 'lodash-es/round.js'
import size from 'lodash-es/size.js'
import sortBy from 'lodash-es/sortBy.js'
import sum from 'lodash-es/sum.js'
import uniq from 'lodash-es/uniq.js'
import { specHash } from '../core/canonical.mjs'


//夢境模擬器:在樹上重放一支探索策略, 不呼叫模型、不跑評估
//  語義(Dream-RSI):策略每輪提出要展開之子 spec;若該 spec 已是樹中「已執行」節點, 模擬器揭露其已存分數並記其真實成本;
//    樹裡沒有者記 unknown(扣預設成本、不揭露)。J = max(揭露節點之 S) − λ·cost/1000 + μ·利用率。
//    別名(env.aliasOf)被提出時記其成本;正本已可見 ⇒ 記 duplicates、不算揭露;正本未可見 ⇒ 以正本計揭露(2026-09-25)。回溯目標不含別名。
//  抗元層過擬合:(a) 時間切分:只以第 startRound 輪以前之節點為起始可見, 之後全部隱藏待揭露;
//    (b) 回溯測:targetIds(如後來被認證者)被揭露時之累計成本;(c) 策略只看策略視圖(遮蔽)。
//  env: { viewOf(node, aliasOf) → 視圖, aliasOf(nodes) → Map, makeCtx(executedSet, views?, lineage?) → ctx, costOf?(node) → 成本 }
//  2026-09-27(探索之全域 / 局部失衡修正):
//    ① 揭露之分數 / 階梯一律讀**策略視圖**(領域遮蔽後;如訓練期之搜尋版 S / 階梯)—— 原讀原始 S(含留出段否決)與 ladder(含全期驗證)
//    ② 目標之階梯(targetLadder)亦以視圖判(領域預設 1 = 訓練期真偽);原 3 在某領域之樹實為以留出段選出之節點
//    ③ 視圖有行為格(score.cell)時 J 之品質項 = Σ 各格揭露之「階梯 ≥ targetLadder」節點之最高 S(QD;覆蓋與品質兼計), 否則 = 揭露之最高 S(舊式)
//    ④ 樹外臂(unknown)之成本:defaultReplays = 'visibleMedian' ⇒ 該輪可見已執行節點之 cost 中位(只用切分前之可見量;某次回報:定值 24 為實際中位 146 之 1/6,
//       「多提樹外規格」之候選可藉低估之成本跨過接受門檻);數值則為定值(舊行為)
//    ⑤ 探索保底:minGlobal > 0 時記每輪 plan.global 不足 min(minGlobal, arms) 之輪數(globalShort);accept 對 globalShort > 0 之候選一律不升版
//    ⑥ 結構保底(2026-10-02;可選):O.structural(plan, { view, round }) → 違規數(領域定義, 如「每輪每族 ≤ 1」);違規 > 0(或拋錯)之重放輪計 structuralShort;
//       accept 對 structuralShort > 0 之候選一律不升版 —— 做夢之重放偏向現任之軌跡(他策略之偏離只成樹外未知臂), 領域之結構約束不可交由分數自行撤銷
//       (做夢對樹外之探索不可識別 —— 只能以結構約束防止升版退回純利用;多樣性與收斂性須兼顧)
//  2026-09-29(實測別名表 0.31 秒 × 每策略 74 次 ≈ 23 秒):opt.aliasMap(Map)⇒ 以之為別名表, 不再每次 simulate 以 env.aliasOf 重算;
//    **須與本次 nodes 之「executed ∧ 有 score」集合同一份求得**(呼叫端負責;evaluatePolicy 一次求得後傳給其全部 simulate, 做夢再於多策略間共用);未給 ⇒ 舊行為
/**
 * 做夢模擬之預設:rounds(重放輪數)、arms、novelty、global、minGlobal(探索保底)、lambda(成本係數)、mu(利用率係數)、defaultReplays(樹外臂之預設成本,或 "visibleMedian")、targetLadder(目標階梯;引擎預設 3 為玩具之值,階梯之意義由領域定)
 *
 * @type {Object}
 */
export const DEFAULT_SIM = { rounds: 5, arms: 8, novelty: 2, global: 0, minGlobal: 0, lambda: 1, mu: 2, defaultReplays: 24, targetLadder: 3 }
let medianOf = (a) => { let s = sortBy(a.filter(isFinite)); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null }
//別名表:executed ∧ 有 score 之節點(與 simulate 之 all、evaluatePolicy 之回溯目標同一集合)
/**
 * 別名表:executed 且有 score 之節點交 env.aliasOf 求得(與 simulate 之 all、evaluatePolicy 之回溯目標同一集合);無 env.aliasOf ⇒ 空 Map
 *
 * @param {Array} nodes 輸入節點陣列
 * @param {Object} env 輸入 { aliasOf(nodes) → Map }
 * @returns {Map} 回傳別名表
 * @example
 * let env = { aliasOf: (xs) => new Map([['n', xs.length]]) }
 * console.log(aliasMapOfNodes([{ status: 'executed', score: {} }, { status: 'error' }], env).get('n'), aliasMapOfNodes([], {}).size)
 * // => 1 0
 */
export let aliasMapOfNodes = (nodes, env) => (env && env.aliasOf ? env.aliasOf((nodes || []).filter((n) => n.status === 'executed' && n.score)) : new Map())

/**
 * 夢境模擬器:在樹上重放一支探索策略,不呼叫模型、不跑評估。策略每輪提出要展開之子 spec;若已是樹中「已執行」節點,揭露其已存分數並記真實成本;樹裡沒有者記 unknown(扣預設成本、不揭露)。J = 品質項(揭露節點之最高 S,有行為格時為各格〔階梯 ≥ targetLadder 之節點〕最高 S 之和)− λ·cost/1000 + μ·利用率。時間切分(startRound)只以該輪以前之節點為起始可見;策略只看策略視圖(遮蔽)
 *
 * @param {Function} policyFn 輸入策略 (view, budget, ctx) => plan
 * @param {Array} nodes 輸入全部節點
 * @param {Object} env 輸入 { viewOf(node, aliasOf) → 視圖, aliasOf(nodes) → Map, makeCtx(executedSet, views, lineage) → ctx, costOf?(node) }
 * @param {Object} [opt={}] 輸入 DEFAULT_SIM 之覆寫 + { startRound, targetIds, aliasMap, structural }
 * @returns {Object} 回傳 { J, bestS, qd, nCells, ladderGain, revealed, unknown, duplicates, cost, util, targets, revealedIds, globalShort, structuralShort, unknownCost };策略拋錯 ⇒ { J:-Infinity, error }
 * @example
 * let nodes = [
 *     { id: 'a', status: 'executed', round: 0, spec: { x: 0 }, score: { S: 1, ladder: 1 }, cost: { replays: 10 } },
 *     { id: 'b', status: 'executed', round: 1, spec: { x: 1 }, score: { S: 5, ladder: 1 }, cost: { replays: 10 } },
 * ]
 * let env = { viewOf: (n) => n, aliasOf: () => new Map(), makeCtx: (executed) => ({ executed }) }
 * let policy = () => ({ expand: [{ spec: { x: 1 } }], novelty: [] })
 * let r = simulate(policy, nodes, env, { rounds: 2, arms: 1, startRound: 0 })
 * console.log(r.revealed, r.bestS, r.cost)
 * // => 1 5 10
 */
export let simulate = (policyFn, nodes, env, opt = {}) => {
    let O = { ...DEFAULT_SIM, ...opt }
    let all = nodes.filter((n) => n.status === 'executed' && n.score)
    let hashOf = (n) => n.specHash || specHash(n.spec)
    let byHash = new Map(all.map((n) => [hashOf(n), n]))
    let byId = new Map(all.map((n) => [n.id, n]))
    let alias = O.aliasMap instanceof Map ? O.aliasMap : (env.aliasOf ? env.aliasOf(all) : new Map())
    //節點之成本(2026-09-29 盤查時發現之潛伏缺陷):cost.replays 為有限數(含 0:已驗載體之原料複製為 0 回放)即用之;缺 ⇒ 該輪之樹外臂成本
    //  原式 `replays || defaultReplays` 把 0 當缺, 且 defaultReplays 為 'visibleMedian' 時回傳字串 ⇒ 揭露 0 回放之節點使 cost 成字串、J 成 NaN(某樹上 13 個複製載體節點 replays = 0)
    //  可見中位只取 > 0 者(與原式之結果相同:原式之 0 / 缺皆成字串而被中位排除)
    let costOf = env.costOf || ((n) => { let c = get(n, 'cost.replays', null); return isFinite(c) ? c : null })
    let startRound = isNumber(O.startRound) ? O.startRound : -1
    let visible = new Set(all.filter((n) => (n.round || 0) === 0 || (n.round || 0) <= startRound).map((n) => n.id))
    let revealed = []
    let cost = 0, unknown = 0, used = 0, duplicates = 0, globalShort = 0, structuralShort = 0
    let unkCosts = []
    let targets = fromPairs((O.targetIds || []).map((id) => [id, null]))
    //視圖之 children 只留可見節點(2026-09-23 登記:原樣傳入全樹之 children ⇒ 未來資訊外洩;子數已滿之父於時間切分中被
    //  策略之「每節點子數上限」排除, 某領域之留出切分因此 0 揭露、全數 unknown)
    let viewOf = (n) => { let v = env.viewOf(n, null); return v && isArray(v.children) ? { ...v, children: v.children.filter((c) => visible.has(c)) } : v }
    for (let r = 1; r <= O.rounds; r++) {
        let vis = all.filter((n) => visible.has(n.id))
        let view = { round: r, nodes: vis.filter((n) => !alias.has(n.id)).map(viewOf), frontier: [] }
        //views:可見之非別名節點之視圖(與策略所見同一份;展開鉤子 domain.childBlock 以之查父之訓練期量, 2026-09-25)
        //lineage:可見節點全部(含別名;與 explore 之全樹視圖同義, 只限可見 ⇒ 不洩漏未來;2026-09-25)⇒ 鉤子之 byId(查父之父與其子)
        let lineage = [...view.nodes, ...vis.filter((n) => alias.has(n.id)).map(viewOf)]
        let ctx = env.makeCtx(new Set(vis.map(hashOf)), view.nodes, lineage)
        //載體之時間切分(2026-09-25):ctx.carriers 由領域自現存工件推導(如自既有工件, 含由節點自動建立者), 不依時間切分 ⇒
        //  規格 = 樹上某節點、該節點由搜尋所得(origin.topic ≠ 'carrier':展開 / 轉折 / 生成 / 手登)且於本切分尚不可見者, 是該節點被發現(建立)後才有之載體 ⇒ 不提供
        //  (否則策略經新區域額度「提前揭露」未來之發現;某次實測:32 個切分中 26 個之 bestS 來自此類載體, 如某載體 = 某節點(第 10 輪由展開發現)使切分 0 ~ 9 之 bestS 皆同值)
        //  origin.topic = 'carrier' 之節點(載體先存在、後被提出入樹)與規格不在樹上之載體照常提供
        if (ctx && isPlainObject(ctx.carriers)) {
            ctx = { ...ctx, carriers: pickBy(ctx.carriers, (spec) => { let n = byHash.get(specHash(spec)); return !n || visible.has(n.id) || get(n, 'origin.topic') === 'carrier' }) }
        }
        let plan
        try { plan = policyFn(view, { arms: O.arms, novelty: O.novelty, global: O.global, workers: 8 }, ctx) }
        catch (e) { return { J: -Infinity, error: String(e && e.message || e), revealed: 0, unknown: 0, cost: 0, bestS: 0, targets, revealedIds: [], globalShort: O.rounds, structuralShort: O.rounds } }
        if (O.minGlobal > 0 && (plan.global || []).length < Math.min(O.minGlobal, O.arms)) { globalShort++ }
        if (isFunction(O.structural)) { let v = 1; try { v = Number(O.structural(plan, { view, round: r })) || 0 } catch (e) { v = 1 } if (v > 0) { structuralShort++ } }
        //④ 樹外臂之成本:'visibleMedian' ⇒ 本輪可見之已執行節點之成本中位(切分前之可見量)
        let unkCost = O.defaultReplays === 'visibleMedian' ? (medianOf(vis.map((n) => costOf(n)).filter((c) => isFinite(c) && c > 0)) ?? 24) : O.defaultReplays
        unkCosts.push(unkCost)
        let items = [...(plan.expand || []), ...(plan.novelty || []), ...(plan.global || [])].slice(0, O.arms)
        for (let it of items) {
            used++
            let h = it.specHash || specHash(it.spec)
            let n = byHash.get(h)
            if (n && !visible.has(n.id)) {
                visible.add(n.id)
                let c = costOf(n)
                cost += isFinite(c) ? c : unkCost
                //別名(原料指紋同較早之正本;env.aliasOf):正本已可見 ⇒ 無新資訊, 只記成本(不入揭露、不計 bestS / 目標);正本未可見 ⇒ 等同揭露正本
                //  2026-09-25:原把別名當新發現(其 S = 正本之 S)⇒ 提出「已知父之別名」之策略於做夢得分虛高, 與「視圖排除別名、別名不作父」不對稱
                let canon = alias.get(n.id)
                let m = canon ? byId.get(canon) : n
                if (canon && (!m || visible.has(m.id))) { duplicates++; continue }
                if (canon) { visible.add(m.id) }
                revealed.push(m)
                if (targets[m.id] === null) { targets[m.id] = cost }
            }
            else if (!n) { unknown++; cost += unkCost }
        }
    }
    //①③ 視圖之分數(遮蔽後);有行為格者以 QD(各格達目標階梯之最高 S 之和)為品質項
    let vs = revealed.map((n) => env.viewOf(n, null)).filter((v) => v && v.score)
    let sOf = (v) => get(v, 'score.S', 0) || 0
    let bestS = vs.length ? max(vs.map(sOf)) : 0
    let ladderGain = sum(vs.map((v) => get(v, 'score.ladder', 0) || 0))
    let hasCell = vs.some((v) => get(v, 'score.cell'))
    let qd = hasCell ? sum(map(groupBy(vs.filter((v) => (get(v, 'score.ladder', 0) || 0) >= O.targetLadder && get(v, 'score.cell')), (v) => v.score.cell), (g) => max(g.map(sOf)))) : null
    let nCells = hasCell ? uniq(vs.filter((v) => (get(v, 'score.ladder', 0) || 0) >= O.targetLadder && get(v, 'score.cell')).map((v) => v.score.cell)).length : null
    let util = used / Math.max(1, O.rounds * O.arms)
    let J = (hasCell ? qd : bestS) - O.lambda * cost / 1000 + O.mu * util
    return { J: round(J, 4), bestS, qd: qd === null ? null : round(qd, 3), nCells, ladderGain, revealed: revealed.length, unknown, duplicates, cost, util: round(util, 3), targets, revealedIds: revealed.map((n) => n.id), globalShort, structuralShort, unknownCost: round(mean(unkCosts) || 0, 1) }
}

//策略之整體評分:全樣本 + 時間切分(各歷史輪為起點)+ 回溯測(ladder ≥ targetLadder 者)
//  別名表一次求得(或取 opt.aliasMap), 全樣本與各切分之 simulate 共用
/**
 * 策略之整體評分:全樣本 + 時間切分(各歷史輪為起點)+ 回溯測(階梯 ≥ targetLadder 且非別名者為目標);別名表一次求得(或取 opt.aliasMap),全樣本與各切分共用;留出分數 = 各切分 J 之均值(無切分時為全樣本 J)
 *
 * @param {Function} policyFn 輸入策略
 * @param {Array} nodes 輸入全部節點
 * @param {Object} env 輸入同 simulate
 * @param {Object} [opt={}] 輸入同 simulate
 * @returns {Object} 回傳 { inSample, timeSplits, heldOutMean, targetsFound, nTargets, nCuts, globalShort, minGlobal, structuralShort, structural }
 * @example
 * let nodes = [
 *     { id: 'a', status: 'executed', round: 0, spec: { x: 0 }, score: { S: 1, ladder: 1 }, cost: { replays: 10 } },
 *     { id: 'b', status: 'executed', round: 1, spec: { x: 1 }, score: { S: 5, ladder: 1 }, cost: { replays: 10 } },
 * ]
 * let env = { viewOf: (n) => n, aliasOf: () => new Map(), makeCtx: (executed) => ({ executed }) }
 * let policy = () => ({ expand: [{ spec: { x: 1 } }], novelty: [] })
 * let e = evaluatePolicy(policy, nodes, env, { rounds: 2, arms: 1 })
 * console.log(e.nCuts, e.nTargets, e.timeSplits.length)
 * // => 1 0 1
 */
export let evaluatePolicy = (policyFn, nodes, env, opt = {}) => {
    let O = { ...DEFAULT_SIM, ...opt }
    let rounds = uniq(nodes.filter((n) => n.status === 'executed').map((n) => n.round || 0)).sort((a, b) => a - b)
    //回溯目標不含別名(別名之發現 = 其正本之發現;2026-09-25)
    let alias = O.aliasMap instanceof Map ? O.aliasMap : aliasMapOfNodes(nodes, env)
    //② 目標之階梯以視圖判(遮蔽後;如訓練期之搜尋階梯)
    let ladderOf = (n) => { let v = env.viewOf ? env.viewOf(n, null) : n; return get(v, 'score.ladder', 0) || 0 }
    let targetIds = nodes.filter((n) => n.status === 'executed' && n.score && ladderOf(n) >= O.targetLadder && !alias.has(n.id)).map((n) => n.id)
    let inSample = simulate(policyFn, nodes, env, { ...O, aliasMap: alias, startRound: -1, targetIds })
    let cuts = rounds.slice(0, -1)
    let timeSplits = cuts.map((r0) => ({ startRound: r0, ...simulate(policyFn, nodes, env, { ...O, aliasMap: alias, startRound: r0, targetIds }) }))
    let heldOut = timeSplits.length ? mean(timeSplits.map((t) => t.J)) : inSample.J
    let found = sum(timeSplits.map((t) => size(filter(t.targets, (v) => v !== null))))
    let globalShort = (inSample.globalShort || 0) + sum(timeSplits.map((t) => t.globalShort || 0))
    let structuralShort = (inSample.structuralShort || 0) + sum(timeSplits.map((t) => t.structuralShort || 0))
    return { inSample, timeSplits, heldOutMean: round(heldOut, 4), targetsFound: found, nTargets: targetIds.length, nCuts: cuts.length, globalShort, minGlobal: O.minGlobal, structuralShort, structural: isFunction(O.structural) }
}

//單調接受規則:候選須於留出(時間切分)優於當前達 margin, 且全樣本不劣於當前之 floor(預設 90%);另須滿足探索保底(⑤ globalShort = 0)
/**
 * 單調接受規則:候選須於留出(時間切分)優於當前達 margin,且全樣本不劣於當前之 floor(預設 90%);另須滿足探索保底(globalShort = 0)與結構保底(structuralShort = 0)
 *
 * @param {Object} cur 輸入當前策略之 evaluatePolicy 結果
 * @param {Object} cand 輸入候選之 evaluatePolicy 結果
 * @param {Object} [opt={}] 輸入 { margin:Number(0.05), floor:Number(0.9) }
 * @returns {Object} 回傳 { ok:Boolean, why:String }
 * @example
 * let cur = { heldOutMean: 10, inSample: { J: 10 } }
 * console.log(JSON.stringify(accept(cur, { heldOutMean: 11, inSample: { J: 10 } })))
 * // => {"ok":true,"why":"留出 11 > 10.5;全樣本 10 ≥ 9"}
 *
 * console.log(accept(cur, { heldOutMean: 10.2, inSample: { J: 10 } }).why)
 * // => 留出 10.2 未優於當前 10(需 > 10.5)
 */
export let accept = (cur, cand, { margin = 0.05, floor = 0.9 } = {}) => {
    if (!cand || !isFinite(cand.heldOutMean)) { return { ok: false, why: '候選無有效分數' } }
    if ((cand.globalShort || 0) > 0) { return { ok: false, why: `探索保底不足:${cand.globalShort} 個重放輪之全域臂 < ${cand.minGlobal}(做夢對樹外探索不可識別 ⇒ 不得以做夢分數升版退回純利用)` } }
    if ((cand.structuralShort || 0) > 0) { return { ok: false, why: `結構保底不符:${cand.structuralShort} 個重放輪違反領域之結構約束(dream.structural)⇒ 不得以做夢分數升版撤銷` } }
    if (!cur || !isFinite(cur.heldOutMean)) { return { ok: true, why: '無當前分數' } }
    let need = cur.heldOutMean >= 0 ? cur.heldOutMean * (1 + margin) : cur.heldOutMean * (1 - margin)
    if (!(cand.heldOutMean > need + 1e-9)) { return { ok: false, why: `留出 ${cand.heldOutMean} 未優於當前 ${cur.heldOutMean}(需 > ${round(need, 4)})` } }
    let base = cur.inSample.J >= 0 ? cur.inSample.J * floor : cur.inSample.J * (2 - floor)
    if (cand.inSample.J < base - 1e-9) { return { ok: false, why: `全樣本 ${cand.inSample.J} 低於當前 ${cur.inSample.J} 之 ${floor * 100}%` } }
    return { ok: true, why: `留出 ${cand.heldOutMean} > ${round(need, 4)};全樣本 ${cand.inSample.J} ≥ ${round(base, 4)}` }
}

export default { simulate, evaluatePolicy, accept, aliasMapOfNodes, DEFAULT_SIM }
