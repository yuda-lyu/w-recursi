import fs from 'fs'
import path from 'path'
import countBy from 'lodash-es/countBy.js'
import get from 'lodash-es/get.js'
import isArray from 'lodash-es/isArray.js'
import isFunction from 'lodash-es/isFunction.js'
import isString from 'lodash-es/isString.js'
import last from 'lodash-es/last.js'
import maxBy from 'lodash-es/maxBy.js'
import _pick from 'lodash-es/pick.js'
import _round from 'lodash-es/round.js'
import size from 'lodash-es/size.js'
import sum from 'lodash-es/sum.js'
import toPairs from 'lodash-es/toPairs.js'
import uniq from 'lodash-es/uniq.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { specHash, nodeIdOf, nowIso } from '../core/canonical.mjs'
import { readJson, writeJson } from '../core/jsonl.mjs'
import { listRoundDirs, roundNumOf, roundNameOf } from '../core/paths.mjs'
import { assertWriteRoot } from '../core/writeRoot.mjs'
import { makeNode } from '../tree/node.mjs'
import { OCCUPIED, STATUS } from '../tree/store.mjs'
import { runJobs } from '../eval/runner.mjs'
import { reportOf } from './report.mjs'
import { aliasShortOfDomain } from '../core/domainContract.mjs'
import { extractTurning } from '../search/turning.mjs'
import { noveltyDebtOf, generationCheck, clearGenRequest, isGenerationFulfilled, readGenRequest, startHeartbeat, HEARTBEAT_MS } from './generation.mjs'


//輪次目錄:原子取號(mkdir 非遞迴;撞號即 +1 重試), 多 session 同時起跑不會共用同一輪
//  輪夾之名與序(2026-10-09;審查):單一來源 core/paths.mjs(isRoundDir / roundNumOf / listRoundDirs)—— 原 `.sort()` 為字典序 ⇒ r1000 起 [r1000, r998, r999] 之末為 r999
//    (peekRound 取錯而靠撞號重試、loadSummaries 之序亂 ⇒ 連續欠額 / 策略開發之「最近兩輪」/ status 之末 5 輪皆錯);今依輪號升冪;非正規名(r0999、r000)不列
//  寫域守門(2026-10-09;core/writeRoot.mjs):建輪夾前 assertWriteRoot(RSI_WRITE_ROOT 未設 ⇒ 不檢)
/**
 * 列出狀態根下之輪夾名(依輪號升冪)
 *
 * @param {Object} paths 輸入 makePaths 之回傳
 * @returns {Array} 回傳輪夾名陣列
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 * import { makePaths } from 'w-recursi/src/core/paths.mjs'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let paths = makePaths(dir)
 * paths.ensure()
 * fs.mkdirSync(paths.fdRound(2))
 * fs.mkdirSync(paths.fdRound(10))
 * console.log(roundDirs(paths).join(' '))
 * // => r002 r010
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let roundDirs = (paths) => listRoundDirs(paths.rounds)
/**
 * 下一輪之輪號(末輪 + 1;無輪夾 ⇒ 1;不建夾)
 *
 * @param {Object} paths 輸入 makePaths 之回傳
 * @returns {Number} 回傳輪號
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 * import { makePaths } from 'w-recursi/src/core/paths.mjs'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let paths = makePaths(dir)
 * console.log(peekRound(paths))
 * // => 1
 * paths.ensure()
 * fs.mkdirSync(paths.fdRound(999))
 * console.log(peekRound(paths))
 * // => 1000
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let peekRound = (paths) => { let ds = roundDirs(paths); return ds.length ? roundNumOf(last(ds)) + 1 : 1 }
/**
 * 輪次目錄之原子取號(mkdir 非遞迴,撞號即 +1 重試):多 session 同時起跑不會共用同一輪;受寫域守門約束
 *
 * @param {Object} paths 輸入 makePaths 之回傳
 * @returns {Object} 回傳 { round, fd }
 * @throws {Error} 取不到輪號、目標不在允許之寫入根下時拋出
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 * import { makePaths } from 'w-recursi/src/core/paths.mjs'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let paths = makePaths(dir)
 * let a = allocateRound(paths)
 * let b = allocateRound(paths)
 * console.log(a.round, b.round, path.basename(b.fd))
 * // => 1 2 r002
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let allocateRound = (paths) => {
    paths.ensure()
    for (let k = 0; k < 10000; k++) {
        let n = peekRound(paths) + k
        let fd = paths.fdRound(n)
        assertWriteRoot(fd, { what: 'allocateRound(建輪夾)' })
        try { fs.mkdirSync(fd, { recursive: false }); return { round: n, fd } }
        catch (e) { if (e.code !== 'EEXIST') { throw e } }
    }
    throw new Error('allocateRound: 取不到輪號')
}
/**
 * 讀各輪之 summary.json(依輪序;無 summary 之輪略過)
 *
 * @param {Object} paths 輸入 makePaths 之回傳
 * @returns {Array} 回傳 summary 物件陣列
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 * import { makePaths } from 'w-recursi/src/core/paths.mjs'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let paths = makePaths(dir)
 * paths.ensure()
 * for (let n of [1, 2]) { fs.mkdirSync(paths.fdRound(n)) }
 * fs.writeFileSync(path.join(paths.fdRound(1), 'summary.json'), JSON.stringify({ round: 1 }))
 * console.log(loadSummaries(paths).length)
 * // => 1
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let loadSummaries = (paths) => roundDirs(paths).map((d) => readJson(path.join(paths.rounds, d, 'summary.json'), null)).filter(Boolean)

//前緣條目之結案判讀(2026-09-29;純函式):本輪之結果 → store.resolveFrontier 之 outcomes
//  節點 executed ⇒ executed;閘門拒絕(後閘之節點 / 前閘之存根有寫入者)⇒ rejectedByGate(附理由);評估錯誤 ⇒ error(附錯誤摘要;前緣維持 proposed 並記 retries)
//  前閘拒絕而同 id 節點已被占用(存根未寫)⇒ 不動前緣(該規格之既有節點另有歸屬)
/**
 * 前緣條目之結案判讀(純函式):本輪之結果 → store.resolveFrontier 之 outcomes;執行 ⇒ executed、閘門拒絕 ⇒ rejectedByGate(附理由)、評估錯誤 ⇒ error(附錯誤摘要);前閘拒絕而同 id 節點已被占用(存根未寫)⇒ 不動前緣
 *
 * @param {Array} nodes 輸入本輪入樹之節點
 * @param {Array} rejected 輸入本輪被前閘拒絕之計畫項
 * @returns {Array} 回傳 [{ specHash, status, why }]
 * @example
 * let nodes = [{ specHash: 'h1', status: 'executed' }, { specHash: 'h2', status: 'error', notes: { error: 'boom' } }]
 * console.log(JSON.stringify(frontierOutcomesOf(nodes, [{ specHash: 'h3', why: 'gate' }])))
 * // => [{"specHash":"h1","status":"executed","why":null},{"specHash":"h2","status":"error","why":"boom"},{"specHash":"h3","status":"rejectedByGate","why":"gate"}]
 */
export let frontierOutcomesOf = (nodes, rejected) => [
    ...(nodes || []).map((n) => ({ specHash: n.specHash || specHash(n.spec), status: n.status, why: n.status === STATUS.ERROR ? get(n, 'notes.error', null) : n.status === STATUS.REJECTED ? get(n, 'notes.why', null) : null })),
    ...(rejected || []).filter((r) => !r.stubSkipped).map((r) => ({ specHash: r.specHash || specHash(r.spec), status: STATUS.REJECTED, why: r.why || null })),
].filter((o) => [STATUS.EXECUTED, STATUS.REJECTED, STATUS.ERROR].includes(o.status))

//—— 父指紋提示(2026-09-29:子與父之本臂逐位同卻整臂評估含冗餘計算, 某對節點耗 132 分)——
//  cfg.aliasPre === true 才附(預設不附 = 舊行為):帶父之臂之 job 協定附 aliasPre: { fps: [{ id, fp }] }(fp = domain.fingerprint(父.raw, 父);null / 缺原料者略過)
//  領域評估器據以於本臂評估後判「行為別名」(本臂指紋 ∈ fps)而略過冗餘計算(如領域評估器於 raw 記略過標記;逐位精確, 非抽樣)
//  父 = 計畫項之 parentId(≠ root;展開與其對照臂)、parents(陣列;策略若給)、origin.from(轉折點提取之來源節點:搬移 [來源父, 來源子, 目標父]、外推 [父, 子]、交叉 [祖先, a, b])
//    —— 多父全附:指紋相等為逐位精確之判定, 多附只增加命中機會, 不致誤判
/**
 * 計畫項之全部父節點 id(parentId ≠ root、parents、轉折點提取之 origin.from;去重去 root):多父全附,指紋相等為逐位精確之判定,多附只增加命中機會
 *
 * @param {Object} it 輸入計畫項
 * @returns {Array} 回傳父 id 陣列
 * @example
 * console.log(parentIdsOf({ parentId: 'p1', parents: ['p2', 'root'], origin: { from: ['p1', 'p3'] } }).join(','))
 * // => p1,p2,p3
 */
export let parentIdsOf = (it) => uniq([
    ...(it && it.parentId && it.parentId !== 'root' ? [it.parentId] : []),
    ...(isArray(get(it, 'parents')) ? it.parents : []),
    ...(isArray(get(it, 'origin.from')) ? it.origin.from : []),
].filter((x) => isString(x) && x && x !== 'root'))
//計畫項 → aliasPre 協定欄({ fps } | null);fpOf(id) → 指紋 | null(呼叫端備忘)
/**
 * 計畫項 → aliasPre 協定欄(cfg.aliasPre 為真時附於 job 協定,供領域評估器於本臂評估後判「行為別名」而略過冗餘計算):每個父附其指紋;指紋 null 者略過;全無 ⇒ null
 *
 * @param {Object} it 輸入計畫項
 * @param {Function} fpOf 輸入 (父 id) => 指紋字串或 null
 * @returns {Object|null} 回傳 { fps:[{ id, fp }] } 或 null
 * @example
 * console.log(JSON.stringify(aliasPreOf({ parentId: 'p1' }, (id) => 'fp-' + id)))
 * // => {"fps":[{"id":"p1","fp":"fp-p1"}]}
 *
 * console.log(aliasPreOf({ parentId: 'root' }, () => 'x'))
 * // => null
 */
export let aliasPreOf = (it, fpOf) => { let fps = parentIdsOf(it).map((id) => ({ id, fp: fpOf(id) })).filter((x) => isString(x.fp) && x.fp); return fps.length ? { fps } : null }
//行為別名短路之判讀:領域鉤子 domain.aliasShortOf(node) → { of, what? } | null(2026-10-01 起;引擎不讀領域原料之欄位;包裝 aliasShortOfDomain 在 core/domainContract.mjs)
//(相容;2026-10-01 起引擎不再使用)舊領域評估器之標記判式 —— 已移為領域之 domain.aliasShortOf, 本匯出只供舊腳本
/**
 * (相容;2026-10-01 起引擎不再使用)以領域原料之固定欄位判定行為別名短路;現由領域鉤子 domain.aliasShortOf 取代,本匯出只供舊腳本
 *
 * @param {Object} n 輸入節點
 * @returns {Boolean} 回傳是否為別名短路
 * @example
 * console.log(isAliasShort({ raw: {} }))
 * // => false
 */
export let isAliasShort = (n) => get(n, 'raw.sameDose.skipped') === 'aliasPre'
//認領衝突之重計畫之補額(純函式;cfg.claims.replanFillOnly, 2026-10-02):目標 = 第一次計畫之通過臂(target), 已得 = 本 session 已認領之臂(got)
//  自 fresh(重計畫之新臂, 依新計畫之原序)先補各流(kindOf)之缺(目標之該流數 − 已得之該流數), 再依原序補足總數(target.length − got.length);總數已足 ⇒ [];新臂不足 ⇒ 全收
/**
 * 認領衝突之重計畫之補額(純函式;cfg.claims.replanFillOnly):目標 = 第一次計畫之通過臂,已得 = 本 session 已認領之臂;自重計畫之新臂(依新計畫之原序)先補各流(kindOf)之缺,再依原序補足總數;總數已足 ⇒ [];新臂不足 ⇒ 全收
 *
 * @param {Array} fresh 輸入重計畫之新臂
 * @param {Array} target 輸入第一次計畫之通過臂
 * @param {Array} got 輸入已認領之臂
 * @returns {Array} 回傳應補入之臂
 * @example
 * let fresh = [{ id: 1, kindOf: 'expand' }, { id: 2, kindOf: 'novelty' }, { id: 3, kindOf: 'expand' }]
 * let target = [{ kindOf: 'expand' }, { kindOf: 'novelty' }, { kindOf: 'novelty' }]
 * let got = [{ kindOf: 'expand' }]
 * console.log(replanFillOf(fresh, target, got).map((x) => x.id).join(','))
 * // => 1,2
 */
export let replanFillOf = (fresh, target, got) => {
    let need = target.length - got.length
    if (need <= 0) { return [] }
    let want = countBy(target, 'kindOf')
    for (let [k, v] of toPairs(countBy(got, 'kindOf'))) { want[k] = (want[k] || 0) - v }
    let pick = new Set()
    for (let i = 0; i < fresh.length && pick.size < need; i++) { let k = fresh[i].kindOf; if ((want[k] || 0) > 0) { want[k]--; pick.add(i) } }
    for (let i = 0; i < fresh.length && pick.size < need; i++) { pick.add(i) }
    return fresh.filter((x, i) => pick.has(i))
}

//一輪探索:回收遺留認領 → 策略出計畫 → 驗證 / 閘門 → 認領(鎖內, 他 session 已領者跳過)→ 平行評估 → 入樹 → 報告
//  opt: { arms, novelty, workers, dry, by, protocol }
//  輪次存活心跳(2026-09-29;generation.mjs):本體於取號後起心跳, 寫出 summary.json 時撤除;本體拋錯 ⇒ 停心跳(檔留存 ⇒ 他輪以 pid 已死或心跳停止判本輪之生成請求標記失效)
//  新區域欠額之計數時點(2026-10-02):預設於第一次計畫之後(舊行為);cfg.generation.debtAfterClaims === true ⇒ 於認領 / 重計畫之後以實得(mine)計,
//    生成判定(寫請求 / streak)隨之移至認領之後;summary.noveltyDebtPlan 另記第一次計畫之值(僅 opt 開時有此欄);乾跑無認領 ⇒ 恆為計畫值
/**
 * 一輪探索工廠(createRsi 以之組 rsi.explore):回收遺留認領 → 轉折點提取 → 策略出計畫 → 驗證 / 閘門 → 認領(鎖內,他 session 已領者跳過並重計畫)→ 平行評估 → 入樹 → 前緣結案 → 報告。選臂(opt.useArms 或 cfg.arms.use)被拒 ⇒ 於取輪號前拋 RSI_ARMS_REJECTED,不開輪
 *
 * @param {Object} rsi 輸入 createRsi 組出之實例
 * @returns {Function} 回傳 async (opt) => 結果;opt: { arms, novelty, workers, dry, by, protocol, useArms, reopen, global }
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
 * let ex = await rsi.explore({ by: 'demo' })
 * console.log(ex.round, ex.items.length, ex.summary.nExecuted)
 * // => 1 1 1
 *
 * let dry = await rsi.explore({ dry: true })
 * console.log(dry.dry, dry.round, dry.items.length)
 * // => true 2 1
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let makeExplore = (rsi) => async (opt = {}) => {
    let hbBox = { hb: null }
    try { return await exploreOnce(rsi, opt, hbBox) }
    catch (e) { if (hbBox.hb) { hbBox.hb.stop(false) } throw e }
}
let exploreOnce = async (rsi, opt, hbBox) => {
    let { paths, store, view, domain, budget } = rsi
    let O = { ...budget, dry: false, by: `pid${process.pid}`, ...opt }
    //臂限制(2026-11-07;search/arms.mjs):opt.useArms(陣列)或 cfg.arms.use ⇒ 本輪只用所選臂之算子(展開與對照)與載體(新區域);全域取樣臂與他臂之前緣 / 載體一律略過(記計畫備註)
    //  選臂被拒(封鎖 / 不可選 / done 未附 reopen / 衝突 / 依賴缺)⇒ 拋錯(code RSI_ARMS_REJECTED), 於取輪號之前 ⇒ 不開輪、不寫任何檔;未給 ⇒ 逐字不變
    let useArms = isArray(O.useArms) && O.useArms.length ? O.useArms : (size(get(rsi.cfg, 'arms.use')) ? rsi.cfg.arms.use : null)
    let armsReopen = O.reopen || get(rsi.cfg, 'arms.defaults.reopen', null) || null
    let R = null
    if (useArms) {
        let pk = rsi.arms.pick(useArms, { reopen: armsReopen })
        if (pk.rejected.length) { throw Object.assign(new Error(`explore: 選臂(useArms)被拒:${pk.rejected.map((r) => `${r.id}(${r.why})`).join('、')}`), { code: 'RSI_ARMS_REJECTED', rejected: pk.rejected }) }
        useArms = pk.ok.map((a) => a.id)
        R = rsi.arms.restrict(useArms)
    }
    //計畫項 ⇒ 所屬之臂 id(有目錄時才記;無目錄 ⇒ [] 不寫 ⇒ plan.json 與節點之 origin 與改前逐字同)
    let armsOfItem = (it) => (!rsi.arms.size ? [] : R ? R.armsOfItem(it) : (it.op ? rsi.arms.armsOfOp(it.op) : []))
    paths.ensure()
    let reclaimed = O.dry ? [] : store.reclaimStale()
    let pol = await rsi.loadPolicy()
    let nodesAll = view.policyView()
    let nodesView = nodesAll.filter((n) => !n.aliasOf)
    let executed = new Set(nodesAll.filter((n) => OCCUPIED.has(n.status)).map((n) => specHash(n.spec)))
    let alloc = O.dry ? { round: peekRound(paths), fd: null } : allocateRound(paths)
    let { round, fd } = alloc
    if (!O.dry) { hbBox.hb = startHeartbeat(fd, { ms: get(rsi.cfg, 'generation.heartbeatMs', HEARTBEAT_MS) }) }
    //轉折點提取:由樹推導新臂(搬移 / 外推 / 交叉)→ 前緣 arm(策略之新區域額度取用);乾跑只併入本次視圖不寫前緣
    //  proposalBlock(2026-10-04):三種提案之產生端守門(domain.proposalBlock;未給 ⇒ 舊行為逐字), 擋下者入 turning.blocked(by proposalBlock)
    let turning = null
    let tcfg = get(rsi.cfg, 'turning', {}) || {}
    if (tcfg.enabled !== false) {
        turning = extractTurning(nodesAll, { registry: rsi.registry, validateSpec: domain.validateSpec, occupied: executed, minGain: tcfg.minGain, topParents: tcfg.topParents, maxProposals: tcfg.maxProposals, excludeParent: domain.excludeParent, isAnchor: domain.isAnchor, transferBlock: domain.transferBlock, parentOk: domain.turningParentOk || null, normSpec: domain.normSpec || null, proposalBlock: domain.proposalBlock || null })
        if (!O.dry && turning.proposals.length) { store.pushFrontier(turning.proposals) }
    }
    let frontier = store.listFrontier()
    if (O.dry && turning) { for (let p of turning.proposals) { if (!frontier.some((f) => f.specHash === p.specHash)) { frontier.push({ ...p, status: 'proposed', proposedAt: nowIso() }) } } }
    let budgetObj = { arms: O.arms, novelty: O.novelty, global: O.global || 0, workers: O.workers }
    //計畫項之 origin(認領 / 入樹之節點與生成端排除鉤子之 ctx 同一來源;2026-10-09 自 toClaimOf 抽出, 式逐字同)
    let armOriginOf = (it) => ({ topic: get(it, 'origin.topic', 'policy'), operator: it.op || get(it, 'origin.operator', null) || 'novelty', reason: it.reason || '', policy: pol.meta, controlOf: it.controlOf || null, ...(size(it.arms) ? { arms: it.arms } : {}), ...get(it, 'originExtra', {}) })
    //生成端之臂排除(2026-10-09;domain.excludeArm, 契約見 core/domainContract.mjs):validateSpec 與 gates.pre 之後問領域;exclude ⇒ 入 rejected(excluded: true)
    //  ⇒ 與閘門拒絕同一路徑:拒絕存根(notes.excluded)、前緣結案 rejectedByGate、報告之「閘門拒絕」節;本輪重計畫之占用集合併入(不再提);鉤子拋錯 ⇒ 不排除並記計畫備註;未給 ⇒ 逐字不變
    let exArm = isFunction(domain.excludeArm)
    //出計畫 → 驗證 / 前置閘 → 節點 id;回 { plan, ok, rejected }
    //roundPlanned(2026-10-02):本輪已認領之臂(認領衝突後之重計畫才非空)⇒ ctx.roundPlanned, 使策略之「每輪上限」(如領域策略之族上限)可承接;不讀者行為不變
    let makePlan = (occupied, roundPlanned = []) => {
        let viewObj = { round, nodes: nodesView, frontier }
        let exErr = []
        let ctx = rsi.makeCtx(occupied, nodesView, nodesAll, { useArms }) //譜系(第三參數)用全樹視圖(含別名;與轉折點提取之 byId 同一全集);useArms ⇒ 算子 / 載體限所選臂
        ctx.roundPlanned = roundPlanned
        let plan = pol.fn(viewObj, budgetObj, ctx)
        plan.policy = pol.meta
        //臂限制之後濾(2026-11-07):策略仍可能自行取樣(plan.global)或自前緣取他臂之規格 ⇒ 不在所選臂之算子 / 載體內者一律略過(策略視圖與 ctx 已限, 此為保證)
        if (R) {
            let drop = {}
            for (let k of ['expand', 'novelty', 'global']) { let all = plan[k] || []; let keep = all.filter((x) => R.allowItem({ ...x, kindOf: k })); drop[k] = all.length - keep.length; plan[k] = keep }
            plan.notes = [...(plan.notes || []), `臂限制(${useArms.join(', ')}):只用算子 ${R.ops.join(' / ') || '—'}、載體 ${R.carriers.join(' / ') || '—'};略過計畫項 ${drop.expand + drop.novelty + drop.global}(展開 ${drop.expand} / 新區域 ${drop.novelty} / 全域 ${drop.global})`]
        }
        //展開鉤子(domain.childBlock;2026-09-25)擋下之子:列入策略備註(同一子可被多次查詢, 以 specHash 去重)
        let blk = uniqBy(ctx.blockedChildren || [], 'specHash')
        if (blk.length) { plan.notes = [...(plan.notes || []), `展開鉤子擋下 ${blk.length} 子(${blk.map((b) => `${b.op}@${String(b.parentId || '?').slice(0, 6)}:${b.why}`).join(';')})`] }
        //plan.global(2026-09-27):策略之全域取樣臂(根節點;origin.topic 'global')—— 與 novelty 分列:新區域欠額只計 novelty 與取自前緣之展開(generation.noveltyDebtOf), 全域臂不使生成請求消失
        let items = [...(plan.expand || []).map((x) => ({ ...x, kindOf: 'expand' })), ...(plan.novelty || []).map((x) => ({ ...x, kindOf: 'novelty', parentId: 'root' })), ...(plan.global || []).map((x) => ({ ...x, kindOf: 'global', parentId: 'root' }))]
        for (let it of items) { let as = armsOfItem(it); if (as.length) { it.arms = as } } //臂目錄:計畫項之所屬臂(入 origin.arms;無目錄 ⇒ 不寫)
        let rejected = [], ok = []
        for (let it of items) {
            let env = isFunction(domain.envHash) ? domain.envHash(it.spec) : ''
            let id = nodeIdOf(it.spec, env)
            try { if (isFunction(domain.validateSpec)) { domain.validateSpec(it.spec) } }
            catch (e) { rejected.push({ ...it, id, why: e.message }); continue }
            if (get(domain, 'gates.pre')) { let g = domain.gates.pre(it.spec, { view: viewObj }); if (g && g.ok === false) { rejected.push({ ...it, id, why: g.why || 'pre gate' }); continue } }
            let sh = it.specHash || specHash(it.spec)
            if (exArm) {
                let x = null
                try { x = domain.excludeArm(it.spec, { id, spec: it.spec, specHash: sh, parent: it.parentId || 'root', kindOf: it.kindOf, op: it.op || null, origin: armOriginOf(it), round, item: _pick(it, ['op', 'controlOf', 'kindOf', 'parentId', 'reason', 'origin']) }) }
                catch (e) { exErr.push(`${String(id).slice(0, 8)}:${String((e && e.message) || e).slice(0, 120)}`) }
                if (x && x.exclude === true) { rejected.push({ ...it, id, specHash: sh, why: x.why || 'excludeArm', excluded: true }); continue }
            }
            ok.push({ ...it, id, specHash: sh, envHash: env, policy: pol.meta })
        }
        if (exErr.length) { plan.notes = [...(plan.notes || []), `生成端排除鉤子 excludeArm 拋錯 ${exErr.length} 臂(視同不排除):${exErr.slice(0, 3).join(';')}${exErr.length > 3 ? ' …' : ''}`] }
        return { plan, ok: uniqBy(ok, 'id'), rejected }
    }
    let toClaimOf = (ok) => ok.map((it) => ({ id: it.id, spec: it.spec, specHash: it.specHash, parentId: it.parentId || 'root', origin: armOriginOf(it), evidence: it.evidence || null, notes: it.notes || null }))
    let { plan, ok, rejected } = makePlan(executed)
    //欠額:新區域額度填不滿 ⇒ 生成請求(全域一份;由生成代理於本輪生成新算子 / 載體 / 條件變數)
    let frontierArms = new Set(frontier.filter((f) => f.status === 'proposed' && (f.kind || 'arm') === 'arm').map((f) => f.specHash))
    let debt = noveltyDebtOf(plan, budgetObj, frontierArms)
    if (O.dry) { return { round, fd: null, dry: true, plan, items: ok, rejected, skipped: [], nodes: [], reclaimed, turning, debt, generation: null, summary: null, ...(useArms ? { useArms, armsReopen } : {}) } }
    //cfg.generation.debtAfterClaims(2026-10-02;預設 false = 舊行為):生成判定延至認領 / 重計畫之後(見認領段末), 以實得計欠額
    //  為何:第一次計畫之新區域臂可被他 session 先認領, 供給告罄時重計畫補不回(只補得展開 / 全域臂)⇒ 以計畫計「得」記欠 0 ⇒ 生成請求不寫、連續欠額(streak)歸零
    //  (某次實測:需 2、第一次計畫得 2、重計畫後實得 0 而記欠 0;連續欠額因而歸零)
    let debtAfterClaims = get(rsi.cfg, 'generation.debtAfterClaims', false) === true
    let generation = debtAfterClaims ? null : generationCheck(rsi, fd, { debt, turning, plan, sums: loadSummaries(paths) })
    //本輪計畫當下所見之全域生成請求(2026-09-29):輪末兌現時只清「本輪所見 / 本輪所寫」之標記(generation.clearGenRequest 之 seen)
    let genSeen = readGenRequest(paths)
    //閘門拒絕 → 存根(rejectedByGate, 附理由);同 id 節點已被占用(已執行 / 認領中 / 已拒;OCCUPIED)⇒ 不寫(store.putNode 之 skipIfStatus, 鎖內判)
    //  2026-09-29:原以 putNode 直接覆寫 ⇒ 策略(或升版之候選)重提「已執行而 validateSpec 已收緊」之規格時, raw: null 之存根蓋掉已執行節點(某策略版本以 ctx.executed 自擋, 引擎不擋)
    let statusAtStart = new Map(nodesAll.map((n) => [n.id, n.status]))
    for (let r of rejected) {
        let row = store.putNode(makeNode({ id: r.id, spec: r.spec, parent: r.parentId || 'root', round, origin: { topic: 'policy', operator: r.op || 'novelty', reason: r.reason || '' }, raw: null, envHash: isFunction(domain.envHash) ? domain.envHash(r.spec) : '', status: STATUS.REJECTED, notes: { why: r.why, ...(r.excluded ? { excluded: true } : {}) } }, domain), { skipIfStatus: OCCUPIED })
        if (!row) { r.stubSkipped = statusAtStart.get(r.id) || 'occupied' }
    }
    //認領(鎖內原子);他 session 已領走者跳過 → 以「已占用 ∪ 被跳過」重新出計畫再認領(最多 3 次), 使併行 session 自然分到不同臂而非空轉
    let toClaim = toClaimOf(ok)
    let { claimed, skipped } = store.claimNodes(toClaim, { round, by: O.by })
    let mine = ok.filter((it) => claimed.some((c) => c.id === it.id))
    let replans = 0
    let occupied = new Set(executed)
    for (let r of rejected) { if (r.excluded) { occupied.add(r.specHash) } } //生成端排除之臂:重計畫不再提(閘門拒絕者維持舊行為)
    //cfg.claims.replanFillOnly(2026-10-02;預設 false = 舊行為):重計畫只補被他 session 先領之額(replanFillOf:依第一次計畫之各流組成補同流, 不足依新計畫之原序)
    //  舊行為:策略依整份預算重出計畫、新臂全收 ⇒ 實計畫臂數可達「已認領 + 整份新計畫」(某些輪超出預算 2 ~ 4 臂, 各流之額比失真)
    //  notesReplans:各次重計畫之策略備註(整份新計畫之備註;opt 開時只取其中補額之臂)⇒ plan.json(有重計畫時);第一次計畫之 notes 照舊為 plan.notes
    let fillOnly = get(rsi.cfg, 'claims.replanFillOnly', false) === true
    let notesReplans = []
    while (skipped.length && mine.length < ok.length && replans < 3) {
        replans++
        for (let s of skipped) { occupied.add(s.specHash || specHash(s.spec)) }
        for (let it of mine) { occupied.add(it.specHash) }
        let again = makePlan(occupied, mine.map((it) => _pick(it, ['id', 'kindOf', 'parentId', 'op', 'specHash', 'controlOf', 'spec'])))
        notesReplans.push(again.plan.notes || [])
        let fresh = again.ok.filter((it) => !mine.some((m) => m.id === it.id) && !skipped.some((s) => s.id === it.id))
        if (fillOnly) { fresh = replanFillOf(fresh, ok, mine) }
        if (!fresh.length) { break }
        let r2 = store.claimNodes(toClaimOf(fresh), { round, by: O.by })
        mine = [...mine, ...fresh.filter((it) => r2.claimed.some((c) => c.id === it.id))]
        toClaim = [...toClaim, ...toClaimOf(fresh)]
        skipped = [...skipped, ...r2.skipped]
        if (!r2.claimed.length) { break }
    }
    //debtAfterClaims:「得」改以本 session 實際認領之臂(mine)計 —— 與第一次計畫同一定義(generation.noveltyDebtOf 之 items:novelty 項 + 取自前緣之展開;global 不計)
    //  debt.at = 'claims';debt.firstPlan = 第一次計畫之值(summary.noveltyDebtPlan 與報告並列, 供對照兩口徑);寫請求 / streak 用認領後之值
    //  本輪所見之標記(genSeen)仍為第一次計畫當下所讀(計畫後才出現之他輪標記不由本輪清除);本輪自寫之標記由輪名判(clearGenRequest 之 round)
    if (debtAfterClaims) {
        debt = { ...noveltyDebtOf(plan, budgetObj, frontierArms, mine), at: 'claims', firstPlan: _pick(debt, ['need', 'got', 'debt', 'fromFrontier']) }
        generation = generationCheck(rsi, fd, { debt, turning, plan, sums: loadSummaries(paths) })
    }
    writeJson(path.join(fd, 'plan.json'), { round, at: nowIso(), by: O.by, policy: pol.meta, budget: budgetObj, replans, items: mine.map((x) => _pick(x, ['id', 'kindOf', 'parentId', 'op', 'specHash', 'reason', 'controlOf', 'spec', 'arms'])), skipped: skipped.map((s) => _pick(s, ['id', 'why', 'spec'])), rejected: rejected.map((r) => _pick(r, ['id', 'why', 'spec', 'stubSkipped', 'excluded'])), requests: plan.requests || [], notes: plan.notes, ...(replans ? { notesReplans, replanFillOnly: fillOnly } : {}), ...(useArms ? { useArms, armsReopen } : {}), stop: plan.stop, reclaimed })
    let t0 = Date.now()
    let nodes = []
    let jobsCommit = null
    let finish = () => {
        //前緣結案(2026-09-29;原不分成敗一律標 executed ⇒ 只經前緣進入之臂(生成型算子、轉折)評估錯誤後永不重試):
        //  executed ⇒ executed;閘門拒絕 ⇒ rejectedByGate;評估錯誤 ⇒ 維持 proposed 並記 retries(達 cfg.frontier.maxRetries(預設 2)⇒ status blocked, 原因入 note)
        let frontierRes = store.resolveFrontier(frontierOutcomesOf(nodes, rejected), { maxRetries: get(rsi.cfg, 'frontier.maxRetries', 2), round })
        let execNodes = nodes.filter((n) => n.status === 'executed')
        let best = maxBy(execNodes, (n) => n.score.S)
        //行為別名短路(cfg.aliasPre 時才列):本臂指紋 = 某父 ⇒ 評估器略過部分計算;判定由領域鉤子 domain.aliasShortOf(2026-10-01 起;原寫死讀領域原料之欄位)
        let aliasOn = get(rsi.cfg, 'aliasPre', false) === true
        let aliasShortOf = aliasShortOfDomain(domain)
        let summary = { round, at: nowIso(), by: O.by, nPlanned: mine.length, nSkipped: skipped.length, replans, noveltyDebt: debt.debt, noveltyNeed: debt.need, ...(debt.firstPlan ? { noveltyDebtPlan: debt.firstPlan.debt } : {}), nTurning: turning ? turning.proposals.length : 0, generation: generation && generation.fp ? generation.fp : null, nExecuted: execNodes.length, nError: nodes.filter((n) => n.status === 'error').length, nRejected: rejected.length, ladderGe1: execNodes.filter((n) => (n.score.ladder || 0) >= 1).length, ladders: countBy(execNodes, (n) => n.score.ladder), bestS: best ? { id: best.id, S: best.score.S, summary: (domain.summarize || JSON.stringify)(best.spec) } : null, replays: sum(execNodes.map((n) => get(n, 'cost.replays', 0) || 0)), wallSec: _round((Date.now() - t0) / 1000), policy: pol.meta, ...(aliasOn ? { nAliasShort: nodes.filter((n) => aliasShortOf(n)).length } : {}), ...(useArms ? { useArms } : {}) }
        //生成已兌現(本輪有 origin.topic = generated 之節點, 或經新區域進入之 operator kind 節點執行;generation.isGenerationFulfilled, 2026-09-27)⇒ 清除全域生成請求
        //  2026-09-29:只清本輪所見 / 所寫之標記(policies 鎖內);計畫後才出現之他輪標記保留
        let genClear = isGenerationFulfilled(execNodes, new Map(mine.map((x) => [x.id, x.kindOf]))) ? clearGenRequest(rsi, { round: path.basename(fd), seen: genSeen }) : null
        writeJson(path.join(fd, 'summary.json'), summary)
        if (hbBox.hb) { hbBox.hb.stop(true) } //summary.json 已寫 ⇒ 本輪之完成訊號已在, 心跳檔撤除
        assertWriteRoot(path.join(fd, 'report.md'), { what: 'explore(report.md)' })
        fs.writeFileSync(path.join(fd, 'report.md'), reportOf(rsi, round, plan, nodes, rejected, { skipped, items: mine, replans, by: O.by, turning, debt, generation, genClear, frontierRes, aliasShort: summary.nAliasShort, useArms, armsReopen }))
        return { round, fd, plan, items: mine, rejected, skipped, replans, nodes, reclaimed, turning, debt, generation, genClear, frontierRes, jobsCommit, summary, ...(useArms ? { useArms, armsReopen } : {}) }
    }
    if (!mine.length) { return finish() }
    let baseProtocol = O.protocol || get(domain, 'evaluator.protocol', null) || undefined
    //父指紋提示(cfg.aliasPre):父節點於本輪讀一次(備忘);領域未給 fingerprint 或父無原料 ⇒ 略過
    let fpMemo = new Map()
    let fpOf = (id) => {
        if (!fpMemo.has(id)) { let fp = null; try { let n = store.getNode(id); fp = n && n.raw && isFunction(domain.fingerprint) ? (domain.fingerprint(n.raw, n) || null) : null } catch (e) { fp = null } fpMemo.set(id, fp) }
        return fpMemo.get(id)
    }
    let jobs = mine.map((it) => { let ap = get(rsi.cfg, 'aliasPre', false) === true ? aliasPreOf(it, fpOf) : null; return { id: it.id, spec: it.spec, protocol: ap ? { ...(baseProtocol || {}), aliasPre: ap } : baseProtocol } })
    let run
    try { run = await runJobs(jobs, { ...rsi.runnerOpt(), workers: O.workers, tag: `${roundNameOf(round)}_${process.pid}` }) }
    catch (e) {
        //評估層整體失敗(如槽位逾時):釋放認領為 stale, 讓他 session 可重提
        store.setStatus(mine.map((it) => it.id), STATUS.STALE, { notes: { error: `runJobs 失敗:${e.message}` } })
        throw e
    }
    let results = run.results
    for (let it of mine) {
        let res = results.get(it.id)
        let origin = toClaim.find((c) => c.id === it.id).origin
        let node = res && res.ok
            ? makeNode({ id: it.id, spec: it.spec, parent: it.parentId || 'root', round, origin, raw: res.raw, envHash: it.envHash, evidence: it.evidence || null, notes: it.notes || null }, domain)
            : makeNode({ id: it.id, spec: it.spec, parent: it.parentId || 'root', round, origin, raw: null, envHash: it.envHash, status: STATUS.ERROR, notes: { error: res ? res.error : 'worker 無結果' } }, domain)
        if (node.status === 'executed' && get(domain, 'gates.post')) { let g = domain.gates.post(node); if (g && g.ok === false) { node.status = STATUS.REJECTED; node.notes = { ...(node.notes || {}), why: g.why || 'post gate' } } }
        let old = store.getNode(it.id)
        if (old) { node.children = old.children || []; node.createdAt = old.createdAt || node.createdAt }
        store.putNode(node); nodes.push(node)
    }
    //結果已入樹(持久化)⇒ 提交 runner 之工作夾(2026-09-29:cfg.runner.keepDir false 時刪夾;入樹前中斷 ⇒ 夾保留可續跑)
    if (isFunction(run.commit)) { try { jobsCommit = run.commit() } catch (e) { jobsCommit = { removed: false, why: `commit 失敗:${e.message}` } } }
    return finish()
}

export default makeExplore
