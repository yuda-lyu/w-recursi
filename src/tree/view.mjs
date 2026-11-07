import isFunction from 'lodash-es/isFunction.js'
import omit from 'lodash-es/omit.js'
import { aliasMapOf } from './alias.mjs'


//策略視圖(遮蔽):探索策略與策略開發代理只看得到這個;領域以 mask(score, node) 決定哪些數值不給看(如留出段)
/**
 * 策略視圖(遮蔽):探索策略與策略開發代理只看得到這個;領域以 mask(score, node) 決定哪些數值不給看,maskNode(view, node) 再做節點層之遮蔽或附加
 *
 * @param {Object} node 輸入完整節點
 * @param {String|null} aliasOf 輸入此節點之正本 id(非別名為 null)
 * @param {Object} [domain={}] 輸入領域物件 { summarize, carrierOf, mask, maskNode }
 * @returns {Object} 回傳視圖 { id, parent, round, status, spec, origin, carrier, summary, children, aliasOf, score, cost, evidence, notes }
 * @example
 * let node = { id: 'n1', spec: { a: 1 }, status: 'executed', score: { S: 3, hidden: 9 } }
 * let v = policyViewOfNode(node, null, { mask: (s) => ({ S: s.S }) })
 * console.log(JSON.stringify(v.score), v.parent, v.aliasOf)
 * // => {"S":3} root null
 */
export let policyViewOfNode = (node, aliasOf, domain = {}) => {
    let summarize = domain.summarize || ((spec) => JSON.stringify(spec).slice(0, 80))
    let carrierOf = domain.carrierOf || (() => null)
    let score = node.score ? (isFunction(domain.mask) ? domain.mask(node.score, node) : node.score) : null
    let v = {
        id: node.id, parent: node.parent || 'root', round: node.round || 0, status: node.status, spec: node.spec, origin: node.origin || null,
        carrier: carrierOf(node.spec), summary: summarize(node.spec), children: node.children || [], aliasOf: aliasOf || null,
        score, cost: node.cost || null, evidence: node.evidence || null, notes: node.notes || null,
    }
    //節點層遮蔽(2026-09-27;領域鉤子 maskNode):evidence / notes 可含被遮蔽之資訊(如被遮蔽之留出段、外部驗證結果)⇒ 由領域決定去留並可加標記
    return isFunction(domain.maskNode) ? domain.maskNode(v, node) : v
}

//遮蔽輔助:依路徑清單 omit(深路徑)
/**
 * 遮蔽輔助:依路徑清單 omit(深路徑),回傳可直接當 domain.mask 之函數
 *
 * @param {Array} paths 輸入欲隱藏之路徑清單(lodash 路徑)
 * @returns {Function} 回傳 (score) => 去除所列路徑後之分數
 * @example
 * let mask = omitMask(['heldOut', 'detail.raw'])
 * console.log(JSON.stringify(mask({ S: 1, heldOut: 2, detail: { raw: 3, ok: 4 } })))
 * // => {"S":1,"detail":{"ok":4}}
 */
export let omitMask = (paths) => (score) => omit(score, paths)

//靜態檢查:策略碼不得寫樹、不得開子程序、不得讀暫存;領域可追加(如不得讀被遮蔽之欄位)
//  2026-09-29:store 新增之前緣寫入 resolveFrontier 與 markFrontier 同列(兄弟寫入函式一併擋)
/**
 * 策略碼靜態檢查之預設禁用式:不得開子程序、不得寫樹(putNode、pushFrontier、markFrontier、resolveFrontier、claimNodes、setStatus)、不得讀暫存夾
 *
 * @type {Array}
 */
export const DEFAULT_FORBIDDEN = [/child_process/, /putNode|pushFrontier|markFrontier|resolveFrontier|claimNodes|setStatus/, /['"`]\.\/tmp\b/]
/**
 * 策略碼靜態檢查:原文命中任一禁用式即列入回傳(預設禁用式 + 領域追加)
 *
 * @param {String} src 輸入策略檔原文
 * @param {Array} [forbidden=[]] 輸入領域追加之正規表示式
 * @returns {Array} 回傳命中之正規表示式字串(空陣列 = 通過)
 * @example
 * console.log(checkPolicySource('export default () => 1').length)
 * // => 0
 *
 * console.log(checkPolicySource("import cp from 'child_process'\nstore.putNode(x)").length)
 * // => 2
 *
 * console.log(checkPolicySource('secretField', [/secretField/]).join(''))
 * // => /secretField/
 */
export let checkPolicySource = (src, forbidden = []) => {
    let bad = []
    for (let re of [...DEFAULT_FORBIDDEN, ...forbidden]) { if (re.test(src)) { bad.push(String(re)) } }
    return bad
}

/**
 * 策略視圖工廠:取全樹視圖(別名以全樹判定,即使只取 ids 子集)
 *
 * @param {Object} store 輸入 makeStore 之回傳
 * @param {Object} [domain={}] 輸入領域物件 { fingerprint, isAnchor, summarize, carrierOf, mask, maskNode }
 * @returns {Object} 回傳 { policyView(ids?:Set) → 視圖陣列, policyViewOfNode(node, aliasOf), aliasOf(nodes) → Map }
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 * import { makePaths } from 'w-recursi/src/core/paths.mjs'
 * import { makeStore } from 'w-recursi/src/tree/store.mjs'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let store = makeStore({ paths: makePaths(dir) })
 * store.putNode({ id: 'n1', spec: { a: 1 }, status: 'executed', score: { S: 2, hidden: 7 } })
 * let view = makeView(store, { mask: (s) => ({ S: s.S }) })
 * console.log(view.policyView().length, JSON.stringify(view.policyView()[0].score))
 * // => 1 {"S":2}
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let makeView = (store, domain = {}) => {
    let isAnchor = domain.isAnchor || (() => false)
    let aliasOf = (nodes) => aliasMapOf(nodes, { fingerprint: domain.fingerprint, isAnchor })
    //全樹視圖(別名以全樹判定, 即使只取 ids 子集)
    let policyView = (ids = null) => {
        let full = store.loadNodes()
        let alias = aliasOf(full)
        return full.filter((n) => !ids || ids.has(n.id)).map((n) => policyViewOfNode(n, alias.get(n.id) || null, domain))
    }
    return { policyView, policyViewOfNode: (n, a) => policyViewOfNode(n, a, domain), aliasOf }
}

export default { policyViewOfNode, omitMask, checkPolicySource, makeView }
