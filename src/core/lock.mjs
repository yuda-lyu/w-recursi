import fs from 'fs'
import path from 'path'
import { pidAlive, readOwner, newToken, ownerLine, ownedBy, waitNote } from './proc.mjs'


//跨程序寫入鎖(mkdir 原子性;同機多 session / 多程序皆可用)
//  - 逾時 timeoutMs 內拿不到鎖即拋錯(不靜默略過)
//  - 死鎖回收(2026-09-26 修訂):持有者已死 ⇒ 立即回收;持有逾 staleMs(持有者存活亦然 —— 本鎖只包短臨界區, 久持即異常或 pid 被重用)⇒ 回收;
//    owner 不可讀(剛建 / 損壞)⇒ 以鎖目錄 mtime 逾 staleMs 回收
//  - **釋放只刪自己的鎖**(owner token 相符;2026-09-26):原本 finally 無條件刪鎖 ⇒ 鎖被回收並由他方取得後, 原持有者會刪掉新持有者之鎖
//  - 等待逾 waitLogMs 起, 每 waitLogMs 以 stderr 同步寫一行(持有者 pid / 已等秒數), 免「沉默等於卡住」
//  - 同步阻塞(Atomics.wait), 只包「讀 → 改 → 整檔重寫」這類短臨界區
/**
 * 同步睡眠(Atomics.wait;會阻塞事件迴圈,僅用於短暫之鎖與槽輪詢)
 *
 * @param {Number} ms 輸入毫秒
 * @returns {String} 回傳 Atomics.wait 之結果("ok"、"timed-out")
 * @example
 * let t0 = Date.now()
 * sleepMs(30)
 * console.log(Date.now() - t0 >= 25)
 * // => true
 */
export let sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

let rmDir = (fd) => {
    for (let k = 0; k < 5; k++) {
        try { fs.rmSync(fd, { recursive: true, force: true }); return true }
        catch (e) { sleepMs(10) }
    }
    return false
}
let isStaleLock = (fd, staleMs) => {
    let o = readOwner(fd)
    if (o) { return !pidAlive(o.pid) || Date.now() - Date.parse(o.at) > staleMs }
    try { return Date.now() - fs.statSync(fd).mtimeMs > staleMs } catch (e) { return false }
}

/**
 * 跨程序寫入鎖(mkdir 原子;同機多 session 與多程序皆可用):逾時拋錯、持有者已死或久持即回收、釋放只刪自己之鎖;同步阻塞,只包「讀 → 改 → 整檔重寫」之短臨界區
 *
 * @param {Function} fn 輸入臨界區函數(同步)
 * @param {Object} opt 輸入選項 { dir:String(鎖夾,必填), name:String(預設 tree), timeoutMs:Number(預設 120000), staleMs:Number(預設 300000), waitLogMs:Number(預設 10000) }
 * @returns {*} 回傳 fn 之回傳值
 * @throws {Error} 缺 dir、逾時取不到鎖時拋出
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let r = withLock(() => 42, { dir })
 * console.log(r, fs.existsSync(path.join(dir, '.lock_tree')))
 * // => 42 false
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let withLock = (fn, { dir, name = 'tree', timeoutMs = 120000, staleMs = 300000, waitLogMs = 10000 } = {}) => {
    if (!dir) { throw new Error('withLock: 缺 dir') }
    fs.mkdirSync(dir, { recursive: true })
    let fd = path.join(dir, `.lock_${name}`)
    let token = newToken()
    let t0 = Date.now(), lastNote = t0
    for (;;) {
        try { fs.mkdirSync(fd, { recursive: false }); fs.writeFileSync(path.join(fd, 'owner'), ownerLine(token)); break }
        catch (e) {
            if (e.code !== 'EEXIST') { throw e }
            if (isStaleLock(fd, staleMs)) { rmDir(fd); continue }
            let now = Date.now()
            if (now - t0 > timeoutMs) { let o = readOwner(fd); throw new Error(`寫入鎖 ${name} 逾時 ${timeoutMs} ms(另一程序持鎖:${fd}${o ? `;持有者 pid ${o.pid}${pidAlive(o.pid) ? ' 存活' : ' 已死'}` : ''})`) }
            if (now - lastNote >= waitLogMs) { lastNote = now; let o = readOwner(fd); waitNote(`等待寫入鎖 ${name} 已 ${Math.round((now - t0) / 1000)} 秒(持有者 ${o ? `pid ${o.pid}` : '未知'})`) }
            sleepMs(15 + Math.floor(Math.random() * 60))
        }
    }
    try { return fn() }
    finally {
        let o = readOwner(fd)
        if (!o || ownedBy(o, token)) { rmDir(fd) }
        else { waitNote(`寫入鎖 ${name} 已被他方回收(現持有者 pid ${o.pid}), 不刪其鎖`) }
    }
}

export default withLock
