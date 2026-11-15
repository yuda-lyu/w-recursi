import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi, frontierOutcomesOf } from '../src/index.mjs'
import { makePaths } from '../src/core/paths.mjs'
import { makeStore } from '../src/tree/store.mjs'
import { runJobs } from '../src/eval/runner.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp, FD_TEST } from './tools/tmpdir.mjs'


let P = (x, y) => ({ kind: 'point', x, y })
const TOY = path.join(FD_TEST, 'tools', 'toy.mjs')

//暫時性失敗(使用端 Gitea #157):評估器拋出之值帶 transient: true(嚴格比對)= 非候選本身之問題(如外部資源一時不可用)
//  ⇒ runJobs 兩種模式之失敗列、error 節點之 notes、frontierOutcomesOf 之該筆皆帶 transient: true;
//    前緣結案(resolveFrontier)只動 proposed 之列:不計 retries、不動 note,另記 transients / transientNote(只留最近一次)/ lastErrorAt;
//    cfg.frontier.maxTransient(選配;wsemi iseint 判為正整數才設上限,其餘 = 不設)達上限 ⇒ blocked;
//    未拋 transient 之領域:resolveFrontier 之回傳、summary.json、報告、前緣檔逐字不變(回傳只在有此類時多 transient 鍵)
describe('eval/runner + loop/explore + tree/store:暫時性失敗不計入前緣重試(Gitea #157)', function () {
    let t
    before(() => { t = makeTmp('frontierTransient') })
    after(() => { t.cleanup() })
    let fresh = (name, over = {}) => createRsi({ root: path.join(t.dir, name), domain: toy.makeDomain(over.domain || {}), budget: { arms: 6, novelty: 2, workers: 3 }, turning: { enabled: false }, ...(over.cfg || {}) }).init()
    let newStore = (name) => { let paths = makePaths(path.join(t.dir, name)); paths.ensure(); return makeStore({ paths, domain: toy.makeDomain() }) }
    let inProc = (evaluate) => ({ evaluator: { mode: 'inProcess', evaluate, createContext: toy.createContext, ctxOpt: {} } })
    let rowOf = (rsi, s) => rsi.store.listFrontier().find((f) => f.specHash === rsi.specHash(s))
    let tr = (h, why = 'x') => ({ specHash: h, status: 'error', why, transient: true })

    it('FT01 整輪(同程序):評估器拋 transient 之前緣臂維持 proposed、不記 retries、記 transients 與 transientNote;連續 3 輪皆不封鎖且每輪重提;恢復後照常執行', async function () {
        this.timeout(120000)
        let down = true
        //規格:暫時性失敗由評估器以錯誤物件之 transient: true 表明;引擎不認得成因字樣
        let evaluate = async (spec, ctx, protocol) => { if (down && toy.summarize(spec) === 'P(7,7)') { throw Object.assign(new Error('外部資源一時不可用'), { transient: true }) } return toy.evaluate(spec, ctx, protocol) }
        let rsi = fresh('whole', { domain: inProc(evaluate) })
        let h = rsi.specHash(P(7, 7)), id = rsi.idOf(P(7, 7))
        rsi.store.pushFrontier([{ kind: 'arm', spec: P(7, 7), specHash: h, reason: '外部資源', priority: 0 }])
        let row = () => rowOf(rsi, P(7, 7))
        let e1 = await rsi.explore({})
        let n1 = e1.nodes.find((n) => n.id === id)
        assert(n1 && n1.status === 'error', '節點仍為 error(不占用、不入已執行)')
        assert.equal(n1.notes.transient, true); assert.match(n1.notes.error, /外部資源一時不可用/)
        assert.equal(rsi.store.getNode(id).notes.transient, true, '持久化之節點亦帶')
        assert.equal(row().status, 'proposed'); assert.equal(row().retries, undefined, '不計 retries'); assert.equal(row().transients, 1)
        assert.match(row().transientNote, /^r001 #1:/); assert.match(row().transientNote, /外部資源一時不可用/); assert(row().lastErrorAt)
        assert.equal(row().note, undefined, 'note 不動(只有最近一次之 transientNote;不隨次數增長)')
        assert.deepEqual(e1.frontierRes, { executed: 0, rejected: 0, retried: 0, blocked: 0, transient: 1 })
        assert.equal(e1.summary.nError, 1, 'nError 之語意不變(仍含暫時性失敗)'); assert.equal(e1.summary.nTransient, 1)
        let sum1 = JSON.parse(fs.readFileSync(path.join(e1.fd, 'summary.json'), 'utf8'))
        assert.equal(sum1.nTransient, 1, 'summary.json 帶 nTransient')
        assert.match(fs.readFileSync(path.join(e1.fd, 'report.md'), 'utf8'), /暫時性失敗\(不計重試\)1/)
        let e2 = await rsi.explore({})
        assert(e2.items.some((it) => it.id === id), '第 2 輪重提')
        let e3 = await rsi.explore({})
        assert(e3.items.some((it) => it.id === id), '第 3 輪重提(預設之 maxRetries = 2 不適用)')
        assert.equal(row().status, 'proposed'); assert.equal(row().retries, undefined); assert.equal(row().transients, 3)
        assert.match(row().transientNote, /^r003 #3:/); assert.equal(row().note, undefined)
        assert.equal(e3.frontierRes.blocked, 0)
        down = false
        let e4 = await rsi.explore({})
        assert(e4.nodes.some((n) => n.id === id && n.status === 'executed'), '恢復後照常執行')
        assert.equal(row().status, 'executed'); assert.equal(row().transients, 3, '歷史計數保留')
        assert.equal(e4.frontierRes.transient, undefined, '無暫時性失敗之輪:回傳不帶此鍵')
        assert.equal(e4.summary.nTransient, undefined, '無暫時性失敗之輪:summary 不帶此鍵')
        assert(!/暫時性失敗/.test(fs.readFileSync(path.join(e4.fd, 'report.md'), 'utf8')), '無暫時性失敗之輪:報告無此字樣')
    })

    it('FT02 整輪(子程序模式):與同程序模式一致——error 節點帶 transient、前緣不計 retries、第 3 輪仍 proposed(預設 maxRetries = 2 不適用)', async function () {
        this.timeout(180000)
        let rsi = fresh('spawn', { domain: { evaluator: { mode: 'spawn', module: TOY, ctxOpt: { transientIf: 'P\\(7,7\\)' } } } })
        let h = rsi.specHash(P(7, 7)), id = rsi.idOf(P(7, 7))
        rsi.store.pushFrontier([{ kind: 'arm', spec: P(7, 7), specHash: h, reason: '外部資源', priority: 0 }])
        let row = () => rowOf(rsi, P(7, 7))
        let e1 = await rsi.explore({})
        let n1 = e1.nodes.find((n) => n.id === id)
        assert(n1 && n1.status === 'error' && n1.notes.transient === true, JSON.stringify(n1 && n1.notes))
        assert.match(n1.notes.error, /模擬暫時性失敗/)
        assert.equal(row().status, 'proposed'); assert.equal(row().retries, undefined); assert.equal(row().transients, 1)
        assert.deepEqual(e1.frontierRes, { executed: 0, rejected: 0, retried: 0, blocked: 0, transient: 1 })
        assert.equal(e1.summary.nTransient, 1)
        await rsi.explore({})
        let e3 = await rsi.explore({})
        assert(e3.items.some((it) => it.id === id), '第 3 輪仍重提')
        assert.equal(row().status, 'proposed'); assert.equal(row().transients, 3); assert.equal(row().retries, undefined)
    })

    it('FT03 整輪(混合):同一輪暫時性失敗、一般錯誤、成功並存——各自分開計數(retries 只計一般錯誤;nError 含兩者、nTransient 只計暫時性)', async function () {
        this.timeout(120000)
        let evaluate = async (spec, ctx, protocol) => { if (toy.summarize(spec) === 'P(7,7)') { throw Object.assign(new Error('外部資源一時不可用'), { transient: true }) } return toy.evaluate(spec, ctx, protocol) }
        let rsi = fresh('mixed', { domain: { evaluator: { mode: 'inProcess', evaluate, createContext: toy.createContext, ctxOpt: { failIf: 'P\\(8,8\\)' } } } })
        rsi.store.pushFrontier([P(7, 7), P(8, 8), P(6, 6)].map((s, i) => ({ kind: 'arm', spec: s, specHash: rsi.specHash(s), reason: 'mix', priority: i })))
        let e1 = await rsi.explore({})
        assert.equal(rowOf(rsi, P(7, 7)).status, 'proposed'); assert.equal(rowOf(rsi, P(7, 7)).retries, undefined); assert.equal(rowOf(rsi, P(7, 7)).transients, 1)
        assert.equal(rowOf(rsi, P(8, 8)).status, 'proposed'); assert.equal(rowOf(rsi, P(8, 8)).retries, 1); assert.equal(rowOf(rsi, P(8, 8)).transients, undefined)
        assert.equal(rowOf(rsi, P(6, 6)).status, 'executed')
        assert.deepEqual(e1.frontierRes, { executed: 1, rejected: 0, retried: 1, blocked: 0, transient: 1 })
        assert.equal(e1.summary.nError, 2); assert.equal(e1.summary.nTransient, 1)
        let e2 = await rsi.explore({})
        assert.equal(rowOf(rsi, P(8, 8)).status, 'blocked', '一般錯誤照舊:第 2 次達 maxRetries ⇒ blocked')
        assert.equal(rowOf(rsi, P(7, 7)).status, 'proposed', '暫時性失敗不因同輪之一般錯誤而受影響')
        assert.deepEqual(e2.frontierRes, { executed: 0, rejected: 0, retried: 0, blocked: 1, transient: 1 })
    })

    it('FT04 resolveFrontier:一般錯誤與暫時性失敗分開計數(暫時性不推進 retries、亦不重設;一般錯誤照舊達 maxRetries 即 blocked)', () => {
        let store = newStore('mix')
        store.pushFrontier([{ specHash: 'a', spec: P(1, 1) }])
        let a = () => store.listFrontier().find((r) => r.specHash === 'a')
        assert.deepEqual(store.resolveFrontier([{ specHash: 'a', status: 'error', why: 'boom' }], { round: 1 }), { executed: 0, rejected: 0, retried: 1, blocked: 0 })
        assert.equal(a().retries, 1)
        assert.deepEqual(store.resolveFrontier([tr('a', '外部不可用')], { round: 2 }), { executed: 0, rejected: 0, retried: 0, blocked: 0, transient: 1 })
        assert.equal(a().status, 'proposed'); assert.equal(a().retries, 1); assert.equal(a().transients, 1)
        assert.match(a().note, /r001 評估錯誤 #1:boom/); assert(!/外部不可用/.test(a().note), '暫時性失敗不寫入 note')
        assert.match(a().transientNote, /^r002 #1:外部不可用$/)
        assert.deepEqual(store.resolveFrontier([{ specHash: 'a', status: 'error', why: 'boom2' }], { round: 3 }), { executed: 0, rejected: 0, retried: 0, blocked: 1 })
        assert.equal(a().status, 'blocked'); assert.equal(a().retries, 2); assert.equal(a().transients, 1)
    })

    it('FT05 resolveFrontier 之形:無暫時性失敗時回傳不帶 transient 鍵(舊形逐字);transient 只認嚴格之 true;只動 proposed 之列;暫時性之後成功 ⇒ executed', () => {
        let store = newStore('shape')
        store.pushFrontier([{ specHash: 'a', spec: P(1, 1) }, { specHash: 'b', spec: P(2, 2) }, { specHash: 'c', spec: P(3, 3), status: 'implementing' }, { specHash: 'd', spec: P(4, 4) }, { specHash: 'e', spec: P(5, 5) }])
        let byH = () => _.keyBy(store.listFrontier(), 'specHash')
        //transient 為字串 'true' / 數字 1 / 其他真值 ⇒ 視同一般錯誤
        let r = store.resolveFrontier([{ specHash: 'a', status: 'error', why: 'x', transient: 'true' }, { specHash: 'b', status: 'error', why: 'y', transient: 1 }, { specHash: 'c', status: 'error', why: 'z', transient: true }, { specHash: 'd', status: 'error', why: 'w', transient: {} }], { round: 1 })
        assert.deepEqual(r, { executed: 0, rejected: 0, retried: 3, blocked: 0 }, 'a / b / d 為一般錯誤各計 retries 1;c 非 proposed 不動')
        for (let h of ['a', 'b', 'd']) { assert.equal(byH()[h].retries, 1, h); assert.equal(byH()[h].transients, undefined, h); assert.equal(byH()[h].transientNote, undefined, h) }
        assert.equal(byH().c.status, 'implementing'); assert.equal(byH().c.transients, undefined, '非 proposed 之列不動'); assert.equal(byH().c.retries, undefined)
        assert.deepEqual(store.resolveFrontier([]), { executed: 0, rejected: 0, retried: 0, blocked: 0 })
        assert.deepEqual(store.resolveFrontier([{ specHash: 'zz', status: 'error', why: 'q', transient: true }]), { executed: 0, rejected: 0, retried: 0, blocked: 0 }, '查無列 ⇒ 不動、回傳無 transient 鍵')
        //暫時性之 error 只動 proposed 之列:其餘各狀態(含 README 所列之 implemented / stopped)之列不動
        let s3 = newStore('shape3')
        let others = ['implementing', 'implemented', 'stopped', 'blocked', 'executed', 'rejectedByGate', 'stale']
        s3.pushFrontier(others.map((st, i) => ({ specHash: `s${i}`, spec: P(i, i), status: st })))
        assert.deepEqual(s3.resolveFrontier(others.map((st, i) => tr(`s${i}`)), { maxTransient: 1, round: 1 }), { executed: 0, rejected: 0, retried: 0, blocked: 0 })
        assert.deepEqual(s3.listFrontier().map((r) => [r.status, r.transients, r.retries, r.transientNote]), others.map((st) => [st, undefined, undefined, undefined]))
        //暫時性失敗不影響 executed / rejectedByGate 之結案
        let s2 = newStore('shape2')
        s2.pushFrontier([{ specHash: 'a', spec: P(1, 1) }, { specHash: 'b', spec: P(2, 2) }])
        s2.resolveFrontier([tr('a'), tr('b')], { round: 1 })
        assert.deepEqual(s2.resolveFrontier([{ specHash: 'a', status: 'executed' }, { specHash: 'b', status: 'rejectedByGate', why: 'g', transient: true }], { round: 2 }), { executed: 1, rejected: 1, retried: 0, blocked: 0 })
        assert.equal(_.keyBy(s2.listFrontier(), 'specHash').a.status, 'executed'); assert.equal(_.keyBy(s2.listFrontier(), 'specHash').b.status, 'rejectedByGate')
    })

    it('FT06 resolveFrontier 之 maxTransient(選配;預設不設上限):給了正整數 ⇒ transients 達上限即 blocked 且計入 blocked;transientNote 只留最近一次', () => {
        let store = newStore('cap')
        store.pushFrontier([{ specHash: 'a', spec: P(1, 1) }, { specHash: 'b', spec: P(2, 2) }, { specHash: 'c', spec: P(3, 3) }])
        let byH = () => _.keyBy(store.listFrontier(), 'specHash')
        //未給 maxTransient:10 次仍 proposed
        for (let k = 1; k <= 10; k++) { assert.deepEqual(store.resolveFrontier([tr('a', `第${k}次`)], { round: k }), { executed: 0, rejected: 0, retried: 0, blocked: 0, transient: 1 }) }
        assert.equal(byH().a.status, 'proposed'); assert.equal(byH().a.transients, 10); assert.equal(byH().a.retries, undefined)
        assert.match(byH().a.transientNote, /^r010 #10:第10次$/, '只留最近一次(不隨次數增長)')
        //給 maxTransient = 2:第 2 次即 blocked
        assert.deepEqual(store.resolveFrontier([tr('b', 'q1')], { maxTransient: 2, round: 1 }), { executed: 0, rejected: 0, retried: 0, blocked: 0, transient: 1 })
        assert.deepEqual(store.resolveFrontier([tr('b', 'q2')], { maxTransient: 2, round: 2 }), { executed: 0, rejected: 0, retried: 0, blocked: 1 })
        assert.equal(byH().b.status, 'blocked'); assert.equal(byH().b.transients, 2); assert(byH().b.resolvedAt); assert.equal(byH().b.retries, undefined)
        //給 maxTransient = 1:第 1 次即 blocked
        assert.deepEqual(store.resolveFrontier([tr('c', 'once')], { maxTransient: 1, round: 1 }), { executed: 0, rejected: 0, retried: 0, blocked: 1 })
        assert.equal(byH().c.status, 'blocked')
        //已 blocked 之列不再動(非 proposed)
        assert.deepEqual(store.resolveFrontier([tr('b', 'q3')], { maxTransient: 2, round: 3 }), { executed: 0, rejected: 0, retried: 0, blocked: 0 })
        assert.equal(byH().b.transients, 2)
        //一般錯誤與上限互不干擾:maxRetries 照舊
        let s2 = newStore('cap2')
        s2.pushFrontier([{ specHash: 'a', spec: P(1, 1) }])
        s2.resolveFrontier([tr('a')], { maxTransient: 5, maxRetries: 1, round: 1 })
        assert.equal(s2.listFrontier()[0].status, 'proposed', '暫時性失敗不受 maxRetries 影響')
        assert.deepEqual(s2.resolveFrontier([{ specHash: 'a', status: 'error', why: 'boom' }], { maxTransient: 5, maxRetries: 1, round: 2 }), { executed: 0, rejected: 0, retried: 0, blocked: 1 })
    })

    it('FT07 maxTransient 之值域(規格〈輸入參數之檢測機制〉N2 正整數,以 wsemi iseint 判定;opt 給了而非預期 ⇒ 視為未給 = 不設上限):各值逐一', () => {
        //有效(正整數或其數字字串;轉換後之值即使用之值)⇒ 第 2 次即 blocked
        let valid = [2, '2', ' 2 ', '+2', '2.0', '2e0']
        //無效 ⇒ 視為未給 ⇒ 5 次皆不封鎖
        let invalid = [0, -1, -0, NaN, 1.5, Infinity, -Infinity, '', ' ', 'abc', '2x', '0x2', '1,2', '-', 'NP', null, undefined, true, false, [2], ['2'], {}, { valueOf: () => 2 }, new Number(2), 2n, Symbol('s'), () => 2, 1e10, 2 ** 60, '1e10', '0', '-2', '0.5']
        let n = 0
        for (let v of valid) {
            let store = newStore(`v${n++}`)
            store.pushFrontier([{ specHash: 'a', spec: P(1, 1) }])
            assert.deepEqual(store.resolveFrontier([tr('a')], { maxTransient: v, round: 1 }), { executed: 0, rejected: 0, retried: 0, blocked: 0, transient: 1 }, `valid ${String(v)} 第 1 次`)
            assert.deepEqual(store.resolveFrontier([tr('a')], { maxTransient: v, round: 2 }), { executed: 0, rejected: 0, retried: 0, blocked: 1 }, `valid ${String(v)} 第 2 次`)
            assert.equal(store.listFrontier()[0].status, 'blocked', `valid ${String(v)}`)
        }
        for (let v of invalid) {
            let store = newStore(`v${n++}`)
            store.pushFrontier([{ specHash: 'a', spec: P(1, 1) }])
            let last
            for (let k = 1; k <= 5; k++) { last = store.resolveFrontier([tr('a')], { maxTransient: v, round: k }) }
            assert.deepEqual(last, { executed: 0, rejected: 0, retried: 0, blocked: 0, transient: 1 }, `invalid ${typeof v === 'symbol' ? 'symbol' : String(v)} 視同不設`)
            assert.equal(store.listFrontier()[0].status, 'proposed', `invalid ${typeof v === 'symbol' ? 'symbol' : String(v)}`); assert.equal(store.listFrontier()[0].transients, 5)
        }
        //opt 之鍵缺 / undefined / null ⇒ 預設(不設上限);整個 opt 省略 ⇒ 預設(既有行為;整個 opt 給 null 仍如舊拋 TypeError,不在本功能範圍);呼叫端之 opt 物件不被改寫
        let s3 = newStore(`v${n++}`)
        s3.pushFrontier([{ specHash: 'a', spec: P(1, 1) }])
        let o = Object.freeze({ maxTransient: 2, round: 1 })
        s3.resolveFrontier([tr('a')], o); s3.resolveFrontier([tr('a')], o)
        assert.equal(s3.listFrontier()[0].status, 'blocked'); assert.deepEqual(o, { maxTransient: 2, round: 1 })
        let s4 = newStore(`v${n++}`)
        s4.pushFrontier([{ specHash: 'a', spec: P(1, 1) }])
        for (let k = 0; k < 4; k++) { s4.resolveFrontier([tr('a')]) }
        assert.equal(s4.listFrontier()[0].status, 'proposed', 'opt 整個省略 ⇒ 不設上限'); assert.equal(s4.listFrontier()[0].transients, 4)
    })

    it('FT07b maxTransient 之邊界:有效上限 1 / 3 / 5 於恰達時封鎖(差一不封);count 範圍上界 4294967295 採用、4294967296 與 1e10 視為未給(預置歷史 transients 於邊界前一次,辨別 use: count 之範圍)', () => {
        let nn = 0
        let one = (cap, preset) => {
            let store = newStore(`b${nn++}`) //每次一個新狀態根(名稱不以值組成:2 與 '2' 同名即共用前緣檔)
            store.pushFrontier([{ specHash: 'a', spec: P(1, 1), ...(preset ? { transients: preset } : {}) }])
            let r = store.resolveFrontier([tr('a')], { maxTransient: cap, round: 1 })
            return { status: store.listFrontier()[0].status, transients: store.listFrontier()[0].transients, r }
        }
        for (let cap of [1, 3, 5]) {
            assert.equal(one(cap, cap - 2 > 0 ? cap - 2 : 0).status, cap === 1 ? 'blocked' : 'proposed', `cap ${cap} 差一 ⇒ ${cap === 1 ? '已達' : '不封'}`)
            let hit = one(cap, cap - 1); assert.equal(hit.status, 'blocked', `cap ${cap} 恰達 ⇒ 封鎖`); assert.equal(hit.transients, cap); assert.equal(hit.r.blocked, 1)
        }
        let top = one(4294967295, 4294967294)
        assert.equal(top.status, 'blocked', 'count 上界 4294967295 採用'); assert.equal(top.transients, 4294967295)
        assert.equal(one('4294967295', 4294967294).status, 'blocked', '其數字字串亦同')
        assert.equal(one(4294967296, 4294967295).status, 'proposed', '超出 count 範圍 ⇒ 視為未給(不設上限)')
        assert.equal(one(1e10, 1e10 - 1).status, 'proposed', '1e10 超出 count 範圍 ⇒ 視為未給')
        assert.equal(one('1e10', 1e10 - 1).status, 'proposed')
        assert.equal(one(2 ** 53, 2 ** 53 - 1).status, 'proposed', '非安全整數 ⇒ 視為未給')
    })

    it('FT08 整輪之 cfg.frontier.maxTransient:設 2 ⇒ 第 2 次暫時性失敗即 blocked、之後不再被提;字串 "2" 同;非正整數(0 / -1 / "abc")⇒ 不設上限', async function () {
        this.timeout(180000)
        let evaluate = async (spec, ctx, protocol) => { if (toy.summarize(spec) === 'P(7,7)') { throw Object.assign(new Error('一直不可用'), { transient: true }) } return toy.evaluate(spec, ctx, protocol) }
        for (let cap of [2, '2']) {
            let rsi = fresh(`cfgcap_${typeof cap}`, { domain: inProc(evaluate), cfg: { frontier: { maxTransient: cap } } })
            let id = rsi.idOf(P(7, 7))
            rsi.store.pushFrontier([{ kind: 'arm', spec: P(7, 7), specHash: rsi.specHash(P(7, 7)), reason: '外部資源', priority: 0 }])
            await rsi.explore({})
            assert.equal(rowOf(rsi, P(7, 7)).status, 'proposed', `cap ${cap} 第 1 次`)
            let e2 = await rsi.explore({})
            assert.equal(rowOf(rsi, P(7, 7)).status, 'blocked', `cap ${cap} 第 2 次`); assert.equal(rowOf(rsi, P(7, 7)).transients, 2); assert.equal(e2.frontierRes.blocked, 1); assert.equal(e2.frontierRes.transient, undefined)
            assert.match(fs.readFileSync(path.join(e2.fd, 'report.md'), 'utf8'), /錯誤達上限封鎖\(status blocked\)1/)
            let e3 = await rsi.explore({})
            assert(!e3.items.some((it) => it.id === id), `cap ${cap}:blocked ⇒ 不再被提`)
        }
        for (let [i, cap] of [0, -1, 'abc'].entries()) {
            let rsi = fresh(`cfgnocap_${i}`, { domain: inProc(evaluate), cfg: { frontier: { maxTransient: cap } } })
            rsi.store.pushFrontier([{ kind: 'arm', spec: P(7, 7), specHash: rsi.specHash(P(7, 7)), reason: '外部資源', priority: 0 }])
            for (let k = 0; k < 3; k++) { await rsi.explore({}) }
            assert.equal(rowOf(rsi, P(7, 7)).status, 'proposed', `cap ${cap} ⇒ 不設上限`); assert.equal(rowOf(rsi, P(7, 7)).transients, 3)
        }
    })

    it('FT09 frontierOutcomesOf:error 節點之 notes.transient 嚴格為 true 才帶 transient: true;其餘之輸出逐字不變', () => {
        let outs = frontierOutcomesOf([
            { specHash: 'h1', status: 'executed', notes: { transient: true } },
            { specHash: 'h2', status: 'error', notes: { error: 'boom' } },
            { specHash: 'h3', status: 'error', notes: { error: '外部不可用', transient: true } },
            { specHash: 'h4', status: 'error', notes: { error: 'x', transient: 'true' } },
            { specHash: 'h5', status: 'rejectedByGate', notes: { why: 'g', transient: true } },
            { specHash: 'h7', status: 'error', notes: { error: 'y', transient: 1 } },
        ], [{ specHash: 'h6', why: 'gate' }])
        assert.deepEqual(outs, [
            { specHash: 'h1', status: 'executed', why: null },
            { specHash: 'h2', status: 'error', why: 'boom' },
            { specHash: 'h3', status: 'error', why: '外部不可用', transient: true },
            { specHash: 'h4', status: 'error', why: 'x' },
            { specHash: 'h5', status: 'rejectedByGate', why: 'g' },
            { specHash: 'h7', status: 'error', why: 'y' },
            { specHash: 'h6', status: 'rejectedByGate', why: 'gate' },
        ])
        assert.equal(Object.keys(outs[1]).join(), 'specHash,status,why', '一般錯誤:鍵集合與順序同舊形')
    })

    it('FT10 runJobs:同程序與子程序兩種模式之失敗列皆帶 transient: true;一般錯誤、拋出 null / 字串、transient 非嚴格 true 者不帶此鍵;成功列不帶', async function () {
        this.timeout(60000)
        let thrown = { a: Object.assign(new Error('暫時'), { transient: true }), b: new Error('一般'), c: null, d: 'str', e: Object.assign(new Error('字串'), { transient: 'true' }), f: { transient: true }, g: Object.assign(new Error('一'), { transient: 1 }), h: undefined, i: Object.defineProperty(new Error('存取器'), 'transient', { get() { throw new Error('transient 存取器拋錯') } }) }
        let r = await runJobs(Object.keys(thrown).map((id) => ({ id, spec: { id } })), { mode: 'inProcess', evaluate: async (spec) => { throw thrown[spec.id] }, workers: 2 })
        for (let id of Object.keys(thrown)) { assert.equal(r.results.get(id).ok, false, id) }
        assert.equal(r.results.get('a').transient, true); assert.match(r.results.get('a').error, /暫時/)
        assert.equal(r.results.get('f').transient, true, '非 Error 之物件亦可帶')
        for (let id of ['b', 'c', 'd', 'e', 'g', 'h', 'i']) { assert(!('transient' in r.results.get(id)), `${id} 不帶 transient 鍵`) }
        //i:讀取 transient 即拋錯 ⇒ 視為未帶(失敗列照舊記下;不使整批評估拋出)
        assert.match(r.results.get('i').error, /存取器/)
        //meta 與 evaluate 同一次評估:meta 拋出之值帶 transient: true 者亦為暫時性失敗(領域自行表明)
        let mr = await runJobs([{ id: 'm', spec: { id: 'm' } }], { mode: 'inProcess', evaluate: async () => ({ v: 1 }), meta: () => { throw Object.assign(new Error('meta 失敗'), { transient: true }) }, workers: 1 })
        assert.equal(mr.results.get('m').ok, false); assert.equal(mr.results.get('m').transient, true)
        assert.equal(Object.keys(r.results.get('b')).sort().join(), 'error,id,ms,ok', '一般失敗列之鍵集合同舊形')
        let okRun = await runJobs([{ id: 'ok', spec: { id: 'ok' } }], { mode: 'inProcess', evaluate: async () => ({ v: 1 }), workers: 1 })
        assert(!('transient' in okRun.results.get('ok')))
        //子程序(worker.mjs):失敗列帶 transient 並經 out 檔讀回
        //  P(10,10) / P(11,11):錯誤物件之 transient 為字串 'true' / 數字 1(job 層協定 transientVal)⇒ 不帶標記(嚴格比對)
        let jobs = [P(1, 1), P(8, 8), P(9, 9)].map((s) => ({ id: toy.summarize(s), spec: s }))
        //  P(12,12):transient 為讀取即拋錯之存取器 ⇒ 不帶標記,且失敗列照舊記下(worker 不因此崩潰、同批他 job 不受影響)
        jobs.push({ id: 'P(10,10)', spec: P(10, 10), protocol: { transientIf: 'P\\(10,10\\)', transientVal: 'true' } }, { id: 'P(11,11)', spec: P(11, 11), protocol: { transientIf: 'P\\(11,11\\)', transientVal: 1 } }, { id: 'P(12,12)', spec: P(12, 12), protocol: { transientIf: 'P\\(12,12\\)', transientVal: 'throws' } })
        let s = await runJobs(jobs, { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'tr1', protocol: { failIf: 'P\\(8,8\\)', transientIf: 'P\\(9,9\\)' } })
        for (let id of ['P(10,10)', 'P(11,11)', 'P(12,12)']) { assert.equal(s.results.get(id).ok, false, id); assert.match(s.results.get(id).error, /模擬暫時性失敗/, `${id} 失敗列照舊記下`); assert(!('transient' in s.results.get(id)), `${id} 之 transient 非嚴格 true(或讀取拋錯)⇒ 不帶此鍵`) }
        assert.equal(s.results.get('P(1,1)').ok, true); assert(!('transient' in s.results.get('P(1,1)')))
        assert.equal(s.results.get('P(8,8)').ok, false); assert(!('transient' in s.results.get('P(8,8)')))
        assert.equal(s.results.get('P(9,9)').ok, false); assert.equal(s.results.get('P(9,9)').transient, true); assert.match(s.results.get('P(9,9)').error, /模擬暫時性失敗/)
        assert.equal(Object.keys(s.results.get('P(8,8)')).sort().join(), 'error,id,key,ms,ok', '子程序一般失敗列之鍵集合同舊形')
    })
})
