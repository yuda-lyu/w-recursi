import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import get from 'lodash-es/get.js'
import isArray from 'lodash-es/isArray.js'
import isFunction from 'lodash-es/isFunction.js'
import isPlainObject from 'lodash-es/isPlainObject.js'
import isString from 'lodash-es/isString.js'
import keys from 'lodash-es/keys.js'
import omit from 'lodash-es/omit.js'
import pickBy from 'lodash-es/pickBy.js'
import size from 'lodash-es/size.js'
import toPairs from 'lodash-es/toPairs.js'
import { makePaths, ROUND_NAME_SRC, isRoundDir, roundNumOf, roundNameOf, listRoundDirs } from './core/paths.mjs'
import { specHash, nodeIdOf, canonicalJson, sha, nowIso } from './core/canonical.mjs'
import { withLock } from './core/lock.mjs'
import { acquireSlots, tryAcquireSlots, releaseSlots, slotsInUse, slotsStatus, reclaimDeadSlots, slotAuxOf, pidAlive } from './core/slots.mjs'
import { HOOK_FAIL_HEAD, hookFailureOf } from './core/hookResult.mjs'
import { assertWriteRoot, writeRootsOf } from './core/writeRoot.mjs'
import { makeStore, STATUS, OCCUPIED, FRONTIER_BLOCKED } from './tree/store.mjs'
import { makeView, checkPolicySource, omitMask, policyViewOfNode } from './tree/view.mjs'
import { makeNode, rescore } from './tree/node.mjs'
import { aliasMapOf } from './tree/alias.mjs'
import { makeRegistry } from './search/operators.mjs'
import { makeExplore, allocateRound, loadSummaries, roundDirs, peekRound, frontierOutcomesOf, parentIdsOf, aliasPreOf, isAliasShort } from './loop/explore.mjs'
import { makeAuto } from './loop/auto.mjs'
import { makeStatus } from './loop/status.mjs'
import { policyDevCheck, lastChangeAtOf } from './loop/policyDev.mjs'
import { makeDream, loadPolicyFile, policySourcesOf } from './sim/dream.mjs'
import { extractTurning, specDiff, applyDiff } from './search/turning.mjs'
import { noveltyDebtOf, generationCheck, clearGenRequest, readGenRequest, markerStale } from './loop/generation.mjs'
import { simulate, evaluatePolicy, accept, DEFAULT_SIM, aliasMapOfNodes } from './sim/replay.mjs'
import { runJobs, reclaimJobDirs, jobKey } from './eval/runner.mjs'
import { DOMAIN_KEYS, checkDomain, aliasShortOfDomain } from './core/domainContract.mjs'
import { makeArms, validateCatalog, checkArmsCfg, catalogArmsOf, selectableOf, unusedOf, featureOf, ARM_KEYS, ARMS_CFG_KEYS, ARM_STATUS, REALIZE_KINDS, ARMS_DEFAULTS } from './search/arms.mjs'
import { makeGovernance, checkGovernanceCfg, checkProposals, applyArmExtensions, readArmExtensions, lenientIdsOf, lenientNamesOf, effectiveCatalogOf, nextArmId, nextLayerId, renderProposals, PROPOSAL_KINDS, PROPOSAL_STATUS, GOVERNANCE_DEFAULTS, GOVERNANCE_CFG_KEYS } from './search/governance.mjs'


//通用 RSI(遞迴自我改進)迴圈之組裝:createRsi({ root, domain, budget, claims, dream, policyDev, slots, runner, maintenance }) → 實例
//  三層六角色(與 README §1 同):資料層 = 樹(節點 / 前緣 / lore);搜尋層 = 算子 + 策略;評估層 = 領域評估器 + 判讀 score;
//    模擬層 = 做夢(策略在樹上重放)+ 單調接受;控制層 = explore / auto / status;併行層 = 鎖 / 認領 / 原子輪號 / 全域槽位。
//  domain(依賴注入):已知鍵、型別與簽名之單一來源為 core/domainContract.mjs 之 DOMAIN_KEYS(README §4 之表由此抄錄);score 必填、evaluator 於 explore 才需要
//    createRsi 以 checkDomain 檢查:缺必填或型別不符 ⇒ 拋錯;未知鍵(多為拼錯 ⇒ 鉤子靜默失效)⇒ 警告(同一鍵每程序一次);cfg.strictDomain = true ⇒ 未知鍵亦拋錯
//  cfg 之選項(非 domain;2026-09-29 所加者皆為 opt-in, 未設 = 舊行為):
//    runner:{ keepDir(預設 true;false ⇒ runJobs 之 commit() 刪工作夾), logDir(刪夾前歸檔 worker 日誌), reclaimDays(keepDir false 時回收逾期 tag 夾, 預設 7) }
//    maintenance:() → 理由字串 | null(維護中 ⇒ 做夢不寫 scores.jsonl、不升版)
//    dream.minIntervalMs、generation.heartbeatMs / heartbeatStaleMs、frontier.maxRetries(預設 2)
//    aliasPre:true ⇒ 帶父之臂(展開 parentId / parents / 轉折 origin.from)之 job 協定附 aliasPre: { fps: [{ id, fp }] }(fp = domain.fingerprint(父.raw)),
//      供領域評估器於本臂評估後判行為別名而略過冗餘計算(預設 false;summary.nAliasShort 計領域鉤子 domain.aliasShortOf(node) 為真者 —— 2026-10-01 起, 原寫死讀領域原料之欄位)
//    evidenceKeys:陣列 ⇒ CLI 之 evidence 只收所列之證據鍵(2026-10-01);做夢之 dream.targetLadder 由領域明設(未設 ⇒ 提示;引擎預設 3 為玩具之值)
//    arms(2026-11-07;search/arms.mjs):{ catalog(臂目錄:資料, 他專案換一份即用), defaults(ARMS_DEFAULTS 之覆寫;defaults.reopen = 選 done 之臂之預設重啟理由), use(預設之選臂 id;explore 之 opt.useArms 覆寫), known({ fragments, modules, carriers }:realize 之名之合法集) }
//      目錄不合 / cfg.arms 之形不合 / use 被拒 ⇒ **組裝期拋錯**(自有套件慣例:未知鍵不靜默);無目錄 ⇒ rsi.arms 為空目錄(全部功能為恆等 / 空, 行為與無此功能前逐字同)
//    governance(2026-11-14,使用端 Gitea #138;search/governance.mjs):{ requireReview(預設 false), maxPendingRounds(預設 0), gateKinds } —— 代理之三層(節點 / 做夢 / 主控)之第三層:
//      下層以 rsi.governance.propose 提案(新臂 / 新層 / 修訂 / 停用 / 上呈事項), 主控以 decide 審定;通過之臂目錄變更寫入 <root>/governance/extensions.json,
//      **生效之目錄 = cfg.arms.catalog(基底)+ 該擴充**(組裝時套用;rsi.reloadArms() 於同一程序重載;無擴充檔 ⇒ 即基底, 逐字同改前);
//      requireReview = true ⇒ 待審逾 maxPendingRounds 輪者擋下一輪(explore 於取輪號前拋 RSI_GOVERNANCE_PENDING;opt.ackPending 越過);cfg.governance 之形不合 ⇒ 組裝期拋錯
//    已知頂層鍵 = CFG_KEYS(未知 ⇒ 警告一次;strictDomain ⇒ 拋錯;checkCfg 為純函式)
const FD_SRC = path.dirname(fileURLToPath(import.meta.url))
//global:全域取樣之臂額(策略以 plan.global 回傳;不計入新區域欠額;2026-09-27, 預設 0 = 舊行為)
/**
 * 預設預算:arms(每輪臂數)、novelty(新區域額度)、global(全域取樣臂額,策略以 plan.global 回傳,不計入新區域欠額)、workers(每輪 worker 數)、maxGlobalWorkers(全域槽位上限)、rounds(做夢之重放輪數)
 *
 * @type {Object}
 */
export const DEFAULT_BUDGET = { arms: 8, novelty: 2, global: 0, workers: 4, maxGlobalWorkers: 8, rounds: DEFAULT_SIM.rounds }
//cfg 之已知頂層鍵(2026-10-01:原 cfg 之拼錯靜默無效 —— 與 checkDomain 對稱):未知鍵 ⇒ 警告一次(cfg.strictDomain = true ⇒ 拋錯)
//  單一來源;test/unit-cfgContract 掃 src 之 cfg 讀取點核對本表(新增 cfg 選項時先登錄於此)
//  evidenceKeys:陣列 ⇒ CLI 之 --mode evidence 只收所列之證據鍵(--set k=v 與 --mech / --usability / --btcOK 別名);未給 ⇒ 不檢
/**
 * cfg 之已知頂層鍵(單一來源):未知鍵 ⇒ 警告一次(cfg.strictDomain = true ⇒ 拋錯);新增 cfg 選項時先登錄於此,test/unit-cfgContract 掃原始碼之 cfg 讀取點核對本表
 *
 * @type {Array}
 */
export const CFG_KEYS = ['root', 'domain', 'budget', 'claims', 'dream', 'policyDev', 'slots', 'runner', 'maintenance', 'tmpDir', 'strictDomain', 'frontier', 'generation', 'aliasPre', 'turning', 'beforeWrite', 'evidenceKeys', 'arms', 'governance']
let warnedUnknown = new Set()
let warnOnce = (key, msg) => { if (!warnedUnknown.has(key)) { warnedUnknown.add(key); console.warn(msg) } }
//cfg 檢查(純函式;createRsi 據以警告 / strictDomain 拋錯):→ { unknown:[鍵], notes:[{ key, msg }] }
/**
 * cfg 檢查(純函式;createRsi 據以警告或拋錯):未知頂層鍵、有 cfg.dream 而未設 targetLadder 之提示、evidenceKeys 型別、cfg.arms 與 cfg.governance 之形(fatal)
 *
 * @param {Object} [cfg={}] 輸入 createRsi 之設定
 * @returns {Object} 回傳 { unknown:Array(未知鍵), notes:Array([{ key, msg, fatal? }]) }
 * @example
 * let r = checkCfg({ root: 'x', dreem: {} })
 * console.log(r.unknown.join(','))
 * // => dreem
 *
 * console.log(checkCfg({ dream: {} }).notes[0].key)
 * // => cfg.dream.targetLadder
 */
export let checkCfg = (cfg = {}) => {
    let unknown = keys(cfg).filter((k) => !CFG_KEYS.includes(k))
    let notes = []
    //做夢之目標階梯:引擎預設 DEFAULT_SIM.targetLadder 為玩具領域之值, 階梯之意義由領域定 ⇒ 有 cfg.dream 而未設 targetLadder 即提示(領域通常明設)
    if (isPlainObject(cfg.dream) && cfg.dream.targetLadder === undefined) { notes.push({ key: 'cfg.dream.targetLadder', msg: `createRsi: cfg.dream.targetLadder 未設 ⇒ 用引擎預設 ${DEFAULT_SIM.targetLadder}(階梯之意義由領域定, 請於 cfg.dream 明設;rsi 設 1)` }) }
    if (cfg.evidenceKeys !== undefined && !(isArray(cfg.evidenceKeys) && cfg.evidenceKeys.every((k) => isString(k) && /^[A-Za-z_]\w*$/.test(k)))) { notes.push({ key: 'cfg.evidenceKeys', msg: 'createRsi: cfg.evidenceKeys 須為識別字字串之陣列(CLI 之 evidence 據以檢鍵)' }) }
    //臂目錄之 cfg 形(2026-11-07):未知鍵 / use 非陣列 ⇒ fatal(createRsi 拋錯, 不只警告)
    for (let e of checkArmsCfg(cfg.arms).errors) { notes.push({ key: 'cfg.arms', msg: `createRsi: ${e}`, fatal: true }) }
    //治理之 cfg 形(2026-11-14):未知鍵 / 型別不符 ⇒ fatal
    for (let e of checkGovernanceCfg(cfg.governance).errors) { notes.push({ key: 'cfg.governance', msg: `createRsi: ${e}`, fatal: true }) }
    return { unknown, notes }
}

/**
 * 通用 RSI(遞迴自我改進)迴圈之組裝,三層六角色:資料層(樹:節點、前緣、lore)、搜尋層(算子 + 策略)、評估層(領域評估器 + 判讀 score)、模擬層(做夢:策略在樹上重放 + 單調接受)、控制層(explore、auto、status)、併行層(鎖、認領、原子輪號、全域槽位);領域一律以依賴注入接上。
 * domain 之已知鍵與簽名見 DOMAIN_KEYS(score 必填;evaluator 於 explore 才需要);cfg 之已知頂層鍵見 CFG_KEYS。缺 root 或領域介面不符 ⇒ 拋錯;未知鍵 ⇒ 警告一次(cfg.strictDomain = true ⇒ 拋錯)。
 * 狀態根目錄須位於可解析 lodash-es 之專案內(init() 寫入之預設策略 v0.mjs 以套件名匯入 lodash-es)
 *
 * @param {Object} cfg 輸入 { root:String(狀態根目錄,必填), domain:Object, budget:Object, claims:Object({ staleMs, replanFillOnly }), dream:Object({ minIntervalMs, everyRound, targetLadder, defaultReplays, minGlobal, lambda, mu, margin, floor, structural }), policyDev:Object({ minRounds, ttlMs }), generation:Object({ ttlMs, escalateRounds, heartbeatMs, heartbeatStaleMs, debtAfterClaims }), frontier:Object({ maxRetries }), turning:Object({ enabled, minGain, topParents, maxProposals }), slots:Object({ timeoutMs, staleMs }), runner:Object({ keepDir, logDir, reclaimDays }), maintenance:Function, tmpDir:String, strictDomain:Boolean, aliasPre:Boolean, beforeWrite:Function, evidenceKeys:Array, arms:Object({ catalog, defaults, use, known }), governance:Object({ requireReview, maxPendingRounds, gateKinds }) }
 * @returns {Object} 回傳實例 rsi:{ cfg, paths, domain, store, view, registry, budget, arms, baseCatalog, governance, reloadArms(), syncArms(), checkCatalog(catalog, opt), STATUS, OCCUPIED, specHash, canonicalJson, makeCtx, carriers, init(), loadPolicy(), runnerOpt(), idOf(spec), explore(opt), dream(opt), auto(opt), status(opt), policyDevCheck(fdRound, sums, opt), turning(opt), setEvidence(id, set, opt), rescoreAll(), invalidate(ids, why), aliasMap(), summaries(), clearGenRequest(opt) }
 * @throws {Error} 缺 root、領域介面不符、cfg 有 fatal 項(如臂目錄不合)、strictDomain 下有未知鍵時拋出
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
 * for (let i = 0; i < 3; i++) { await rsi.explore({ by: 'demo' }) }
 * let st = await rsi.status({ print: false })
 * console.log(st.nNodes, st.top[0].S)
 * // => 3 2
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let createRsi = (cfg = {}) => {
    if (!cfg.root) { throw new Error('createRsi: 缺 root(狀態根目錄)') }
    let chk = checkDomain(cfg.domain || {})
    if (chk.errors.length) { throw new Error(`createRsi: 領域介面不符:\n  ${chk.errors.join('\n  ')}`) }
    if (chk.unknown.length) {
        let msg = `createRsi: domain 有未知鍵 ${chk.unknown.join(', ')}(套件不讀;若為拼錯, 該鉤子不會生效;已知鍵見 w-recursi/src/core/domainContract.mjs)`
        if (cfg.strictDomain === true) { throw new Error(msg) }
        let fresh = chk.unknown.filter((k) => !warnedUnknown.has(k))
        if (fresh.length) { fresh.forEach((k) => warnedUnknown.add(k)); console.warn(msg) }
    }
    let cc = checkCfg(cfg)
    if (cc.unknown.length) {
        let msg = `createRsi: cfg 有未知鍵 ${cc.unknown.join(', ')}(套件不讀;若為拼錯, 該設定不會生效;已知鍵見 w-recursi/src/index.mjs 之 CFG_KEYS)`
        if (cfg.strictDomain === true) { throw new Error(msg) }
        warnOnce(`cfg:${cc.unknown.join(',')}`, msg)
    }
    let fatal = cc.notes.filter((n) => n.fatal)
    if (fatal.length) { throw new Error(fatal.map((n) => n.msg).join('\n')) }
    for (let n of cc.notes) { warnOnce(n.key, n.msg) }
    let domain = {
        name: 'domain', summarize: (s) => JSON.stringify(s).slice(0, 80), carrierOf: () => null, validateSpec: null, envHash: () => '',
        score: null, fingerprint: null, mask: null, isAnchor: () => false, excludeParent: null, familyRank: {}, forbidden: [], operators: [], carriers: {}, evaluator: {}, gates: {}, hooks: {},
        ...(cfg.domain || {}),
    }
    let paths = makePaths(cfg.root, { tmp: cfg.tmpDir || null })
    let store = makeStore({ paths, domain, claims: cfg.claims || {} })
    let view = makeView(store, domain)
    let registry = makeRegistry({ operators: domain.operators || [], validateSpec: domain.validateSpec, familyRank: domain.familyRank || {} })
    let budget = { ...DEFAULT_BUDGET, ...(cfg.budget || {}) }
    //臂目錄(2026-11-07;search/arms.mjs):目錄對登錄表 / known 核對, 不合即拋(組裝期);cfg.arms.use 之預設選臂於此先驗(被拒即拋, 免每輪才知)
    //  治理(2026-11-14;search/governance.mjs):生效之目錄 = 注入之基底(cfg.arms.catalog)+ 狀態根之擴充(<root>/governance/extensions.json;主控審過之新臂 / 新層 / 修訂 / 停用)
    //    無擴充檔 ⇒ 即基底(行為逐字同改前);擴充檔損壞 / 結構不合 ⇒ 拋錯;擴充所加 / 所修之臂之落成名未登錄 ⇒ 不拋、該臂不可選(lenient)
    //    rsi.reloadArms():同一程序內重讀擴充並重建 rsi.arms(不合 ⇒ 拋錯, rsi.arms 維持原樣);引擎各處一律經 rsi.arms 取用(不留組裝期之舊參照)
    let baseCatalog = get(cfg, 'arms.catalog', null)
    //cfg.arms.use 之預設選臂於此先驗(被拒即拋, 免每輪才知);組裝、重載與治理之試建共用(2026-11-14:停用預設選臂之審定須於寫入前被拒, 否則下一次組裝即拋)
    let checkUse = (a, head) => {
        if (!size(get(cfg, 'arms.use'))) { return }
        let pk = a.pick(cfg.arms.use, { reopen: get(cfg, 'arms.defaults.reopen', null) })
        if (pk.rejected.length) { throw new Error(`${head}cfg.arms.use 被拒:${pk.rejected.map((r) => `${r.id}(${r.why})`).join('、')}`) }
    }
    let makeArmsOf = (catalog, lenient, lenientNames = null) => makeArms({ catalog, defaults: get(cfg, 'arms.defaults', {}), registry, known: get(cfg, 'arms.known', {}), ...(lenient ? { lenient } : {}), ...(lenientNames ? { lenientNames } : {}) })
    //擴充檔之原文(比對用;無檔 ⇒ '')
    let extSigOf = () => { try { return fs.existsSync(paths.govExtensions) ? fs.readFileSync(paths.govExtensions, 'utf8') : '' } catch (e) { return null } }
    let extSig = null
    let armsOf = () => {
        let sig = extSigOf()
        let ext = readArmExtensions(paths)
        let a = makeArmsOf(applyArmExtensions(baseCatalog, ext), lenientIdsOf(ext), lenientNamesOf(ext, baseCatalog))
        checkUse(a, 'createRsi: ')
        extSig = sig
        return a
    }
    let arms = armsOf()
    let rsi = { cfg, paths, domain, store, view, registry, budget, arms, baseCatalog, STATUS, OCCUPIED, specHash, canonicalJson }
    rsi.reloadArms = () => { rsi.arms = armsOf(); return rsi.arms }
    //擴充檔自上次組裝 / 重載後有變(他實例之審定)⇒ 重載;回是否重載(explore 起跑時呼叫:不以過期之目錄開輪;未用治理 ⇒ 只查無檔, 不寫)
    rsi.syncArms = () => { let sig = extSigOf(); if (sig === extSig) { return false } rsi.reloadArms(); return true }
    //目錄之試建(治理之審定於寫入前呼叫):結構檢查(不對登錄表 / known)、再以登錄表 / known(lenient 之臂寬鬆)組一次並核對 cfg.arms.use;不合 ⇒ 拋錯
    rsi.checkCatalog = (catalog, { lenient = null, lenientNames = null } = {}) => {
        let c = validateCatalog(catalog)
        if (c.errors.length) { throw new Error(`臂目錄不合:\n  ${c.errors.join('\n  ')}`) }
        checkUse(makeArmsOf(catalog, lenient, lenientNames), '臂目錄與 ')
        return c
    }
    rsi.governance = makeGovernance(rsi)
    //carriers 可為物件或函式(每次出計畫時求值:領域可自既有工件自動登錄載體)
    let carriersNow = () => { let c = isFunction(domain.carriers) ? domain.carriers() : (domain.carriers || {}); return isPlainObject(c) ? c : {} }
    //策略之 ctx;views(策略視圖陣列, 可省)給出時, 可選領域鉤子 domain.childBlock({ op, params, parent, child, byId }) → 擋下理由 | null 過濾參數型展開之子
    //  (parent = 以 specHash 自 views 查得之父視圖, 查不到則 { spec });擋下者不交給策略, 記於 ctx.blockedChildren(explore 列入策略備註)
    //  2026-09-25(如「某上限於父之訓練期不綁定」之子 = 父之別名);未給鉤子或未傳 views 時與原行為逐字相同;controlsFor / 轉折點提取不經此鉤子
    //  lineage(可省;2026-09-25):譜系用之節點視圖陣列(可含別名;省略則用 views)⇒ 鉤子另收 byId(Map id → 視圖, 惰性建一次), 可查父之父與其子
    //  (如「同一改動已於父之父施過而大跌」;與轉折點提取之 transferBlock 收到之 byId 同為已執行節點全集);explore 傳全樹視圖、做夢重放傳可見節點(含別名)
    //  **規格級**(2026-09-25;某次回報):計畫以 specHash 去重, 同一規格可經多條展開路徑(兩改動可交換:P1 + a + b = P2 + b + a)
    //  ⇒ 擋下以規格為單位 —— 視圖內任一父之路徑擋下某子規格, 經他父展開亦不出(記錄沿用擋下路徑之父 / 算子 / 理由);首次展開時預掃視圖內全部父一次(真樹 280 父 × 1,982 子約 0.2 秒)
    //  路徑級之漏網於某輪首見:某規格(= 某節點 × 某算子, 其兄弟已 −78% 而擋)經新節點之同一算子入計畫;某樹當時 258 個被擋規格中 62 個可經他父放行
    //  opt.useArms(2026-11-07;臂目錄):所選臂之 id ⇒ childrenOf / controlsFor 只出所選臂之算子、carriers 只留所選臂之載體(arms.restrict);ctx.useArms = 所選 id;未給 ⇒ 逐字不變
    rsi.makeCtx = (executed, views = null, lineage = null, opt = {}) => {
        let childrenOf = registry.childrenOf
        let blockedChildren = []
        if (isFunction(domain.childBlock) && isArray(views)) {
            let byHash = new Map(views.filter((v) => v && v.spec).map((v) => [specHash(v.spec), v]))
            let byId = null
            let byIdOf = () => byId || (byId = new Map((isArray(lineage) ? lineage : views).filter((v) => v && v.id).map((v) => [v.id, v])))
            let whyOf = (parent, k) => { try { return domain.childBlock({ op: k.op, params: k.params, parent, child: k, byId: byIdOf() }) || null } catch (e) { return null } }
            let bySpec = null //specHash → { parentId, op, why }(視圖內各父之路徑擋下;先到者為準)
            let bySpecOf = () => {
                if (bySpec) { return bySpec }
                bySpec = new Map()
                for (let v of byHash.values()) {
                    for (let k of registry.childrenOf(v.spec)) {
                        if (bySpec.has(k.specHash)) { continue }
                        let why = whyOf(v, k)
                        if (why) { bySpec.set(k.specHash, { parentId: v.id || null, op: k.op, why }) }
                    }
                }
                return bySpec
            }
            let listed = new Set()
            childrenOf = (spec, opt = {}) => registry.childrenOf(spec, opt).filter((k) => {
                let parent = byHash.get(specHash(spec)) || { spec }
                let why = whyOf(parent, k)
                let rec = why ? { parentId: parent.id || null, op: k.op, why } : (bySpecOf().get(k.specHash) || null)
                if (rec && !(executed && executed.has(k.specHash))) { //已執行 / 已認領者本就不會被選, 不列;同一(父, 算子, 規格)只列一次
                    let key = `${rec.parentId}|${rec.op}|${k.specHash}`
                    if (!listed.has(key)) { listed.add(key); blockedChildren.push({ parentId: rec.parentId, op: rec.op, specHash: k.specHash, why: rec.why }) }
                }
                return !rec
            })
        }
        //臂限制(2026-11-07):所選臂之算子 / 載體以外一律不出(於 childBlock 之後包裝 ⇒ 擋下紀錄不受影響)
        let R = isArray(opt.useArms) && opt.useArms.length ? rsi.arms.restrict(opt.useArms) : null
        let controlsFor = registry.controlsFor
        let carriers = carriersNow()
        if (R) {
            childrenOf = R.childrenOf(childrenOf)
            controlsFor = (child) => registry.controlsFor(child).filter((c) => R.ops.includes(c.op))
            carriers = pickBy(carriers, (v, k) => R.carriers.includes(k))
        }
        //領域附加(2026-09-27;domain.ctxExtra):如全域取樣器 sampleGlobal(n, opt)、規格判定;不得覆寫引擎之鍵
        let extra = isFunction(domain.ctxExtra) ? (domain.ctxExtra({ executed: executed || new Set(), views, lineage }) || {}) : {}
        return { ...omit(extra, ['childrenOf', 'controlsFor', 'rankOf', 'isControlOp', 'carriers', 'specHash', 'executed', 'excludeParent', 'blockedChildren', 'useArms']), childrenOf, controlsFor, rankOf: registry.rankOf, isControlOp: registry.isControlOp, carriers, specHash, executed: executed || new Set(), excludeParent: domain.excludeParent || null, blockedChildren, useArms: R ? R.ids : null }
    }
    rsi.carriers = carriersNow
    //初始化:狀態根之資料夾;current.mjs 缺時建之(指向 v0.mjs)
    //  2026-09-29:**不覆寫既有之 v0.mjs**(只在缺檔時以套件之 policyV0 寫入)—— 領域之 v0(如領域自有之 policies/v0.mjs 0.1.2)與套件版(0.2.0)已分歧,
    //    原於 current.mjs 缺時無條件以套件版覆寫;另:current.mjs 缺而已有 v1…vN ⇒ 警告(以 v0 為當前策略可能非預期)
    rsi.init = () => {
        paths.ensure()
        if (!fs.existsSync(paths.current)) {
            let fpV0 = path.join(paths.policies, 'v0.mjs')
            assertWriteRoot(paths.current, { what: 'init(current.mjs)' }) //寫域守門(2026-10-09;RSI_WRITE_ROOT 未設 ⇒ 不檢)
            if (!fs.existsSync(fpV0)) { fs.writeFileSync(fpV0, fs.readFileSync(path.join(FD_SRC, 'search', 'policyV0.mjs'), 'utf8')) }
            let later = fs.readdirSync(paths.policies).filter((f) => /^v\d+\.mjs$/.test(f) && f !== 'v0.mjs').sort()
            if (later.length) { console.warn(`w-recursi init:${paths.current} 缺, 而已有 ${later.join(', ')} ⇒ 以 v0.mjs 為當前策略(若非預期, 請把 current.mjs 改回指向正確之版本)`) }
            fs.writeFileSync(paths.current, `//當前探索策略(只由 dream --accept 依單調接受規則改寫;人可回退)\nexport { default, meta } from './v0.mjs'\n`)
        }
        return rsi
    }
    rsi.loadPolicy = async () => { let p = await loadPolicyFile(paths.current, domain.forbidden || []); if (p.error) { throw new Error(`current.mjs ${p.error}`) } return p }
    rsi.runnerOpt = () => {
        let ev = domain.evaluator || {}
        let rc = get(cfg, 'runner', {}) || {}
        return {
            mode: ev.mode || (ev.module ? 'spawn' : 'inProcess'), evaluatorModule: ev.module || null, evaluate: ev.evaluate || null, createContext: ev.createContext || null,
            ctxOpt: ev.ctxOpt || {}, protocol: ev.protocol || {}, meta: ev.meta || null, costOf: ev.costOf || null, tmpDir: paths.tmp, cwd: ev.cwd || process.cwd(), env: ev.env || null,
            slots: { dir: paths.slots, max: budget.maxGlobalWorkers, timeoutMs: get(cfg, 'slots.timeoutMs', 3600000), staleMs: get(cfg, 'slots.staleMs', 6 * 3600000) },
            //工作夾之清理(2026-09-29;cfg.runner, 未設 = 舊行為:保留)
            keepDir: rc.keepDir !== false, logDir: rc.logDir || null, ...(rc.reclaimDays !== undefined ? { reclaimDays: rc.reclaimDays } : {}),
        }
    }
    rsi.idOf = (spec) => nodeIdOf(spec, isFunction(domain.envHash) ? domain.envHash(spec) : '')
    rsi.explore = makeExplore(rsi)
    rsi.dream = makeDream(rsi)
    rsi.auto = makeAuto(rsi)
    rsi.status = makeStatus(rsi)
    rsi.policyDevCheck = (fdRound, sums, opt) => policyDevCheck(rsi, fdRound, sums || loadSummaries(paths), opt)
    //轉折點提取(唯讀;opt.push = true 時寫入前緣);proposalBlock(2026-10-04):三種提案之產生端守門, 與 explore 同傳
    rsi.turning = (opt = {}) => {
        let nodesAll = view.policyView()
        let occupied = new Set(nodesAll.filter((n) => OCCUPIED.has(n.status)).map((n) => specHash(n.spec)))
        let t = extractTurning(nodesAll, { registry, validateSpec: domain.validateSpec, occupied, excludeParent: domain.excludeParent, isAnchor: domain.isAnchor, transferBlock: domain.transferBlock, parentOk: domain.turningParentOk || null, normSpec: domain.normSpec || null, proposalBlock: domain.proposalBlock || null, ...(cfg.turning || {}), ...opt })
        if (opt.push && t.proposals.length) { store.pushFrontier(t.proposals) }
        return t
    }
    //人工認證之寫回:evidence 併入 → 重算分數(階梯)→ 入樹
    //  2026-09-26:改經 store.updateNode(鎖內重讀最新節點再併入), 免鎖外讀之舊副本蓋掉他 session 期間之寫入
    rsi.setEvidence = (id, set, { ref = null, note = null } = {}) => {
        let n = store.updateNode(id, (x) => {
            x.evidence = x.evidence || { refs: [] }
            x.evidence.refs = x.evidence.refs || []
            for (let [k, v] of toPairs(set || {})) { x.evidence[k] = v }
            x.evidence.refs.push({ ref, set, note, at: nowIso() })
            rescore(x, domain)
        })
        if (!n) { throw new Error(`setEvidence: 無節點 ${id}`) }
        return n
    }
    rsi.rescoreAll = () => { let k = 0; for (let r of store.listIndex()) { if (store.updateNode(r.id, (n) => (n.raw ? void rescore(n, domain) : false))) { k++ } } return k }
    rsi.invalidate = (ids, why) => store.setStatus(ids, STATUS.INVALID, { notes: { invalid: { why, at: nowIso() } } })
    rsi.aliasMap = () => view.aliasOf(store.loadNodes())
    rsi.summaries = () => loadSummaries(paths)
    //全域生成請求之清除(作廢輪次等外部工具用;policies 鎖內, opt.round 給出時只刪該輪之標記;2026-09-29)
    rsi.clearGenRequest = (opt = {}) => clearGenRequest(rsi, opt)
    return rsi
}

export { DOMAIN_KEYS, checkDomain, aliasShortOfDomain, tryAcquireSlots, slotsStatus, reclaimDeadSlots }
//2026-11-07 臂目錄(search/arms.mjs):目錄之檢查 / 工廠 / 純函式(coverage 與 menu 由實例 rsi.arms 取)
export { makeArms, validateCatalog, checkArmsCfg, catalogArmsOf, selectableOf, unusedOf, featureOf, ARM_KEYS, ARMS_CFG_KEYS, ARM_STATUS, REALIZE_KINDS, ARMS_DEFAULTS }
//2026-11-14 治理(search/governance.mjs):提案帳、審定、臂目錄之擴充(純函式與工廠;實例之入口為 rsi.governance / rsi.reloadArms)
//  2026-11-14(Gitea #144):補 lenientIdsOf(README §4 已列)與 lenientNamesOf —— 自行以 applyArmExtensions + makeArms 組裝或檢查目錄者取得與引擎一致之 lenient / lenientNames
export { makeGovernance, checkGovernanceCfg, checkProposals, applyArmExtensions, readArmExtensions, lenientIdsOf, lenientNamesOf, effectiveCatalogOf, nextArmId, nextLayerId, renderProposals, PROPOSAL_KINDS, PROPOSAL_STATUS, GOVERNANCE_DEFAULTS, GOVERNANCE_CFG_KEYS }
//2026-10-09:輪夾之名、輔助夾之列舉、鉤子失敗之結果形、寫域守門
export { ROUND_NAME_SRC, isRoundDir, roundNumOf, roundNameOf, listRoundDirs, slotAuxOf, HOOK_FAIL_HEAD, hookFailureOf, assertWriteRoot, writeRootsOf }
export { specHash, nodeIdOf, canonicalJson, sha, nowIso, withLock, acquireSlots, releaseSlots, slotsInUse, pidAlive, STATUS, OCCUPIED, FRONTIER_BLOCKED, makeStore, makeNode, rescore, aliasMapOf, makeRegistry, makeView, policyViewOfNode, omitMask, checkPolicySource, simulate, evaluatePolicy, accept, DEFAULT_SIM, aliasMapOfNodes, runJobs, reclaimJobDirs, jobKey, allocateRound, roundDirs, peekRound, loadSummaries, loadPolicyFile, policySourcesOf, policyDevCheck, lastChangeAtOf, makePaths, extractTurning, specDiff, applyDiff, noveltyDebtOf, generationCheck, clearGenRequest, readGenRequest, markerStale, frontierOutcomesOf, parentIdsOf, aliasPreOf, isAliasShort }
export default createRsi
