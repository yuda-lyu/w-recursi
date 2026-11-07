import countBy from 'lodash-es/countBy.js'
import isFinite from 'lodash-es/isFinite.js'
import orderBy from 'lodash-es/orderBy.js'
import pick from 'lodash-es/pick.js'
import round from 'lodash-es/round.js'
import toPairs from 'lodash-es/toPairs.js'
import { loadSummaries } from './explore.mjs'
import { slotsInUse } from '../core/slots.mjs'


let fmt = (v, d = 2) => (isFinite(v) ? round(v, d) : '-')

//樹 / 前緣 / 策略 / 近況之摘要(唯讀)
/**
 * 樹 / 前緣 / 策略 / 近況之摘要工廠(唯讀;createRsi 以之組 rsi.status)
 *
 * @param {Object} rsi 輸入實例
 * @returns {Function} 回傳 async (opt) => { nNodes, byStatus, ladders, carriers, top, policy, rounds, frontier, lore, claims, slotsInUse, last, arms? };opt: { print:Boolean(預設 true,印摘要), top:Number(最佳節點數,預設 8) }
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
 * let st = await rsi.status({ print: false })
 * console.log(st.nNodes, st.rounds, st.policy.name, st.byStatus.executed)
 * // => 1 1 v0 1
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let makeStatus = (rsi) => async (opt = {}) => {
    let { paths, store } = rsi
    let idx = store.listIndex()
    let byStatus = countBy(idx, 'status')
    let exec = idx.filter((r) => r.status === 'executed')
    let ladders = countBy(exec, (r) => r.ladder ?? 'na')
    let carriers = countBy(exec, (r) => r.carrier || 'na')
    let top = orderBy(exec.filter((r) => isFinite(r.S)), ['ladder', 'S'], ['desc', 'desc']).slice(0, opt.top || 8)
    let pol = await rsi.loadPolicy()
    let sums = loadSummaries(paths)
    let fr = store.listFrontier().filter((f) => f.status === 'proposed')
    let claims = idx.filter((r) => ['planned', 'running'].includes(r.status))
    let out = { nNodes: idx.length, byStatus, ladders, carriers, top, policy: pol.meta, rounds: sums.length, frontier: { proposed: fr.length, kinds: countBy(fr, (f) => f.kind || 'arm') }, lore: store.listLore().length, claims: claims.length, slotsInUse: slotsInUse(paths.slots, { max: rsi.budget.maxGlobalWorkers }), last: sums.slice(-5) }
    //臂目錄之覆蓋(2026-11-07;search/arms.mjs;有目錄才算:依 origin.arms ∪ origin.operator, 讀全部節點之**正式**分數(store.loadNodes;策略視圖之階梯為遮蔽後之搜尋版, 不用))
    if (rsi.arms && rsi.arms.size) {
        let cov = rsi.arms.coverage(store.loadNodes())
        let top8 = orderBy(toPairs(cov.byArm).filter(([, c]) => c.n > 0), [([, c]) => c.n, ([id]) => id], ['desc', 'asc']).slice(0, 8)
        out.arms = { n: rsi.arms.size, selectable: rsi.arms.list({ selectable: true }).length, top: top8.map(([id, c]) => ({ id, ...pick(c, ['n', 'ge1', 'ge4', 'feature']) })) }
    }
    if (opt.print !== false) {
        console.log(`樹:${idx.length} 節點 ${JSON.stringify(byStatus)};階梯 ${JSON.stringify(ladders)};載體 ${JSON.stringify(carriers)};前緣 proposed ${fr.length}(${JSON.stringify(out.frontier.kinds)});認領中 ${claims.length};全域槽位使用 ${out.slotsInUse}/${rsi.budget.maxGlobalWorkers}`)
        console.log(`評估器 ${rsi.domain.evaluatorVersion ?? '-'};策略 ${pol.meta.name} ${pol.meta.version || ''};已完成輪次 ${sums.length};lore ${out.lore} 列`)
        if (out.arms) { console.log(`臂目錄 ${out.arms.n} 臂(可選 ${out.arms.selectable});覆蓋(節點 / 階 ≥ 1 / 階 ≥ 4)前 ${out.arms.top.length}:${out.arms.top.map((a) => `${a.id} ${a.n}/${a.ge1}/${a.ge4}`).join('、')}(選單:--mode arms)`) }
        for (let s of sums.slice(-5)) { console.log(`  r${String(s.round).padStart(3, '0')} ${String(s.at).slice(0, 16)} ${s.by || ''} 計畫 ${s.nPlanned} 跳過 ${s.nSkipped ?? 0} 執行 ${s.nExecuted} 錯 ${s.nError} 拒 ${s.nRejected} 階梯≥1 ${s.ladderGe1} 最佳 S ${fmt(s.bestS && s.bestS.S)} 回放 ${s.replays} 牆鐘 ${fmt(s.wallSec / 60, 1)} 分`) }
        console.log('最佳節點:')
        for (let r of top) { console.log(`  ${r.id} L${r.ladder} S ${fmt(r.S)} veto ${r.vetoed}  ${r.summary}`) }
    }
    return out
}

export default makeStatus
