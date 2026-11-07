import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'


//通用評估 worker(子程序;由 eval/runner.mjs 派發):載入領域評估器模組一次, 逐 job 評估, 每 job 一行寫出(可中斷續跑)
//  用法: node worker.mjs --module <評估器模組路徑> --jobs <fp.json> --out <fp.jsonl> [--ctx <json>] [--protocol <json>]
//        node worker.mjs --module <評估器模組路徑> --queue <fp.json> --claims <dir> --out <fp.jsonl> [--ctx <json>] [--protocol <json>]
//  --retry-failed(2026-10-02):續跑時 out 檔之失敗列(ok:false)不算已完成(runner 之 opt.retryFailed 轉來)
//  --jobs:固定清單(舊式;逐一做完)
//  --queue + --claims(2026-09-25 動態派工):多個 worker 共用同一佇列, 逐項以 mkdir(<claims>/<序>)原子認領, 認領到才做 ⇒ 先做完者自動接手剩餘, 不因靜態分桶而閒置
//  評估器模組須匯出:createContext(ctxOpt) → ctx(可 async;每 worker 一次)、evaluate(spec, ctx, protocol) → raw(可 async);可選 meta(ctx) → 附於結果之 meta
let argv = process.argv.slice(2)
let argOf = (k, d) => { let i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
let modPath = argOf('--module', null)
let fpJobs = argOf('--jobs', null)
let fpQueue = argOf('--queue', null)
let fdClaims = argOf('--claims', null)
let fpOut = argOf('--out', null)
if (!modPath || !fpOut || !(fpJobs || (fpQueue && fdClaims))) { throw new Error('用法: node worker.mjs --module <mjs> (--jobs <fp> | --queue <fp> --claims <dir>) --out <fp>') }
let ctxOpt = JSON.parse(argOf('--ctx', '{}'))
let protocol = JSON.parse(argOf('--protocol', '{}'))

let mod = await import(pathToFileURL(path.resolve(modPath)).href)
if (typeof mod.evaluate !== 'function') { throw new Error(`評估器模組未匯出 evaluate:${modPath}`) }
let ctx = typeof mod.createContext === 'function' ? await mod.createContext(ctxOpt) : null
//續跑:out 檔已有之列只在 job 鍵(runner 於 jobs / queue 檔嵌入之 key = id + 規格 + 協定)相同時才沿用;同 tag 重複呼叫留下之舊列(協定 / 規格不同)不算已完成
let done = new Set()
const RETRY_FAILED = argv.includes('--retry-failed')
if (fs.existsSync(fpOut)) { for (let l of fs.readFileSync(fpOut, 'utf8').split(/\r?\n/).filter(Boolean)) { try { let j = JSON.parse(l); if (j.key && (!RETRY_FAILED || j.ok === true)) { done.add(j.key) } } catch (e) {} } }
let runOne = async (job) => {
    let t = Date.now()
    let line
    try {
        let raw = await mod.evaluate(job.spec, ctx, job.protocol || protocol)
        line = { id: job.id, key: job.key || null, ok: true, raw, meta: typeof mod.meta === 'function' ? mod.meta(ctx) : null, ms: Date.now() - t }
        console.log(`${job.id} ok (${line.ms} ms)`)
    }
    catch (e) {
        line = { id: job.id, key: job.key || null, ok: false, error: String(e && e.stack || e), ms: Date.now() - t }
        console.log(`${job.id} ERROR ${String(e && e.message || e).slice(0, 200)}`)
    }
    fs.appendFileSync(fpOut, JSON.stringify(line) + '\n')
}
if (fpQueue) {
    let queue = JSON.parse(fs.readFileSync(fpQueue, 'utf8'))
    fs.mkdirSync(fdClaims, { recursive: true })
    console.log(`worker ready(佇列):${queue.length} jobs`)
    let nMine = 0
    for (let i = 0; i < queue.length; i++) {
        let job = queue[i]
        if (job.key && done.has(job.key)) { continue }
        try { fs.mkdirSync(path.join(fdClaims, String(i)), { recursive: false }) }
        catch (e) { if (e.code === 'EEXIST') { continue } throw e }
        nMine++
        await runOne(job)
    }
    console.log(`worker 佇列已空:本 worker 做 ${nMine} 個`)
}
else {
    let jobs = JSON.parse(fs.readFileSync(fpJobs, 'utf8'))
    console.log(`worker ready: ${jobs.length} jobs(已完成 ${jobs.filter((j) => j.key && done.has(j.key)).length})`)
    for (let job of jobs) {
        if (job.key && done.has(job.key)) { continue }
        await runOne(job)
    }
}
if (typeof mod.dispose === 'function') { await mod.dispose(ctx) }
