import isFunction from 'lodash-es/isFunction.js'
import sortBy from 'lodash-es/sortBy.js'


//行為別名:executed 且非錨點之節點中, 指紋(領域之 fingerprint(raw))與「較早節點」相同者 → Map(aliasId → canonicalId)
//  用途:無效變異之偵測(算子改了引擎不讀之欄位)、控制器 / 做夢不以別名為父、下游之後續處理不重複
//  先後:輪次 → createdAt → id(確定性);指紋不可得(null)⇒ 不判(保守)
/**
 * 行為別名:executed 且非錨點之節點中,指紋(領域之 fingerprint(raw, node))與「較早節點」相同者 → Map(aliasId → canonicalId);先後依輪次、createdAt、id(確定性);指紋不可得(null)⇒ 不判(保守)
 *
 * @param {Array} nodes 輸入節點陣列
 * @param {Object} [opt={}] 輸入選項 { fingerprint:Function(必填,否則回空 Map), isAnchor:Function(預設恆 false) }
 * @returns {Map} 回傳 Map(別名 id → 正本 id)
 * @example
 * let nodes = [
 *     { id: 'a', status: 'executed', round: 1, raw: { f: 'x' } },
 *     { id: 'b', status: 'executed', round: 2, raw: { f: 'x' } },
 *     { id: 'c', status: 'executed', round: 2, raw: { f: 'y' } },
 * ]
 * let m = aliasMapOf(nodes, { fingerprint: (raw) => raw.f })
 * console.log(m.get('b'), m.has('a'), m.has('c'))
 * // => a false false
 */
export let aliasMapOf = (nodes, { fingerprint, isAnchor = () => false } = {}) => {
    let out = new Map()
    if (!isFunction(fingerprint)) { return out }
    let order = sortBy((nodes || []).filter((n) => n && n.status === 'executed' && !isAnchor(n)), [(n) => n.round || 0, (n) => n.createdAt || '', 'id'])
    let first = new Map()
    for (let n of order) {
        let f = fingerprint(n.raw, n)
        if (!f) { continue }
        if (first.has(f)) { out.set(n.id, first.get(f)) }
        else { first.set(f, n.id) }
    }
    return out
}

export default aliasMapOf
