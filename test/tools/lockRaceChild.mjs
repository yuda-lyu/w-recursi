import fs from 'fs'
import path from 'path'
import { withLock } from '../../src/core/lock.mjs'


//鎖之死鎖回收競態之子程序(2026-11-14,第 456 項;unit-lock 之事件同步測試用)
//  參數:<dir> <鎖名> <角色 A|B> <旗標夾> <臨界區占用檔>
//  角色 A:攔截 fs.readFileSync 對 <鎖夾>/owner 之讀取 —— 第 1 次(判定時之讀取)讀完後印 `A:judged` 並停住, 直到旗標夾出現 goA 才把讀到之內容交回(使 A 之「判定」與「動作」之間夾著他方之回收與取得);
//    第 2 次讀取印 `A:judged2`(= A 已回到等候迴圈再判定, 未進臨界區)
//  角色 B:臨界區內停住, 直到旗標夾出現 goB
//  臨界區:以 wx 建占用檔(EEXIST ⇒ 另一方仍在臨界區 ⇒ 印 overlap), 印 `<角色>:in`, 結束時刪本方所建之占用檔
//  輸出以 fs.writeSync(1) 同步寫(本程序隨即以 Atomics.wait 阻塞, 非同步之寫入會被延後)
let [dir, name, role, flags, holderFp] = process.argv.slice(2)
let out = (s) => fs.writeSync(1, `${s}\n`)
let waitFlag = (f) => {
    let fp = path.join(flags, f)
    //條件輪詢(標記檔由父程序於收到事件後建立);防懸置上限 60 秒
    for (let k = 0; k < 12000; k++) { if (fs.existsSync(fp)) { return } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5) }
    out(`timeout-wait-${f}`)
    process.exit(3)
}
if (role === 'A') {
    let fo = path.resolve(dir, `.lock_${name}`, 'owner')
    let orig = fs.readFileSync, n = 0
    fs.readFileSync = function (p, ...rest) {
        let r = orig.call(this, p, ...rest)
        if (path.resolve(String(p)) === fo) {
            n++
            if (n === 1) { out('A:judged'); waitFlag('goA') }
            else if (n === 2) { out('A:judged2') }
        }
        return r
    }
}
withLock(() => {
    let mine = false
    try { fs.writeFileSync(holderFp, role, { flag: 'wx' }); mine = true }
    catch (e) { out('overlap') }
    out(`${role}:in`)
    if (role === 'B') { waitFlag('goB') }
    if (mine) { fs.unlinkSync(holderFp) }
    out(`${role}:out`)
}, { dir, name, timeoutMs: 60000, staleMs: 1e9, waitLogMs: 1e9 })
out(`${role}:done`)
