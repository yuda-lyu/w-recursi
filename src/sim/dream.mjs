import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import get from 'lodash-es/get.js'
import isFunction from 'lodash-es/isFunction.js'
import last from 'lodash-es/last.js'
import max from 'lodash-es/max.js'
import maxBy from 'lodash-es/maxBy.js'
import pick from 'lodash-es/pick.js'
import { withLock } from '../core/lock.mjs'
import { appendJsonl, readJsonl, writeFileAtomic } from '../core/jsonl.mjs'
import { assertWriteRoot } from '../core/writeRoot.mjs'
import { nowIso } from '../core/canonical.mjs'
import { checkPolicySource } from '../tree/view.mjs'
import { evaluatePolicy, accept, aliasMapOfNodes } from './replay.mjs'


//做夢:對當前策略與 policies/candidates/*.mjs 逐一在樹上重放打分, 寫 policies/scores.jsonl(**不是唯讀**:每次追加各策略一列;維護中不寫, 見下)
//  樹大時一次約 1 ~ 18 分(2026-09 某次實測);cfg.dream.minIntervalMs 可使同批之多 session 只做一次(loop/auto.mjs)
//  accept 時為單一寫者:鎖內確認 current.mjs 未被他 session 改寫才升版(存 v{n}.mjs, current.mjs 改為 re-export, changelog 記理由), 並清除策略開發請求標記

//策略檔之相對匯入(靜態 import / 轉匯出 export … from / 字串常值之動態 import;只收 './'、'../' 開頭, 裸套件名如 lodash-es 不查);整列為 // 註解者不掃
const RE_REL_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g
/**
 * 策略檔之相對匯入(靜態 import、轉匯出 export … from、字串常值之動態 import;只收 ./ 與 ../ 開頭,裸套件名不查);整列為 // 註解者不掃
 *
 * @param {String} src 輸入策略檔原文
 * @returns {Array} 回傳相對指定詞陣列
 * @example
 * let src = "import a from './a.mjs'\n// import b from './b.mjs'\nexport { x } from '../c.mjs'\nimport _ from 'lodash-es'"
 * console.log(relativeImportsOf(src).join(' '))
 * // => ./a.mjs ../c.mjs
 */
export let relativeImportsOf = (src) => {
    let out = []
    for (let line of String(src || '').split(/\r?\n/)) {
        if (/^\s*\/\//.test(line)) { continue }
        for (let m of line.matchAll(RE_REL_SPEC)) { out.push(m[2]) }
    }
    return out
}
//策略檔及其相對匯入閉包(2026-09-29:現行策略之 current.mjs 只有一行 re-export, 靜態檢查原只看它 ⇒ 實際策略 v2.mjs 從未於載入時受檢)
//  自 fp 起沿相對匯入逐檔收集(廣度優先;去重防環);回 { files:[{ fp, src }], missing:[fp], truncated }(上限 maxFiles, 超過 ⇒ truncated)
/**
 * 策略檔及其相對匯入閉包:自 fp 起沿相對匯入逐檔收集(廣度優先,去重防環),供靜態檢查涵蓋轉匯出目標(如 current.mjs → ./v2.mjs)
 *
 * @param {String} fp 輸入策略檔路徑
 * @param {Object} [opt={}] 輸入 { maxFiles:Number(預設 16) }
 * @returns {Object} 回傳 { files:[{ fp, src }], missing:[fp], truncated:Boolean }
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * fs.writeFileSync(path.join(dir, 'current.mjs'), "export { default } from './v1.mjs'")
 * fs.writeFileSync(path.join(dir, 'v1.mjs'), 'export default () => 1')
 * let r = policySourcesOf(path.join(dir, 'current.mjs'))
 * console.log(r.files.length, r.missing.length, r.truncated)
 * // => 2 0 false
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let policySourcesOf = (fp, { maxFiles = 16 } = {}) => {
    let seen = new Set(), files = [], missing = []
    let q = [path.resolve(fp)]
    while (q.length) {
        let f = q.shift()
        if (seen.has(f)) { continue }
        seen.add(f)
        if (files.length >= maxFiles) { return { files, missing, truncated: true } }
        if (!fs.existsSync(f)) { missing.push(f); continue }
        let src = fs.readFileSync(f, 'utf8')
        files.push({ fp: f, src })
        for (let rel of relativeImportsOf(src)) { q.push(path.resolve(path.dirname(f), rel)) }
    }
    return { files, missing, truncated: false }
}

//載入策略檔:靜態檢查(套件預設 + 領域 forbidden)通過才 import;回 { fp, src(本檔原文), fn, meta, checked:[受檢之檔] } 或 { fp, error }
//  2026-09-29:靜態檢查之範圍 = 本檔 + 其相對匯入閉包(轉匯出目標如 current.mjs → ./v2.mjs 同受檢);目標不存在 / 閉包過大 ⇒ 錯誤(不載入)
//  已知限制:同一程序內, 轉匯出目標之模組仍依 Node 之模組快取(本檔 import 帶亂碼參數, 其相對匯入不帶)⇒ 長程序中「同檔改版」之目標會沿用舊模組(靜態檢查讀的是新原文)
/**
 * 載入策略檔:靜態檢查(套件預設 + 領域 forbidden;範圍 = 本檔 + 其相對匯入閉包)通過才 import(帶亂碼參數避開模組快取)
 *
 * @param {String} fp 輸入策略檔路徑
 * @param {Array} [forbidden=[]] 輸入領域追加之禁用式
 * @returns {Promise} 回傳 Promise,resolve { fp, src, fn, meta, checked:[受檢之檔] } 或 { fp, error }
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * fs.writeFileSync(path.join(dir, 'v1.mjs'), 'export default () => 1')
 * fs.writeFileSync(path.join(dir, 'bad.mjs'), "import cp from 'child_process'\nexport default () => 1")
 * let ok = await loadPolicyFile(path.join(dir, 'v1.mjs'))
 * console.log(ok.meta.name, typeof ok.fn)
 * // => v1 function
 * let bad = await loadPolicyFile(path.join(dir, 'bad.mjs'))
 * console.log(bad.error)
 * // => 靜態檢查不過:/child_process/
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let loadPolicyFile = async (fp, forbidden = []) => {
    if (!fs.existsSync(fp)) { return { fp, error: '檔案不存在' } }
    let src = fs.readFileSync(fp, 'utf8')
    let clo = policySourcesOf(fp)
    if (clo.missing.length) { return { fp, error: `相對匯入之目標不存在:${clo.missing.map((x) => path.relative(path.dirname(path.resolve(fp)), x) || x).join(', ')}` } }
    if (clo.truncated) { return { fp, error: `相對匯入閉包超過 ${clo.files.length} 檔(策略檔應自含)` } }
    let main = path.resolve(fp)
    let bad = []
    for (let f of clo.files) { for (let re of checkPolicySource(f.fp === main ? src : f.src, forbidden)) { bad.push(f.fp === main ? re : `${re}(${path.basename(f.fp)})`) } }
    if (bad.length) { return { fp, error: `靜態檢查不過:${bad.join(' ')}` } }
    try {
        let mod = await import(pathToFileURL(fp).href + `?t=${Date.now()}_${Math.random().toString(36).slice(2)}`)
        if (!isFunction(mod.default)) { return { fp, error: '未匯出 default 函式' } }
        return { fp, src, fn: mod.default, meta: mod.meta || { name: path.basename(fp, '.mjs') }, checked: clo.files.map((f) => f.fp) }
    }
    catch (e) { return { fp, error: `載入失敗:${e.message}` } }
}

//上次做夢之時刻(scores.jsonl 末列之 at;無 ⇒ null);中間壞列略過(唯讀之消費端;2026-09-29 之 skipBad)
/**
 * 上次做夢之時刻(policies/scores.jsonl 末列之 at;無 ⇒ null);中間壞列略過(唯讀之消費端)
 *
 * @param {Object} paths 輸入 makePaths 之回傳
 * @returns {String|null} 回傳 ISO 時刻或 null
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 * import { makePaths } from 'w-recursi/src/core/paths.mjs'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * console.log(lastDreamAt(makePaths(dir)))
 * // => null
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let lastDreamAt = (paths) => { let rows = readJsonl(paths.scores, { skipBad: true }); return rows.length ? last(rows).at : null }

//維護判定(2026-09-29):cfg.maintenance() 回理由字串 ⇒ 維護中;拋錯 ⇒ 視同維護中(寧可不寫)
/**
 * 維護判定:cfg.maintenance() 回理由字串 ⇒ 維護中(做夢只印不寫 scores.jsonl、--accept 不升版);拋錯 ⇒ 視同維護中(寧可不寫)
 *
 * @param {Object} cfg 輸入 createRsi 之設定
 * @returns {String|null} 回傳維護理由或 null
 * @example
 * console.log(maintenanceOf({ maintenance: () => '維護窗' }), maintenanceOf({}), maintenanceOf({ maintenance: () => { throw new Error('x') } }))
 * // => 維護窗 null 維護判定拋錯:x
 */
export let maintenanceOf = (cfg) => {
    if (!cfg || !isFunction(cfg.maintenance)) { return null }
    try { return cfg.maintenance() || null }
    catch (e) { return `維護判定拋錯:${e.message}` }
}

/**
 * 做夢工廠(createRsi 以之組 rsi.dream):對當前策略與 policies/candidates/*.mjs 逐一在樹上重放打分,追加寫 policies/scores.jsonl(維護中不寫);opt.accept 時為單一寫者(policies 鎖內確認 current.mjs 未被他 session 改寫才升版,存 v{n}.mjs、改 current.mjs、記 changelog、清策略開發請求標記);飽和(空間用盡或全部候選與當前相差 < 1%)⇒ 不升版
 *
 * @param {Object} rsi 輸入實例
 * @returns {Function} 回傳 async (opt) => { nodes, rows, decision, saturated, scoresSkipped };opt: { accept, currentOnly(只打當前策略), rounds, arms, novelty, global, minGlobal, lambda, mu, defaultReplays, targetLadder, structural, nodes }
 * @throws {Error} current.mjs 載入失敗(缺檔、靜態檢查不過等)時拋出
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 * import { createRsi } from 'w-recursi/src/index.mjs'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let domain = {
 *     name: 'toy',
 *     score: (raw) => ({ S: raw.v, ladder: raw.v >= 2 ? 1 : 0, flags: {} }),
 *     validateSpec: (s) => { if (typeof s.x !== 'number') { throw new Error('x 須為數字') } },
 *     operators: [{ name: 'inc', family: 'f', applies: () => true, children: (s) => [{ spec: { x: s.x + 1 }, params: { by: 1 } }] }],
 *     carriers: { root: { x: 0 } },
 *     evaluator: { mode: 'inProcess', evaluate: async (spec) => ({ v: spec.x }) },
 * }
 * let rsi = createRsi({ root: dir, domain, budget: { arms: 2, novelty: 1 } }).init()
 * await rsi.explore()
 * await rsi.explore()
 * let d = await rsi.dream()
 * console.log(d.nodes, d.rows.length, d.rows[0].name, d.decision)
 * // => 2 1 current(v0) null
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let makeDream = (rsi) => async (opt = {}) => {
    let { paths, store, view, domain } = rsi
    paths.ensure()
    //2026-09-27:cfg.dream 之 defaultReplays / minGlobal / targetLadder / lambda / mu 亦為重放選項(呼叫端 opt 優先)
    //2026-10-02:cfg.dream.structural(plan, { view, round }) → 違規數(結構保底;replay.mjs ⑥)亦傳入重放
    let simOpt = pick({ ...rsi.budget, ...pick(get(rsi.cfg, 'dream', {}) || {}, ['defaultReplays', 'minGlobal', 'targetLadder', 'lambda', 'mu', 'structural']), ...opt }, ['rounds', 'arms', 'novelty', 'global', 'minGlobal', 'lambda', 'mu', 'defaultReplays', 'targetLadder', 'structural'])
    let env = { viewOf: view.policyViewOfNode, aliasOf: view.aliasOf, makeCtx: rsi.makeCtx, costOf: domain.costOf || null }
    let nodes = opt.nodes || store.loadNodes()
    //別名表於本次做夢求一次, 當前策略與各候選(及其全樣本 / 各切分)共用(2026-09-29;同一 nodes ⇒ 同一表, 分數逐位不變)
    let evalOpt = { ...simOpt, aliasMap: aliasMapOfNodes(nodes, env) }
    let forbidden = domain.forbidden || []
    //維護中(cfg.maintenance;如領域之維護旗標且非維護者本人)⇒ 只印不寫 scores.jsonl;--accept 亦拒(呼叫端之 CLI 本已擋, 此為引擎之雙保險)
    let mt = maintenanceOf(rsi.cfg)
    let cur = await loadPolicyFile(paths.current, forbidden)
    if (cur.error) { throw new Error(`current.mjs ${cur.error}`) }
    let curScore = evaluatePolicy(cur.fn, nodes, env, evalOpt)
    let rows = [{ name: `current(${cur.meta.name})`, fp: cur.fp, meta: cur.meta, score: curScore, isCurrent: true }]
    //opt.currentOnly(2026-10-07):只打當前策略 —— 候選之接受只由 --accept 判, 輪內重打候選只耗時;
    //  原於打完當前後才列舉候選 ⇒ 他方策略開發代理於做夢中寫入之候選亦被重打(某輪因此逾背景 2 小時存活上限而被停, 無 DONE.json)
    let cands = opt.currentOnly ? [] : (fs.existsSync(paths.candidates) ? fs.readdirSync(paths.candidates).filter((f) => f.endsWith('.mjs')).sort() : [])
    for (let f of cands) {
        let c = await loadPolicyFile(path.join(paths.candidates, f), forbidden)
        if (c.error) { rows.push({ name: f, fp: c.fp, error: c.error }); continue }
        rows.push({ name: f, fp: c.fp, meta: c.meta, score: evaluatePolicy(c.fn, nodes, env, evalOpt) })
    }
    let stamp = nowIso()
    let scoresSkipped = null
    if (mt) {
        scoresSkipped = `維護中:${mt}`
        try { fs.writeSync(2, `[w-recursi] 做夢分數未寫入 scores.jsonl(${scoresSkipped})\n`) } catch (e) {}
    }
    else {
        for (let r of rows) {
            //2026-09-27 起:J 之品質項為視圖之 QD(有行為格時)、目標為視圖階梯 ≥ targetLadder、樹外臂成本可為可見中位 ⇒ 口徑欄 sim 記之(與舊列不可直接比較)
            appendJsonl(paths.scores, { at: stamp, nNodes: nodes.length, name: r.name, error: r.error || null, inSample: r.score ? r.score.inSample.J : null, heldOut: r.score ? r.score.heldOutMean : null, targetsFound: r.score ? r.score.targetsFound : null, nTargets: r.score ? r.score.nTargets : null, nCuts: r.score ? r.score.nCuts : null, bestS: r.score ? r.score.inSample.bestS : null, qd: r.score ? r.score.inSample.qd : null, nCells: r.score ? r.score.inSample.nCells : null, revealed: r.score ? r.score.inSample.revealed : null, unknown: r.score ? r.score.inSample.unknown : null, globalShort: r.score ? r.score.globalShort : null, structuralShort: r.score && r.score.structural ? r.score.structuralShort : null, sim: { v: 2, targetLadder: simOpt.targetLadder, defaultReplays: simOpt.defaultReplays, minGlobal: simOpt.minGlobal || 0, structural: isFunction(simOpt.structural) } })
        }
    }
    //飽和判定(裁示分流:飽和 ⇒ 不升版、轉生成):空間用盡 —— 全部策略(當前 + 候選)於全部時間切分皆提不出樹外之臂(unknown = 0), 或全部候選之留出分數與當前相差 < 1%
    let scored = rows.filter((r) => r.score)
    let saturated = scored.length > 1 && (scored.every((r) => r.score.timeSplits.length > 0 && r.score.timeSplits.every((t) => t.unknown === 0))
        || scored.every((r) => Math.abs(r.score.heldOutMean - curScore.heldOutMean) <= Math.max(0.01 * Math.abs(curScore.heldOutMean), 1e-9)))
    let decision = null
    if (opt.accept && mt) { decision = { ok: false, why: `維護中不升版(${mt})`, saturated } }
    else if (opt.accept) {
        //探索保底(replay.mjs ⑤;2026-09-27):globalShort > 0 之候選不參與升版比較
        let floorOk = rows.filter((r) => !r.isCurrent && r.score && !(r.score.globalShort > 0) && !(r.score.structuralShort > 0)) //2026-10-02:結構保底(replay.mjs ⑥)
        let best = maxBy(floorOk, (r) => r.score.heldOutMean)
        if (!best) { decision = { ok: false, why: rows.some((r) => !r.isCurrent && r.score) ? `無滿足探索保底(每重放輪全域臂 ≥ ${simOpt.minGlobal})與結構保底(dream.structural)之候選` : '無可評分之候選', saturated } }
        else if (saturated) { decision = { candidate: best.name, current: cur.meta.name, ok: false, saturated: true, why: `飽和:可揭露集用盡或全部候選留出分數與當前相差 < 1%(${best.score.heldOutMean} vs ${curScore.heldOutMean})⇒ 不升版, 轉生成(GENERATION_REQUEST)` } }
        else {
            let margin = get(rsi.cfg, 'dream.margin', 0.05), floor = get(rsi.cfg, 'dream.floor', 0.9)
            //async 載入在鎖外;鎖內只做同步之「確認 current 未變 → 寫檔」, 他 session 剛升版則重讀重比(最多 3 次)
            let tryAccept = async (attempt = 0) => {
                let cur2 = await loadPolicyFile(paths.current, forbidden)
                if (cur2.error) { throw new Error(`current.mjs ${cur2.error}`) }
                let curScore2 = cur2.src === cur.src ? curScore : evaluatePolicy(cur2.fn, nodes, env, evalOpt)
                let d = accept(curScore2, best.score, { margin, floor })
                let out = { candidate: best.name, current: cur2.meta.name, ...d }
                if (!d.ok) { return out }
                let res = withLock(() => {
                    if (fs.readFileSync(paths.current, 'utf8') !== cur2.src) { return { retry: true } }
                    let vs = fs.readdirSync(paths.policies).filter((f) => /^v\d+\.mjs$/.test(f)).map((f) => Number(f.slice(1, -4)))
                    let n = (vs.length ? max(vs) : 0) + 1
                    let fpV = path.join(paths.policies, `v${n}.mjs`)
                    for (let x of [fpV, paths.current, paths.changelog, paths.devRequest]) { assertWriteRoot(x, { what: 'dream --accept(升版)' }) } //寫域守門(2026-10-09;先判全部再寫 ⇒ 不留半套;未設 ⇒ 不檢)
                    fs.copyFileSync(best.fp, fpV)
                    //原子寫(2026-09-26:他 session 同時 import current.mjs 不致讀到半檔)
                    writeFileAtomic(paths.current, `//當前探索策略(只由 dream --accept 依單調接受規則改寫;人可回退)\nexport { default, meta } from './v${n}.mjs'\n`)
                    fs.appendFileSync(paths.changelog, `- ${stamp} v${n} ← ${best.name}:${d.why}(樹 ${nodes.length} 節點)\n`)
                    try { fs.rmSync(paths.devRequest, { force: true }) } catch (e) {}
                    return { version: n }
                }, { dir: paths.policies, name: 'policies' })
                if (res.retry) { return attempt < 3 ? tryAccept(attempt + 1) : { ...out, ok: false, why: 'current.mjs 於接受期間被他 session 改寫, 重試 3 次仍變動' } }
                return { ...out, version: res.version }
            }
            decision = await tryAccept()
        }
    }
    return { nodes: nodes.length, rows, decision, saturated, scoresSkipped }
}

export default makeDream
