import get from 'lodash-es/get.js'
import isFunction from 'lodash-es/isFunction.js'
import omit from 'lodash-es/omit.js'
import { specHash } from '../core/canonical.mjs'
import { nowIso } from '../core/canonical.mjs'


//節點之組裝:由評估結果(raw)組 executed 節點;分數由領域之 score(raw, node) 判讀(可重算, 不重跑評估)
/**
 * 節點之組裝:由評估結果(raw)組 executed 節點;分數由領域之 score(raw, node) 判讀(可重算,不重跑評估)
 *
 * @param {Object} o 輸入 { id, spec, parent, round, origin, raw, envHash, status, evidence, notes, children, createdAt }
 * @param {Object} domain 輸入領域物件 { score, evaluatorVersion }
 * @returns {Object} 回傳節點 { id, parent, round, status, spec, origin, specHash, regen, raw, cost, evidence, notes, children, claim, createdAt, score }
 * @example
 * let domain = { score: (raw) => ({ S: raw.v * 2, ladder: 1 }) }
 * let n = makeNode({ id: 'n1', spec: { a: 1 }, raw: { v: 3 } }, domain)
 * console.log(n.status, n.parent, n.score.S, n.regen.specHash === n.specHash)
 * // => executed root 6 true
 */
export let makeNode = ({ id, spec, parent = 'root', round = 0, origin = {}, raw = null, envHash = '', status = 'executed', evidence = null, notes = null, children = [], createdAt = null }, domain) => {
    let node = {
        id, parent, round, status, spec, origin, specHash: specHash(spec),
        regen: { specHash: specHash(spec), envHash, evaluator: get(domain, 'evaluatorVersion', null), extraHash: get(raw, 'extraHash', '') },
        raw: raw ? omit(raw, ['extraHash', 'specHash']) : null,
        cost: raw ? (raw.cost || null) : null,
        evidence, notes, children: children || [], claim: null, createdAt: createdAt || nowIso(),
    }
    node.score = raw && isFunction(domain.score) ? domain.score(node.raw, node) : null
    return node
}

//重算分數(評估器判讀層改版時用;不重跑評估)
/**
 * 重算分數(評估器判讀層改版時用;不重跑評估);無 raw 或領域無 score 時節點不變
 *
 * @param {Object} node 輸入節點
 * @param {Object} domain 輸入領域物件 { score }
 * @returns {Object} 回傳同一節點(就地更新 score)
 * @example
 * let domain = { score: (raw) => ({ S: raw.v * 2 }) }
 * let n = makeNode({ id: 'n1', spec: { a: 1 }, raw: { v: 3 } }, domain)
 * n.raw.v = 5
 * console.log(rescore(n, domain).score.S)
 * // => 10
 */
export let rescore = (node, domain) => { if (node.raw && isFunction(domain.score)) { node.score = domain.score(node.raw, node) } return node }

export default { makeNode, rescore }
