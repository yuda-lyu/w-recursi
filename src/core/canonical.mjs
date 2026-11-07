import crypto from 'crypto'
import fromPairs from 'lodash-es/fromPairs.js'
import isArray from 'lodash-es/isArray.js'
import isPlainObject from 'lodash-es/isPlainObject.js'
import sortBy from 'lodash-es/sortBy.js'
import toPairs from 'lodash-es/toPairs.js'


//規格之正規化與雜湊(凍結契約:正規化與節點 id 公式不得改動, 使既有節點 id 可沿用)
let canon = (v) => {
    if (isArray(v)) { return v.map(canon) }
    if (isPlainObject(v)) { return fromPairs(sortBy(toPairs(v), (p) => p[0]).map(([k, x]) => [k, canon(x)])) }
    return v
}
/**
 * 規格正規化後之 JSON 字串:物件鍵遞迴排序、陣列保序;同一規格不論鍵序皆得同一字串(specHash 與節點 id 之凍結契約)
 *
 * @param {*} spec 輸入規格(JSON 可序列化之值)
 * @returns {String} 回傳正規化後之 JSON 字串
 * @example
 * console.log(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }))
 * // => {"a":[2,{"c":3,"d":4}],"b":1}
 */
export let canonicalJson = (spec) => JSON.stringify(canon(spec))
/**
 * 字串之 sha1 十六進位摘要(取前 n 碼)
 *
 * @param {*} s 輸入內容(非字串以 String 轉)
 * @param {Number} [n=16] 輸入取前幾碼
 * @returns {String} 回傳十六進位摘要
 * @example
 * console.log(sha('abc'))
 * // => a9993e364706816a
 *
 * console.log(sha('abc', 8))
 * // => a9993e36
 */
export let sha = (s, n = 16) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n)
/**
 * 規格雜湊:sha(canonicalJson(spec));同規格(不論鍵序)得同一雜湊,為樹中去重之依據
 *
 * @param {*} spec 輸入規格
 * @returns {String} 回傳 16 碼雜湊
 * @example
 * console.log(specHash({ a: 1, b: 2 }) === specHash({ b: 2, a: 1 }))
 * // => true
 *
 * console.log(specHash({ a: 1 }) === specHash({ a: 2 }))
 * // => false
 */
export let specHash = (spec) => sha(canonicalJson(spec))

//節點 id:規格 + 環境雜湊(領域決定:如引擎碼雜湊 / 資料版本 / 環境指紋…;同規格不同環境 ⇒ 不同節點)
/**
 * 節點 id:規格 + 環境雜湊(由領域決定,如引擎碼雜湊、資料版本);同規格同環境 ⇒ 同 id,同規格不同環境 ⇒ 不同節點
 *
 * @param {*} spec 輸入規格
 * @param {String} [envHash=''] 輸入環境雜湊
 * @returns {String} 回傳 16 碼節點 id
 * @example
 * console.log(nodeIdOf({ a: 1 }, 'e1') === nodeIdOf({ a: 1 }, 'e1'))
 * // => true
 *
 * console.log(nodeIdOf({ a: 1 }, 'e1') === nodeIdOf({ a: 1 }, 'e2'))
 * // => false
 */
export let nodeIdOf = (spec, envHash = '') => sha(`${canonicalJson(spec)}|${envHash}`, 16)

/**
 * 現在時刻之 ISO 字串(UTC,毫秒;持有者列與標記檔皆以此格式寫入)
 *
 * @returns {String} 回傳 ISO 時刻字串
 * @example
 * console.log(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(nowIso()))
 * // => true
 */
export let nowIso = () => new Date().toISOString()

export default { canonicalJson, sha, specHash, nodeIdOf, nowIso }
