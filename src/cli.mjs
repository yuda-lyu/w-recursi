import path from 'path'
import { pathToFileURL } from 'url'
import isArray from 'lodash-es/isArray.js'
import isFunction from 'lodash-es/isFunction.js'
import isUndefined from 'lodash-es/isUndefined.js'
import keys from 'lodash-es/keys.js'
import mapValues from 'lodash-es/mapValues.js'
import omitBy from 'lodash-es/omitBy.js'
import round from 'lodash-es/round.js'
import size from 'lodash-es/size.js'
import { parseCli } from './core/cli.mjs'
import { writeFileAtomic } from './core/jsonl.mjs' //--mode arms --out 之整檔寫入(原子寫)


//通用 CLI:node w-recursi/src/cli.mjs --config <cfg.mjs> --mode <mode> [...]
//  cfg.mjs 之 default 匯出 = createRsi 之設定物件 { root, domain, budget, claims, dream, policyDev, slots, runner, maintenance }
//  mode:status | explore [--arms --novelty --workers --dry --by --use-arms --reopen] | dream [--accept --rounds] | auto [--arms --novelty --workers --dry --by --accept --no-dream --use-arms --reopen]
//        | turning [--push] | reclaim [--stale-ms] | rescore | evidence --node <id> [--set k=v,…(cfg.evidenceKeys 有宣告時只收所列之鍵)| --mech|--usability|--btcOK true|false(別名)] --ref <..> [--note <..>] | invalidate --ids a,b --why <..> | init
//        | arms [--out <檔>](2026-11-07 臂目錄:印可用臂選單含樹上覆蓋, 唯讀;--out 另寫檔)
//  --use-arms <id,…>(2026-11-07;cfg.arms.catalog 之臂 id):本輪只用所選臂之算子 / 載體;狀態 done 之臂須 --reopen <理由>;blocked / 不可選 / 衝突 / 依賴缺 ⇒ exit 2 且不開輪
//  2026-09-26(審查):參數經 core/cli.mjs —— --config 與 --mode 必填、未知 / 位置參數 / 值錯 / 旗標不適用於該模式 ⇒ exit 2 且不載入設定;布林只收 true / false
//  用途界線(2026-09-29):領域另有自己之 CLI 時(如領域之 run.mjs:auto 後另重產清單 / 總表、可設旗標、worker 上限較嚴), **輪次一律經領域 CLI**;
//    本 CLI 供玩具領域 / 測試與 init / status / rescore / evidence / invalidate / reclaim / turning 之通用維運(同名模式之語義以領域 CLI 為準)
let modes = { init: [], status: [], rescore: [], explore: ['arms', 'novelty', 'workers', 'dry', 'by', 'use-arms', 'reopen'], dream: ['accept', 'rounds'], auto: ['arms', 'novelty', 'workers', 'dry', 'by', 'accept', 'no-dream', 'use-arms', 'reopen'], turning: ['push'], reclaim: ['stale-ms'], evidence: ['node', 'ref', 'note', 'set', 'mech', 'usability', 'btcOK'], invalidate: ['ids', 'why'], arms: ['out'] }
let { values: V, mode: MODE } = parseCli(process.argv.slice(2), {
    name: 'w-recursi/src/cli.mjs', usage: '用法:node w-recursi/src/cli.mjs --config <cfg.mjs> --mode <模式> [選項](領域另有 CLI 者, 輪次請用領域 CLI, 如 node rsi/run.mjs)',
    options: {
        config: { type: 'str', desc: '設定檔(必填)' },
        arms: { type: 'int', min: 1, max: 64 }, novelty: { type: 'int', min: 0, max: 64 }, workers: { type: 'int', min: 1, max: 64 }, dry: { type: 'flag' }, by: { type: 'str' },
        accept: { type: 'flag' }, 'no-dream': { type: 'flag' }, rounds: { type: 'int', min: 1, max: 100 }, push: { type: 'flag' }, 'stale-ms': { type: 'int', min: 0 },
        node: { type: 'str' }, ref: { type: 'str' }, note: { type: 'str' },
        set: { type: 'list', desc: '證據鍵值 k=v(逗號分隔多組;值 true / false / 數值 / 字串;cfg.evidenceKeys 有宣告時只收所列之鍵;2026-10-01)' },
        mech: { type: 'bool', desc: '(別名)= --set mech=…' }, usability: { type: 'bool', desc: '(別名)= --set usability=…' }, btcOK: { type: 'bool', desc: '(別名)= --set btcOK=…' },
        ids: { type: 'list' }, why: { type: 'str' },
        'use-arms': { type: 'list', desc: '只用所選臂(cfg.arms.catalog 之 id;done 之臂須 --reopen;blocked / 不可選者拒)' }, reopen: { type: 'str', desc: '選 done 之臂之重啟理由' },
        out: { type: 'str', desc: '--mode arms:另寫選單至此檔' },
    },
    mode: { key: 'mode', modes: mapValues(modes, (ks) => ['config', ...ks]) },
})
let die = (msg) => { console.error(`${msg}(未執行任何動作)`); process.exit(2) }
if (!V.config) { die('須 --config <cfg.mjs>') }
if (MODE === 'evidence' && (!V.node || !V.ref)) { die('evidence 須 --node <id> --ref <..>') }
if (MODE === 'invalidate' && (!V.ids || !V.why)) { die('invalidate 須 --ids a,b --why <..>') }
const { createRsi } = await import('./index.mjs')
let cfg = (await import(pathToFileURL(path.resolve(V.config)).href)).default
//寫入類模式之前置守門(可選;設定物件之 beforeWrite(what), 如領域之維護旗標 —— 2026-09-26:原經本 CLI 可繞過領域之停工機制);乾跑 / 唯讀不經此
//  做夢(無 --accept)不經此守門, 但於維護中(cfg.maintenance)不寫 scores.jsonl(2026-09-29)
const WRITES = { init: true, rescore: true, explore: !V.dry, dream: !!V.accept, auto: !V.dry, turning: !!V.push, reclaim: true, evidence: true, invalidate: true, arms: false }
if (WRITES[MODE] && isFunction(cfg.beforeWrite)) { cfg.beforeWrite(`w-recursi cli --mode ${MODE}`) }
let rsi = createRsi(cfg).init()
let bud = { arms: V.arms ?? rsi.budget.arms, novelty: V.novelty ?? rsi.budget.novelty, workers: V.workers ?? rsi.budget.workers, dry: V.dry, by: V.by || `pid${process.pid}`, ...(V['use-arms'] ? { useArms: V['use-arms'], reopen: V.reopen || null } : {}) }
//選臂被拒(explore 於取輪號前拋 RSI_ARMS_REJECTED)⇒ exit 2(未執行任何動作);其餘錯誤照拋
let armsGuard = async (fn) => { try { return await fn() } catch (e) { if (e && e.code === 'RSI_ARMS_REJECTED') { die(e.message) } throw e } }
let printPlan = (ex) => {
    console.log(`第 ${ex.round} 輪${ex.dry ? '(乾跑)' : ''}:計畫 ${ex.items.length} 臂(拒 ${ex.rejected.length};他 session 已認領 ${ex.skipped.length})${size(ex.useArms) ? `;臂限制 ${ex.useArms.join(', ')}` : ''}`)
    for (let it of ex.items) { console.log(`  ${it.id} [${it.op || 'novelty'}] ${rsi.domain.summarize(it.spec)}  ← ${it.reason || ''}`) }
}
let printDream = (d) => {
    console.log(`樹 ${d.nodes} 節點`)
    for (let row of d.rows) {
        if (row.error) { console.log(`  ${row.name.padEnd(28)} ✗ ${row.error}`); continue }
        let s = row.score
        console.log(`  ${row.name.padEnd(28)} 全樣本 J ${String(s.inSample.J).padStart(9)} 留出均 ${String(s.heldOutMean).padStart(9)}(切分 ${s.nCuts})  bestS ${s.inSample.bestS}  揭露 ${s.inSample.revealed}  未知 ${s.inSample.unknown}  回溯 ${s.targetsFound}/${s.nTargets}`)
    }
    if (d.scoresSkipped) { console.log(`分數未寫入 scores.jsonl(${d.scoresSkipped})`) }
    if (d.decision) { console.log(`接受判定:${JSON.stringify(d.decision)}`) }
}
if (MODE === 'init') { console.log(`已初始化 ${rsi.paths.root}`) }
else if (MODE === 'status') { await rsi.status() }
else if (MODE === 'arms') {
    //臂目錄之選單(唯讀;覆蓋依全部節點(正式分數;store.loadNodes)之 origin.arms ∪ origin.operator)
    let md = rsi.arms.size ? rsi.arms.menu({ coverage: rsi.arms.coverage(rsi.store.loadNodes()) }) : '(cfg.arms.catalog 未給 ⇒ 無臂目錄)'
    console.log(md)
    if (V.out) { writeFileAtomic(path.resolve(V.out), md); console.log(`已寫 ${path.resolve(V.out)}`) }
}
else if (MODE === 'explore') {
    let ex = await armsGuard(() => rsi.explore(bud))
    printPlan(ex)
    if (!ex.dry) { console.log(`第 ${ex.round} 輪完成:執行 ${ex.summary.nExecuted} 錯 ${ex.summary.nError};階梯≥1 ${ex.summary.ladderGe1};最佳 S ${ex.summary.bestS ? ex.summary.bestS.S : '-'};牆鐘 ${(ex.summary.wallSec / 60).toFixed(1)} 分`) }
}
else if (MODE === 'dream') { printDream(await rsi.dream({ accept: V.accept, rounds: V.rounds ?? rsi.budget.rounds })) }
else if (MODE === 'auto') {
    let r = await armsGuard(() => rsi.auto({ ...bud, accept: V.accept, noDream: V['no-dream'] }))
    printPlan(r)
    if (!r.dry) {
        console.log(`第 ${r.round} 輪完成:執行 ${r.summary.nExecuted} 錯 ${r.summary.nError};階梯≥1 ${r.summary.ladderGe1};最佳 S ${r.summary.bestS ? r.summary.bestS.S : '-'}`)
        if (r.dream) { printDream(r.dream) }
        else if (r.dreamSkip) { console.log(`做夢略過:${r.dreamSkip.why}${r.dreamSkip.last ? `(上次 ${r.dreamSkip.last}, 距今 ${r.dreamSkip.gapMin} 分 < ${r.dreamSkip.minIntervalMin} 分)` : ''}`) }
        if (r.hook && r.hook.lines) { console.log(r.hook.lines.join('\n')) }
        if (r.policyDev) { console.log(`策略開發請求 → ${r.policyDev}`) }
        await rsi.status()
        //鉤子失敗 ⇒ 非 0 結束(審查)
        if (r.hook && r.hook.failed) { console.error(`領域鉤子失敗:${(r.hook.errors || []).join(';')}`); process.exitCode = 1 }
    }
}
else if (MODE === 'turning') {
    let t = rsi.turning({ push: V.push })
    console.log(`轉折點提取:邊 ${t.nEdges}、有效轉折 ${t.nProductive}、提案 ${t.proposals.length}${V.push ? '(已寫前緣)' : '(唯讀;--push 寫前緣)'}`)
    for (let p of t.proposals) { console.log(`  [${p.origin.operator}] ${rsi.domain.summarize(p.spec)}  ← ${p.reason}`) }
    for (let a of t.avoid) { console.log(`  避免 ${a.op}@${a.parentId.slice(0, 6)}(${round(a.gain * 100)}%)`) }
}
else if (MODE === 'reclaim') { let ids = rsi.store.reclaimStale({ staleMs: V['stale-ms'] }); console.log(`回收遺留認領 ${ids.length}:${ids.join(' ')}`) }
else if (MODE === 'rescore') { console.log(`重算 ${rsi.rescoreAll()} 節點`) }
else if (MODE === 'evidence') {
    //證據鍵由領域宣告(2026-10-01:原只收寫死之 mech / usability / btcOK —— 領域之鍵寫進引擎):--set k=v 為通用形, 三旗標保留為別名
    let set = omitBy({ mech: V.mech, usability: V.usability, btcOK: V.btcOK }, isUndefined)
    for (let kv of V.set || []) {
        let m = String(kv).match(/^([A-Za-z_][\w]*)=(.*)$/)
        if (!m) { die(`--set 須為 k=v(收到 ${kv})`) }
        if (m[1] in set) { die(`證據鍵 ${m[1]} 重複給定(--set 與別名旗標擇一)`) }
        let raw = m[2]
        set[m[1]] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw
    }
    let declared = isArray(cfg.evidenceKeys) ? cfg.evidenceKeys : null
    if (declared) { let bad = keys(set).filter((k) => !declared.includes(k)); if (bad.length) { die(`證據鍵 ${bad.join(', ')} 未於 cfg.evidenceKeys 宣告(已宣告:${declared.join(', ') || '無'})`) } }
    let n = rsi.setEvidence(V.node, set, { ref: V.ref, note: V.note ?? null })
    console.log(`${V.node} evidence ${JSON.stringify(set)} → 階梯 ${n.score ? n.score.ladder : '-'} S ${n.score ? n.score.S : '-'}`)
}
else if (MODE === 'invalidate') { console.log(`標無效 ${rsi.invalidate(V.ids, V.why).length} 節點`) }
