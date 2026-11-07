import fs from 'fs'
import path from 'path'


//行程存活與持有者檔(owner)之共用小工具(2026-09-26;core/lock 與 core/slots 共用, 免兩處各寫一份)
//  owner 檔格式:`pid ISO時間 [token]`;第 3 欄 token 自 2026-09-26 起寫入(釋放時核對, 免誤刪他方之鎖 / 槽);舊碼只讀前兩欄 ⇒ 向下相容
/**
 * 行程是否存活(EPERM = 存在但無權限,視為存活)
 *
 * @param {Number} pid 輸入行程識別碼
 * @returns {Boolean} 回傳是否存活
 * @example
 * console.log(pidAlive(process.pid), pidAlive(0))
 * // => true false
 */
export let pidAlive = (pid) => {
    if (!pid) { return false }
    try { process.kill(pid, 0); return true }
    catch (e) { return e.code === 'EPERM' } //EPERM = 存在但無權限(Windows 系統程序)
}

//時間須為寫入端之完整 ISO(toISOString);空檔 / 寫到一半(他程序 mkdir 後、writeFileSync 建檔尚未寫入之瞬間)⇒ null(視同尚未寫 owner)
//  不可只用 Date.parse:截斷之「2026」「2026-09-2」可解析為較早日期 ⇒ 被判逾時而誤回收(2026-09-25 槽位雙持有之成因)
const RE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/**
 * 讀持有者檔 <fd>/owner(格式 `pid ISO時間 [token]`);空檔、半寫、時間非完整 ISO ⇒ null(視同尚未寫)
 *
 * @param {String} fd 輸入鎖或槽之夾路徑
 * @returns {Object|null} 回傳 { pid, at, token } 或 null
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * fs.writeFileSync(path.join(dir, 'owner'), ownerLine('tok1'))
 * let o = readOwner(dir)
 * console.log(o.pid === process.pid, o.token)
 * // => true tok1
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let readOwner = (fd) => {
    try {
        let [pid, at, token] = fs.readFileSync(path.join(fd, 'owner'), 'utf8').trim().split(' ')
        let p = Number(pid)
        return Number.isInteger(p) && p > 0 && RE_ISO.test(at || '') ? { pid: p, at, token: token || null } : null
    }
    catch (e) { return null }
}
/**
 * 產生持有者 token(`pid.時戳.亂碼`;釋放時核對,免誤刪他方之鎖或槽)
 *
 * @returns {String} 回傳 token
 * @example
 * console.log(newToken().startsWith(process.pid + "."))
 * // => true
 */
export let newToken = () => `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`
/**
 * 持有者檔之內容列:`pid ISO時間 token`
 *
 * @param {String} token 輸入持有者 token
 * @returns {String} 回傳內容列
 * @example
 * let line = ownerLine('t1')
 * console.log(line.split(' ').length, line.endsWith(' t1'))
 * // => 3 true
 */
export let ownerLine = (token) => `${process.pid} ${new Date().toISOString()} ${token}`
//是否為呼叫端自己持有:有 token 則比 token;舊格式(無 token)則比 pid
/**
 * 持有者是否為呼叫端自己:有 token 則比 token;舊格式(無 token)則比 pid
 *
 * @param {Object|null} o 輸入 readOwner 之回傳
 * @param {String} token 輸入自己的 token
 * @returns {Boolean} 回傳是否自己持有
 * @example
 * console.log(ownedBy({ pid: 1, token: 'a' }, 'a'), ownedBy({ pid: 1, token: 'a' }, 'b'), ownedBy(null, 'a'))
 * // => true false false
 */
export let ownedBy = (o, token) => !!o && (o.token ? o.token === token : o.pid === process.pid)
//等待訊息(stderr 同步寫 ⇒ 事件迴圈被 Atomics.wait 凍結時仍即時可見)
/**
 * 等待訊息(stderr 同步寫一行;事件迴圈被 Atomics.wait 凍結時仍即時可見;寫入失敗不拋)
 *
 * @param {String} s 輸入訊息
 * @returns {undefined} 無回傳
 * @example
 * waitNote('等待寫入鎖 tree 已 12 秒')
 */
export let waitNote = (s) => { try { fs.writeSync(2, `[w-recursi ${new Date().toISOString().slice(11, 19)}] ${s}\n`) } catch (e) {} }

export default { pidAlive, readOwner, newToken, ownerLine, ownedBy, waitNote }
