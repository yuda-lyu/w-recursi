import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import _ from 'lodash-es'
import { makePaths } from '../src/core/paths.mjs'
import { makeStore, STATUS } from '../src/tree/store.mjs'
import { makeNode } from '../src/tree/node.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp, FD_TEST } from './tools/tmpdir.mjs'


let run = (args) => new Promise((resolve) => { let p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let out = '', err = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d }); p.on('exit', (code) => resolve({ code, out, err })) })
let P = (x, y) => ({ kind: 'point', x, y })

describe('tree/store:節點 / 認領 / 回收 / 前緣 / lore', function () {
    let t, paths, store, domain
    before(() => { t = makeTmp('store'); domain = makeDomain(); paths = makePaths(t.dir); paths.ensure(); store = makeStore({ paths, domain, claims: { staleMs: 1000 } }) })
    after(() => { t.cleanup() })

    it('putNode 同 id 覆寫, index 只有一列;getNode 回完整節點', () => {
        let n = makeNode({ id: 'a1', spec: P(1, 1), status: 'executed' }, domain)
        store.putNode(n)
        store.putNode({ ...n, notes: { k: 1 } })
        assert.equal(store.listIndex().length, 1)
        assert.deepEqual(store.getNode('a1').notes, { k: 1 })
        assert.equal(store.listIndex()[0].summary, 'P(1,1)')
        assert(store.hasNode('a1') && !store.hasNode('nope'))
    })
    it('子節點寫入時反向連結父之 children', () => {
        store.putNode(makeNode({ id: 'b1', spec: P(2, 2), parent: 'a1', status: 'executed' }, domain))
        assert.deepEqual(store.getNode('a1').children, ['b1'])
        store.putNode(makeNode({ id: 'b1', spec: P(2, 2), parent: 'a1', status: 'executed' }, domain))
        assert.deepEqual(store.getNode('a1').children, ['b1'], '不重複連結')
    })
    it('claimNodes:首次認領成功;重複認領與已執行者跳過(鎖內原子)', () => {
        let items = [{ id: 'c1', spec: P(3, 3) }, { id: 'c2', spec: P(4, 4), parentId: 'a1' }, { id: 'a1', spec: P(1, 1) }]
        let r = store.claimNodes(items, { round: 7, by: 'me' })
        assert.deepEqual(r.claimed.map((x) => x.id), ['c1', 'c2'])
        assert.equal(r.skipped[0].id, 'a1')
        let r2 = store.claimNodes(items.slice(0, 2), { round: 8, by: 'other' })
        assert.equal(r2.claimed.length, 0)
        assert.equal(r2.skipped.length, 2)
        let n = store.getNode('c1')
        assert.equal(n.status, STATUS.PLANNED); assert.equal(n.claim.by, 'me'); assert.equal(n.round, 7)
        assert.equal(store.listIndex().find((x) => x.id === 'c1').claim.by, 'me')
        assert(_.includes(store.getNode('a1').children, 'c2'), '認領存根亦反向連結父')
    })
    it('setStatus stale(清除認領)後可再認領', () => {
        store.setStatus(['c1'], STATUS.STALE)
        assert.equal(store.getNode('c1').claim, null)
        let r = store.claimNodes([{ id: 'c1', spec: P(3, 3) }], { round: 9, by: 'x' })
        assert.equal(r.claimed.length, 1)
        assert.equal(store.getNode('c1').claim.by, 'x')
    })
    it('reclaimStale:認領者行程已死者回收為 stale;存活者不論認領多久皆不動(2026-09-26);無 pid 之舊紀錄逾 staleMs 回收', () => {
        let n2 = store.getNode('c2'); n2.claim.pid = 999999; store.putNode(n2)
        let ids = store.reclaimStale()
        assert.deepEqual(ids, ['c2'])
        assert.equal(store.getNode('c2').status, STATUS.STALE)
        assert.equal(store.getNode('c1').status, STATUS.PLANNED, '活的認領不動')
        let n1 = store.getNode('c1'); n1.claim.at = new Date(Date.now() - 5000).toISOString(); store.putNode(n1)
        assert.deepEqual(store.reclaimStale(), [], '存活之認領者逾時(staleMs 1000)亦不回收 —— 原規則會使評估逾時之臂被他 session 重提而重複評估')
        let n1b = store.getNode('c1'); n1b.claim.pid = null; store.putNode(n1b)
        assert.deepEqual(store.reclaimStale(), ['c1'], '無 pid 之舊紀錄逾時回收')
        assert.equal(store.getNode('c1').notes.stale.was, STATUS.PLANNED)
    })
    it('updateNode:鎖內重讀最新節點再改(舊副本不蓋掉他方寫入);fn 回 false 放棄;節點不存在回 null;putNode 之 children 與磁碟聯集(2026-09-26)', () => {
        store.claimNodes([{ id: 'u1', spec: P(7, 7) }], { round: 1, by: 'me' })
        let old = store.getNode('u1') //本方手上之舊副本
        store.updateNode('u1', (n) => { n.notes = { ...(n.notes || {}), other: 1 } }) //他方期間之寫入
        let r = store.updateNode('u1', (n) => { n.evidence = { refs: [], mech: true } })
        assert.equal(r.id, 'u1')
        assert.equal(store.getNode('u1').notes.other, 1, '他方之 notes 保留')
        assert.equal(store.getNode('u1').evidence.mech, true)
        assert.equal(store.updateNode('u1', () => false), null, 'fn 回 false ⇒ 不寫')
        assert.equal(store.updateNode('nope', () => { throw new Error('不應呼叫') }), null)
        assert.throws(() => store.updateNode('u1', (n) => ({ ...n, id: 'x' })), /不得改 id/)
        store.claimNodes([{ id: 'u2', spec: P(8, 8), parentId: 'u1' }], { round: 1, by: 'me' }) //回連 u1.children
        assert(store.getNode('u1').children.includes('u2'))
        old.children = []; store.putNode(old) //以舊副本整筆寫回
        assert(store.getNode('u1').children.includes('u2'), 'putNode 不抹掉期間回連之子節點')
    })
    it('claimFrontier / releaseFrontier:CAS(只 proposed 可認領;只認領者可釋放);原子寫(2026-09-26)', () => {
        store.pushFrontier([{ specHash: 'f1', spec: P(9, 9) }])
        assert(store.claimFrontier('f1', 'A').ok)
        let b = store.claimFrontier('f1', 'B')
        assert(!b.ok && /status implementing/.test(b.why), b.why)
        assert(!store.releaseFrontier('f1', 'B', 'proposed').ok, '非認領者不可釋放')
        assert(store.releaseFrontier('f1', 'A', 'proposed').ok)
        let row = store.listFrontier().find((f) => f.specHash === 'f1')
        assert.equal(row.status, 'proposed'); assert.equal(row.claimBy, 'A'); assert(row.resolvedAt)
        assert(!store.claimFrontier('zz', 'A').ok)
    })
    it('releaseFrontier opt.patch:釋放時鎖內併入進度欄(只收 FRONTIER_PATCH_KEYS;他鍵拒絕且不寫);未給 patch = 舊行為(2026-09-27)', () => {
        store.pushFrontier([{ specHash: 'f2', spec: P(8, 8) }])
        assert(store.claimFrontier('f2', 'A').ok)
        let bad = store.releaseFrontier('f2', 'A', 'stopped', { patch: { status: 'executed' } })
        assert(!bad.ok && /patch 只收/.test(bad.why), bad.why)
        assert.equal(store.listFrontier().find((f) => f.specHash === 'f2').status, 'implementing', '拒絕時不寫')
        let ok = store.releaseFrontier('f2', 'A', 'stopped', { patch: { progress: '階 0 完成', stop: { why: '別名' }, refs: ['rounds/r050/report.md'] } })
        assert(ok.ok, ok.why)
        let row = store.listFrontier().find((f) => f.specHash === 'f2')
        assert.equal(row.status, 'stopped'); assert.equal(row.progress, '階 0 完成'); assert.deepEqual(row.stop, { why: '別名' }); assert.equal(row.patchedBy, 'A'); assert(row.patchedAt)
    })
    it('執行後 putNode 覆寫存根:claim 清空、status executed', async () => {
        store.claimNodes([{ id: 'd1', spec: P(5, 5) }], { round: 1, by: 'me' })
        let raw = await domain.evaluator.evaluate(P(5, 5), null)
        store.putNode(makeNode({ id: 'd1', spec: P(5, 5), round: 1, raw }, domain))
        let n = store.getNode('d1')
        assert.equal(n.status, 'executed'); assert.equal(n.claim, null); assert(_.isNumber(n.score.S))
        assert.equal(store.listIndex().find((x) => x.id === 'd1').claim, null)
    })
    it('frontier 以 specHash 去重;markFrontier 改狀態', () => {
        assert.equal(store.pushFrontier([{ specHash: 'h1', spec: P(5, 5) }, { specHash: 'h1', spec: P(5, 5) }, { specHash: 'h2', spec: P(6, 6) }]), 2)
        assert.equal(store.pushFrontier([{ specHash: 'h2', spec: P(6, 6) }]), 0)
        store.markFrontier(['h1'], 'executed')
        assert.equal(store.listFrontier().find((f) => f.specHash === 'h1').status, 'executed')
        assert.equal(store.listFrontier().find((f) => f.specHash === 'h2').status, 'proposed')
    })
    it('lore 只追加, 附 addedAt', () => {
        store.appendLore({ feature: 'f', verdict: 'v' }); store.appendLore({ feature: 'g' })
        assert.equal(store.listLore().length, 2)
        assert(store.listLore()[0].addedAt)
    })
    it('併行 putNode(6 程序 × 5 節點)無遺失無重複', async function () {
        this.timeout(90000)
        let root = path.join(t.dir, 'par')
        let rs = await Promise.all(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((p) => run([path.join(FD_TEST, 'tools', 'putChild.mjs'), root, p, '5'])))
        assert.deepEqual(rs.map((r) => r.code), [0, 0, 0, 0, 0, 0], rs.map((r) => r.err).join('\n'))
        let rows = makeStore({ paths: makePaths(root), domain }).listIndex()
        assert.equal(rows.length, 30)
        assert.equal(_.uniq(rows.map((r) => r.id)).length, 30)
        assert(!fs.existsSync(path.join(root, 'tree', '.lock_tree')))
    })
})
