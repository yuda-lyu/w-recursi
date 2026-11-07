import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import castArray from 'lodash-es/castArray.js'
import compact from 'lodash-es/compact.js'
import difference from 'lodash-es/difference.js'
import find from 'lodash-es/find.js'
import findIndex from 'lodash-es/findIndex.js'
import get from 'lodash-es/get.js'
import includes from 'lodash-es/includes.js'
import isPlainObject from 'lodash-es/isPlainObject.js'
import keyBy from 'lodash-es/keyBy.js'
import keys from 'lodash-es/keys.js'
import size from 'lodash-es/size.js'
import uniq from 'lodash-es/uniq.js'
import { withLock } from '../core/lock.mjs'
import { readJsonl, writeJsonl, appendJsonl, writeFileAtomic } from '../core/jsonl.mjs'
import { specHash, nowIso } from '../core/canonical.mjs'
import { pidAlive } from '../core/proc.mjs'


//發現樹之儲存(多 session 併行安全:所有「讀 → 改 → 整檔重寫」皆在跨程序鎖內)
//  nodes/{id}.json.gz  完整節點(spec / origin / raw 原料 / score / cost / status / claim / notes)
//  index.jsonl         每節點一行摘要
//  frontier.jsonl      提出但未執行之候選;lore.jsonl 方向性經驗(只追加)
//  節點狀態:planned(已認領, 待評估)→ executed | error;另 rejectedByGate(規格不過閘)、invalid(事後判無效)、stale(認領者死亡 / 逾時, 可重提)
/**
 * 節點狀態:planned(已認領,待評估)→ running(評估中;與 planned 同屬已占用)→ executed | error;另 rejectedByGate(規格不過閘)、invalid(事後判無效)、stale(認領者死亡或逾時,可重提)
 *
 * @type {Object}
 */
export const STATUS = { PLANNED: 'planned', RUNNING: 'running', EXECUTED: 'executed', ERROR: 'error', REJECTED: 'rejectedByGate', INVALID: 'invalid', STALE: 'stale' }
//已被占用(策略不得再提)之狀態:已執行、規格不過閘、已認領中
/**
 * 已被占用(策略不得再提)之狀態集合:已執行、規格不過閘、已認領中(planned 與 running)
 *
 * @type {Set}
 */
export const OCCUPIED = new Set([STATUS.EXECUTED, STATUS.REJECTED, STATUS.PLANNED, STATUS.RUNNING])
//releaseFrontier 之 opt.patch 可併入之欄(進度 / 停止紀錄 / 結果 / 參照 / 備註;2026-09-27)
/**
 * releaseFrontier 之 opt.patch 可併入之欄:進度、停止紀錄、結果、參照、備註(他鍵拒絕、不寫)
 *
 * @type {Array}
 */
export const FRONTIER_PATCH_KEYS = ['progress', 'stop', 'result', 'refs', 'note']
//前緣條目之狀態(resolveFrontier 所寫;2026-09-29):評估錯誤達重試上限 ⇒ blocked(與 kind 'blocked' 之「裁示封鎖」不同:此為 status)
/**
 * 前緣條目之狀態「評估錯誤達重試上限」(resolveFrontier 所寫;與條目 kind 為 blocked 之「裁示封鎖」不同,此為 status)
 *
 * @type {String}
 */
export const FRONTIER_BLOCKED = 'blocked'

/**
 * 發現樹之儲存(多 session 併行安全:所有「讀 → 改 → 整檔重寫」皆在跨程序鎖內):nodes/{id}.json.gz 完整節點、index.jsonl 每節點一行摘要、frontier.jsonl 提出但未執行之候選、lore.jsonl 方向性經驗(只追加)
 *
 * @param {Object} o 輸入 { paths:Object(makePaths 之回傳,必填), domain:Object(summarize、carrierOf、indexExtra 等鉤子), claims:Object(staleMs) }
 * @returns {Object} 回傳 { paths, fpNode, getNode, hasNode, putNode(node, { skipIfStatus }), updateNode(id, fn), claimNodes(items, { round, by }), setStatus(ids, status, opt), reclaimStale(opt), listIndex, indexRowOf, loadNodes(pred), listFrontier, pushFrontier(items), markFrontier(hashes, status), resolveFrontier(outcomes, opt), claimFrontier(hash, by, opt), releaseFrontier(hash, by, status, opt), listLore, appendLore(row), lock(fn, name) }
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 * import { makePaths } from 'w-recursi/src/core/paths.mjs'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let store = makeStore({ paths: makePaths(dir) })
 * store.putNode({ id: 'n1', spec: { a: 1 }, status: 'executed', score: { S: 1.5, ladder: 1 } })
 * console.log(store.listIndex().length, store.getNode('n1').spec.a, store.hasNode('n2'))
 * // => 1 1 false
 *
 * let r1 = store.claimNodes([{ id: 'n2', spec: { a: 2 } }], { round: 1, by: 'me' })
 * let r2 = store.claimNodes([{ id: 'n2', spec: { a: 2 } }], { round: 1, by: 'you' })
 * console.log(r1.claimed.length, r2.claimed.length, r2.skipped[0].why)
 * // => 1 0 已planned(me)
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let makeStore = ({ paths, domain = {}, claims = {} }) => {
    let staleMs = get(claims, 'staleMs', 2 * 3600000)
    let lock = (fn, name = 'tree') => withLock(fn, { dir: paths.tree, name })
    let fpNode = (id) => path.join(paths.nodes, `${id}.json.gz`)
    let readNode = (id) => { let fp = fpNode(id); if (!fs.existsSync(fp)) { return null } return JSON.parse(zlib.gunzipSync(fs.readFileSync(fp)).toString('utf8')) }
    let writeNodeFile = (node) => writeFileAtomic(fpNode(node.id), zlib.gzipSync(Buffer.from(JSON.stringify(node), 'utf8'))) //原子寫(2026-09-24:鎖外之 getNode 不再讀到截斷檔)
    let summarize = domain.summarize || ((spec) => JSON.stringify(spec).slice(0, 80))
    let carrierOf = domain.carrierOf || (() => null)

    let indexRowOf = (node) => ({
        id: node.id, parent: node.parent || 'root', round: node.round || 0, createdAt: node.createdAt, updatedAt: node.updatedAt, status: node.status,
        kind: get(node, 'spec.kind', null), carrier: carrierOf(node.spec), summary: summarize(node.spec),
        topic: get(node, 'origin.topic', null), operator: get(node, 'origin.operator', null),
        ladder: get(node, 'score.ladder', null), S: get(node, 'score.S', null), vetoed: get(node, 'score.flags.vetoed', null),
        replays: get(node, 'cost.replays', null), wallSec: get(node, 'cost.wallSec', null), evaluator: get(node, 'score.evaluator', null),
        claim: node.claim ? { by: node.claim.by, pid: node.claim.pid, at: node.claim.at } : null,
        ...(domain.indexExtra ? domain.indexExtra(node) : {}),
    })
    let listIndex = () => readJsonl(paths.index)
    let hasNode = (id) => fs.existsSync(fpNode(id))
    let getNode = (id) => readNode(id)
    let upsertRow = (rows, row) => { let i = findIndex(rows, (r) => r.id === row.id); if (i >= 0) { rows[i] = row } else { rows.push(row) } }
    let backlink = (node) => {
        if (!node.parent || node.parent === 'root') { return }
        let p = readNode(node.parent)
        if (p && !includes(p.children || [], node.id)) { p.children = [...(p.children || []), node.id]; writeNodeFile(p) }
    }

    //鎖內寫一個節點(寫檔 → 索引列 → 父之 children 反向連結);呼叫端須已持樹鎖
    let commitLocked = (node) => {
        node.updatedAt = nowIso()
        if (!node.createdAt) { node.createdAt = node.updatedAt }
        writeNodeFile(node)
        let rows = listIndex()
        let row = indexRowOf(node)
        upsertRow(rows, row)
        writeJsonl(paths.index, rows)
        backlink(node)
        return row
    }
    //寫入完整節點(評估後 / 回填 / 建立);同 id 覆寫;父節點 children 反向連結
    //  **children 以磁碟上之現值聯集**(2026-09-26:呼叫端手上若是舊副本, 期間他 session 回連之子節點原會被抹掉;children 只增不減 ⇒ 聯集恆正確)
    //  改「既有節點」之部分欄位請用 updateNode(鎖內重讀最新再改), 免整筆覆寫蓋掉他 session 之寫入
    //  opt.skipIfStatus(2026-09-29;Set 或陣列, 預設無 = 舊行為):鎖內查同 id 之 index 列與節點檔, 其狀態 ∈ 此集合 ⇒ 不寫、回 null
    //    (explore 之閘門拒絕存根以 OCCUPIED 呼叫:存根不得覆寫已執行 / 認領中 / 已拒之節點)
    let putNode = (node, opt = {}) => {
        paths.ensure()
        if (!node.id) { throw new Error('putNode: 缺 id') }
        let skip = opt && opt.skipIfStatus ? new Set(opt.skipIfStatus) : null
        return lock(() => {
            let cur = readNode(node.id)
            if (skip) {
                let row = find(listIndex(), (r) => r.id === node.id)
                if ((row && skip.has(row.status)) || (cur && skip.has(cur.status))) { return null }
            }
            if (cur && size(cur.children)) { node.children = uniq([...(cur.children || []), ...(node.children || [])]) }
            return commitLocked(node)
        })
    }
    //讀改寫(2026-09-26;審查:「鎖外 getNode → 改 → putNode」使期間他 session 之寫入被舊副本整筆覆寫)
    //  fn(最新節點):就地修改或回傳新物件;回傳 false ⇒ 放棄寫入(條件不符之 CAS);節點不存在 ⇒ 回 null 且不呼叫 fn
    //  fn 在樹鎖內同步執行 ⇒ 只做欄位修改, 重計算請於呼叫前完成;回傳寫入後之節點(放棄 / 不存在 ⇒ null)
    let updateNode = (id, fn) => {
        paths.ensure()
        return lock(() => {
            let cur = readNode(id)
            if (!cur) { return null }
            let r = fn(cur)
            if (r === false) { return null }
            let next = (r && typeof r === 'object') ? r : cur
            if (next.id !== id) { throw new Error(`updateNode: fn 不得改 id(${id} → ${next.id})`) }
            commitLocked(next)
            return next
        })
    }

    //認領(多 agent 併行之核心):同一鎖內「檢查是否已被占用 → 寫入 planned 存根」;回 { claimed, skipped }
    //  items: [{ id, spec, parentId, origin, evidence, notes, specHash }]
    let claimNodes = (items, { round = 0, by = `pid${process.pid}` } = {}) => {
        paths.ensure()
        return lock(() => {
            let rows = listIndex()
            let byId = keyBy(rows, 'id')
            let claimed = [], skipped = []
            for (let it of items) {
                let r = byId[it.id]
                if (r && OCCUPIED.has(r.status)) { skipped.push({ ...it, why: `已${r.status}${r.claim ? `(${r.claim.by})` : ''}` }); continue }
                let old = r ? readNode(it.id) : null
                let now = nowIso()
                let stub = {
                    id: it.id, parent: it.parentId || 'root', round, status: STATUS.PLANNED, spec: it.spec, specHash: it.specHash || specHash(it.spec), origin: it.origin || {},
                    claim: { by, pid: process.pid, at: now, round }, raw: null, score: null, cost: null,
                    evidence: it.evidence || get(old, 'evidence', null) || null, notes: it.notes || null, children: get(old, 'children', []) || [],
                    createdAt: get(old, 'createdAt', now) || now, updatedAt: now,
                }
                writeNodeFile(stub)
                let row = indexRowOf(stub)
                upsertRow(rows, row); byId[it.id] = row
                backlink(stub)
                claimed.push(it)
            }
            writeJsonl(paths.index, rows)
            return { claimed, skipped }
        })
    }

    //改狀態(只動 status / notes / claim;用於釋放認領、標無效)
    let setStatus = (ids, status, { notes = null, clearClaim = true } = {}) => lock(() => {
        let rows = listIndex()
        let set = new Set(castArray(ids))
        let done = []
        for (let r of rows) {
            if (!set.has(r.id)) { continue }
            let n = readNode(r.id)
            if (!n) { continue }
            n.status = status; n.updatedAt = nowIso()
            if (notes) { n.notes = { ...(n.notes || {}), ...notes } }
            if (clearClaim) { n.claim = null }
            writeNodeFile(n)
            upsertRow(rows, indexRowOf(n)); done.push(r.id)
        }
        writeJsonl(paths.index, rows)
        return done
    })

    //回收遺留認領:planned / running 且認領者行程已死(或無認領紀錄)⇒ stale(可重提)
    //  2026-09-26(審查):原本「認領逾 staleMs(2 小時)」亦判死 ⇒ 評估逾 2 小時之臂(等槽 + 單臂 3,701 秒已有實例)被他 session 回收重提 ⇒ 重複評估;
    //    改為認領者存活即不回收(pid 被重用而永佔者由狀態列之認領時刻判讀);opt.staleMs 只影響 claim.pid 缺失之舊紀錄
    let reclaimStale = (opt = {}) => lock(() => {
        let ms = get(opt, 'staleMs', staleMs)
        let rows = listIndex()
        let out = []
        for (let r of rows) {
            if (![STATUS.PLANNED, STATUS.RUNNING].includes(r.status)) { continue }
            let at = Date.parse(get(r, 'claim.at', '') || '')
            let pid = get(r, 'claim.pid', null)
            let dead = !r.claim || (pid ? !pidAlive(pid) : (Number.isFinite(at) && Date.now() - at > ms))
            if (!dead) { continue }
            let n = readNode(r.id)
            if (!n) { continue }
            n.status = STATUS.STALE; n.notes = { ...(n.notes || {}), stale: { was: r.status, claim: r.claim, at: nowIso() } }; n.claim = null; n.updatedAt = nowIso()
            writeNodeFile(n); upsertRow(rows, indexRowOf(n)); out.push(r.id)
        }
        if (out.length) { writeJsonl(paths.index, rows) }
        return out
    })

    //前緣(提出但未執行之候選;以 specHash 去重)
    let listFrontier = () => readJsonl(paths.frontier)
    let pushFrontier = (items) => { paths.ensure(); return lock(() => {
        let rows = listFrontier()
        let seen = new Set(rows.map((r) => r.specHash))
        let added = 0
        for (let it of items) {
            if (!it.specHash || seen.has(it.specHash)) { continue }
            rows.push({ ...it, proposedAt: it.proposedAt || nowIso(), status: it.status || 'proposed' })
            seen.add(it.specHash); added++
        }
        writeJsonl(paths.frontier, rows)
        return added
    }, 'frontier') }
    let markFrontier = (specHashes, status) => lock(() => {
        let rows = listFrontier()
        let set = new Set(specHashes)
        for (let r of rows) { if (set.has(r.specHash)) { r.status = status; r.resolvedAt = nowIso() } }
        writeJsonl(paths.frontier, rows)
    }, 'frontier')
    //前緣條目之結案(2026-09-29;explore 於輪末呼叫, 取代原「本輪全部臂一律 markFrontier executed」):
    //  outcomes = [{ specHash, status: 'executed' | 'rejectedByGate' | 'error', why? }](同一 specHash 多筆 ⇒ 以最後一筆為準;只動 specHash 相符之列)
    //    executed       ⇒ status executed、resolvedAt(與原 markFrontier 同;不論原狀態)
    //    rejectedByGate ⇒ status rejectedByGate、resolvedAt、note 附理由(原被標 executed 或維持 proposed)
    //    error          ⇒ 只動 status 為 proposed 之列:retries + 1、note 附錯誤摘要、lastErrorAt;retries ≥ maxRetries ⇒ status blocked(FRONTIER_BLOCKED)、resolvedAt
    //                      (未達上限者維持 proposed ⇒ 策略下一輪可重提;error 節點不在 OCCUPIED)
    //  opt:{ maxRetries = 2, round = null };回 { executed, rejected, retried, blocked }
    let resolveFrontier = (outcomes, { maxRetries = 2, round = null } = {}) => {
        let by = new Map((outcomes || []).filter((o) => o && o.specHash && o.status).map((o) => [o.specHash, o]))
        let res = { executed: 0, rejected: 0, retried: 0, blocked: 0 }
        if (!by.size) { return res }
        paths.ensure()
        return lock(() => {
            let rows = listFrontier()
            let now = nowIso()
            let tag = round !== null && round !== undefined ? `r${String(round).padStart(3, '0')} ` : ''
            let noteOf = (r, s) => { let prev = r.note === undefined || r.note === null ? '' : (typeof r.note === 'string' ? r.note : JSON.stringify(r.note)); return prev ? `${prev};${s}` : s }
            let brief = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 160)
            let changed = false
            for (let r of rows) {
                let o = by.get(r.specHash)
                if (!o) { continue }
                if (o.status === STATUS.EXECUTED) { r.status = STATUS.EXECUTED; r.resolvedAt = now; res.executed++; changed = true }
                else if (o.status === STATUS.REJECTED) { r.status = STATUS.REJECTED; r.resolvedAt = now; r.note = noteOf(r, `${tag}閘門拒絕:${brief(o.why)}`); res.rejected++; changed = true }
                else if (o.status === STATUS.ERROR && r.status === 'proposed') {
                    r.retries = (Number(r.retries) || 0) + 1
                    r.lastErrorAt = now
                    r.note = noteOf(r, `${tag}評估錯誤 #${r.retries}:${brief(o.why)}`)
                    if (r.retries >= maxRetries) { r.status = FRONTIER_BLOCKED; r.resolvedAt = now; res.blocked++ }
                    else { res.retried++ }
                    changed = true
                }
            }
            if (changed) { writeJsonl(paths.frontier, rows) }
            return res
        }, 'frontier')
    }
    //前緣條目之 CAS 認領 / 釋放(2026-09-26;原為領域輪次夾內之腳本, 以非原子整檔覆寫 frontier.jsonl):
    //  claimFrontier:只有 status === expect(預設 proposed)才改為 to(預設 implementing)並記 claimBy / claimAt
    //  releaseFrontier:只有 claimBy === by 才改為 status 並記 resolvedAt;兩者皆回 { ok, why?, row? }
    //    opt.patch(2026-09-27;預設 = 舊行為):釋放時併入進度欄(只收 FRONTIER_PATCH_KEYS;他鍵拒絕、不寫)
    //      —— 原 agent 以 node -e 直接改寫 frontier.jsonl 記進度(鎖外非原子);改由同一把 frontier 鎖內寫
    let claimFrontier = (h, by, { expect = 'proposed', to = 'implementing' } = {}) => { paths.ensure(); return lock(() => {
        let rows = listFrontier()
        let row = rows.find((x) => x.specHash === h)
        if (!row) { return { ok: false, why: `找不到 ${h}` } }
        if (row.status !== expect) { return { ok: false, why: `status ${row.status}(claimBy ${row.claimBy || '-'})` } }
        row.status = to; row.claimBy = by; row.claimAt = nowIso()
        writeJsonl(paths.frontier, rows)
        return { ok: true, row }
    }, 'frontier') }
    let releaseFrontier = (h, by, status, { patch = null } = {}) => { paths.ensure(); return lock(() => {
        if (patch !== null && (!isPlainObject(patch) || difference(keys(patch), FRONTIER_PATCH_KEYS).length)) { return { ok: false, why: `patch 只收 ${FRONTIER_PATCH_KEYS.join(' / ')}(收到 ${isPlainObject(patch) ? keys(patch).join(', ') : typeof patch})` } }
        let rows = listFrontier()
        let row = rows.find((x) => x.specHash === h)
        if (!row) { return { ok: false, why: `找不到 ${h}` } }
        if (row.claimBy !== by) { return { ok: false, why: `非 ${by} 所認領(claimBy ${row.claimBy || '-'})` } }
        row.status = status; row.resolvedAt = nowIso()
        if (patch) { Object.assign(row, patch, { patchedBy: by, patchedAt: row.resolvedAt }) }
        writeJsonl(paths.frontier, rows)
        return { ok: true, row }
    }, 'frontier') }

    //lore(方向性經驗之資料;只追加)
    let listLore = () => readJsonl(paths.lore)
    let appendLore = (row) => { paths.ensure(); return lock(() => { let r = { ...row, addedAt: nowIso() }; appendJsonl(paths.lore, r); return r }, 'lore') }

    let loadNodes = (pred = null) => compact(listIndex().filter((r) => !pred || pred(r)).map((r) => readNode(r.id)))

    return { paths, fpNode, getNode, hasNode, putNode, updateNode, claimNodes, setStatus, reclaimStale, listIndex, indexRowOf, loadNodes, listFrontier, pushFrontier, markFrontier, resolveFrontier, claimFrontier, releaseFrontier, listLore, appendLore, lock }
}

export default makeStore
