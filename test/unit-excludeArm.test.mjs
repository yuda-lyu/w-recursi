import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi, STATUS } from '../src/index.mjs'
import { makeDomain, carriers } from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//生成端之臂排除(2026-10-09;審查:已結案之臂於結案後仍可被生成端入樹而重評 —— 某案 841 秒)
//  domain.excludeArm(spec, ctx) → { exclude, why? } | null(契約:core/domainContract.mjs;領域端之判定由領域自給)
//  EA01 鉤子在而不排除(回 null / { exclude: false })⇒ 計畫 / plan.json / 節點與無鉤子者逐欄同(只多一次呼叫)
//  EA02 排除者入 rejected(excluded: true、why)、plan.json 之 rejected 帶 excluded、寫拒絕存根(rejectedByGate、notes.why / excluded)、不評估;下一輪不再提(存根已占用)
//  EA03 ctx 為節點形:id = idOf(spec)、specHash、parent、kindOf、op、origin(topic / operator / controlOf)、round;對照臂之 origin.controlOf 可見
//  EA04 鉤子拋錯 ⇒ 不排除(照常評估)、計畫備註記一行
//  EA05 重計畫:排除之臂併入本輪之占用 ⇒ 認領衝突後之重計畫不再提(鉤子對之只問一次)
//  EA06 前緣之臂被排除 ⇒ 前緣結案 rejectedByGate;報告之「閘門拒絕」節列其 why
describe('loop/explore:生成端之臂排除 domain.excludeArm', function () {
    this.timeout(120000)
    let t
    before(() => { t = makeTmp('excludeArm') })
    after(() => { t.cleanup() })
    let fresh = (name, domainOver = {}) => createRsi({ root: path.join(t.dir, name), domain: makeDomain(domainOver), budget: { arms: 6, novelty: 2, workers: 3 } }).init()
    let planOf = (ex) => JSON.parse(fs.readFileSync(path.join(ex.fd, 'plan.json'), 'utf8'))
    let FAR = carriers.far

    it('EA01 鉤子在而不排除 ⇒ 計畫 / plan.json / 節點與無鉤子者逐欄同', async () => {
        let a = fresh('ea01a'), n = 0
        let b = fresh('ea01b', { excludeArm: (spec) => { n++; return spec.x === 999 ? { exclude: true } : (n % 2 ? null : { exclude: false }) } })
        for (let r = 0; r < 2; r++) {
            let ea = await a.explore({ by: 'x' }), eb = await b.explore({ by: 'x' })
            let pa = _.omit(planOf(ea), ['at']), pb = _.omit(planOf(eb), ['at'])
            assert.deepEqual(pb, pa, `第 ${r + 1} 輪 plan.json 不同`)
            assert.deepEqual(eb.nodes.map((x) => [x.id, x.status, x.score.S]), ea.nodes.map((x) => [x.id, x.status, x.score.S]))
        }
        assert(n >= 4, `鉤子被呼叫 ${n} 次`)
    })

    it('EA02 排除者:rejected(excluded)、plan.json、拒絕存根、不評估;下一輪不再提', async () => {
        let farHash = null
        let rsi = fresh('ea02', { excludeArm: (spec, ctx) => (_.isEqual(spec, FAR) ? { exclude: true, why: 'lore 第 9 列已結案(測試)' } : null) })
        farHash = rsi.specHash(FAR)
        let ex = await rsi.explore({ by: 'me' })
        let farId = rsi.idOf(FAR)
        let rj = ex.rejected.find((r) => r.id === farId)
        assert(rj && rj.excluded === true && rj.why === 'lore 第 9 列已結案(測試)', JSON.stringify(ex.rejected))
        assert(!ex.items.some((it) => it.id === farId), '不入認領')
        assert.equal(ex.summary.nExecuted, 1); assert.equal(ex.summary.nRejected, 1)
        let pj = planOf(ex).rejected.find((r) => r.id === farId)
        assert.deepEqual(_.pick(pj, ['why', 'excluded']), { why: 'lore 第 9 列已結案(測試)', excluded: true })
        let stub = rsi.store.getNode(farId)
        assert.equal(stub.status, STATUS.REJECTED); assert.equal(stub.raw, null)
        assert.deepEqual(stub.notes, { why: 'lore 第 9 列已結案(測試)', excluded: true })
        assert.equal(stub.specHash, farHash)
        let ex2 = await rsi.explore({ by: 'me' })
        assert(!ex2.items.some((it) => it.id === farId) && !ex2.rejected.some((r) => r.id === farId), '下一輪不再提(存根已占用)')
    })

    it('EA03 ctx 為節點形(含 round、origin.controlOf)', async () => {
        let seen = []
        let rsi = fresh('ea03', { excludeArm: (spec, ctx) => { seen.push(ctx); return null } })
        await rsi.explore({ by: 'me' })
        let c = seen.find((x) => _.isEqual(x.spec, carriers.origin))
        assert(c, '新區域之載體臂有被問')
        assert.equal(c.id, rsi.idOf(carriers.origin)); assert.equal(c.specHash, rsi.specHash(carriers.origin))
        assert.equal(c.parent, 'root'); assert.equal(c.kindOf, 'novelty'); assert.equal(c.round, 1)
        assert(c.origin.topic && c.origin.operator, 'origin.topic / operator 有值'); assert.equal(c.origin.controlOf, null)
        assert.deepEqual(_.pick(c.origin, ['topic', 'operator', 'controlOf', 'reason']), _.pick(rsi.store.getNode(c.id).origin, ['topic', 'operator', 'controlOf', 'reason']), 'ctx.origin 與入樹節點之 origin 同一來源(armOriginOf)')
        await rsi.explore({ by: 'me' })
        seen.length = 0
        let ex3 = await rsi.explore({ by: 'me' }) //玩具之 v0 於第 3 輪以整族提 X.cond 與其對照(X.condSwap / X.condBranch)
        assert(seen.length >= 2 && seen.every((x) => x.round === 3), '第 3 輪之 ctx.round = 3')
        let ctl = seen.filter((x) => x.origin.controlOf)
        let items = ex3.items.filter((it) => it.controlOf)
        assert(items.length >= 1, '第 3 輪有對照臂(玩具之 X.cond 以整族提)')
        assert.deepEqual(_.sortBy(ctl.map((x) => [x.id, x.origin.controlOf]), 0), _.sortBy(items.map((it) => [it.id, it.controlOf]), 0), '對照臂之 controlOf 經 ctx.origin 可見(與計畫項同)')
        assert(ctl.every((x) => x.item && x.item.controlOf === x.origin.controlOf && x.item.op === x.op && x.item.kindOf === x.kindOf), 'ctx.item(計畫項之形)與節點形之欄一致')
        assert(seen.filter((x) => x.kindOf === 'expand').every((x) => x.parent !== 'root' && x.op), '展開臂之 parent / op')
    })

    it('EA04 鉤子拋錯 ⇒ 不排除(照常評估)、計畫備註記一行', async () => {
        let rsi = fresh('ea04', { excludeArm: (spec) => { if (_.isEqual(spec, FAR)) { throw new Error('lore 讀取失敗(測試)') } return null } })
        let ex = await rsi.explore({ by: 'me' })
        assert.equal(ex.summary.nExecuted, 2, '拋錯之臂照常評估')
        assert.equal(ex.rejected.length, 0)
        let notes = planOf(ex).notes || []
        assert(notes.some((s) => /excludeArm 拋錯 1 臂/.test(s) && /lore 讀取失敗/.test(s)), JSON.stringify(notes))
    })

    it('EA05 重計畫:排除之臂併入本輪之占用 ⇒ 認領衝突後之重計畫不再提(鉤子對之只問一次)', async () => {
        let rsi, armed = false, exHash = null, dry = null, raced = false
        let calls = new Map()
        let pre = () => {
            if (armed && dry && !raced) { raced = true; rsi.store.claimNodes(dry.items.filter((it) => it.specHash !== exHash).map((it) => ({ id: it.id, spec: it.spec, specHash: it.specHash, parentId: it.parentId })), { round: 99, by: 'other' }) }
            return { ok: true }
        }
        let excludeArm = (spec, ctx) => { if (!armed) { return null } calls.set(ctx.specHash, (calls.get(ctx.specHash) || 0) + 1); return ctx.specHash === exHash ? { exclude: true, why: '測試' } : null }
        rsi = fresh('ea05', { gates: { pre }, excludeArm })
        await rsi.explore({})
        dry = await rsi.explore({ dry: true })
        assert(dry.items.length >= 3)
        exHash = dry.items[0].specHash
        armed = true
        let ex = await rsi.explore({})
        assert(raced, '競態已注入'); assert(ex.replans >= 1, '有重計畫')
        assert.equal(calls.get(exHash), 1, '排除之臂於重計畫不再提(只問一次)')
        assert(ex.rejected.some((r) => r.specHash === exHash && r.excluded === true))
        assert(!ex.items.some((it) => it.specHash === exHash))
    })

    it('EA06 前緣之臂被排除 ⇒ 前緣結案 rejectedByGate;報告列其 why', async () => {
        let P = (x, y) => ({ kind: 'point', x, y })
        let rsi = fresh('ea06', { excludeArm: (spec) => (_.isEqual(spec, P(7, 7)) ? { exclude: true, why: '已結案之對照臂(測試)' } : null) })
        rsi.store.pushFrontier([{ kind: 'arm', spec: P(7, 7), specHash: rsi.specHash(P(7, 7)), reason: 'x', priority: 2 }])
        let ex = await rsi.explore({})
        let f = rsi.store.listFrontier().find((x) => x.specHash === rsi.specHash(P(7, 7)))
        assert.equal(f.status, 'rejectedByGate', JSON.stringify(f))
        assert.equal(rsi.store.getNode(rsi.idOf(P(7, 7))).status, STATUS.REJECTED)
        assert.match(fs.readFileSync(path.join(ex.fd, 'report.md'), 'utf8'), /已結案之對照臂\(測試\)/)
    })
})
