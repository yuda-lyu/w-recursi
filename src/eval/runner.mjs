import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import isFunction from 'lodash-es/isFunction.js'
import orderBy from 'lodash-es/orderBy.js'
import range from 'lodash-es/range.js'
import sortBy from 'lodash-es/sortBy.js'
import { acquireSlots, tryAcquireSlots, releaseSlots } from '../core/slots.mjs'
import { sha, canonicalJson } from '../core/canonical.mjs'
import { withLock } from '../core/lock.mjs'
import { pidAlive } from '../core/proc.mjs'


const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs')
//job 鍵(續跑與讀回之比對依據):id + 規格 + 有效協定(job 自帶者優先, 否則本次預設協定)
/**
 * job 鍵(續跑與讀回之比對依據):id + 規格 + 有效協定(job 自帶者優先,否則本次預設協定)
 *
 * @param {Object} job 輸入 { id, spec, protocol? }
 * @param {Object|null} [defaultProtocol=null] 輸入預設協定
 * @returns {String} 回傳 16 碼鍵
 * @example
 * let job = { id: 'a', spec: { x: 1 } }
 * console.log(jobKey(job) === jobKey({ id: 'a', spec: { x: 1 } }), jobKey(job) === jobKey(job, { n: 2 }))
 * // => true false
 */
export let jobKey = (job, defaultProtocol = null) => sha(canonicalJson({ id: job.id, spec: job.spec, protocol: job.protocol || defaultProtocol || {} }))

//—— 工作夾之清理(2026-09-29:原永不清, 某領域累積 369 夾 193 MB)——
//  runner 產物(判定「是 tag 夾」之依據):queue_<run>.json、out_w<i>.jsonl、w<i>.log、claims_<run>/、進行中標記 .active_<pid>_<亂碼>
const RE_RUNNER_FILE = /^(queue_.+\.json|out_w\d+\.jsonl|w\d+\.log|\.active_\d+_.+)$/
let safeName = (s) => String(s).replace(/[^\w.-]/g, '_')
//刪夾(Windows 下檔案短暫被防毒 / 索引持有時重試;失敗不拋)
let rmDirRetry = (fd) => {
    for (let k = 0; k < 5; k++) {
        try { fs.rmSync(fd, { recursive: true, force: true }) } catch (e) {}
        if (!fs.existsSync(fd)) { return true }
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (k + 1)) } catch (e) {}
    }
    return !fs.existsSync(fd)
}
let tagLockOf = (fdJobs, tag) => (fn) => withLock(fn, { dir: fdJobs, name: `tag_${safeName(tag)}` })
//夾內存活之進行中標記(標記名之 pid 仍存活者;except = 本次自己之標記檔名)
let liveMarkersOf = (fd, except = null) => { try { return fs.readdirSync(fd).filter((f) => f.startsWith('.active_') && f !== except && pidAlive(Number(f.split('_')[1]))) } catch (e) { return [] } }
//把 w*.log 依序附加到 <logDir>/<tag>.log(清夾前保留抽驗不符等警示之證據);回檔案路徑
let archiveLogs = (fd, tag, logDir, head) => {
    let logs = fs.readdirSync(fd).filter((f) => /^w\d+\.log$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    let text = [`== ${tag} ${new Date().toISOString()} ${head} ==`, ...logs.map((f) => `--- ${f} ---\n${fs.readFileSync(path.join(fd, f), 'utf8').replace(/\s+$/, '')}`)].join('\n') + '\n'
    fs.mkdirSync(logDir, { recursive: true })
    let fp = path.join(logDir, `${safeName(tag)}.log`)
    fs.appendFileSync(fp, text)
    return fp
}
//回收舊 tag 夾(可單獨呼叫, 如維護窗清理舊佈局):fdJobs 下「含 runner 產物、最新 mtime 距今 ≥ days 日、無存活進行中標記」之子夾 ⇒ (logDir 有給則先歸檔日誌)刪除
//  不動:非目錄、名稱以 . 或 _ 開頭者(如 _logs、.lock_*)、不含 runner 產物者(如舊佈局之巢狀 jobs/)、exclude 所列之夾;單夾失敗不拋
//  回 { removed:[名], kept:[{ name, why }] }
/**
 * 回收舊 tag 夾(可單獨呼叫,如維護窗清理舊佈局):fdJobs 下「含 runner 產物、最新 mtime 距今 ≥ days 日、無存活進行中標記」之子夾 ⇒ (logDir 有給則先歸檔日誌)刪除;不動非目錄、名稱以 . 或 _ 開頭者、不含 runner 產物者、exclude 所列之夾;單夾失敗不拋
 *
 * @param {String} fdJobs 輸入 jobs 夾
 * @param {Object} [opt={}] 輸入 { days:Number(7), logDir:String, exclude:Array }
 * @returns {Object} 回傳 { removed:Array(夾名), kept:Array([{ name, why }]) }
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let fdJobs = path.join(dir, 'jobs')
 * fs.mkdirSync(path.join(fdJobs, 'tag1'), { recursive: true })
 * let f = path.join(fdJobs, 'tag1', 'queue_a.json')
 * fs.writeFileSync(f, '[]')
 * let old = new Date(Date.now() - 10 * 86400000)
 * fs.utimesSync(f, old, old)
 * console.log(JSON.stringify(reclaimJobDirs(fdJobs, { days: 7 })))
 * // => {"removed":["tag1"],"kept":[]}
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let reclaimJobDirs = (fdJobs, { days = 7, logDir = null, exclude = [] } = {}) => {
    let out = { removed: [], kept: [] }
    let ex = new Set((exclude || []).map((x) => path.resolve(x)))
    let ents = []
    try { ents = fs.readdirSync(fdJobs, { withFileTypes: true }) } catch (e) { return out }
    let cutoff = Date.now() - days * 86400000
    for (let e of ents) {
        if (!e.isDirectory() || /^[._]/.test(e.name)) { continue }
        let fd = path.join(fdJobs, e.name)
        if (ex.has(path.resolve(fd))) { continue }
        try {
            let files = fs.readdirSync(fd)
            if (!files.some((f) => RE_RUNNER_FILE.test(f) || /^claims_/.test(f))) { continue }
            //最後活動 = 夾內各項(檔 / 子夾)之最新 mtime(worker 追加寫出只動檔之 mtime, 不動夾之 mtime);空夾 ⇒ 夾之 mtime
            let newest = files.length ? Math.max(...files.map((f) => { try { return fs.statSync(path.join(fd, f)).mtimeMs } catch (e2) { return 0 } })) : fs.statSync(fd).mtimeMs
            if (newest > cutoff) { continue }
            let why = tagLockOf(fdJobs, e.name)(() => {
                if (liveMarkersOf(fd).length) { return '有存活之進行中標記' }
                if (logDir) { archiveLogs(fd, e.name, logDir, `回收(${days} 日未動)`) }
                return rmDirRetry(fd) ? null : '刪夾失敗'
            })
            if (why) { out.kept.push({ name: e.name, why }) } else { out.removed.push(e.name) }
        }
        catch (err) { out.kept.push({ name: e.name, why: String(err && err.message || err).slice(0, 120) }) }
    }
    return out
}
let reclaimedOnce = new Set() //本程序已回收過之 jobs 夾(每程序每夾只掃一次)

//平行評估 runJobs(jobs, opt) → { results: Map(id → { ok, raw | error, meta, ms }), exits, nWorkers, fd, commit }
//  opt.mode = 'spawn'(每 worker 一個 node 子程序;子程序總數受全域槽位 opt.slots = { dir, max } 限制, 多 session 併行時合計 ≤ max)
//           | 'inProcess'(同程序 promise pool;opt.evaluate / opt.createContext;測試與輕量評估器用)
//  job: { id, spec, protocol? };opt.protocol 為預設協定;opt.costOf(job) 供大者先派
//  spawn 之派工(2026-09-25 改為動態佇列;原為起跑時靜態輪流分桶 ⇒ 重 job 落同桶時他 worker 做完即閒置(某次實例閒置 18 分)):
//    待辦 job 依 costOf 由大到小寫成單一佇列(queue_<run>.json), worker 以 mkdir(claims_<run>/<序>)原子認領下一個 ⇒ 先做完者自動接手剩餘
//    補槽:起跑時只取得部分槽位(他 session 占用)者, 運行中每 opt.expandMs(預設 5 秒)試取空槽並加開 worker(整次呼叫開過之 worker 總數 ≤ 所求;
//      原為取槽後不擴增 ⇒ 爭用時晚到者可能只拿 1 槽整批序列跑, 某次實例 8 臂單 worker 84 分)
//    續跑:同 tag 前次留下之 out_w*.jsonl 中 job 鍵相符之列視為已完成, 不入佇列、直接作為結果
//      opt.retryFailed(2026-10-02;預設 false = 舊行為):true ⇒ 只把 ok 之列視為已完成, 失敗列(ok:false)之 job 重新入佇列(worker 端同);
//      讀回:同 job 鍵有 ok 列者以 ok 列為準(與檔序無關;無重試時同鍵不會並存 ok 與失敗列 ⇒ 舊行為不變)
//  工作夾 = <tmpDir>/jobs/<tag>(tmpDir 未給 ⇒ <cwd>/tmp)
//  工作夾之清理(2026-09-29;提交界線:讀回結果 ≠ 已持久化 ⇒ runner 不自行刪夾):
//    opt.keepDir(預設 true = 舊行為, 保留):false ⇒ 回傳之 commit() 於「呼叫端已把結果持久化」後呼叫, 才刪本次之工作夾
//      (全部 job 皆 ok 讀回、且無他方以同 tag 進行中;否則保留 —— 供診斷與同 tag 續跑);未呼叫 commit 者保留(由下述回收處理)
//      同 tag 併行:各次呼叫於夾內留進行中標記 `.active_<pid>_<亂碼>`(建立與撤除皆在 tag 鎖內);他方標記之 pid 存活 ⇒ 不刪, 由最後 commit 者清
//      例外離開 ⇒ 撤本次之標記、夾保留;程序被殺 ⇒ 標記殘留, 其 pid 已死 ⇒ 他方視同無人
//    opt.logDir(可省):刪夾前把 w*.log(含「抽驗不符」一類之警示)附加到 <logDir>/<tag>.log —— 清夾不使證據消失
//    opt.reclaimDays(keepDir false 時生效, 預設 7;0 / 負 ⇒ 不回收):本程序首次於該 jobs 夾派工時, 以 reclaimJobDirs 回收逾期未動之 tag 夾
//    commit() 回 { removed, why, log? }(重複呼叫回同一結果;keepDir 為 true 或 inProcess ⇒ { removed: false, why: 'keepDir' / 'inProcess' })
/**
 * 平行評估:mode "spawn"(每 worker 一個 node 子程序,總數受全域槽位限制;待辦 job 依 costOf 由大到小寫成單一佇列,worker 以 mkdir 原子認領下一個;起跑槽位不足者運行中補槽加開;同 tag 續跑只重算未完成者)或 "inProcess"(同程序 promise pool,測試與輕量評估器用)。keepDir 為 false 時由回傳之 commit() 於結果持久化後才刪工作夾
 *
 * @param {Array} jobs 輸入 [{ id, spec, protocol? }]
 * @param {Object} [opt={}] 輸入 { mode, workers:Number(4), tag, tmpDir, evaluatorModule(spawn 必填), evaluate/createContext/ctxOpt/ctx/meta(inProcess;未給 createContext 時取 ctx), protocol, costOf, slots:{ dir, max, timeoutMs, staleMs }, expandMs:Number(5000), keepDir:Boolean(預設 true), logDir, reclaimDays:Number(7), retryFailed:Boolean(false), cwd, env }
 * @returns {Promise} 回傳 Promise,resolve { results:Map(id → { ok, raw | error, meta, ms }), exits, nWorkers, fd(僅 spawn 模式有), commit() }
 * @throws {Error} inProcess 缺 evaluate、spawn 缺 evaluatorModule、槽位逾時時拋出
 * @example
 * let run = await runJobs([{ id: 'a', spec: { x: 1 } }, { id: 'b', spec: { x: 2 } }], { mode: 'inProcess', workers: 2, evaluate: async (spec) => ({ v: spec.x * 10 }) })
 * console.log(run.nWorkers, run.results.get('b').ok, run.results.get('b').raw.v)
 * // => 2 true 20
 */
export let runJobs = async (jobs, opt = {}) => {
    let O = { workers: 4, mode: 'spawn', tag: `run_${Date.now()}_${process.pid}`, expandMs: 5000, ...opt }
    if (!jobs.length) { return { results: new Map(), exits: [], nWorkers: 0, commit: () => ({ removed: false, why: '無 job' }) } }
    if (O.mode === 'inProcess') {
        if (!isFunction(O.evaluate)) { throw new Error('runJobs(inProcess): 缺 evaluate') }
        let ctx = isFunction(O.createContext) ? await O.createContext(O.ctxOpt || {}) : (O.ctx || null)
        let nW = Math.max(1, Math.min(O.workers, jobs.length))
        let results = new Map()
        let queue = [...jobs]
        let run = async () => {
            for (;;) {
                let job = queue.shift()
                if (!job) { return }
                let t = Date.now()
                try { let raw = await O.evaluate(job.spec, ctx, job.protocol || O.protocol || {}); results.set(job.id, { id: job.id, ok: true, raw, meta: isFunction(O.meta) ? O.meta(ctx) : null, ms: Date.now() - t }) }
                catch (e) { results.set(job.id, { id: job.id, ok: false, error: String(e && e.stack || e), ms: Date.now() - t }) }
            }
        }
        await Promise.all(range(nW).map(run))
        return { results, exits: [], nWorkers: nW, commit: () => ({ removed: false, why: 'inProcess' }) }
    }
    if (!O.evaluatorModule) { throw new Error('runJobs(spawn): 缺 evaluatorModule') }
    let fdJobs = path.join(O.tmpDir || path.join(process.cwd(), 'tmp'), 'jobs')
    let fd = path.join(fdJobs, O.tag)
    let clean = O.keepDir === false
    let tagLock = tagLockOf(fdJobs, O.tag)
    let marker = clean ? `.active_${process.pid}_${Math.random().toString(36).slice(2, 10)}` : null
    if (clean) {
        let days = O.reclaimDays === undefined ? 7 : Number(O.reclaimDays)
        let k = path.resolve(fdJobs)
        if (days > 0 && !reclaimedOnce.has(k)) { reclaimedOnce.add(k); try { reclaimJobDirs(fdJobs, { days, logDir: O.logDir || null, exclude: [fd] }) } catch (e) {} }
        tagLock(() => { fs.mkdirSync(fd, { recursive: true }); fs.writeFileSync(path.join(fd, marker), new Date().toISOString()) })
    }
    else { fs.mkdirSync(fd, { recursive: true }) }
    let dropMarker = () => { try { fs.rmSync(path.join(fd, marker), { force: true }) } catch (e) {} }
    //job 鍵 = id + 規格 + 有效協定:續跑(out 檔已有者不重跑)與讀回都以鍵比對, 同 tag 重複呼叫時舊列(協定或規格不同)不會被誤用
    //  (2026-09-23 實際踩到:續抽同 tag 三批, 同 id 換桶後讀回上一批之舊列 ⇒ 抽序 16..31 被重複記成 32..47)
    let keyOf = (j) => jobKey(j, O.protocol)
    let keyById = new Map(jobs.map((j) => [j.id, keyOf(j)]))
    let outFiles = () => fs.readdirSync(fd).filter((f) => /^out_w\d+\.jsonl$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).map((f) => path.join(fd, f))
    let readRows = () => {
        let rows = []
        for (let fp of outFiles()) { for (let l of fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter(Boolean)) { try { rows.push(JSON.parse(l)) } catch (e) {} } }
        return rows
    }
    let results = new Map(), rs = [], spawned = 0
    let done = false
    try {
        let doneKeys = new Set(readRows().filter((r) => !O.retryFailed || r.ok === true).map((r) => r.key).filter(Boolean))
        let pending = jobs.filter((j) => !doneKeys.has(keyById.get(j.id)))
        let sorted = isFunction(O.costOf) ? orderBy(pending, [O.costOf], ['desc']) : pending
        if (sorted.length) {
            //runId 加亂碼(2026-09-29:同程序同毫秒兩次呼叫同 tag 時, 原 `${時戳}_${pid}` 撞名 ⇒ 共用佇列檔與認領夾)
            let runId = `${Date.now().toString(36)}_${process.pid}_${Math.random().toString(36).slice(2, 6)}`
            let fpQueue = path.join(fd, `queue_${runId}.json`)
            let fdClaims = path.join(fd, `claims_${runId}`)
            fs.writeFileSync(fpQueue, JSON.stringify(sorted.map((j) => ({ ...j, key: keyById.get(j.id) }))))
            fs.mkdirSync(fdClaims, { recursive: true })
            let want = Math.max(1, Math.min(O.workers, sorted.length))
            let slotOpt = O.slots ? { max: O.slots.max || 8, staleMs: O.slots.staleMs || 6 * 3600000 } : null
            let first = O.slots ? acquireSlots(O.slots.dir, { want, ...slotOpt, timeoutMs: O.slots.timeoutMs || 3600000 }) : range(want).map(() => null)
            let procs = [], live = 0, held = []
            let spawnWorker = (handle) => {
                let i = spawned++
                let fpOut = path.join(fd, `out_w${i}.jsonl`)
                let fpLog = path.join(fd, `w${i}.log`)
                let log = fs.openSync(fpLog, 'a')
                let args = [WORKER, '--module', O.evaluatorModule, '--queue', fpQueue, '--claims', fdClaims, '--out', fpOut, '--ctx', JSON.stringify(O.ctxOpt || {}), '--protocol', JSON.stringify(O.protocol || {}), ...(O.retryFailed ? ['--retry-failed'] : [])]
                let p = spawn(process.execPath, args, { stdio: ['ignore', log, log], cwd: O.cwd || process.cwd(), env: { ...process.env, ...(O.env || {}) } })
                live++
                if (handle) { held.push(handle) }
                //各 worker 結束即釋放自己那一格槽位(2026-09-24:原為整批結束才釋放 ⇒ 他 session 之 acquireSlots 只能乾等最慢那個 worker)
                procs.push(new Promise((resolve) => p.on('exit', (code) => {
                    fs.closeSync(log)
                    live--
                    if (handle) { releaseSlots([handle]); held = held.filter((h) => h !== handle) }
                    resolve({ i, code, fpOut, fpLog })
                })))
            }
            let timer = null
            try {
                for (let h of first) { spawnWorker(h) }
                let unclaimed = () => { try { return sorted.length - fs.readdirSync(fdClaims).length } catch (e) { return 0 } }
                if (O.slots && spawned < want) {
                    timer = setInterval(() => {
                        //全部 worker 已結束(含啟動即失敗)⇒ 不再補開(免對壞掉之評估器無限重開)
                        if (spawned >= want || live === 0) { clearInterval(timer); timer = null; return }
                        let need = Math.min(want - spawned, unclaimed())
                        if (need <= 0) { return }
                        for (let h of tryAcquireSlots(O.slots.dir, { want: need, ...slotOpt })) { spawnWorker(h) }
                    }, O.expandMs)
                }
                //等到「本輪等待期間無新 worker 加開」為止(補槽可能於等待中加開)
                for (;;) {
                    let n = procs.length
                    let r = await Promise.all(procs)
                    if (procs.length === n) { rs = r; break }
                }
            }
            finally {
                if (timer) { clearInterval(timer) }
                releaseSlots(held)
            }
        }
        for (let row of readRows()) { if (row.key && keyById.get(row.id) === row.key) { let prev = results.get(row.id); if (!prev || row.ok === true || prev.ok !== true) { results.set(row.id, row) } } }
        for (let j of jobs) { if (!results.has(j.id)) { results.set(j.id, { id: j.id, ok: false, error: `worker 無結果(exit ${rs.map((r) => r.code).join(',')};log ${fd})` }) } }
        done = true
    }
    finally {
        //例外離開(如槽位逾時)⇒ 撤本次之進行中標記(夾保留)
        if (clean && !done) { try { tagLock(dropMarker) } catch (e) { dropMarker() } }
    }
    //提交(呼叫端持久化結果之後):全部 ok ⇒ 刪夾(他方仍在跑則留給最後提交者);否則只撤本次之標記
    let allOk = jobs.every((j) => { let r = results.get(j.id); return !!(r && r.ok === true) })
    let committed = null
    let commit = () => {
        if (committed) { return committed }
        if (!clean) { committed = { removed: false, why: 'keepDir' }; return committed }
        committed = tagLock(() => {
            dropMarker()
            if (!allOk) { return { removed: false, why: '有失敗或無結果之 job(保留工作夾)' } }
            let others = liveMarkersOf(fd)
            if (others.length) { return { removed: false, why: `同 tag 另有 ${others.length} 個進行中之呼叫(由最後提交者清)` } }
            let log = null
            if (O.logDir) {
                try { log = archiveLogs(fd, O.tag, O.logDir, `pid ${process.pid};job ${jobs.length};worker ${spawned}`) }
                catch (e) { return { removed: false, why: `worker 日誌歸檔失敗(保留工作夾):${e.message}` } }
            }
            let removed = rmDirRetry(fd)
            return { removed, why: removed ? '已提交, 全部 job 成功讀回' : '刪夾失敗(檔案被占用?)', log }
        })
        return committed
    }
    return { results, exits: sortBy(rs, 'i').map((r) => r.code), nWorkers: spawned, fd, commit }
}

export default runJobs
