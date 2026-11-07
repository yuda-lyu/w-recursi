import cloneDeep from 'lodash-es/cloneDeep.js'
import find from 'lodash-es/find.js'
import get from 'lodash-es/get.js'
import isEqual from 'lodash-es/isEqual.js'
import isFunction from 'lodash-es/isFunction.js'
import isNumber from 'lodash-es/isNumber.js'
import isPlainObject from 'lodash-es/isPlainObject.js'
import keys from 'lodash-es/keys.js'
import orderBy from 'lodash-es/orderBy.js'
import round from 'lodash-es/round.js'
import set from 'lodash-es/set.js'
import uniq from 'lodash-es/uniq.js'
import unset from 'lodash-es/unset.js'
import { specHash } from '../core/canonical.mjs'


//轉折點提取(turning points):由樹自己推導新臂, 不靠人定軸或參數種類
//  把「已走過之路徑上, 分數發生轉折之處」轉成三類新規格(全部在 JSON 規格層操作, 領域只提供 validateSpec 與算子登錄):
//    ① 搬移 transfer   :某算子(含參數)施於父 P 使 S 提升 ≥ minGain ⇒ 對其他高分父 P′ 施同一算子同一參數
//                        領域可給相容鉤子 transferBlock({ op, params, from:P, child, to:P′, spec, byId }) → 擋下理由(字串)| null;擋下者不提案、列於回傳之 blocked
//                        (byId = 本次提取之已執行節點 Map(id → 節點 / 視圖);2026-09-25:供領域查目標父之譜系, 如「同一改動已施於目標父之父而大跌」)
//                        (2026-09-25:增益依賴來源父之其他軸 ⇒ 搬到該軸不同之父為交互作用失配;執行層上限於目標父不綁定 ⇒ 子與父同行為)
//    ② 外推 extrapolate:父 → 子之規格差為單一數值路徑之改變且子更好 ⇒ 沿同方向再走一步(格點外;不合法者由 validateSpec 擋;語言域 / 綁定等領域判定由 opt.proposalBlock 擋, 2026-10-04)
//    ③ 交叉 crossover  :兩個高分節點相對最近共同祖先之規格差落在不同路徑 ⇒ 合併兩組差異
//  產物為前緣 arm 條目({ kind:'arm', spec, specHash, origin:{ topic:'turning', operator, from }, priority, reason }), 由策略之新區域額度取用
//  負向轉折(施用後大幅變差)另回 avoid:[{ op, params, parentId }] 供策略 / 報告參考(本版只回報, 不強制)

//規格之葉層差異(路徑以 a.b.0.c 表示;陣列視為整體)
/**
 * 規格之葉層差異(路徑以 a.b.0.c 表示;陣列視為整體)
 *
 * @param {*} a 輸入規格甲
 * @param {*} b 輸入規格乙
 * @returns {Array} 回傳 [{ path, from, to }]
 * @example
 * console.log(JSON.stringify(specDiff({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 }, d: 1 })))
 * // => [{"path":"a.c","from":2,"to":3},{"path":"d","to":1}]
 */
export let specDiff = (a, b) => {
    let out = []
    let walk = (x, y, p) => {
        if (isPlainObject(x) && isPlainObject(y)) {
            for (let k of uniq([...keys(x), ...keys(y)])) { walk(x[k], y[k], p ? `${p}.${k}` : k) }
            return
        }
        if (!isEqual(x, y)) { out.push({ path: p, from: x, to: y }) }
    }
    walk(a, b, '')
    return out
}
/**
 * 把差異施於規格(深拷貝後;to 為 undefined 者刪除該路徑)
 *
 * @param {*} spec 輸入規格
 * @param {Array} diffs 輸入 specDiff 之回傳
 * @returns {*} 回傳新規格
 * @example
 * console.log(JSON.stringify(applyDiff({ a: { b: 1 } }, [{ path: 'a.b', to: 2 }, { path: 'c', to: 5 }])))
 * // => {"a":{"b":2},"c":5}
 */
export let applyDiff = (spec, diffs) => {
    let s = cloneDeep(spec)
    for (let d of diffs) { if (d.to === undefined) { unset(s, d.path) } else { set(s, d.path, cloneDeep(d.to)) } }
    return s
}
let chainOf = (n, byId) => { let out = []; let cur = n; let guard = 0; while (cur && guard++ < 64) { out.push(cur.id); cur = cur.parent && cur.parent !== 'root' ? byId.get(cur.parent) : null } return out }
let commonAncestor = (a, b, byId) => { let ca = chainOf(a, byId); let cb = new Set(chainOf(b, byId)); for (let id of ca) { if (id !== a.id && id !== b.id && cb.has(id)) { return byId.get(id) } } return null }

//nodes:策略視圖(遮蔽後;需 id / parent / status / spec / specHash / score.S / score.ladder / origin.operator / aliasOf)
//  2026-09-27:不再以 score.flags.vetoed 篩父 —— 留出段只作否決, 不擇優(領域之遮蔽已給訓練期之搜尋版 S / 階梯, 視圖無 flags)
//opt:{ registry(childrenOf), validateSpec, occupied:Set(specHash), minGain 0.05, topParents 6, maxProposals 10, excludeParent(n) → bool, transferBlock(ctx) → 理由 | null, parentOk(n) → bool }
//  parentOk(可省;2026-09-27):領域之父條件(如只取某類節點;其餘不作搬移之目標父 / 交叉之親代)
//  normSpec(可省;2026-09-30):領域之規格正規形 —— 提案(搬移 / 外推 / 交叉)先正規化再判占用 / 去重 / validateSpec(例:某哨兵值 ≥ 9999 一律歸一,
//    外推 12 → 9999 ⇒ 19986 正規化為 9999 = 子 ⇒ 已占用而不提);未給時逐字不變
//  proposalBlock(可省;2026-10-04 收編使用端回報):三種提案(搬移 / 外推 / 交叉)共用之產生端守門 proposalBlock(spec, ctx) → 理由 | null
//    於 push 內 normSpec → 已占用 / 本次已提 → validateSpec 之後呼叫(已占用 / 已提 / 不合法者不問鉤子);外推 / 交叉原只經 normSpec ∧ validateSpec(某次實測:外推 9999 → 40 ⇒ −9919 入樹為祖父之別名)
//    ctx = { op: 'T.transfer' | 'T.extrapolate' | 'T.crossover'(= origin.operator), origin(提案之 origin), byId(本次提取之已執行節點 Map),
//            parent(提案之「父」:搬移 = 目標父 q、外推 = 邊之子 c;交叉無), parents(origin.from 之節點, 同序), kidOp(搬移 / 外推 = 邊之算子;交叉無) }
//    擋下 ⇒ 不提案、入回傳之 blocked(列 { op: 轉折算子, params, from: origin.from, specHash, why, by: 'proposalBlock' };與 transferBlock 之列同欄, 以 by 區分)且回傳另帶 nProposalBlocked;
//    **不入 seen**(他路徑之同規格仍再判一次:ctx 不同, 如外推之父 = 各邊之子);未給 ⇒ 不呼叫, 提案與回傳與舊版逐字相同(無 nProposalBlocked);鉤子拋錯即拋出(同 transferBlock)
/**
 * 轉折點提取:由樹自己推導新臂,不靠人定軸。把「已走過之路徑上,分數發生轉折之處」轉成三類新規格:① 搬移(某算子施於父使 S 提升 ≥ minGain ⇒ 對其他高分父施同一算子同一參數)、② 外推(父 → 子為單一數值路徑之改變且子更好 ⇒ 同方向再走一步)、③ 交叉(兩高分節點相對最近共同祖先之差異落在不同路徑 ⇒ 合併)。產物為前緣 arm 條目;負向轉折另回 avoid
 *
 * @param {Array} nodes 輸入策略視圖(需 id、parent、round〔缺或 0 之子節點不產生轉折邊〕、status、spec、score.S、score.ladder、origin.operator、aliasOf)
 * @param {Object} [opt={}] 輸入選項 { registry, validateSpec, occupied:Set(specHash), minGain:Number(0.05), topParents:Number(6), maxProposals:Number(10), excludeParent, isAnchor, transferBlock, parentOk, normSpec, proposalBlock }
 * @returns {Object} 回傳 { proposals, avoid, blocked, nBlocked, nProposalBlocked?(僅給 proposalBlock 時有), nEdges, nProductive }
 * @example
 * let mk = (id, parent, round, S, x, op) => ({ id, parent, round, status: 'executed', spec: { kind: 'k', x }, score: { S, ladder: 1 }, origin: { operator: op } })
 * let nodes = [mk('p', 'root', 1, 10, 1, null), mk('c', 'p', 2, 12, 2, 'inc')]
 * let t = extractTurning(nodes)
 * console.log(t.nEdges, t.nProductive, t.proposals.length, t.proposals[0].origin.operator, JSON.stringify(t.proposals[0].spec))
 * // => 1 1 1 T.extrapolate {"kind":"k","x":3}
 */
export let extractTurning = (nodes, opt = {}) => {
    let O = { minGain: 0.05, topParents: 6, maxProposals: 10, ...opt }
    let ok = (spec) => { if (!isFunction(O.validateSpec)) { return true } try { O.validateSpec(spec); return true } catch (e) { return false } }
    let exec = nodes.filter((n) => n && n.status === 'executed' && n.score && isNumber(n.score.S))
    let byId = new Map(exec.map((n) => [n.id, n]))
    let hashOf = (n) => n.specHash || specHash(n.spec)
    let occupied = new Set([...(O.occupied || []), ...exec.map(hashOf)])
    let excl = isFunction(O.excludeParent) ? O.excludeParent : () => false
    let pOk = isFunction(O.parentOk) ? O.parentOk : () => true
    let good = (n) => !n.aliasOf && !excl(n) && pOk(n)
    let proposals = [], avoid = [], blocked = []
    let seen = new Set()
    let transferBlock = isFunction(O.transferBlock) ? O.transferBlock : () => null
    let norm = isFunction(O.normSpec) ? O.normSpec : null
    let pBlock = isFunction(O.proposalBlock) ? O.proposalBlock : null
    let push = (spec0, origin, priority, reason, expect, pctx = null) => {
        let spec = norm ? norm(spec0) : spec0
        let h = specHash(spec)
        if (occupied.has(h) || seen.has(h) || !ok(spec)) { return false }
        //產生端守門(opt.proposalBlock;2026-10-04):擋下者入 blocked(by proposalBlock)、不入 seen
        if (pBlock) {
            let why = pBlock(spec, { op: origin.operator, origin, byId, ...(pctx || {}) })
            if (why) { if (!blocked.some((b) => b.specHash === h)) { blocked.push({ op: origin.operator, params: origin.params || null, from: origin.from || null, specHash: h, why: String(why), by: 'proposalBlock' }) } return false }
        }
        seen.add(h)
        proposals.push({ kind: 'arm', spec, specHash: h, topic: 'turning', title: origin.operator, priority, reason, origin: { topic: 'turning', ...origin }, expect: round(expect, 3) })
        return true
    }
    //—— 轉折邊:父 → 子(子有 origin.operator;回填 / 錨點之邊不算轉折)——
    let isAnchor = isFunction(O.isAnchor) ? O.isAnchor : () => false
    let edges = []
    for (let c of exec) {
        if (!c.parent || c.parent === 'root') { continue }
        let p = byId.get(c.parent)
        if (!p || isAnchor(p) || isAnchor(c) || get(c, 'origin.topic') === 'backfill' || (c.round || 0) === 0) { continue }
        let gain = (c.score.S - p.score.S) / Math.max(1, Math.abs(p.score.S))
        edges.push({ p, c, op: get(c, 'origin.operator', null), gain })
    }
    let productive = edges.filter((e) => e.op && e.gain >= O.minGain && good(e.c) && (get(e.c, 'score.ladder', 0) || 0) >= 1)
    for (let e of edges.filter((e) => e.op && e.gain <= -Math.max(0.5, O.minGain * 10))) { if (!avoid.some((a) => a.op === e.op && a.parentId === e.p.id)) { avoid.push({ op: e.op, parentId: e.p.id, childId: e.c.id, gain: round(e.gain, 3) }) } }
    let parents = orderBy(exec.filter(good), [(n) => get(n, 'score.ladder', 0) || 0, (n) => n.score.S], ['desc', 'desc']).slice(0, O.topParents)
    //① 搬移:取回該邊之算子參數(以 registry 對父重展開, 比對 specHash), 施於其他高分父
    if (O.registry) {
        for (let e of orderBy(productive, ['gain'], ['desc'])) {
            let kid = find(O.registry.childrenOf(e.p.spec, { ops: [e.op] }), (k) => k.specHash === hashOf(e.c))
            if (!kid) { continue }
            for (let q of parents) {
                if (q.id === e.p.id || q.id === e.c.id) { continue }
                let same = find(O.registry.childrenOf(q.spec, { ops: [e.op] }), (k) => isEqual(k.params || null, kid.params || null))
                if (!same) { continue }
                let hs = specHash(same.spec)
                if (!occupied.has(hs) && !seen.has(hs)) {
                    let why = transferBlock({ op: e.op, params: kid.params || null, from: e.p, child: e.c, to: q, spec: same.spec, byId })
                    if (why) { if (!blocked.some((b) => b.specHash === hs)) { blocked.push({ op: e.op, params: kid.params || null, from: [e.p.id, e.c.id, q.id], specHash: hs, why: String(why) }) } continue }
                }
                push(same.spec, { operator: 'T.transfer', op: e.op, params: kid.params || null, from: [e.p.id, e.c.id, q.id] }, 1, `搬移:${e.op}${kid.params ? ' ' + JSON.stringify(kid.params) : ''} 於 ${e.p.id.slice(0, 6)} 使 S +${round(e.gain * 100)}% ⇒ 施於 ${q.id.slice(0, 6)}(S ${q.score.S})`, q.score.S * (1 + e.gain), { kidOp: e.op, parent: q, parents: [e.p, e.c, q] })
            }
        }
    }
    //② 外推:單一數值路徑之改變且子更好 ⇒ 同方向再走一步
    for (let e of orderBy(productive, ['gain'], ['desc'])) {
        let d = specDiff(e.p.spec, e.c.spec)
        if (d.length !== 1 || !isNumber(d[0].from) || !isNumber(d[0].to)) { continue }
        let step = d[0].to - d[0].from
        if (!step) { continue }
        let next = set(cloneDeep(e.c.spec), d[0].path, d[0].to + step)
        push(next, { operator: 'T.extrapolate', path: d[0].path, step, from: [e.p.id, e.c.id] }, 2, `外推:${d[0].path} ${d[0].from} → ${d[0].to}(S +${round(e.gain * 100)}%)⇒ ${d[0].to + step}`, e.c.score.S * (1 + e.gain), { kidOp: e.op, parent: e.c, parents: [e.p, e.c] })
    }
    //③ 交叉:同 kind 之高分節點兩兩, 相對最近共同祖先之差異落在不同路徑 ⇒ 合併
    for (let i = 0; i < parents.length; i++) {
        for (let j = i + 1; j < parents.length; j++) {
            let a = parents[i], b = parents[j]
            if (get(a, 'spec.kind') !== get(b, 'spec.kind')) { continue }
            let anc = commonAncestor(a, b, byId)
            if (!anc) { continue }
            let da = specDiff(anc.spec, a.spec), db = specDiff(anc.spec, b.spec)
            if (!da.length || !db.length) { continue }
            let pa = new Set(da.map((x) => x.path)), overlap = db.some((x) => pa.has(x.path) || [...pa].some((y) => x.path.startsWith(y + '.') || y.startsWith(x.path + '.')))
            if (overlap) { continue }
            push(applyDiff(anc.spec, [...da, ...db]), { operator: 'T.crossover', from: [anc.id, a.id, b.id] }, 3, `交叉:${a.id.slice(0, 6)}(${da.map((x) => x.path).join(',')})× ${b.id.slice(0, 6)}(${db.map((x) => x.path).join(',')})自祖先 ${anc.id.slice(0, 6)}`, (a.score.S + b.score.S) / 2, { parents: [anc, a, b] })
        }
    }
    let out = orderBy(proposals, ['priority', (x) => -x.expect], ['asc', 'asc']).slice(0, O.maxProposals)
    return { proposals: out, avoid: orderBy(avoid, ['gain'], ['asc']).slice(0, 10), blocked: blocked.slice(0, 10), nBlocked: blocked.length, ...(pBlock ? { nProposalBlocked: blocked.filter((b) => b.by === 'proposalBlock').length } : {}), nEdges: edges.length, nProductive: productive.length }
}

export default { specDiff, applyDiff, extractTurning }
