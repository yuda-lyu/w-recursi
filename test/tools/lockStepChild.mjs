import fs from 'fs'
import path from 'path'
import { withLock } from '../../src/core/lock.mjs'


//鎖之交錯測試之子程序(2026-11-14,外審 Argon #1 / #2 / #4 之交錯;unit-lock 用):以宣告之「步進鉤子」把本程序停在指定之 fs 呼叫前後, 由父程序以標記檔放行
//  參數:<spec.json>;spec = { dir, name, flags, holder, role, timeoutMs, staleMs, rounds:[{ hold? }], stay?, hooks:[{ fn, path?, from?, to?, toEnds?, nth, when:'before'|'after', emit?, wait? }] }
//    hooks:fs[fn] 之第 nth 次相符之呼叫(首參數之絕對路徑以 path 結尾、含 from;第二參數含 to、以 toEnds 結尾;未給之條件不核), 於呼叫前或後印 emit(after 時附 :<錯誤碼>)並等標記檔 wait
//    stay:各次取鎖皆結束後印 <role>:released, 等此標記才結束(使本程序於釋放後仍存活)
//    rounds:依序取鎖之次數;每次臨界區以 wx 建占用檔(EEXIST 且占用者非本方 ⇒ 印 overlap)、印 <role>:in<k>、有 hold 則等該標記、刪本方之占用檔、印 <role>:out<k>;取鎖拋錯 ⇒ 印 <role>:err<k>
//  輸出以 fs.writeSync(1) 同步寫(停住時以 Atomics.wait 阻塞);防懸置上限 60 秒(逾時印 timeout-<標記> 並以 3 結束)
let spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
let out = (s) => fs.writeSync(1, `${s}\n`)
let waitFlag = (f) => {
    let fp = path.join(spec.flags, f)
    for (let k = 0; k < 12000; k++) { if (fs.existsSync(fp)) { return } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5) }
    out(`timeout-${f}`)
    process.exit(3)
}
let counts = spec.hooks.map(() => 0)
let fns = [...new Set(spec.hooks.map((h) => h.fn))]
for (let fn of fns) {
    let orig = fs[fn]
    fs[fn] = function (...args) {
        let p0 = path.resolve(String(args[0]))
        let p1 = typeof args[1] === 'string' ? args[1] : ''
        let fired = []
        spec.hooks.forEach((h, i) => {
            if (h.fn !== fn || (h.path && !p0.endsWith(h.path)) || (h.from && !p0.includes(h.from)) || (h.to && !p1.includes(h.to)) || (h.toEnds && !path.resolve(p1 || '.').endsWith(h.toEnds))) { return }
            counts[i]++
            if (counts[i] === h.nth) { fired.push(h) }
        })
        for (let h of fired.filter((x) => x.when === 'before')) { if (h.emit) { out(h.emit) } if (h.wait) { waitFlag(h.wait) } }
        let r, err = null
        try { r = orig.apply(this, args) }
        catch (e) { err = e }
        for (let h of fired.filter((x) => x.when !== 'before')) { if (h.emit) { out(`${h.emit}${err ? `:${err.code}` : ''}`) } if (h.wait) { waitFlag(h.wait) } }
        if (err) { throw err }
        return r
    }
}
let rd = (fp) => { try { return fs.readFileSync(fp, 'utf8') } catch (e) { return null } }
spec.rounds.forEach((rnd, k) => {
    try {
        withLock(() => {
            let mine = false
            try { fs.writeFileSync(spec.holder, `${spec.role}`, { flag: 'wx' }); mine = true }
            catch (e) { out(`overlap ${spec.role}${k + 1} with ${rd(spec.holder)}`) }
            out(`${spec.role}:in${k + 1}`)
            if (rnd.hold) { waitFlag(rnd.hold) }
            if (mine) { fs.unlinkSync(spec.holder) }
            out(`${spec.role}:out${k + 1}`)
        }, { dir: spec.dir, name: spec.name, timeoutMs: spec.timeoutMs, staleMs: spec.staleMs, waitLogMs: 1e9 })
    }
    catch (e) { out(`${spec.role}:err${k + 1} ${String(e.message).split('\n')[0]}`) }
})
if (spec.stay) { out(`${spec.role}:released`); waitFlag(spec.stay) }
out(`${spec.role}:done`)
