import { spawn } from 'child_process'


//起子程序並以其輸出為事件同步點(2026-11-14;unit-lock 之死鎖回收競態、unit-governance 之兩程序同時審定共用)
//  spawnWatch(args) ⇒ { out, err, code, waitFor(pred, what), closed }
//    waitFor:stdout 每次有資料即重判 pred(c);成立即 resolve。子程序先結束而未成立 ⇒ reject(附輸出);
//    另以真實計時器設防懸置上限 limitMs(預設 60 秒;只防懸置, 不表達規格)
//    closed:stdio 全部關閉後 resolve(離開碼見 code)
export let spawnWatch = (args, { limitMs = 60000 } = {}) => {
    let p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let c = { pid: p.pid, out: '', err: '', code: null, done: false }
    let waiters = []
    let check = () => { waiters = waiters.filter((w) => !w()) }
    p.stdout.on('data', (d) => { c.out += d; check() })
    p.stderr.on('data', (d) => { c.err += d })
    c.closed = new Promise((resolve) => { p.on('close', (code) => { c.code = code; c.done = true; check(); resolve(code) }) })
    c.waitFor = (pred, what) => new Promise((resolve, reject) => {
        let tm = setTimeout(() => { waiters = waiters.filter((w) => w !== w1); reject(new Error(`等候 ${what} 逾 ${limitMs} ms(防懸置上限;stdout=${c.out};stderr=${c.err})`)) }, limitMs)
        let w1 = () => {
            if (pred(c)) { clearTimeout(tm); resolve(); return true }
            if (c.done) { clearTimeout(tm); reject(new Error(`子程序已結束(code ${c.code})而未見 ${what}(stdout=${c.out};stderr=${c.err})`)); return true }
            return false
        }
        if (!w1()) { waiters.push(w1) }
    })
    c.kill = () => { try { p.kill() } catch (e) {} }
    return c
}

export default spawnWatch
