import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi, specHash } from '../src/index.mjs'
import { readJson, writeJson } from '../src/core/jsonl.mjs'
import { markerStale, markerPidOf, clearGenRequest, readGenRequest, startHeartbeat, HEARTBEAT_FILE, PROC_STARTED_AT } from '../src/loop/generation.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


let P = (x, y) => ({ kind: 'point', x, y })
const DEAD = 999999 //視為已死之 pid(同 unit-store / unit-explore 之慣例)
let iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()

//生成請求標記之持有者、失效接手與清除(2026-09-29;已觀察:被放棄之輪之標記吸收他輪之欠額;清除無鎖且不驗擁有者)
describe('loop/generation:生成請求標記之持有者、失效接手與清除(2026-09-29)', function () {
    let t
    before(() => { t = makeTmp('genRequest') })
    after(() => { t.cleanup() })
    let fresh = (name, over = {}) => createRsi({ root: path.join(t.dir, name), domain: toy.makeDomain(over.domain || {}), budget: { arms: 6, novelty: 2, workers: 3 }, turning: { enabled: false }, ...(over.cfg || {}) }).init()
    //第 1 輪冷啟動(載體入樹), 第 2 輪起新區域額度填不滿 ⇒ 欠額 ⇒ 生成請求
    let twoRounds = async (rsi) => { await rsi.explore({}); return rsi.explore({}) }

    it('新標記記 pid / pidStartedAt / roundDir;探索期間本輪夾有心跳 .alive.json, summary.json 寫出後撤除', async function () {
        this.timeout(60000)
        let seen = []
        let rsi = fresh('fields', { domain: { evaluator: { mode: 'inProcess', createContext: toy.createContext, evaluate: async (spec, ctx, p) => { let ds = fs.readdirSync(rsi.paths.rounds).filter((d) => /^r\d{3,}$/.test(d)).sort(); seen.push(fs.existsSync(path.join(rsi.paths.rounds, _.last(ds), HEARTBEAT_FILE))); return toy.evaluate(spec, ctx, p) } } } })
        let e2 = await twoRounds(rsi)
        assert(e2.generation && e2.generation.fp, '第 2 輪欠額 ⇒ 寫生成請求')
        let m = readJson(rsi.paths.genRequest)
        assert.equal(m.pid, process.pid); assert.equal(m.pidStartedAt, PROC_STARTED_AT); assert.equal(m.roundDir, e2.fd); assert.equal(m.round, 'r002'); assert.equal(m.by, `pid${process.pid}`)
        assert(seen.length > 0 && seen.every(Boolean), '評估期間本輪夾有心跳檔')
        assert(!fs.existsSync(path.join(e2.fd, HEARTBEAT_FILE)), 'summary.json 寫出後心跳檔撤除')
        assert(fs.existsSync(path.join(e2.fd, 'summary.json')))
        let hb = startHeartbeat(path.join(t.dir, 'fields'), { ms: 60000 })
        assert.equal(readJson(hb.fp).pid, process.pid); hb.stop(true); assert(!fs.existsSync(hb.fp), 'stop(true) 撤除心跳檔')
    })
    it('活標記(持有者存活)照舊吸收他輪欠額(全域一份)', async function () {
        this.timeout(60000)
        let rsi = fresh('live')
        await twoRounds(rsi)
        let e3 = await rsi.explore({})
        assert(e3.debt.debt > 0)
        assert(e3.generation && !e3.generation.fp && /已有生成請求/.test(e3.generation.why), JSON.stringify(e3.generation))
        assert.equal(readJson(rsi.paths.genRequest).round, 'r002')
    })
    it('死亡標記(pid 已死 ∧ 輪夾無 summary / DONE)⇒ 欠額之輪接手(寫本輪之標記, 記 replaced;請求文與報告載明)', async function () {
        this.timeout(60000)
        let rsi = fresh('dead')
        await twoRounds(rsi)
        //被放棄之輪:夾只有 plan.json(名不合 rNNN ⇒ 不影響取號);標記之持有者已死
        let fdDead = path.join(rsi.paths.rounds, 'r099_dead')
        fs.mkdirSync(fdDead, { recursive: true }); fs.writeFileSync(path.join(fdDead, 'plan.json'), '{}')
        writeJson(rsi.paths.genRequest, { at: iso(), round: 'r099_dead', roundDir: fdDead, fp: path.join(fdDead, 'GENERATION_REQUEST.md'), by: `pid${DEAD}`, pid: DEAD, debt: 2, streak: 1 })
        let e = await rsi.explore({})
        assert(e.generation && e.generation.fp, JSON.stringify(e.generation))
        assert.equal(e.generation.replaced.round, 'r099_dead'); assert.match(e.generation.replaced.why, /已死/)
        let m = readJson(rsi.paths.genRequest)
        assert.equal(m.round, path.basename(e.fd)); assert.equal(m.pid, process.pid); assert.equal(m.replaced.round, 'r099_dead')
        assert.match(fs.readFileSync(e.generation.fp, 'utf8'), /接手失效之全域標記/)
        assert.match(fs.readFileSync(path.join(e.fd, 'report.md'), 'utf8'), /接手失效之全域生成請求標記/)
        //舊式標記(無 pid / roundDir;by = pid<數字>, fp 在被放棄之輪夾)亦判失效
        writeJson(rsi.paths.genRequest, { at: iso(), round: 'r099_dead', fp: path.join(fdDead, 'GENERATION_REQUEST.md'), by: `pid${DEAD}`, debt: 2, streak: 1 })
        let e2 = await rsi.explore({})
        assert(e2.generation && e2.generation.fp && e2.generation.replaced, '舊式死亡標記亦被接手')
    })
    it('持有者已死而其輪夾有 summary.json ⇒ 完成之輪, 標記仍有效(吸收欠額)', async function () {
        this.timeout(60000)
        let rsi = fresh('doneRound')
        await twoRounds(rsi)
        let m = readJson(rsi.paths.genRequest)
        writeJson(rsi.paths.genRequest, { ...m, pid: DEAD, by: `pid${DEAD}` })
        let e3 = await rsi.explore({})
        assert(e3.generation && !e3.generation.fp && /已有生成請求/.test(e3.generation.why), JSON.stringify(e3.generation))
    })
    it('markerStale(純判定):pid 死 / 心跳停(pid 回收重用之假存活)/ 心跳行程不符 ⇒ 失效;DONE.json、pid 不可得、無心跳之活 pid ⇒ 有效', () => {
        let paths = { rounds: path.join(t.dir, 'ms', 'rounds') }
        let fd = path.join(paths.rounds, 'r010')
        fs.mkdirSync(fd, { recursive: true })
        let m = { at: iso(), round: 'r010', roundDir: fd, pid: 4242, pidStartedAt: 'S1' }
        let alive = () => true, dead = () => false
        assert.equal(markerStale(m, paths, { alive }), null, '存活且無心跳(舊式)⇒ 只以 pid 判 ⇒ 有效')
        assert.match(markerStale(m, paths, { alive: dead }), /已死/)
        writeJson(path.join(fd, HEARTBEAT_FILE), { pid: 4242, pidStartedAt: 'S1', beatAt: iso() })
        assert.equal(markerStale(m, paths, { alive }), null, '心跳新鮮 ⇒ 有效')
        writeJson(path.join(fd, HEARTBEAT_FILE), { pid: 4242, pidStartedAt: 'S1', beatAt: iso(3 * 3600e3) })
        assert.match(markerStale(m, paths, { alive }), /心跳已停/, 'pid 看似存活而心跳停逾 2 小時 ⇒ 失效')
        assert.equal(markerStale(m, paths, { alive, heartbeatStaleMs: 4 * 3600e3 }), null, '門檻內 ⇒ 有效')
        writeJson(path.join(fd, HEARTBEAT_FILE), { pid: 4242, pidStartedAt: 'S2', beatAt: iso() })
        assert.match(markerStale(m, paths, { alive }), /不符/, '心跳之行程啟動時刻與標記不符 ⇒ 失效')
        fs.writeFileSync(path.join(fd, 'DONE.json'), '{}')
        assert.equal(markerStale(m, paths, { alive: dead }), null, '輪夾有 DONE.json ⇒ 完成之輪, 有效')
        assert.equal(markerPidOf({ by: 'pid123' }), 123); assert.equal(markerPidOf({ by: 'd09a' }), null); assert.equal(markerPidOf({ pid: 7, by: 'pid9' }), 7)
        assert.equal(markerStale({ at: iso(), round: 'r011', by: 'd09a' }, paths, { alive: dead }), null, 'pid 不可得 ⇒ 不判失效(以 TTL)')
    })
    it('清除:本輪所見之標記於兌現時清除;本輪計畫之後他輪才寫之標記不被本輪清除(報告載明未清除)', async function () {
        this.timeout(90000)
        let hook = null
        let rsi = fresh('race', { domain: { evaluator: { mode: 'inProcess', createContext: toy.createContext, evaluate: async (spec, ctx, p) => { if (hook) { let h = hook; hook = null; h() } return toy.evaluate(spec, ctx, p) } } } })
        await twoRounds(rsi) //標記 r002
        //(a)本輪計畫當下所見之標記(r002)⇒ 本輪之生成節點兌現後清除
        rsi.store.pushFrontier([{ kind: 'arm', spec: P(9, -9), specHash: specHash(P(9, -9)), reason: 'gen', priority: 0, origin: { topic: 'generated', operator: 'G.new' } }])
        let e3 = await rsi.explore({})
        assert(e3.nodes.some((n) => _.get(n, 'origin.topic') === 'generated'))
        assert(e3.genClear && e3.genClear.cleared, JSON.stringify(e3.genClear))
        assert(!fs.existsSync(rsi.paths.genRequest))
        //(b)評估期間他輪寫入新標記(r777, 持有者存活)⇒ 本輪兌現亦不刪之
        rsi.store.pushFrontier([{ kind: 'arm', spec: P(8, -8), specHash: specHash(P(8, -8)), reason: 'gen2', priority: 0, origin: { topic: 'generated', operator: 'G.new' } }])
        hook = () => writeJson(rsi.paths.genRequest, { at: iso(), round: 'r777', roundDir: path.join(rsi.paths.rounds, 'r777'), by: `pid${process.pid}`, pid: process.pid, debt: 1, streak: 1 })
        let e4 = await rsi.explore({})
        assert(e4.nodes.some((n) => _.isEqual(n.spec, P(8, -8))))
        assert(e4.genClear && e4.genClear.cleared === false, JSON.stringify(e4.genClear))
        assert.equal(readJson(rsi.paths.genRequest).round, 'r777', '他輪之標記保留')
        assert.match(fs.readFileSync(path.join(e4.fd, 'report.md'), 'utf8'), /未清除/)
    })
    it('clearGenRequest:opt.round 只刪該輪之標記(作廢輪次);無 opt ⇒ 舊行為(無條件刪);非 JSON 之標記視同無標記;鎖已釋放', () => {
        let rsi = fresh('clear')
        writeJson(rsi.paths.genRequest, { at: iso(), round: 'r005' })
        let r1 = clearGenRequest(rsi, { round: 'r004' })
        assert.equal(r1.cleared, false); assert.match(r1.why, /標記屬 r005/); assert(fs.existsSync(rsi.paths.genRequest))
        assert.equal(rsi.clearGenRequest({ round: 'r005' }).cleared, true); assert(!fs.existsSync(rsi.paths.genRequest))
        writeJson(rsi.paths.genRequest, { at: iso(), round: 'r006' })
        assert.equal(clearGenRequest(rsi).cleared, true, '無 opt ⇒ 舊行為')
        fs.writeFileSync(rsi.paths.genRequest, '{bad')
        assert.equal(readGenRequest(rsi.paths), null)
        assert.equal(clearGenRequest(rsi, { round: 'r001' }).cleared, false)
        assert(!fs.existsSync(rsi.paths.genRequest), '非 JSON 之標記清掉')
        assert(!fs.existsSync(path.join(rsi.paths.policies, '.lock_policies')), '鎖已釋放')
    })
})
