import fs from 'fs'
import path from 'path'
import { assertWriteRoot } from './writeRoot.mjs'


//原子寫檔(2026-09-24;某次實測重現之競態:整檔覆寫 = 先截斷再寫, 鎖外之讀者可讀到截斷 / 空檔而 JSON.parse 拋錯或靜默少列)
//  先寫同目錄暫存檔(`.{檔名}.{pid}.{時戳}.{亂碼}.tmp`, 字尾 .tmp ⇒ 不被 *.jsonl / *.json.gz 之列舉誤取)再 rename 覆蓋 ⇒ 讀者只見舊檔或新檔之完整內容
//  Windows:目標檔正被他程序開啟時 rename 可能 EPERM / EACCES / EBUSY ⇒ 遞增等待重試(合計約 2 秒);仍失敗則退回直接覆寫(不比舊行為差)並刪暫存檔
//  寫域守門(2026-10-09;core/writeRoot.mjs):環境變數 RSI_WRITE_ROOT 有值 ⇒ 目標須在其根之下, 否則拋錯(先判再寫 ⇒ 不留暫存檔);未設 ⇒ 逐位不變
//    writeJson / writeJsonl 經本函式;appendJsonl 同守
/**
 * 原子寫檔之累計(本程序):writes(次數)、retries(Windows EPERM / EACCES / EBUSY 之重試)、fallbacks(重試用盡退回直寫)
 *
 * @type {Object}
 */
export let atomicStats = { writes: 0, retries: 0, fallbacks: 0 }
let RETRY_CODES = ['EPERM', 'EACCES', 'EBUSY']
let sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch (e) {} }
/**
 * 原子寫檔:先寫同目錄暫存檔再 rename 覆蓋,鎖外之讀者只見舊檔或新檔之完整內容;Windows 目標檔被占用時遞增等待重試,仍失敗退回直寫;受寫域守門(RSI_WRITE_ROOT)約束
 *
 * @param {String} fp 輸入目標檔
 * @param {String|Buffer} data 輸入內容
 * @returns {undefined} 無回傳
 * @throws {Error} 目標不在允許之寫入根下(code ERSI_WRITE_ROOT)、非暫時性之 rename 失敗時拋出
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let fp = path.join(dir, 'a.txt')
 * writeFileAtomic(fp, 'v1')
 * writeFileAtomic(fp, 'v2')
 * console.log(fs.readFileSync(fp, 'utf8'), fs.readdirSync(dir).join(','))
 * // => v2 a.txt
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let writeFileAtomic = (fp, data) => {
    assertWriteRoot(fp, { what: 'writeFileAtomic' })
    let tmp = path.join(path.dirname(fp), `.${path.basename(fp)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
    fs.writeFileSync(tmp, data)
    atomicStats.writes++
    for (let i = 0; i < 20; i++) {
        try { fs.renameSync(tmp, fp); return }
        catch (e) {
            if (!RETRY_CODES.includes(e.code)) { try { fs.rmSync(tmp, { force: true }) } catch (e2) {} throw e }
            atomicStats.retries++
            sleepSync(10 + i * 10)
        }
    }
    atomicStats.fallbacks++
    try { fs.writeFileSync(fp, data) }
    finally { try { fs.rmSync(tmp, { force: true }) } catch (e2) {} }
}

//stderr 同步寫一行(與 core/proc.mjs 之 waitNote 同格式;程序隨即結束時亦不遺失)
let warnLine = (s) => { try { fs.writeSync(2, `[w-recursi ${new Date().toISOString().slice(11, 19)}] ${s}\n`) } catch (e) {} }

//讀 jsonl(2026-09-26):最後一列解析失敗 ⇒ 視為他程序追加中之半列而略過(appendJsonl 於鎖內追加, 鎖外讀者可能恰讀到半列);中間列失敗 ⇒ 真損壞, 拋錯
//  opt.skipBad(2026-09-29;某紀錄檔一行截斷使全部評估失敗之單點故障;預設 false = 上述行為不變):
//    中間壞列亦略過, 並以 stderr 印一行警示(壞列數與前 5 個列號);opt.onBad(列號陣列)可另收(不影響警示)
//    —— 只給「唯讀之消費端」(只追加之紀錄檔之讀者, 如載體驗證紀錄、做夢分數);讀後會整檔重寫者(index / frontier / lore)勿用, 否則壞列於重寫時被丟棄
/**
 * 讀 jsonl:最後一列解析失敗 ⇒ 視為他程序追加中之半列而略過;中間列失敗 ⇒ 拋錯(skipBad 為真則略過並於 stderr 印一行警示;只給唯讀之消費端);檔不存在回 []
 *
 * @param {String} fp 輸入檔路徑
 * @param {Object} [opt={}] 輸入選項 { skipBad:Boolean(預設 false), onBad:Function(收壞列號陣列) }
 * @returns {Array} 回傳列物件陣列
 * @throws {Error} 中間列非 JSON 且未設 skipBad 時拋出
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let fp = path.join(dir, 'a.jsonl')
 * fs.writeFileSync(fp, '{"a":1}\n{"a":2}\n{"a"')
 * console.log(JSON.stringify(readJsonl(fp)))
 * // => [{"a":1},{"a":2}]
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let readJsonl = (fp, opt = {}) => {
    let skipBad = !!(opt && opt.skipBad)
    if (!fs.existsSync(fp)) { return [] }
    let ls = fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter(Boolean)
    let out = [], bad = []
    for (let i = 0; i < ls.length; i++) {
        try { out.push(JSON.parse(ls[i])) }
        catch (e) {
            if (i === ls.length - 1) { break }
            if (!skipBad) { throw new Error(`${fp} 第 ${i + 1} 列非 JSON(${e.message})`) }
            bad.push(i + 1)
        }
    }
    if (bad.length) {
        warnLine(`${fp}:略過非 JSON 之中間列 ${bad.length} 列(第 ${bad.slice(0, 5).join('、')}${bad.length > 5 ? ' …' : ''} 列;readJsonl skipBad)`)
        if (opt && typeof opt.onBad === 'function') { try { opt.onBad(bad) } catch (e) {} }
    }
    return out
}
/**
 * 整檔寫 jsonl(經 writeFileAtomic;rows 為空 ⇒ 空檔)
 *
 * @param {String} fp 輸入檔路徑
 * @param {Array} rows 輸入列物件陣列
 * @returns {undefined} 無回傳
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let fp = path.join(dir, 'a.jsonl')
 * writeJsonl(fp, [{ a: 1 }, { a: 2 }])
 * console.log(JSON.stringify(fs.readFileSync(fp, 'utf8')))
 * // => "{\"a\":1}\n{\"a\":2}\n"
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let writeJsonl = (fp, rows) => writeFileAtomic(fp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
/**
 * 追加一列到 jsonl(受寫域守門約束;追加為單次 appendFileSync,不經暫存檔)
 *
 * @param {String} fp 輸入檔路徑
 * @param {Object} row 輸入列物件
 * @returns {undefined} 無回傳
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let fp = path.join(dir, 'a.jsonl')
 * appendJsonl(fp, { a: 1 })
 * appendJsonl(fp, { a: 2 })
 * console.log(JSON.stringify(readJsonl(fp)))
 * // => [{"a":1},{"a":2}]
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let appendJsonl = (fp, row) => { assertWriteRoot(fp, { what: 'appendJsonl' }); fs.appendFileSync(fp, JSON.stringify(row) + '\n') }
/**
 * 讀 JSON 檔;檔不存在回預設值
 *
 * @param {String} fp 輸入檔路徑
 * @param {*} [d=null] 輸入檔不存在時之回傳值
 * @returns {*} 回傳解析後之值或預設值
 * @throws {Error} 檔存在但非 JSON 時拋出
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * console.log(readJson(path.join(dir, 'none.json'), 'dflt'))
 * // => dflt
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let readJson = (fp, d = null) => (fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : d)
/**
 * 原子寫 JSON 檔(縮排 1 空格;經 writeFileAtomic)
 *
 * @param {String} fp 輸入檔路徑
 * @param {*} obj 輸入 JSON 可序列化之值
 * @returns {undefined} 無回傳
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let fp = path.join(dir, 'a.json')
 * writeJson(fp, { a: [1, 2] })
 * console.log(JSON.stringify(readJson(fp)))
 * // => {"a":[1,2]}
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let writeJson = (fp, obj) => writeFileAtomic(fp, JSON.stringify(obj, null, 1))

export default { readJsonl, writeJsonl, appendJsonl, readJson, writeJson, writeFileAtomic, atomicStats }
