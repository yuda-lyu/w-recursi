import isFunction from 'lodash-es/isFunction.js'
import isNumber from 'lodash-es/isNumber.js'
import orderBy from 'lodash-es/orderBy.js'
import pick from 'lodash-es/pick.js'
import sortBy from 'lodash-es/sortBy.js'
import toPairs from 'lodash-es/toPairs.js'


//通用預設探索策略(純函式:只讀策略視圖, 不碰評估器 / 樹寫入;領域規則一律經 ctx 注入)
//  介面:policy(view, budget, ctx) → plan
//    view   { round, nodes:[策略視圖(遮蔽後;別名節點已附 aliasOf)], frontier:[{ specHash, spec, origin, reason, status, kind, priority }] }
//    budget { arms, novelty, workers }
//    ctx    { childrenOf(spec, {ops}) → [{ op, family, spec, specHash, reason }], controlsFor(child) → [...], rankOf(op) → number,
//             carriers:{ name: spec }, specHash(spec), executed:Set(specHash;含已認領), excludeParent?(nodeView) → bool }
//    plan   { expand:[{ parentId, op, spec, specHash, reason, controlOf? }], novelty:[{ spec, specHash, reason, origin }], requests, stop:[nodeId], notes:[...] }
//  規則:
//    ① 父節點候選 = executed、非別名、非錨點(ctx.excludeParent 判)、未譜系停止、children < MAX_CHILDREN;優先序 = ladder 高者、S 高者
//    ② 譜系停止:連續兩代 ladder ≤ 1 且 S 未高於父 ⇒ 該譜系停止展開
//    ③ 每父每輪最多 PER_PARENT 子;算子依 ctx.rankOf 排序
//    ④ 對照臂整族計入 armsMain(放不進預算就跳過該子, 對照不可拆)
//    ⑤ 新區域額度 ≥ budget.novelty:先取前緣之 proposed arm, 不足以未入樹之載體補;冷啟動(無可展開父)時全部給新區域
/**
 * 通用預設策略之識別(name、version、desc);init() 於策略夾缺 v0.mjs 時以本檔寫入
 *
 * @type {Object}
 */
export const meta = { name: 'v0', version: '0.2.0', desc: '通用預設策略:譜系停止 / 父節點優先序 / 每父上限 / 算子優先序 / 對照臂整族計入預算 / 新區域額度' }
const PER_PARENT = 3
const MAX_CHILDREN = 8

/**
 * 通用預設探索策略(純函式:只讀策略視圖,不碰評估器與樹寫入;領域規則一律經 ctx 注入):父節點候選 = executed、非別名、非錨點、未譜系停止、子數 < 8,依階梯與 S 排序;每父每輪至多 3 子;對照臂整族計入預算;新區域額度先取前緣之 proposed arm、不足以未入樹之載體補;冷啟動(無可展開父)時全部給新區域
 *
 * @param {Object} view 輸入 { round, nodes:[策略視圖], frontier:[{ specHash, spec, origin, reason, status, kind, priority }] }
 * @param {Object} budget 輸入 { arms, novelty, workers }
 * @param {Object} ctx 輸入 { childrenOf(spec, { ops }), controlsFor(child), rankOf(op), carriers, specHash(spec), executed:Set, excludeParent?(view) }
 * @returns {Object} 回傳 plan { policy, round, expand:[{ parentId, op, spec, specHash, reason, controlOf? }], novelty:[{ spec, specHash, reason, origin }], requests, stop:[nodeId], notes:[字串] }
 * @example
 * let ctx = { childrenOf: () => [], controlsFor: () => [], rankOf: () => 1, carriers: { root: { n: 0 } }, specHash: (s) => JSON.stringify(s), executed: new Set() }
 * let plan = policy({ round: 1, nodes: [], frontier: [] }, { arms: 3, novelty: 1 }, ctx)
 * console.log(plan.expand.length, plan.novelty.length, plan.notes[0])
 * // => 0 1 冷啟動:無可展開之父節點;本輪全部給載體 / 前緣
 */
export default function policy(view, budget, ctx) {
    let nodes = view.nodes || []
    let byId = new Map(nodes.map((n) => [n.id, n]))
    let executed = nodes.filter((n) => n.status === 'executed' && n.score && isNumber(n.score.S))
    let planned = new Set()
    let notes = []
    let stalled = (n) => {
        if (!n || n.parent === 'root') { return false }
        let p = byId.get(n.parent)
        if (!p || !p.score) { return false }
        return (n.score.ladder || 0) <= 1 && n.score.S <= (p.score.S || 0)
    }
    let stopped = new Set()
    for (let n of executed) { if (stalled(n) && stalled(byId.get(n.parent))) { stopped.add(n.id) } }
    let exclude = isFunction(ctx.excludeParent) ? ctx.excludeParent : () => false
    let parents = executed.filter((n) => !n.aliasOf && !exclude(n) && !stopped.has(n.id) && (n.children || []).length < MAX_CHILDREN)
    parents = orderBy(parents, [(n) => n.score.ladder || 0, (n) => n.score.S, 'id'], ['desc', 'desc', 'asc'])
    let coldStart = parents.length === 0
    let armsMain = coldStart ? 0 : Math.max(0, (budget.arms || 8) - (budget.novelty || 0))
    let expand = []
    for (let p of parents) {
        if (expand.length >= armsMain) { break }
        let kids = ctx.childrenOf(p.spec).filter((k) => !ctx.executed.has(k.specHash) && !planned.has(k.specHash))
        kids = sortBy(kids, [(k) => ctx.rankOf(k.op), 'specHash'])
        let taken = 0
        for (let k of kids) {
            if (taken >= PER_PARENT || expand.length >= armsMain) { break }
            let ctrls = (ctx.controlsFor ? ctx.controlsFor(k) : []).filter((c) => !ctx.executed.has(c.specHash) && !planned.has(c.specHash))
            if (expand.length + 1 + ctrls.length > armsMain) { continue } //④ 對照不可拆
            expand.push({ parentId: p.id, op: k.op, spec: k.spec, specHash: k.specHash, reason: k.reason })
            planned.add(k.specHash); taken++
            for (let c of ctrls) { expand.push({ parentId: p.id, op: c.op, spec: c.spec, specHash: c.specHash, reason: c.reason, controlOf: k.specHash }); planned.add(c.specHash) }
        }
    }
    let novelty = []
    let need = coldStart ? (budget.arms || 8) : (budget.novelty || 0)
    let frontier = sortBy((view.frontier || []).filter((f) => f.status === 'proposed'), [(f) => f.priority ?? 5, 'proposedAt'])
    for (let f of frontier.filter((f) => (f.kind || 'arm') === 'arm' && f.spec)) {
        if (novelty.length >= need) { break }
        let h = f.specHash || ctx.specHash(f.spec)
        if (ctx.executed.has(h) || planned.has(h)) { continue }
        novelty.push({ spec: f.spec, specHash: h, reason: `前緣:${f.reason || ''}`, origin: f.origin || null })
        planned.add(h)
    }
    let requests = frontier.filter((f) => ['operator', 'endpoint'].includes(f.kind)).slice(0, 5).map((f) => pick(f, ['kind', 'topic', 'title', 'needs', 'priority', 'reason']))
    for (let [name, spec] of toPairs(ctx.carriers || {})) {
        if (novelty.length >= need) { break }
        let h = ctx.specHash(spec)
        if (ctx.executed.has(h) || planned.has(h)) { continue }
        novelty.push({ spec, specHash: h, reason: `載體 ${name} 未入樹`, origin: { topic: 'carrier', operator: 'root' } })
        planned.add(h)
    }
    if (coldStart) { notes.push('冷啟動:無可展開之父節點;本輪全部給載體 / 前緣') }
    if (stopped.size) { notes.push(`譜系停止 ${stopped.size} 節點`) }
    if (requests.length) { notes.push(`前緣待實作:算子 / 終點請求 ${requests.length}`) }
    return { policy: meta, round: view.round, expand, novelty, requests, stop: [...stopped], notes }
}
