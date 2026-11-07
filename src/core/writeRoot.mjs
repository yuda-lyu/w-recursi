import fs from 'fs'
import path from 'path'


//寫域守門(2026-10-09;預寫沙箱之防誤寫 —— 某次事故:沙箱之 CLI 經墊片指向真模組, 漏打 --dry 即以未審之碼寫生產之輪夾 / 清單)
//  環境變數 RSI_WRITE_ROOT 有值 ⇒ 本套件之寫入之目標須在所列之根之下, 否則拋錯(訊息含目標與根;e.code = 'ERSI_WRITE_ROOT', e.target, e.roots)
//    受守者:jsonl 原語 writeFileAtomic / appendJsonl(writeJson / writeJsonl 經前者;樹之節點 / index / 前緣 / lore、輪夾之 plan / summary、策略夾之標記 / 分數)、
//            explore 之取輪號(建輪夾)與 report.md、auto 之 report.md、生成 / 策略開發請求之文字與標記之清除、dream --accept 之升版寫檔、init 之策略檔
//    不守(刻意):槽位 / 鎖之 owner 與 .max(跨 session 之協調狀態 —— 沙箱須與生產共用全域槽位, 否則 worker 上限失守)、runner / worker 之 job 暫存(paths.tmp)、刪除他人之鎖 / 槽
//  值 = 一或多個根(以 path.delimiter 分隔:Windows「;」、POSIX「:」);相對路徑依 cwd 解析;空字串 / 只有空白 = 未設
//  判定:目標之絕對路徑(path.resolve)在某根之下(根 + 尾端 path.sep 之 startsWith;Windows 不分大小寫)**且**其實際路徑(最近之既存上層夾經 realpath 再接回其餘段)亦在某根之實際路徑之下
//    ⇒ `..` 穿越、同前綴之兄弟夾(<根>x)、經 junction / 符號連結指出根外者皆擋;根本身不作為寫入之目標
//  未設 ⇒ 不做任何檢查(行為逐位不變)
//  沙箱之用法:RSI_WRITE_ROOT=<沙箱夾>;研究須寫共用快取 / job 暫存者另列其根(如 <沙箱夾>;<共用快取夾>;<job 暫存夾>), 或以領域自訂之環境變數(如快取夾位置)指入沙箱
//  領域端直呼 fs 之寫者不經本守門;新寫者宜經 jsonl 原語或先呼叫 assertWriteRoot
/**
 * 寫域守門之環境變數名:有值(一或多個根,以 path.delimiter 分隔)⇒ 本套件之寫入須在所列之根之下;未設 ⇒ 不檢
 *
 * @type {String}
 */
export const WRITE_ROOT_ENV = 'RSI_WRITE_ROOT'
const IS_WIN = process.platform === 'win32'
let normOf = (p) => (IS_WIN ? p.toLowerCase() : p)
let withSep = (p) => (p.endsWith(path.sep) ? p : p + path.sep)
let under = (p, root) => normOf(p).startsWith(normOf(withSep(root)))
//實際路徑:最近之既存上層夾之 realpath + 其餘段(目標多為尚不存在之新檔)
let realOf = (abs) => {
    let cur = abs, rest = []
    for (;;) {
        try { let r = fs.realpathSync.native(cur); return rest.length ? path.join(r, ...rest.slice().reverse()) : r }
        catch (e) {
            let up = path.dirname(cur)
            if (up === cur) { return abs }
            rest.push(path.basename(cur))
            cur = up
        }
    }
}
//所列之根(絕對路徑;未設 ⇒ null)
/**
 * 取允許之寫入根(絕對路徑);未設或只有空白 ⇒ null
 *
 * @param {Object} [env=process.env] 輸入環境變數物件
 * @returns {Array|null} 回傳根陣列或 null
 * @example
 * let sep = path.delimiter
 * console.log(writeRootsOf({}), writeRootsOf({ RSI_WRITE_ROOT: '  ' }), writeRootsOf({ RSI_WRITE_ROOT: 'a' + sep + 'b' }).length)
 * // => null null 2
 */
export let writeRootsOf = (env = process.env) => {
    let v = env ? env[WRITE_ROOT_ENV] : undefined
    if (typeof v !== 'string' || !v.trim()) { return null }
    let roots = v.split(path.delimiter).map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(s))
    return roots.length ? roots : null
}
//目標是否可寫(純判定;未設 ⇒ true)
/**
 * 目標是否可寫(純判定):未設根 ⇒ true;否則目標之絕對路徑與其實際路徑(經 realpath,擋 junction 與符號連結)皆須在某根之下;根本身不可作為寫入目標
 *
 * @param {String} fp 輸入目標路徑
 * @param {Object} [opt={}] 輸入選項 { env:Object(預設 process.env) }
 * @returns {Boolean} 回傳是否可寫
 * @example
 * let root = path.resolve('demo-root')
 * let env = { RSI_WRITE_ROOT: root }
 * console.log(writeAllowed(path.join(root, 'a.json'), { env }), writeAllowed(path.resolve('other', 'a.json'), { env }), writeAllowed('any', { env: {} }))
 * // => true false true
 */
export let writeAllowed = (fp, { env = process.env } = {}) => {
    let roots = writeRootsOf(env)
    if (!roots) { return true }
    let abs = path.resolve(String(fp))
    if (!roots.some((r) => under(abs, r))) { return false }
    let real = realOf(abs)
    return roots.some((r) => under(real, realOf(r)))
}
//守門:不可寫 ⇒ 拋錯(寫入之前呼叫;不建檔、不留暫存)
/**
 * 寫域守門:不可寫 ⇒ 拋錯(須在寫入之前呼叫;不建檔、不留暫存);錯誤帶 code ERSI_WRITE_ROOT、target、roots
 *
 * @param {String} fp 輸入目標路徑
 * @param {Object} [opt={}] 輸入選項 { env:Object, what:String(訊息用之動作名) }
 * @returns {undefined} 可寫時無回傳
 * @throws {Error} 目標不在允許之寫入根下時拋出(code ERSI_WRITE_ROOT)
 * @example
 * let root = path.resolve('demo-root')
 * let env = { RSI_WRITE_ROOT: root }
 * assertWriteRoot(path.join(root, 'ok.json'), { env })
 * try { assertWriteRoot(path.resolve('other', 'x.json'), { env, what: 'demo' }) }
 * catch (e) { console.log(e.code) }
 * // => ERSI_WRITE_ROOT
 */
export let assertWriteRoot = (fp, { env = process.env, what = null } = {}) => {
    if (writeAllowed(fp, { env })) { return }
    let roots = writeRootsOf(env)
    let abs = path.resolve(String(fp))
    let e = new Error(`寫域守門(${WRITE_ROOT_ENV}):${what ? `${what} 之` : ''}目標 ${abs} 不在允許之寫入根之下(根:${roots.join(' | ')})—— 預寫沙箱之防誤寫, 拒寫(未寫入任何檔)`)
    e.code = 'ERSI_WRITE_ROOT'
    e.target = abs
    e.roots = roots
    throw e
}

export default { WRITE_ROOT_ENV, writeRootsOf, writeAllowed, assertWriteRoot }
