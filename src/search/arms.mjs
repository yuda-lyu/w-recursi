import castArray from 'lodash-es/castArray.js'
import countBy from 'lodash-es/countBy.js'
import every from 'lodash-es/every.js'
import fromPairs from 'lodash-es/fromPairs.js'
import _get from 'lodash-es/get.js'
import has from 'lodash-es/has.js'
import isArray from 'lodash-es/isArray.js'
import isBoolean from 'lodash-es/isBoolean.js'
import isEqual from 'lodash-es/isEqual.js'
import isFunction from 'lodash-es/isFunction.js'
import isPlainObject from 'lodash-es/isPlainObject.js'
import isString from 'lodash-es/isString.js'
import keyBy from 'lodash-es/keyBy.js'
import keys from 'lodash-es/keys.js'
import map from 'lodash-es/map.js'
import size from 'lodash-es/size.js'
import some from 'lodash-es/some.js'
import toPairs from 'lodash-es/toPairs.js'
import uniq from 'lodash-es/uniq.js'
import uniqBy from 'lodash-es/uniqBy.js'
import values from 'lodash-es/values.js'
import { specHash } from '../core/canonical.mjs'


//臂目錄(arm catalog;2026-11-07 使用端需求:w-recursi 須能由外部注入指定多臂, 讓節點 agent 於探索 / 測試 / 計算時自選單臂或多臂去寫程式)
//  臂 = 探索之「可選方向」之一級概念(原引擎只認 operators(父生子)、carriers(根候選)、frontier arm(手登規格);臂種與其狀態散在 lore / 前緣 / 策略碼 / 派工說明)
//  目錄為**資料**(JSON 可), 由 createRsi({ arms: { catalog, defaults, use, known } }) 注入(仿 w-dispatch-ai:工廠一次注入定義表與預設, 其後以名稱宣告);他專案換一份目錄即用
//  條目(ARM_KEYS;未知鍵 ⇒ 組裝期拋錯, 與 CFG_KEYS / DOMAIN_KEYS 同精神):
//    id        識別字(唯一;^[A-Za-z][\w-]*$)         layer   層代號(catalog.layers 有表時須為其鍵)     title / desc   名稱 / 已試之形
//    status    done | partial | sparse | proposed | blocked(做完 / 部分 / 很少 / 提案 / 封鎖)
//    selectable 可否選為生成臂(預設 = 非 blocked;評估層、量尺、須改引擎者標 false:agent 看得到但不可選)
//    realize[] 怎麼落成規格(至少一項):{ kind:'operator', op } | { kind:'fragment', mech } | { kind:'spec', path } | { kind:'carrier', name } | { kind:'generative', module } | { kind:'manual', how }
//              | { kind:'origin', op }(只供覆蓋對應:節點之 origin.operator 為此值者計入本臂, 如全域取樣 G.sample、轉折 T.transfer、生成 novelty、手登臂之名;非登錄表之算子 ⇒ 不可限臂 / 組合)
//    grid / used  { 鍵: [值] } 格點全集與已用值 ⇒ unusedOf = 待探索空間      verdict / reopen / blockedBy  判定摘要 / 重啟條件 / 封鎖來源(blocked 必填)
//    requires / conflicts  [臂 id](多臂組合之相容規則)      n / refs  序號 / 參照(資訊)
//    origin    出處(物件;治理之擴充所加 / 所修 / 所停:哪一筆提案、哪一輪、誰提、誰審、何時;search/governance.mjs, 2026-11-14;基底目錄之臂通常無此欄)
//  lenient(2026-11-14;治理):makeArms / validateCatalog 之選項, 列「狀態根之擴充所加、所停或改了落成名 / 可選與否之臂 id」——其落成之算子 / 片段 / 生成模組 / 載體未登錄者
//    不拋錯:可選者列入 warnings 且不可選(pick 拒之;擴充之資料不得使組裝失敗), 本就不可選者(停用等)不警告;未給 ⇒ 行為逐字同改前(基底之臂恆嚴格)
//  提供:validateCatalog、pick(選臂:封鎖 / 不可選 / 做完未附重啟理由 / 衝突 / 依賴缺 ⇒ 拒)、restrict(本輪只用所選臂之算子與載體)、compose(多臂依序施用產子規格)、
//        coverage(樹上每臂之節點數 / 階 ≥ 1 / 階 ≥ 4;依 origin.arms 與 origin.operator, 另依規格特徵)、menu(每輪之選單 markdown, 供 agent 與派工說明)
//  接線:index.createRsi(rsi.arms)、loop/explore(opt.useArms / opt.reopen ⇒ 計畫只含所選臂;計畫項與節點之 origin.arms)、loop/generation(請求文列待探索臂)、loop/status、cli(--use-arms / --reopen / --mode arms)
/**
 * 臂之狀態:done(做完)、partial(部分)、sparse(很少)、proposed(提案)、blocked(封鎖)
 *
 * @type {Array}
 */
export const ARM_STATUS = ['done', 'partial', 'sparse', 'proposed', 'blocked']
/**
 * 臂之落成方式(realize 項之 kind):operator、fragment、spec、carrier、generative、manual、origin
 *
 * @type {Array}
 */
export const REALIZE_KINDS = ['operator', 'fragment', 'spec', 'carrier', 'generative', 'manual', 'origin']
/**
 * 臂目錄條目之已知鍵(未知鍵 ⇒ 組裝期拋錯)
 *
 * @type {Array}
 */
export const ARM_KEYS = ['id', 'n', 'layer', 'title', 'desc', 'status', 'selectable', 'realize', 'grid', 'used', 'verdict', 'reopen', 'blockedBy', 'requires', 'conflicts', 'refs', 'origin']
//cfg.arms 之已知鍵:catalog(目錄:{ arms:[…], layers?, name?, note?, version? } 或臂陣列)、defaults(覆寫 ARMS_DEFAULTS)、use(預設之選臂 id 陣列;explore 之 opt.useArms 覆寫)、
//  known({ fragments:[名], modules:[名], carriers:[名] }:realize 之 fragment / generative / carrier 之合法名;給了才核對)
/**
 * cfg.arms 之已知鍵:catalog(目錄)、defaults(覆寫 ARMS_DEFAULTS)、use(預設之選臂 id)、known(realize 之名之合法集)
 *
 * @type {Array}
 */
export const ARMS_CFG_KEYS = ['catalog', 'defaults', 'use', 'known']
//requireReopenFor:選此等狀態之臂須附重啟理由;maxCompose:compose 之子規格上限;menuTitle:選單標題
/**
 * 臂目錄之預設:requireReopenFor(選此等狀態之臂須附重啟理由,預設 done)、maxCompose(compose 之子規格上限)、menuTitle(選單標題)
 *
 * @type {Object}
 */
export const ARMS_DEFAULTS = Object.freeze({ requireReopenFor: ['done'], maxCompose: 64, menuTitle: '可用臂選單' })
const ID_RE = /^[A-Za-z][\w-]*$/
const REALIZE_FIELD = { operator: 'op', fragment: 'mech', spec: 'path', carrier: 'name', generative: 'module', manual: 'how', origin: 'op' }

/**
 * 取目錄之臂陣列(目錄可為臂陣列或 { arms, layers? });其他形回 []
 *
 * @param {Array|Object|null} catalog 輸入目錄
 * @returns {Array} 回傳臂陣列
 * @example
 * console.log(catalogArmsOf({ arms: [{ id: 'A1' }] }).length, catalogArmsOf([{ id: 'A1' }, { id: 'A2' }]).length, catalogArmsOf(null).length)
 * // => 1 2 0
 */
export let catalogArmsOf = (catalog) => (isArray(catalog) ? catalog : isPlainObject(catalog) && isArray(catalog.arms) ? catalog.arms : [])
/**
 * 取目錄之層代號表({ 代號: 名 });無 ⇒ {}
 *
 * @param {Array|Object|null} catalog 輸入目錄
 * @returns {Object} 回傳層表
 * @example
 * console.log(JSON.stringify(catalogLayersOf({ layers: { E: '評估層' }, arms: [] })), JSON.stringify(catalogLayersOf([])))
 * // => {"E":"評估層"} {}
 */
export let catalogLayersOf = (catalog) => (isPlainObject(catalog) && isPlainObject(catalog.layers) ? catalog.layers : {})
//預設之可選性:非 blocked 即可選(目錄可明設 selectable)
/**
 * 臂預設之可選性:明設 selectable 者從之,否則非 blocked 即可選
 *
 * @param {Object} a 輸入臂條目
 * @returns {Boolean} 回傳是否可選
 * @example
 * console.log(selectableOf({ status: 'done' }), selectableOf({ status: 'blocked' }), selectableOf({ status: 'sparse', selectable: false }))
 * // => true false false
 */
export let selectableOf = (a) => (a && a.selectable !== undefined ? a.selectable === true : !!a && a.status !== 'blocked')
//臂之算子名(realize 之 operator 項;限臂 / 組合用)
/**
 * 臂之算子名(realize 之 operator 項;限臂與組合用)
 *
 * @param {Object} a 輸入臂條目
 * @returns {Array} 回傳算子名陣列(去重)
 * @example
 * let a = { realize: [{ kind: 'operator', op: 'inc' }, { kind: 'origin', op: 'G.sample' }, { kind: 'carrier', name: 'root' }] }
 * console.log(opsOfArm(a).join(','))
 * // => inc
 */
export let opsOfArm = (a) => uniq(((a && a.realize) || []).filter((r) => r && r.kind === 'operator' && isString(r.op)).map((r) => r.op))
//臂之來源名(realize 之 operator ∪ origin 項;覆蓋對應用:節點之 origin.operator ∈ 此集 ⇒ 計入本臂)
/**
 * 臂之來源名(realize 之 operator 與 origin 項;覆蓋對應用:節點之 origin.operator 屬此集 ⇒ 計入本臂)
 *
 * @param {Object} a 輸入臂條目
 * @returns {Array} 回傳來源名陣列(去重)
 * @example
 * let a = { realize: [{ kind: 'operator', op: 'inc' }, { kind: 'origin', op: 'G.sample' }, { kind: 'carrier', name: 'root' }] }
 * console.log(originsOfArm(a).join(','))
 * // => inc,G.sample
 */
export let originsOfArm = (a) => uniq(((a && a.realize) || []).filter((r) => r && (r.kind === 'operator' || r.kind === 'origin') && isString(r.op)).map((r) => r.op))
/**
 * 臂之載體名(realize 之 carrier 項)
 *
 * @param {Object} a 輸入臂條目
 * @returns {Array} 回傳載體名陣列(去重)
 * @example
 * let a = { realize: [{ kind: 'operator', op: 'inc' }, { kind: 'carrier', name: 'root' }] }
 * console.log(carriersOfArm(a).join(','))
 * // => root
 */
export let carriersOfArm = (a) => uniq(((a && a.realize) || []).filter((r) => r && r.kind === 'carrier' && isString(r.name)).map((r) => r.name))
//未用之格點(grid − used;值以 isEqual 比)⇒ { 鍵: [值] }(只列有未用者)
/**
 * 未用之格點(grid − used;值以 isEqual 比)⇒ 待探索空間
 *
 * @param {Object} a 輸入臂條目 { grid:{ 鍵:[值] }, used:{ 鍵:[值] } }
 * @returns {Object} 回傳 { 鍵:[未用值] }(只列有未用者)
 * @example
 * console.log(JSON.stringify(unusedOf({ grid: { k: [1, 2, 3], z: [0] }, used: { k: [2], z: [0] } })))
 * // => {"k":[1,3]}
 */
export let unusedOf = (a) => {
    let out = {}
    for (let [k, g] of toPairs((a && a.grid) || {})) {
        if (!isArray(g)) { continue }
        let u = _get(a, ['used', k], [])
        let rest = g.filter((v) => !some(u, (x) => isEqual(x, v)))
        if (rest.length) { out[k] = rest }
    }
    return out
}

//目錄之檢查(純函式)⇒ { errors:[字串], warnings:[字串] };opt.operators / fragments / modules / carriers:合法名之陣列(給了才核對)
/**
 * 目錄之檢查(純函式):形、未知鍵、id 唯一與格式、title、status、selectable、blocked 須附 blockedBy、layer 在層表、realize 至少一項且各項之 kind 與必填欄、grid / used 形、origin 為物件、requires / conflicts 指向存在之臂;opt 給了合法名清單才核對 realize 之名(lenient 所列之臂,以及落成之名為寬鬆之名〔lenient 之臂於本目錄所落成之名 ∪ lenientNames〕之臂,未登錄者:可選者降為警告並列於 unregistered,本就不可選者不警告)
 *
 * @param {Array|Object|null} catalog 輸入目錄
 * @param {Object} [opt={}] 輸入 { operators:Array, fragments:Array, modules:Array, carriers:Array }(給了才核對)、lenient:Array(治理之擴充所加、所停或改了落成名 / 可選與否之臂 id)、lenientNames:Array(另外寬鬆之落成名);lenient 或 lenientNames 給了回傳另有 unregistered
 * @returns {Object} 回傳 { errors:Array(字串), warnings:Array(字串) };給 lenient / lenientNames 時另有 unregistered:Array(落成之名未登錄而降為不可選之臂 id)
 * @example
 * let ok = { arms: [{ id: 'A1', layer: 'L', title: '遞增', status: 'sparse', realize: [{ kind: 'operator', op: 'inc' }] }] }
 * console.log(validateCatalog(ok, { operators: ['inc'] }).errors.length)
 * // => 0
 *
 * console.log(validateCatalog(ok, { operators: ['dec'] }).errors[0])
 * // => 臂[0] A1:realize 之算子 inc 不在登錄表
 *
 * console.log(validateCatalog({ arms: [{ id: '1x' }] }).errors.length > 0)
 * // => true
 */
export let validateCatalog = (catalog, { operators = null, fragments = null, modules = null, carriers = null, lenient = null, lenientNames = null } = {}) => {
    let errors = [], warnings = []
    let soft = isArray(lenient) || isArray(lenientNames) ? new Set(isArray(lenient) ? lenient : []) : null
    let unregistered = []
    let done = () => (soft ? { errors, warnings, unregistered: uniq(unregistered) } : { errors, warnings })
    if (catalog !== null && catalog !== undefined && !isArray(catalog) && !(isPlainObject(catalog) && isArray(catalog.arms))) { errors.push('arms.catalog 須為臂陣列或 { arms:[…], layers? }'); return done() }
    let arms = catalogArmsOf(catalog)
    let layers = catalogLayersOf(catalog)
    let ids = new Set()
    let known = (list, v) => !isArray(list) || list.includes(v)
    //寬鬆之名(2026-11-14,Gitea #144):lenient 之臂於本目錄所落成之名 ∪ lenientNames(治理所觸及之臂於基底與擴充項內之名)——
    //  由目錄推導登錄者, 這些名之登錄與否隨審定而變;共用其名之他臂(含基底未被觸及者)亦不因之拋錯
    let softNames = new Set(isArray(lenientNames) ? lenientNames.filter(isString) : [])
    if (soft) { for (let a of arms) { if (isPlainObject(a) && soft.has(a.id) && isArray(a.realize)) { for (let r of a.realize) { let f = isPlainObject(r) ? REALIZE_FIELD[r.kind] : null; if (f && isString(r[f])) { softNames.add(r[f]) } } } } }
    for (let [i, a] of arms.entries()) {
        let at = `臂[${i}]${a && a.id ? ` ${a.id}` : ''}`
        //落成之名未登錄:擴充之臂(lenient)或寬鬆之名 ⇒ 可選者警告並記 unregistered(不可選至登錄為止);本就不可選者(停用 / blocked / selectable false)不需登錄 ⇒ 不警告(2026-11-14,Gitea #144);其餘 ⇒ 錯誤
        let unreg = (name, msg) => {
            if (!(soft && a && (soft.has(a.id) || softNames.has(name)))) { errors.push(msg); return }
            if (selectableOf(a)) { warnings.push(`${msg}(治理之擴充:不可選至登錄為止)`); unregistered.push(a.id) }
        }
        if (!isPlainObject(a)) { errors.push(`${at}:須為物件`); continue }
        let unknown = keys(a).filter((k) => !ARM_KEYS.includes(k))
        if (unknown.length) { errors.push(`${at}:未知鍵 ${unknown.join(', ')}(已知鍵 ${ARM_KEYS.join(', ')})`) }
        if (!isString(a.id) || !ID_RE.test(a.id)) { errors.push(`${at}:id 須為識別字(${ID_RE})`) }
        else if (ids.has(a.id)) { errors.push(`${at}:id 重複`) }
        else { ids.add(a.id) }
        if (!isString(a.title) || !a.title.trim()) { errors.push(`${at}:title 必填`) }
        if (!ARM_STATUS.includes(a.status)) { errors.push(`${at}:status 須為 ${ARM_STATUS.join(' | ')}(收到 ${a.status})`) }
        if (a.selectable !== undefined && !isBoolean(a.selectable)) { errors.push(`${at}:selectable 須為布林`) }
        if (a.status === 'blocked') {
            if (!isString(a.blockedBy) || !a.blockedBy.trim()) { errors.push(`${at}:blocked 須附 blockedBy(封鎖來源)`) }
            if (a.selectable === true) { errors.push(`${at}:blocked 不可 selectable`) }
        }
        if (size(layers) && !(a.layer in layers)) { errors.push(`${at}:layer ${a.layer} 不在 catalog.layers(${keys(layers).join(', ')})`) }
        if (!isArray(a.realize) || !a.realize.length) { errors.push(`${at}:realize 至少一項`) }
        else {
            for (let [j, r] of a.realize.entries()) {
                if (!isPlainObject(r) || !REALIZE_KINDS.includes(r.kind)) { errors.push(`${at}:realize[${j}] 之 kind 須為 ${REALIZE_KINDS.join(' | ')}`); continue }
                let f = REALIZE_FIELD[r.kind]
                if (!isString(r[f]) || !r[f].trim()) { errors.push(`${at}:realize[${j}](${r.kind})須有 ${f}`); continue }
                if (r.kind === 'operator' && !known(operators, r.op)) { unreg(r.op, `${at}:realize 之算子 ${r.op} 不在登錄表`) }
                if (r.kind === 'fragment' && !known(fragments, r.mech)) { unreg(r.mech, `${at}:realize 之片段 ${r.mech} 不在 known.fragments`) }
                if (r.kind === 'generative' && !known(modules, r.module)) { unreg(r.module, `${at}:realize 之生成模組 ${r.module} 不在 known.modules`) }
                if (r.kind === 'carrier' && !known(carriers, r.name)) { unreg(r.name, `${at}:realize 之載體 ${r.name} 不在 known.carriers`) }
            }
        }
        for (let k of ['grid', 'used']) { if (a[k] !== undefined && !(isPlainObject(a[k]) && every(values(a[k]), isArray))) { errors.push(`${at}:${k} 須為 { 鍵: [值] }`) } }
        for (let k of keys(a.used || {})) { if (!has(a, ['grid', k])) { warnings.push(`${at}:used.${k} 無對應之 grid.${k}`) } }
        if (a.origin !== undefined && !isPlainObject(a.origin)) { errors.push(`${at}:origin 須為物件(出處)`) }
        for (let k of ['requires', 'conflicts']) { if (a[k] !== undefined && !(isArray(a[k]) && a[k].every(isString))) { errors.push(`${at}:${k} 須為臂 id 陣列`) } }
    }
    for (let a of arms) {
        if (!isPlainObject(a)) { continue }
        for (let k of ['requires', 'conflicts']) { for (let x of (isArray(a[k]) ? a[k] : [])) { if (!ids.has(x)) { errors.push(`臂 ${a.id}:${k} 指向不存在之臂 ${x}`) } } }
    }
    return done()
}
//cfg.arms 之形(純函式;createRsi 據以拋錯)⇒ { errors }
/**
 * cfg.arms 之形檢查(純函式;createRsi 據以拋錯):須為物件、無未知鍵、use 為臂 id 陣列、defaults 與 known 為物件
 *
 * @param {*} ac 輸入 cfg.arms
 * @returns {Object} 回傳 { errors:Array(字串) }
 * @example
 * console.log(checkArmsCfg(undefined).errors.length, checkArmsCfg({ use: 'A1' }).errors.length, checkArmsCfg({ foo: 1 }).errors.length)
 * // => 0 1 1
 */
export let checkArmsCfg = (ac) => {
    let errors = []
    if (ac === undefined || ac === null) { return { errors } }
    if (!isPlainObject(ac)) { return { errors: ['cfg.arms 須為物件 { catalog, defaults?, use?, known? }'] } }
    let unknown = keys(ac).filter((k) => !ARMS_CFG_KEYS.includes(k))
    if (unknown.length) { errors.push(`cfg.arms 有未知鍵 ${unknown.join(', ')}(已知鍵 ${ARMS_CFG_KEYS.join(', ')})`) }
    if (ac.use !== undefined && !(isArray(ac.use) && ac.use.every(isString))) { errors.push('cfg.arms.use 須為臂 id 之陣列') }
    if (ac.defaults !== undefined && !isPlainObject(ac.defaults)) { errors.push('cfg.arms.defaults 須為物件') }
    if (ac.known !== undefined && !isPlainObject(ac.known)) { errors.push('cfg.arms.known 須為物件 { fragments?, modules?, carriers? }') }
    return { errors }
}

//規格是否含某臂之特徵(覆蓋之第二口徑;純函式):fragment ⇒ spec.mechs 含之;spec 路徑 ⇒ 有值且非 false / null;generative ⇒ kind operator 且 module 同;cond 之分支 / book 之帳 / 配比之子池遞迴
/**
 * 規格是否含某臂之特徵(覆蓋之第二口徑;純函式):fragment ⇒ spec.mechs 含之;spec 路徑 ⇒ 有值且非 false / null;generative ⇒ kind 為 operator 且 module 同;branches、books、params.pools 內之子規格遞迴
 *
 * @param {Object} a 輸入臂條目
 * @param {*} spec 輸入節點規格
 * @returns {Boolean} 回傳是否含特徵
 * @example
 * let a = { realize: [{ kind: 'spec', path: 'opts.x' }] }
 * console.log(featureOf(a, { opts: { x: 1 } }), featureOf(a, { opts: { x: false } }), featureOf(a, {}))
 * // => true false false
 */
export let featureOf = (a, spec) => {
    let hit = (s) => {
        if (!isPlainObject(s)) { return false }
        for (let r of (a && a.realize) || []) {
            if (r.kind === 'fragment' && isArray(s.mechs) && s.mechs.includes(r.mech)) { return true }
            if (r.kind === 'spec') { let v = _get(s, r.path); if (v !== undefined && v !== null && v !== false) { return true } }
            if (r.kind === 'generative' && s.kind === 'operator' && s.module === r.module) { return true }
        }
        if (isPlainObject(s.branches)) { for (let b of values(s.branches)) { if (hit(b)) { return true } } }
        if (isArray(s.books)) { for (let b of s.books) { if (hit(b)) { return true } } }
        if (isArray(_get(s, 'params.pools'))) { for (let p of s.params.pools) { if (hit(_get(p, 'spec'))) { return true } } }
        return false
    }
    return hit(spec)
}

/**
 * 臂目錄工廠(臂 = 探索之「可選方向」之一級概念;目錄為資料,由 createRsi({ arms }) 注入):目錄不合即拋(組裝期)。實例提供 validate / get / list / pick(選臂:封鎖、不可選、done 未附重啟理由、衝突、依賴缺 ⇒ 拒)/ restrict(本輪只用所選臂之算子與載體)/ compose(多臂依序施用產子規格)/ coverage(每臂之節點數、階 ≥ 1、階 ≥ 4)/ menu(選單 markdown)
 *
 * @param {Object} [o={}] 輸入 { catalog:Array|Object, defaults:Object(覆寫 ARMS_DEFAULTS), registry:Object(makeRegistry 之回傳,用以核對算子名), known:Object({ fragments, modules, carriers }), lenient:Array(治理之擴充所加、所停或改了落成名 / 可選與否之臂 id:落成之名未登錄者不拋錯,可選者列入 warnings 且不可選), lenientNames:Array(另外寬鬆之落成名:共用其名之臂同上;見 governance.mjs 之 lenientNamesOf) }
 * @returns {Object} 回傳 { arms, layers, byId, defaults, size, validate, warnings, get, list, selectableOf, opsOfArm, originsOfArm, carriersOfArm, armsOfOp, unusedOf, featureOf, pick, opsOf, carriersOf, restrict, compose, coverage, menuLines, menu }
 * @throws {Error} 目錄不合時拋出
 * @example
 * let catalog = {
 *     layers: { L: '層' },
 *     arms: [
 *         { id: 'A1', layer: 'L', title: '遞增', status: 'sparse', realize: [{ kind: 'operator', op: 'inc' }] },
 *         { id: 'B1', layer: 'L', title: '已封鎖', status: 'blocked', blockedBy: '需改引擎', realize: [{ kind: 'manual', how: '待辦' }] },
 *     ],
 * }
 * let arms = makeArms({ catalog })
 * let pk = arms.pick(['A1', 'B1'])
 * console.log(arms.size, pk.ok.map((a) => a.id).join(','), pk.rejected.map((r) => r.id + ':' + r.why).join(','))
 * // => 2 A1 B1:封鎖:需改引擎
 */
export let makeArms = ({ catalog = null, defaults = {}, registry = null, known = {}, lenient = null, lenientNames = null } = {}) => {
    let arms = catalogArmsOf(catalog)
    let layers = catalogLayersOf(catalog)
    let D = { ...ARMS_DEFAULTS, ...(defaults || {}) }
    let chk = validateCatalog(catalog, { operators: registry && isArray(registry.names) ? registry.names : null, fragments: _get(known, 'fragments', null), modules: _get(known, 'modules', null), carriers: _get(known, 'carriers', null), ...(isArray(lenient) ? { lenient } : {}), ...(isArray(lenientNames) ? { lenientNames } : {}) })
    if (chk.errors.length) { throw new Error(`arms: 臂目錄不合:\n  ${chk.errors.join('\n  ')}`) }
    //治理之擴充之臂, 落成之名未登錄 ⇒ 不可選(副本;原目錄不改)
    let unreg = new Set(chk.unregistered || [])
    if (unreg.size) { arms = arms.map((a) => (unreg.has(a.id) ? { ...a, selectable: false } : a)) }
    let byId = keyBy(arms, 'id')
    let opToArms = {}
    for (let a of arms) { for (let op of originsOfArm(a)) { (opToArms[op] = opToArms[op] || []).push(a.id) } } //覆蓋對應:operator ∪ origin 兩種落成
    let armsOfOp = (op) => opToArms[op] || []
    let get = (id) => byId[id] || null
    let list = ({ layer = null, status = null, selectable = null } = {}) => arms.filter((a) => (layer === null || a.layer === layer) && (status === null || castArray(status).includes(a.status)) && (selectable === null || selectableOf(a) === selectable))
    //選臂:ids ⇒ { ok:[臂], rejected:[{ id, why }] };opt.reopen = 重啟理由(選 requireReopenFor 之狀態之臂時必填)
    let pick = (ids, { reopen = null } = {}) => {
        let ok = [], rejected = []
        let want = uniq(castArray(ids || []).filter(Boolean))
        for (let id of want) {
            let a = byId[id]
            if (!a) { rejected.push({ id, why: '目錄無此臂' }); continue }
            if (a.status === 'blocked') { rejected.push({ id, why: `封鎖:${a.blockedBy}` }); continue }
            if (unreg.has(id)) { rejected.push({ id, why: '落成之算子 / 名尚未登錄(治理之擴充所加;領域登錄後之下一次組裝起可選)' }); continue }
            if (!selectableOf(a)) { rejected.push({ id, why: '不可選為生成臂(評估 / 對照層、量尺或須改引擎者)' }); continue }
            if ((D.requireReopenFor || []).includes(a.status) && !(isString(reopen) && reopen.trim())) { rejected.push({ id, why: `狀態 ${a.status}(做完 / 結案):須附重啟理由 reopen${a.reopen ? `(目錄之重啟條件:${a.reopen})` : ''}` }); continue }
            let clash = ok.find((b) => (b.conflicts || []).includes(a.id) || (a.conflicts || []).includes(b.id))
            if (clash) { rejected.push({ id, why: `與已選之臂 ${clash.id} 衝突` }); continue }
            ok.push(a)
        }
        let okIds = new Set(ok.map((a) => a.id))
        let missing = ok.filter((a) => (a.requires || []).some((r) => !okIds.has(r)))
        for (let a of missing) { rejected.push({ id: a.id, why: `依賴之臂 ${(a.requires || []).filter((r) => !okIds.has(r)).join(', ')} 未同選` }) }
        ok = ok.filter((a) => !missing.includes(a))
        return { ok, rejected }
    }
    let opsOf = (ids) => uniq(castArray(ids || []).flatMap((id) => opsOfArm(byId[id])))
    let carriersOf = (ids) => uniq(castArray(ids || []).flatMap((id) => carriersOfArm(byId[id])))
    //本輪只用所選臂:ops(允許之算子)、carriers(允許之載體名;所選臂無 carrier 項 ⇒ 不放行任何載體)、childrenOf 之包裝、計畫項之判定
    let restrict = (ids) => {
        let ops = new Set(opsOf(ids))
        let cs = new Set(carriersOf(ids))
        let wrap = (childrenOf) => (spec, opt = {}) => {
            let only = isArray(opt.ops) ? opt.ops.filter((o) => ops.has(o)) : [...ops]
            if (!only.length) { return [] }
            return (childrenOf(spec, { ...opt, ops: only }) || []).filter((k) => ops.has(k.op))
        }
        //計畫項之載體名(策略 v0 與領域策略之新區域臂之 reason 形「載體 <名> 未入樹」「載體 <名>(附註) 未入樹」;origin.topic 'carrier')
        let carrierNameOf = (it) => { if (_get(it, 'origin.topic', null) !== 'carrier') { return null } let m = /^載體 (\S+?)(?:\(|$| )/.exec(String(it.reason || '')); return m ? m[1] : null }
        let allowItem = (it) => {
            if (it.kindOf === 'expand') { return !!it.op && ops.has(it.op) }
            let op = it.op || _get(it, 'origin.operator', null)
            if (op && ops.has(op)) { return true }
            let c = carrierNameOf(it)
            return !!(c && cs.has(c))
        }
        //計畫項對應之所選臂(算子 ⇒ 含該算子之臂;載體 ⇒ 含該載體之臂)
        let armsOfItem = (it) => castArray(ids || []).filter((id) => {
            let a = byId[id]
            if (!a) { return false }
            let op = it.kindOf === 'expand' ? it.op : (it.op || _get(it, 'origin.operator', null))
            if (op && opsOfArm(a).includes(op)) { return true }
            let c = carrierNameOf(it)
            return !!(c && carriersOfArm(a).includes(c))
        })
        return { ids: castArray(ids || []), ops: [...ops], carriers: [...cs], childrenOf: wrap, allowItem, armsOfItem }
    }
    //多臂組合:依 ids 之序, 對當前規格集逐臂以其算子展開(childrenOf 由呼叫端給:registry.childrenOf 或 makeCtx 之包裝), 去重(specHash)、過 validateSpec、上限 max
    //  ⇒ { specs:[{ spec, specHash, path:[算子], arms:[臂 id] }], skipped:[無算子項之臂 id] }
    let compose = (ids, parentSpec, { childrenOf, validateSpec = null, max = D.maxCompose } = {}) => {
        if (!isFunction(childrenOf)) { throw new Error('arms.compose: 須給 childrenOf') }
        let ok = (s) => { if (!isFunction(validateSpec)) { return true } try { validateSpec(s); return true } catch (e) { return false } }
        let specs = [{ spec: parentSpec, specHash: specHash(parentSpec), path: [], arms: [] }]
        let skipped = []
        for (let id of castArray(ids || [])) {
            let ops = opsOfArm(byId[id])
            if (!ops.length) { skipped.push(id); continue }
            let next = []
            for (let s of specs) {
                for (let k of childrenOf(s.spec, { ops }) || []) {
                    if (!k || !k.spec || !ops.includes(k.op)) { continue }
                    next.push({ spec: k.spec, specHash: k.specHash || specHash(k.spec), path: [...s.path, k.op], arms: [...s.arms, id] })
                }
            }
            specs = uniqBy(next, 'specHash').filter((x) => ok(x.spec)).slice(0, max)
            if (!specs.length) { break }
        }
        return { specs: specs.filter((x) => x.path.length), skipped }
    }
    //覆蓋:nodes(節點或索引列;需 origin.operator / origin.arms / score.ladder 或 ladder / spec(特徵口徑, 可省))⇒ { byArm:{ id:{ n, ge1, ge4, byOp:{}, feature } }, unmapped:{ 算子: n } }
    //  計入臂之判定:origin.arms(計畫時所記)∪ armsOfOp(origin.operator);feature = spec 含該臂之特徵(含既有節點;無 spec 者不計)
    let coverage = (nodes) => {
        let byArm = fromPairs(arms.map((a) => [a.id, { n: 0, ge1: 0, ge4: 0, byOp: {}, feature: 0 }]))
        let unmapped = {}
        for (let n of nodes || []) {
            let lad = _get(n, 'score.ladder', _get(n, 'ladder', 0)) || 0
            let op = _get(n, 'origin.operator', _get(n, 'operator', null))
            let ids = uniq([...(isArray(_get(n, 'origin.arms')) ? n.origin.arms : []), ...(op ? armsOfOp(op) : [])]).filter((id) => byArm[id])
            if (!ids.length && op) { unmapped[op] = (unmapped[op] || 0) + 1 }
            for (let id of ids) { let c = byArm[id]; c.n++; if (lad >= 1) { c.ge1++ } if (lad >= 4) { c.ge4++ } if (op) { c.byOp[op] = (c.byOp[op] || 0) + 1 } }
            if (n.spec) { for (let a of arms) { if (featureOf(a, n.spec)) { byArm[a.id].feature++ } } }
        }
        return { byArm, unmapped, nNodes: (nodes || []).length }
    }
    let realizeText = (a) => (a.realize || []).map((r) => (r.kind === 'operator' ? r.op : r.kind === 'origin' ? `來源 ${r.op}` : r.kind === 'fragment' ? r.mech : r.kind === 'spec' ? r.path : r.kind === 'carrier' ? `載體 ${r.name}` : r.kind === 'generative' ? `${r.module}.mjs` : `(${r.how})`)).join(' / ')
    //選單(markdown 列):每層一表;opt.coverage(coverage 之回傳)有則加覆蓋欄;opt.statuses / selectable 可篩
    let menuLines = ({ coverage: cov = null, statuses = null, selectable = null, title = D.menuTitle, withHeader = true } = {}) => {
        let L = []
        if (withHeader) { L.push(`# ${title}(${arms.length} 臂;可選 ${arms.filter(selectableOf).length};狀態:${map(countBy(arms, 'status'), (v, k) => `${k} ${v}`).join('、')})`, '', '選臂:`--use-arms <id,…>`(狀態 done 之臂須附 `--reopen <理由>`;blocked / 不可選者拒);多臂組合依所列次序施用各臂之算子。未用格點 = 目錄之 grid − used。覆蓋 = 節點 / 階 ≥ 1 / 階 ≥ 4(依 origin.arms ∪ origin.operator);特徵 = 規格含該臂特徵之節點。', '') }
        let sel = list({ status: statuses, selectable })
        let layerKeys = uniq([...keys(layers), ...sel.map((a) => a.layer)])
        for (let lk of layerKeys) {
            let rows = sel.filter((a) => a.layer === lk)
            if (!rows.length) { continue }
            L.push(`## ${lk}. ${layers[lk] || ''}`, '', `| id | 狀態 | 可選 | 臂 | 落成 | 未用格點 | ${cov ? '覆蓋 | 特徵 | ' : ''}判定 / 重啟 |`, `|---|---|---|---|---|---|${cov ? '---|---|' : ''}---|`)
            for (let a of rows) {
                let un = unusedOf(a)
                let unTxt = size(un) ? map(un, (v, k) => `${k}:${v.map((x) => JSON.stringify(x)).join(',')}`).join(';') : '—'
                let c = cov ? _get(cov, ['byArm', a.id], null) : null
                L.push(`| ${a.id} | ${a.status} | ${selectableOf(a) ? '是' : '否'} | ${String(a.title).replace(/\|/g, '/')} | ${realizeText(a).replace(/\|/g, '/')} | ${unTxt.replace(/\|/g, '/')} | ${cov ? `${c ? `${c.n}/${c.ge1}/${c.ge4}` : '-'} | ${c ? c.feature : '-'} | ` : ''}${String(a.status === 'blocked' ? `封鎖:${a.blockedBy}` : `${a.verdict || ''}${a.reopen ? `;重啟:${a.reopen}` : ''}`).replace(/\|/g, '/')} |`)
            }
            L.push('')
        }
        if (cov && size(cov.unmapped)) { L.push(`- 未對應任何臂之算子(origin.operator):${map(cov.unmapped, (v, k) => `${k} ${v}`).join('、')}`, '') }
        return L
    }
    let menu = (opt = {}) => menuLines(opt).join('\n')
    return { arms, layers, byId, defaults: D, size: arms.length, validate: () => chk, warnings: chk.warnings, get, list, selectableOf, opsOfArm, originsOfArm, carriersOfArm, armsOfOp, unusedOf, featureOf, pick, opsOf, carriersOf, restrict, compose, coverage, menuLines, menu }
}

export default { ARM_STATUS, REALIZE_KINDS, ARM_KEYS, ARMS_CFG_KEYS, ARMS_DEFAULTS, catalogArmsOf, catalogLayersOf, selectableOf, opsOfArm, originsOfArm, carriersOfArm, unusedOf, validateCatalog, checkArmsCfg, featureOf, makeArms }
