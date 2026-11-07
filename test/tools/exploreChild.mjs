import path from 'path'
import { fileURLToPath } from 'url'
import { createRsi } from '../../src/index.mjs'
import { makeDomain, evaluate, createContext, meta } from './toy.mjs'


//併行測試子程序:在共用 root 上跑 waves 輪探索;每輪印一行 JSON 摘要
//  用法: node exploreChild.mjs <root> <arms> <novelty> <workers> <delayMs> <waves> [spawn:0|1] [maxGlobalWorkers] [logFile]
let [root, arms, novelty, workers, delayMs, waves, spawnMode = '0', maxGlobal = '8', logFile = ''] = process.argv.slice(2)
let evaluator = spawnMode === '1'
    ? { mode: 'spawn', module: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'toy.mjs'), ctxOpt: { delayMs: Number(delayMs), logFile: logFile || null } }
    : { mode: 'inProcess', evaluate, createContext, ctxOpt: { delayMs: Number(delayMs), logFile: logFile || null }, meta }
let rsi = createRsi({ root, domain: makeDomain({ evaluator }), budget: { arms: Number(arms), novelty: Number(novelty), workers: Number(workers), maxGlobalWorkers: Number(maxGlobal) }, slots: { timeoutMs: 120000 } }).init()
for (let w = 0; w < Number(waves); w++) {
    let ex = await rsi.explore({ by: `child${process.pid}` })
    console.log(JSON.stringify({ pid: process.pid, wave: w, round: ex.round, nPlanned: ex.items.length, nSkipped: ex.skipped.length, nExecuted: ex.summary.nExecuted, nError: ex.summary.nError, ids: ex.nodes.map((n) => n.id) }))
}
