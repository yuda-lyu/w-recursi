import fs from 'fs'
import path from 'path'
import { pidAlive, ownerOfLine, readOwner, newToken, ownerLine, ownedBy, waitNote } from './proc.mjs'


//跨程序寫入鎖(mkdir 原子性;同機多 session / 多程序皆可用)
//  - 逾時 timeoutMs 內拿不到鎖即拋錯(不靜默略過)
//  - 死鎖回收(2026-09-26 修訂):持有者已死 ⇒ 立即回收;持有逾 staleMs(持有者存活亦然 —— 本鎖只包短臨界區, 久持即異常或 pid 被重用)⇒ 回收;
//    owner 不可讀(剛建 / 損壞)⇒ 以鎖目錄 mtime 逾 staleMs 回收
//  - **持有者檔 <鎖夾>/owner 為持有之憑證**(2026-11-14,第 456 項):
//    · 只以 wx(不存在才建)寫入;動用他方之持有者檔(回收、釋放)前, 先把它改名為本方唯一之名(owner.dead-<token> / owner.rel-<token>)而「取得」之 —— 同一檔只有一方取得得到
//    · 回收 = 取得已判死之持有者檔 → 核對其原文 = 判定時所讀(token 使每次取鎖之原文唯一)→ 於**同一鎖夾**以 wx 寫入本方之持有者檔而接手(不刪夾、不重建);
//      原文已變(判定後他方已回收並重取)⇒ 移回原處、不接手
//      原「判定 stale → 以路徑刪夾 → 重建」非原子:判定與刪除之間他方已回收並取得新鎖時, 新鎖被誤刪而兩臨界區重疊(持有者已死之鎖 + 兩個以上同時等候者;
//      外審以兩真程序 + 屏障實測)。改名期間鎖夾仍在(他方 mkdir 仍 EEXIST), 第三方無從於其間建夾取得(槽位之「移夾」法於移走期間有此窗)
//    · 無有效持有者檔之夾:他方之取得檔(owner.dead- / owner.rel-)尚在且其取得者存活、未逾 staleMs ⇒ 非死鎖(等其完成);取得檔之取得者皆已死 ⇒ 死鎖
//      (其內為存活持有者之列者移回原處, 不接手);皆無 ⇒ 以夾之 mtime 逾 staleMs 判(夾內之建檔 / 改名 / 刪檔皆更新夾之 mtime)
//    · 建夾後寫持有者檔遇 EEXIST(回收者於建夾與寫檔之間以 wx 占下此無主之夾)⇒ 本次不算取得而續等
//  - **釋放只刪自己的鎖**(owner token 相符;2026-09-26):先取得持有者檔再核對 token, 相符才刪夾;不符 ⇒ 移回、不刪
//    持有者檔不在(2026-11-14 檢討原「不可讀即刪」:可刪掉他方建夾後、寫持有者檔前之新鎖)⇒ 不刪;其取得檔內為本方之列(回收者核對中)⇒ 於 RELEASE_WAIT_MS 內等其移回再釋放
//  - 等待逾 waitLogMs 起, 每 waitLogMs 以 stderr 同步寫一行(持有者 pid / 已等秒數), 免「沉默等於卡住」
//  - 建鎖夾回 EPERM / EACCES / EBUSY(Windows:同名夾正被他程序刪除;2026-11-14)⇒ 視同被占用而等候, 逾 timeoutMs 拋錯並附錯誤碼(原即時拋出 ⇒ 高負載下併行之寫者偶發失敗)
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

//建鎖夾之暫時性失敗(Windows:同名夾刪除待決)⇒ 視同鎖被占用
let BUSY_CODES = ['EPERM', 'EACCES', 'EBUSY']
const FN_OWNER = 'owner'
//取得檔:owner.{dead|rel}-<token>(token = `pid.時戳(36 進位).亂碼`;名內 pid / 時戳 = 取得者 / 取得時刻)
const RE_TAKEN = /^owner\.(dead|rel)-(\d+)\.([0-9a-z]+)\./
//釋放時持有者檔被回收者暫時取得(核對中)之等候上限;逾之不刪(活性問題, 不致重疊)
const RELEASE_WAIT_MS = 2000
//空夾(無持有者檔、無取得檔)之寬限:逾之即可占下(見 judgeLock)
const OWNERLESS_GRACE_MS = 2000
let rmDir = (fd) => {
    for (let k = 0; k < 5; k++) {
        try { fs.rmSync(fd, { recursive: true, force: true }); return true }
        catch (e) { sleepMs(10) }
    }
    return false
}
//釋放時自規範路徑移除鎖夾:先整夾改名為 <鎖夾>.gone-<token>(原子;夾內之檔隨之離開規範路徑)再刪(2026-11-14 負載探測所見:遞迴刪除先刪夾內之檔、後刪夾,
//  其間他方以 wx 寫入之持有者檔會被當成唯一之檔而自認持有, 遞迴刪除重試時再刪掉它, 或刪不掉夾而留下無主之空夾);改名持續失敗(Windows 之占用)⇒ 退回遞迴刪除
let removeLockDir = (fd) => {
    let grave = `${fd}.gone-${newToken()}`
    let t0 = Date.now()
    for (;;) {
        try { fs.renameSync(fd, grave); break }
        catch (e) {
            if (e.code === 'ENOENT') { return true }
            if (Date.now() - t0 > RELEASE_WAIT_MS) { return rmDir(fd) }
            sleepMs(2 + Math.floor(Math.random() * 8))
        }
    }
    if (!rmDir(grave)) { waitNote(`寫入鎖:已釋放, 惟移出之夾刪不掉(${path.basename(grave)};不影響取鎖)`) }
    return true
}
let readRaw = (fp) => { try { return fs.readFileSync(fp, 'utf8') } catch (e) { return null } }
//剛取得之檔讀不到(Windows 之防毒 / 索引短暫開啟)⇒ 短重試
let readTaken = (fp) => {
    for (let k = 0; k < 5; k++) { let s = readRaw(fp); if (s !== null) { return s } sleepMs(5) }
    return null
}
let unlinkQuiet = (fp) => { try { fs.unlinkSync(fp) } catch (e) {} }
//以 wx 寫持有者檔(不存在才建)⇒ true | 錯誤碼
let writeOwnerOnce = (fd, line) => {
    try { fs.writeFileSync(path.join(fd, FN_OWNER), line, { flag: 'wx' }); return true }
    catch (e) { return e.code || 'ERR' }
}
//取得:把 from 改名為本方唯一之名 ⇒ { fp } | { code }(ENOENT = 已不在 / 已被他方取得)
let take = (fd, from, kind) => {
    let fp = path.join(fd, `${FN_OWNER}.${kind}-${newToken()}`)
    try { fs.renameSync(from, fp); return { fp } }
    catch (e) { return { code: e.code || 'ERR' } }
}
//移回:取得檔改回持有者檔(本方持有取得檔期間, 他方無從建持有者檔:建夾者須先 mkdir 成功、回收者須先取得持有者檔、無主之判定見取得檔即不成立);移不回 ⇒ 留著(取得者 = 本程序, 逾 staleMs 後依取得檔回收)
let putBack = (fd, fp) => {
    for (let k = 0; k < 5; k++) {
        try { fs.renameSync(fp, path.join(fd, FN_OWNER)); return true }
        catch (e) { if (e.code === 'ENOENT') { return false } sleepMs(5) }
    }
    return false
}
//夾內之取得檔:[{ fp, pid, at(ms), live }](live = 取得者存活且未逾 staleMs)
let takenOf = (fd, staleMs) => {
    let ents = []
    try { ents = fs.readdirSync(fd) } catch (e) { return [] }
    let out = []
    for (let f of ents) {
        let m = f.match(RE_TAKEN)
        if (!m) { continue }
        let pid = Number(m[2])
        let at = parseInt(m[3], 36)
        out.push({ fp: path.join(fd, f), pid, at, live: pidAlive(pid) && !(Date.now() - at > staleMs) })
    }
    return out
}
//判定:{ stale, raw, kind }(raw = 持有者檔之原文, 不存在 / 讀不到 ⇒ null;kind = owner | abandoned | ownerless)
let judgeLock = (fd, staleMs) => {
    let raw = readRaw(path.join(fd, FN_OWNER))
    let o = ownerOfLine(raw)
    if (o) { return { stale: !pidAlive(o.pid) || Date.now() - Date.parse(o.at) > staleMs, raw, kind: 'owner' } }
    let takers = takenOf(fd, staleMs)
    if (takers.some((x) => x.live)) { return { stale: false, raw, kind: 'busy' } }
    if (takers.length && raw === null) { return { stale: true, raw, kind: 'abandoned' } }
    //空夾(無持有者檔、無取得檔):持有者檔只以 wx 建立 ⇒ 建夾者於寬限後才 wx 亦只會 EEXIST 而退讓 ⇒ 逾 OWNERLESS_GRACE_MS 即可占下(2026-11-14 負載探測:原須等 staleMs,
    //  釋放 / 回收之交錯偶留空夾而停滯至 staleMs);持有者檔存在而不可解析(損壞)者仍依 staleMs
    let old = false
    try { old = Date.now() - fs.statSync(fd).mtimeMs > (raw === null ? Math.min(staleMs, OWNERLESS_GRACE_MS) : staleMs) } catch (e) {}
    return { stale: old, raw, kind: raw === null ? 'ownerless' : 'owner' }
}
//取得檔連同其內容:[{ fp, pid, at, live, raw, o }](o = 解析後之持有者列);列舉後已不在(他方移回 / 刪除;ENOENT)⇒ 略去;
//  暫時讀不到(EPERM / EBUSY 等)⇒ 短重試, 仍不成 ⇒ raw = null(2026-11-14:原把「已不在」當成讀不到 ⇒ 確認持有時誤判有他方而撤回, 留下無主之夾至 staleMs)
let takenWith = (fd, staleMs) => {
    let out = []
    for (let x of takenOf(fd, staleMs)) {
        let raw = null, gone = false
        for (let k = 0; k < 5; k++) {
            try { raw = fs.readFileSync(x.fp, 'utf8'); break }
            catch (e) { if (e.code === 'ENOENT') { gone = true; break } sleepMs(5) }
        }
        if (!gone) { out.push({ ...x, raw, o: ownerOfLine(raw) }) }
    }
    return out
}
//讀持有者檔:{ o, missing }(missing = 確實不在;暫時讀不到 ⇒ 短重試, 仍不成 ⇒ o null 且 missing false)
let ownerAt = (fd) => {
    for (let k = 0; k < 5; k++) {
        try { return { o: ownerOfLine(fs.readFileSync(path.join(fd, FN_OWNER), 'utf8')), missing: false } }
        catch (e) { if (e.code === 'ENOENT') { return { o: null, missing: true } } sleepMs(5) }
    }
    return { o: null, missing: false }
}
//存活之持有者列:pid 存活且未逾 staleMs
let liveLine = (o, staleMs) => !!o && pidAlive(o.pid) && !(Date.now() - Date.parse(o.at) > staleMs)
let pause = () => sleepMs(2 + Math.floor(Math.random() * 8))
let olderThan = (fp, ms) => { try { return Date.now() - fs.statSync(fp).mtimeMs > ms } catch (e) { return false } }
//撤回本方剛以 wx 寫入之持有者檔:取得之、為本方之列才刪(他方移回者不動);本方之列被他方暫時取得 ⇒ 等其移回(上限 RELEASE_WAIT_MS)
let retreat = (fd, token, staleMs) => {
    let fo = path.join(fd, FN_OWNER)
    let t0 = Date.now()
    let ours = (x) => ownedBy(x.o, token)
    while (Date.now() - t0 <= RELEASE_WAIT_MS) {
        let t = take(fd, fo, 'dead')
        if (t.fp) {
            let raw = readTaken(t.fp)
            if (ownedBy(ownerOfLine(raw), token)) { unlinkQuiet(t.fp) }
            else { putBack(fd, t.fp) }
        }
        else if (t.code !== 'ENOENT') { pause(); continue }
        //本方之列是否仍在某處(他方之取得檔內 / 剛被移回持有者檔):皆無(再列舉、再讀確認)⇒ 完成;取得者已死者由本方取回後刪;否則等候(外審 hydrogen 第二輪 #2:原處理完持有者檔即返回)
        let takers = takenWith(fd, staleMs)
        let cur = ownerAt(fd)
        if (!takers.some(ours) && !ownedBy(cur.o, token) && (cur.o || cur.missing)) { return }
        for (let x of takers.filter((y) => ours(y) && !pidAlive(y.pid))) {
            let t2 = take(fd, x.fp, 'dead')
            if (!t2.fp) { continue }
            if (ownedBy(ownerOfLine(readTaken(t2.fp)), token)) { unlinkQuiet(t2.fp) }
            else { try { fs.renameSync(t2.fp, x.fp) } catch (e) {} }
        }
        pause()
    }
}
//確認持有(回收途徑以 wx 寫入本方持有者檔之後;2026-11-14 外審 Argon #1):持有者檔之名於他方動作之窗內會暫時空出 ——
//  回收者核對中(取得了存活持有者之檔、即將移回)、釋放者即將刪夾(已取得其持有者檔)—— 本方之 wx 若落在此窗內即與他方重疊
//  ⇒ 寫入後列舉夾內之取得檔:有他方之存活取得者(其內非本方之列)、讀不到之取得檔、或任一取得檔內為他方之存活持有者列 ⇒ 撤回、不進臨界區
//  持有者檔為他方之列(他方移回時覆蓋本方)⇒ 未持有;本方之列在他方之取得檔內(他方核對中)⇒ 等其移回(取得者已死 ⇒ 本方取回;上限 RELEASE_WAIT_MS)
let confirmHeld = (fd, token, staleMs) => {
    let t0 = Date.now()
    let ours = (x) => ownedBy(x.o, token)
    for (;;) {
        //先列舉、後讀持有者檔(決定性之讀取須在列舉之後;外審 hydrogen 第二輪 #1:先讀後列舉 ⇒ 兩者之間釋放者刪夾或核對者移回而本方之列已不在, 仍憑先前之讀取進臨界區)
        //  列舉時無他方進行中之取得、其後之持有者檔仍為本方之列 ⇒ 持有(列舉時之釋放者 / 核對者必已現於列舉, 或其動作已使本方之列不在原處)
        let takers = takenWith(fd, staleMs)
        if (takers.some((x) => !ours(x) && (pidAlive(x.pid) || x.raw === null || liveLine(x.o, staleMs)))) { retreat(fd, token, staleMs); return false }
        let cur = ownerAt(fd)
        if (ownedBy(cur.o, token)) { return true }
        //本方之列不在原處:在他方之取得檔內(核對中)⇒ 等其移回;不在任何取得檔內 ⇒ 再列舉與再讀確認確實不在才判未持有(其間被取走或移回者不誤判)
        if (!takers.some(ours) && (cur.o || cur.missing)) {
            let again = takenWith(fd, staleMs)
            let cur2 = ownerAt(fd)
            if (!again.some(ours) && !ownedBy(cur2.o, token) && (cur2.o || cur2.missing)) { return false }
            continue
        }
        //逾時 ⇒ 撤回本方之列(免其後移回而成為以本方 pid 為持有者之遺留;2026-11-14 負載探測所見)
        if (Date.now() - t0 > RELEASE_WAIT_MS) { retreat(fd, token, staleMs); return false }
        for (let x of takers.filter((y) => ours(y) && !pidAlive(y.pid))) { let t = take(fd, x.fp, 'dead'); if (t.fp) { putBack(fd, t.fp) } }
        pause()
    }
}
//回收已判死之鎖並接手(j = judgeLock 之結果;token = 本方之 token)⇒ 接手成功(本方已持有且已確認)與否
let reclaimLock = (fd, j, token, staleMs) => {
    let fo = path.join(fd, FN_OWNER)
    let line = ownerLine(token)
    if (j.kind === 'owner') {
        let t = take(fd, fo, 'dead')
        if (!t.fp) { return false }
        let c = readTaken(t.fp)
        //同一份(原文相同;判定時原文不可解析者另須該檔確實逾 staleMs 未動, 免把他方正在寫之新持有者檔當成同一份)
        let same = c !== null && c === j.raw && (ownerOfLine(c) !== null || olderThan(t.fp, staleMs))
        if (!same) { putBack(fd, t.fp); return false }
        let w = writeOwnerOnce(fd, line)
        //接手 ⇒ 刪取得檔(先刪, 免確認時被當成他方之取得檔)後確認持有;EEXIST ⇒ 他方已占下, 刪之;wx 暫時性失敗 ⇒ 移回死持有者之檔(仍判死, 下一輪再接手;不留無主之夾而等 staleMs)
        if (w === true) { unlinkQuiet(t.fp); return confirmHeld(fd, token, staleMs) }
        if (w === 'EEXIST') { unlinkQuiet(t.fp) }
        else { putBack(fd, t.fp) }
        return false
    }
    //取得者已死之取得檔:逐一取得(取不到 = 他方正處理 ⇒ 不接手);讀不到 / 損壞而未逾 staleMs ⇒ 不判死;其內為存活持有者之列 ⇒ 移回持有者檔(不接手);
    //  全部取得且皆非存活之列才以 wx 占下;未占下 ⇒ 已取得者改回原名(仍為死取得檔, 下一輪再處理);占下 ⇒ 刪之後確認持有
    let held = []
    let restore = () => { for (let h of held) { try { fs.renameSync(h.fp, h.from) } catch (e) {} } return false }
    if (j.kind === 'abandoned') {
        for (let x of takenOf(fd, staleMs)) {
            if (x.live) { return restore() }
            let t = take(fd, x.fp, 'dead')
            if (!t.fp) { return restore() }
            held.push({ fp: t.fp, from: x.fp })
            let raw = readTaken(t.fp)
            let o = ownerOfLine(raw)
            if (raw === null || (!o && !olderThan(t.fp, staleMs))) { return restore() }
            if (liveLine(o, staleMs)) { held.pop(); putBack(fd, t.fp); return restore() }
        }
    }
    //無主(或取得者皆已死):以 wx 占下
    if (writeOwnerOnce(fd, line) !== true) { return restore() }
    for (let h of held) { unlinkQuiet(h.fp) }
    return confirmHeld(fd, token, staleMs)
}
//釋放:取得持有者檔 → token 相符才刪夾;不符 ⇒ 移回;持有者檔不在 ⇒ 不刪(其取得檔內為本方之列 ⇒ 等其移回再釋放)
let releaseLock = (fd, token, name) => {
    let fo = path.join(fd, FN_OWNER)
    let t0 = Date.now()
    let mineOf = (fp) => ownedBy(ownerOfLine(readTaken(fp)), token)
    for (;;) {
        let t = take(fd, fo, 'rel')
        let waited = Date.now() - t0 > RELEASE_WAIT_MS
        if (t.fp) {
            let raw = readTaken(t.fp)
            let o = ownerOfLine(raw)
            if (ownedBy(o, token)) { removeLockDir(fd); return }
            putBack(fd, t.fp)
            //讀不到(暫時性)⇒ 移回後重試, 不當成他方之列(外審 hydrogen 第二輪 #2-D:原即放棄釋放而遺留)
            if (raw === null && !waited) { pause(); continue }
            waitNote(`寫入鎖 ${name} 已被他方回收(現持有者 pid ${o ? o.pid : '?'}), 不刪其鎖`)
            return
        }
        if (t.code !== 'ENOENT') {
            //取得失敗而持有者檔仍在(Windows 之暫時性占用):短重試;逾時 ⇒ 以核對後刪除收尾(原行為)
            if (!waited) { pause(); continue }
            if (ownedBy(readOwner(fd), token)) { removeLockDir(fd) }
            return
        }
        //持有者檔不在:鎖夾已不在 / 他方之新夾 ⇒ 非本方之鎖 ⇒ 不刪;本方之列在他方之取得檔內 ⇒ 取得者已死者由本方取得後刪夾, 存活者(回收者核對中)等其移回
        let mine = takenWith(fd, Infinity).filter((x) => ownedBy(x.o, token))
        if (!mine.length) {
            //取得(ENOENT)與列舉之間他方已移回 ⇒ 持有者檔又是本方之列 ⇒ 重來(外審 Argon #4:原直接返回而遺留至 staleMs);
            //  再列舉與再讀皆無本方之列(或鎖夾已不在)才結束(外審 hydrogen 第二輪 #2-C:列舉與讀取之間被另一方取走)
            let cur = ownerAt(fd)
            if (!waited && (ownedBy(cur.o, token) || (!cur.o && !cur.missing))) { continue }
            if (!waited && fs.existsSync(fd)) {
                let again = takenWith(fd, Infinity).some((x) => ownedBy(x.o, token))
                let cur2 = ownerAt(fd)
                if (again || ownedBy(cur2.o, token) || (!cur2.o && !cur2.missing)) { continue }
            }
            return
        }
        for (let x of mine.filter((y) => !pidAlive(y.pid))) {
            let t2 = take(fd, x.fp, 'rel')
            if (t2.fp && mineOf(t2.fp)) { removeLockDir(fd); return }
            if (t2.fp) { try { fs.renameSync(t2.fp, x.fp) } catch (e) {} }
        }
        if (waited) { waitNote(`寫入鎖 ${name}:持有者檔被他方取得逾 ${RELEASE_WAIT_MS} ms 未歸還, 不刪(移回後由死鎖回收處理)`); return }
        pause()
    }
}

/**
 * 跨程序寫入鎖(mkdir 原子;同機多 session 與多程序皆可用):逾時拋錯、持有者已死或久持即回收、釋放只刪自己之鎖;同步阻塞,只包「讀 → 改 → 整檔重寫」之短臨界區。
 * 持有者檔 <鎖夾>/owner 為持有之憑證:只以 wx 建立,回收與釋放皆先改名取得之再核對(回收 = 核對原文未變後於同一鎖夾接手;釋放 = token 相符才刪夾),判定與動作之間他方已重取之鎖不會被誤刪或誤接手
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
        let busy = null
        try { fs.mkdirSync(fd, { recursive: false }) }
        catch (e) {
            //Windows(2026-11-14;第 429 項之同族症狀):同名鎖夾正被他程序刪除(刪除待決)時 mkdir 回 EPERM / EACCES / EBUSY ⇒ 視同鎖被占用而等候重試(不拋);
            //  非暫時性之權限問題則於 timeoutMs 逾時拋錯(訊息附錯誤碼)
            if (e.code !== 'EEXIST' && !BUSY_CODES.includes(e.code)) { throw e }
            busy = e.code
        }
        if (busy === null) {
            //建夾成功 ⇒ 以 wx 寫持有者檔;EEXIST(回收者已占下此無主之夾)/ ENOENT(夾已不在)⇒ 本次不算取得;
            //  暫時性錯誤 ⇒ 刪本方之夾、視同被占用而等候;其他錯誤 ⇒ 刪本方之夾並拋出(原:拋出而留下無持有者檔之夾)
            let w = writeOwnerOnce(fd, ownerLine(token))
            if (w === true) { break }
            if (w === 'EEXIST' || w === 'ENOENT') { busy = 'EEXIST' }
            else {
                rmDir(fd)
                if (!BUSY_CODES.includes(w)) { throw Object.assign(new Error(`寫入鎖 ${name}:寫持有者檔失敗(${w})`), { code: w }) }
                busy = w
            }
        }
        //死鎖回收:取得已判死之持有者檔、核對未變後於同一鎖夾接手 ⇒ 已持有;未成(他方已重取 / 取得或寫入失敗)⇒ 與一般等候同經逾時檢查
        else if (busy === 'EEXIST') {
            let j = judgeLock(fd, staleMs)
            if (j.stale && reclaimLock(fd, j, token, staleMs)) { break }
        }
        let now = Date.now()
        if (now - t0 > timeoutMs) { let o = readOwner(fd); throw new Error(`寫入鎖 ${name} 逾時 ${timeoutMs} ms(另一程序持鎖:${fd}${o ? `;持有者 pid ${o.pid}${pidAlive(o.pid) ? ' 存活' : ' 已死'}` : ''}${busy !== 'EEXIST' ? `;最後一次建鎖夾回 ${busy}` : ''})`) }
        if (now - lastNote >= waitLogMs) { lastNote = now; let o = readOwner(fd); waitNote(`等待寫入鎖 ${name} 已 ${Math.round((now - t0) / 1000)} 秒(持有者 ${o ? `pid ${o.pid}` : '未知'}${busy !== 'EEXIST' ? `;建鎖夾回 ${busy}` : ''})`) }
        sleepMs(15 + Math.floor(Math.random() * 60))
    }
    try { return fn() }
    finally { releaseLock(fd, token, name) }
}

export default withLock
