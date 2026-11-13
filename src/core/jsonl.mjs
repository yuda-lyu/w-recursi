import fs from 'fs'
import path from 'path'
import getTrace from 'wsemi/src/getTrace.mjs'
import { assertWriteRoot } from './writeRoot.mjs'


//原子寫檔(2026-09-24;某次實測重現之競態:整檔覆寫 = 先截斷再寫, 鎖外之讀者可讀到截斷 / 空檔而 JSON.parse 拋錯或靜默少列)
//  先寫同目錄暫存檔(`.{檔名}.{pid}.{時戳}.{亂碼}.tmp`, 字尾 .tmp ⇒ 不被 *.jsonl / *.json.gz 之列舉誤取)再 rename 覆蓋 ⇒ 讀者只見舊檔或新檔之完整內容
//  Windows:目標檔正被他程序開啟(讀者持有 handle)時 rename 回 EPERM / EACCES / EBUSY ⇒ 以短而帶亂數之間隔重試(有界:opt.retryMs, 預設 RETRY_MS)
//    **不退回直接覆寫**(2026-11-14;第 429 項):原於重試約 2 秒用盡後退回 writeFileSync(目標) = 截斷再寫, 高負載下鎖外讀者因此讀到截斷檔(列數不足);
//    用盡 ⇒ 刪暫存檔並拋錯(code ERSI_ATOMIC_RENAME), 目標檔維持原內容 —— 交呼叫端處置(多在鎖內:鎖隨例外釋放)
//  觀察回調 opt.onTrace(wsemi getTrace;計時器相關函數之制式):retry / renamed / giveUp 三種事件, 測試以事件同步(不以延時)
//  寫域守門(2026-10-09;core/writeRoot.mjs):環境變數 RSI_WRITE_ROOT 有值 ⇒ 目標須在其根之下, 否則拋錯(先判再寫 ⇒ 不留暫存檔);未設 ⇒ 逐位不變
//    writeJson / writeJsonl 經本函式;appendJsonl 同守
/**
 * 原子寫檔之累計(本程序):writes(次數)、retries(Windows EPERM / EACCES / EBUSY 之重試)、giveUps(重試用盡而拋錯;不退回非原子之直寫)
 *
 * @type {Object}
 */
export let atomicStats = { writes: 0, retries: 0, giveUps: 0 }
let RETRY_CODES = ['EPERM', 'EACCES', 'EBUSY']
//改名重試之總時限預設(毫秒):讀者之 handle 每次只持有一次讀檔之久, 有界重試足以等到空檔;逾此仍被占用(如長期開啟之外部程式)⇒ 拋錯
const RETRY_MS = 15000
let sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch (e) {} }
//第 i 次重試前之等待:1 ~ 50 毫秒漸增, 乘 0.5 ~ 1.5 之亂數(錯開讀者之週期, 增加命中空檔之次數)
let waitOf = (i) => Math.max(1, Math.round(Math.min(50, 1 + i * 2) * (0.5 + Math.random())))
/**
 * 原子寫檔:先寫同目錄暫存檔再 rename 覆蓋,鎖外之讀者只見舊檔或新檔之完整內容;Windows 目標檔被占用(EPERM / EACCES / EBUSY)時以有界重試等候(時限以單調時鐘計,於每次失敗後判定;等待不越過時限),用盡即拋錯(目標檔維持原內容,不退回非原子之直接覆寫);拋錯前盡力刪除暫存檔,刪不掉者錯誤之 tmpLeft 列其路徑;受寫域守門(RSI_WRITE_ROOT)約束。
 * 觀察回調 opt.onTrace 之事件:retry({ attempt, code, waitMs }:第 attempt 次改名失敗,將等 waitMs 毫秒再試)、renamed({ attempts }:改名成功)、giveUp({ attempts, code, elapsedMs }:重試用盡,隨即拋錯)
 *
 * @param {String} fp 輸入目標檔
 * @param {String|Buffer} data 輸入內容
 * @param {Object} [opt={}] 輸入選項 { retryMs:Number(改名重試之總時限毫秒,非負數;預設 15000,非預期之值改用預設;於每次改名失敗後判定,未到即等待〔不越過時限〕並必再試一次 ⇒ 總耗時可略超過時限:一次等待、一次改名與回調之時間), onTrace:Function(觀察回調,同步呼叫、拋錯忽略) }
 * @returns {undefined} 無回傳
 * @throws {Error} 目標不在允許之寫入根下(code ERSI_WRITE_ROOT)、改名重試用盡(code ERSI_ATOMIC_RENAME;目標檔不變)、寫暫存檔失敗或非暫時性之 rename 失敗(原錯)時拋出;暫存檔刪不掉時錯誤另帶 tmpLeft
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
export let writeFileAtomic = (fp, data, opt = {}) => {
    assertWriteRoot(fp, { what: 'writeFileAtomic' })
    let trace = getTrace(opt)
    let rm = opt && opt.retryMs
    let retryMs = typeof rm === 'number' && Number.isFinite(rm) && rm >= 0 ? rm : RETRY_MS
    let tmp = path.join(path.dirname(fp), `.${path.basename(fp)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
    //拋錯前之暫存檔清理(盡力:有界重試;仍刪不掉 ⇒ 錯誤之 tmpLeft 列其路徑, 不靜默)
    let fail = (e) => { if (!rmTmp(tmp)) { e.tmpLeft = tmp } return e }
    //寫暫存檔失敗(如磁碟滿)⇒ 刪半寫之暫存檔再拋原錯(目標檔未動)
    try { fs.writeFileSync(tmp, data) }
    catch (e) { throw fail(e) }
    atomicStats.writes++
    //時限以單調時鐘計(不受系統時鐘調整影響);每次改名失敗後判定:未到時限 ⇒ 等待(不越過時限)後必再試一次(retry 事件即此承諾), 已到 ⇒ 拋錯
    let t0 = performance.now()
    let elapsed = () => Math.round(performance.now() - t0)
    for (let i = 0; ; i++) {
        let e = null
        try {
            fs.renameSync(tmp, fp)
            if (trace) { trace('renamed', { attempts: i + 1 }) }
            return
        }
        catch (err) { e = err }
        let retryable = RETRY_CODES.includes(e.code)
        if (!retryable) { throw fail(e) }
        let remain = retryMs - elapsed()
        if (remain > 0) {
            atomicStats.retries++
            let waitMs = Math.min(waitOf(i), Math.max(1, Math.ceil(remain)))
            if (trace) { trace('retry', { attempt: i + 1, code: e.code, waitMs }) }
            sleepSync(waitMs)
            continue
        }
        atomicStats.giveUps++
        let elapsedMs = elapsed()
        if (trace) { trace('giveUp', { attempts: i + 1, code: e.code, elapsedMs }) }
        throw fail(Object.assign(new Error(`writeFileAtomic: 改名覆蓋失敗(${e.code}), 嘗試 ${i + 1} 次、${elapsedMs} ms 目標仍被占用;目標檔維持原內容(不退回非原子之直接覆寫):${fp}`), { code: 'ERSI_ATOMIC_RENAME', cause: e }))
    }
}
//刪暫存檔(有界重試;Windows 上暫存檔被他程序短暫開啟時刪除可能失敗)⇒ 回是否已不存在
let rmTmp = (tmp) => {
    for (let k = 0; k < 5; k++) {
        try { fs.rmSync(tmp, { force: true }); if (!fs.existsSync(tmp)) { return true } }
        catch (e) {}
        sleepSync(10 + k * 10)
    }
    return !fs.existsSync(tmp)
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
