import castArray from 'lodash-es/castArray.js'
import isArray from 'lodash-es/isArray.js'
import isFunction from 'lodash-es/isFunction.js'
import isPlainObject from 'lodash-es/isPlainObject.js'
import keys from 'lodash-es/keys.js'
import toPairs from 'lodash-es/toPairs.js'


//領域介面(依賴注入)之單一來源(2026-09-25 收斂):已知鍵 → { type, required?, doc }
//  createRsi 以 checkDomain 檢查:缺必填或型別不符 ⇒ 拋錯;未知鍵 ⇒ 警告一次(多為拼錯, 如 transferBlok ⇒ 鉤子靜默失效)
//  新增鉤子時:先在此登錄(型別與簽名), 再於使用處讀 domain.<鍵>;README §4 之表由此抄錄
//  type:'function' | 'object' | 'array' | 'string' | 'number';多型以陣列列出
/**
 * 領域介面(依賴注入)之單一來源:已知鍵 → { type, required?, doc };createRsi 以 checkDomain 檢查,缺必填或型別不符 ⇒ 拋錯,未知鍵 ⇒ 警告一次(多為拼錯)。新增鉤子時先在此登錄,再於使用處讀 domain.<鍵>,並補 README 之表
 *
 * @type {Object}
 */
export const DOMAIN_KEYS = {
    score: { type: 'function', required: true, doc: 'score(raw, node) → { S, ladder, flags:{ vetoed, … }, evaluator, … }:判讀層(可重算不重跑);ladder = 證據之序數階梯, **≥ 1 = 通過領域之第一道真偽**(引擎據以計 summary.ladderGe1、策略開發之停滯判定「連續兩輪無 ladder ≥ 1」;做夢之 targetLadder 由 cfg.dream 設);flags.vetoed = 否決(不入目標)' },
    evaluator: { type: 'object', doc: "{ mode:'spawn', module, ctxOpt, protocol, costOf(job) } | { mode:'inProcess', evaluate, createContext, ctxOpt, protocol };costOf 供 runner 大者先派" },
    evaluatorVersion: { type: ['number', 'string'], doc: '評估器版本(status 顯示)' },
    name: { type: 'string', doc: '領域名稱(資訊)' },
    validateSpec: { type: 'function', doc: 'validateSpec(spec):拋錯即無效' },
    summarize: { type: 'function', doc: 'summarize(spec) → 字串' },
    carrierOf: { type: 'function', doc: 'carrierOf(spec) → 分組標籤' },
    envHash: { type: 'function', doc: 'envHash(spec) → 節點 id 之環境雜湊' },
    operators: { type: 'array', doc: '[{ name, family, applies(spec), children(spec) → [{ spec, params, reason }], controls?, rank? }]' },
    familyRank: { type: 'object', doc: '{ family: rank }(策略展開順位)' },
    carriers: { type: ['object', 'function'], doc: '{ name: spec } | () => ({ name: spec })(新區域 / 冷啟動之根候選;函式每次出計畫時求值)' },
    fingerprint: { type: 'function', doc: 'fingerprint(raw, node) → 行為指紋(別名判定)' },
    aliasShortOf: { type: 'function', doc: 'aliasShortOf(node) → { of, what? } | null:評估器是否因本臂原料指紋 = 某父(cfg.aliasPre 之提示)而略過部分計算;of = 父 id、what = 略過之計算(報告用語);summary.nAliasShort 與報告「行為別名短路」計之(未給 ⇒ 0;2026-10-01 起引擎不再讀領域原料之欄位)' },
    isAnchor: { type: 'function', doc: 'isAnchor(node):不作別名亦不作正本(如既有型)' },
    excludeParent: { type: 'function', doc: 'excludeParent(view) → 不作父節點' },
    mask: { type: 'function', doc: 'mask(score, node) → 策略可見之分數(遮蔽)' },
    maskNode: { type: 'function', doc: 'maskNode(view, node) → view:策略視圖之節點層遮蔽 / 附加(於 mask 之後;如移除 evidence / notes 等可能含窗外資訊之欄、加領域標記;2026-09-27)' },
    ctxExtra: { type: 'function', doc: 'ctxExtra({ executed, views, lineage }) → 物件:併入策略之 ctx(如全域取樣器 sampleGlobal(n, opt)、規格判定;純函式、可重放;2026-09-27)' },
    forbidden: { type: 'array', doc: '[regex]:策略碼靜態檢查(套件另擋 child_process / 樹寫入 / 暫存)' },
    gates: { type: 'object', doc: '{ pre(spec, { view }) → { ok, why }, post(node) → { ok, why } }' },
    excludeArm: { type: 'function', doc: 'excludeArm(spec, ctx) → { exclude: boolean, why?: string } | null:生成端之臂排除(explore 出計畫時, 於 validateSpec 與 gates.pre 之後;如領域已結案論證過之臂 —— 再評估無新資訊);ctx = { id, spec, specHash, parent, kindOf, op, origin: { topic, operator, controlOf, … }, round, item }(節點形:可直接交領域之對照臂判定;item = 計畫項之 op / controlOf / kindOf / parentId / reason / origin);exclude 為真 ⇒ 入計畫之 rejected(excluded: true;why 缺 ⇒ excludeArm)、寫拒絕存根(notes.excluded)、前緣結案 rejectedByGate、本輪重計畫不再提;拋錯 ⇒ 不排除(計畫備註記一行);未給 ⇒ 逐字不變(2026-10-09 rsi 改善窗 B 之 B9)' },
    hooks: { type: 'object', doc: '{ afterRound({ rsi, round, fd, nodes, … }) → { lines } }' },
    childBlock: { type: 'function', doc: 'childBlock({ op, params, parent, child, byId }) → 擋下理由 | null:策略展開參數型子臂前過濾(如上限於父之訓練期不綁定 ⇒ 別名;byId = 譜系 Map, 如同一改動已於父之父大跌);引擎以規格為單位套用:視圖內任一父之路徑擋下某子規格, 經他父亦不出' },
    transferBlock: { type: 'function', doc: 'transferBlock({ op, params, from, child, to, spec, byId }) → 擋下理由 | null:轉折點搬移提案前過濾(byId = 已執行節點 Map)' },
    normSpec: { type: 'function', doc: 'normSpec(spec) → spec:規格之正規形(轉折點提取之提案先正規化再判占用 / 去重 / validateSpec;未給時不正規化;2026-09-30)' },
    proposalBlock: { type: 'function', doc: 'proposalBlock(spec, ctx) → 擋下理由 | null:轉折點提取之三種提案(搬移 / 外推 / 交叉)共用之產生端守門(於 normSpec / 占用 / validateSpec 之後;ctx = { op, origin, byId, parent?, parents, kidOp? };擋下者入回傳之 blocked(by proposalBlock)、不入 seen;未給時逐字不變;2026-10-04 rsi r128 #1)' },
    turningParentOk: { type: 'function', doc: 'turningParentOk(view) → bool:轉折點提取之父 / 有效邊之子之領域條件(如只取 PIT 節點;2026-09-27)' },
    costOf: { type: 'function', doc: 'costOf(spec) → 做夢重放之成本估算(未給時用預設)' },
    reportColumns: { type: 'array', doc: '[{ header, of(node) }]:輪次報告之欄' },
    reportExtra: { type: 'function', doc: 'reportExtra(nodes, plan, { items, getNode }) → [lines]:輪次報告之尾段;items = 本 session 實得之計畫項(kindOf / op / parentId / spec;含認領衝突之重計畫;2026-10-02 起, 無則 null), getNode(id) → 節點或 null' },
    indexExtra: { type: 'function', doc: 'indexExtra(node) → index 列之附加欄' },
    policyDevText: { type: 'function', doc: 'policyDevText({ why }) → 策略開發請求之文字' },
    generationText: { type: 'function', doc: 'generationText({ … }) → 生成請求之文字' },
}
let typeOf = (v) => (isArray(v) ? 'array' : isFunction(v) ? 'function' : isPlainObject(v) ? 'object' : typeof v)
//→ { errors:[字串], unknown:[鍵] };null / undefined 視為未給(不檢型別)
/**
 * 檢查領域介面:必填、型別、未知鍵(null 與 undefined 視為未給)
 *
 * @param {Object} [domain={}] 輸入領域物件
 * @returns {Object} 回傳 { errors:Array(字串), unknown:Array(未知鍵) }
 * @example
 * let r = checkDomain({ score: () => 1, scroe: 2 })
 * console.log(r.errors.length, r.unknown.join(','))
 * // => 0 scroe
 *
 * console.log(checkDomain({}).errors.length)
 * // => 1
 */
export let checkDomain = (domain = {}) => {
    let errors = [], unknown = []
    for (let [k, spec] of toPairs(DOMAIN_KEYS)) {
        let v = domain[k]
        if (v === null || v === undefined) { if (spec.required) { errors.push(`domain.${k} 必填(${spec.doc})`) } continue }
        let want = castArray(spec.type)
        if (!want.includes(typeOf(v))) { errors.push(`domain.${k} 型別應為 ${want.join(' | ')}, 實為 ${typeOf(v)}(${spec.doc})`) }
    }
    for (let k of keys(domain)) { if (!DOMAIN_KEYS[k]) { unknown.push(k) } }
    return { errors, unknown }
}

//領域鉤子 aliasShortOf 之包裝(2026-10-01;explore 之計數與 report 之列舉共用, 置此免 explore ↔ report 循環匯入):
//  未給鉤子 ⇒ 恆 null(不計);鉤子拋錯 ⇒ 視同 null(只影響計數 / 報告, 不影響流程)
/**
 * 領域鉤子 domain.aliasShortOf 之包裝:未給鉤子 ⇒ 恆 null(不計);鉤子拋錯 ⇒ 視同 null(只影響計數與報告,不影響流程)
 *
 * @param {Object} domain 輸入領域物件
 * @returns {Function} 回傳 (node) => { of, what? } | null
 * @example
 * let f = aliasShortOfDomain({ aliasShortOf: (n) => (n.id === 'x' ? { of: 'p1' } : null) })
 * console.log(JSON.stringify(f({ id: 'x' })), f({ id: 'y' }), aliasShortOfDomain({})({ id: 'x' }))
 * // => {"of":"p1"} null null
 */
export let aliasShortOfDomain = (domain) => (n) => {
    if (!domain || !isFunction(domain.aliasShortOf)) { return null }
    try { return domain.aliasShortOf(n) || null } catch (e) { return null }
}

export default { DOMAIN_KEYS, checkDomain, aliasShortOfDomain }
