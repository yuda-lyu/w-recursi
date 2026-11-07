import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { runJobs } from '../src/eval/runner.mjs'
import { slotsInUse, tryAcquireSlots, releaseSlots, slotsStatus, reclaimDeadSlots } from '../src/core/slots.mjs'
import { makeTmp, FD_TEST } from './tools/tmpdir.mjs'


let P = (x, y) => ({ kind: 'point', x, y })
const TOY = path.join(FD_TEST, 'tools', 'toy.mjs')
//以本測試程序之 pid 佔槽(存活 ⇒ 不會被回收)
let occupy = (dir, i) => { let fd = path.join(dir, `s${i}`); fs.mkdirSync(fd, { recursive: true }); fs.writeFileSync(path.join(fd, 'owner'), `${process.pid} ${new Date().toISOString()}`); return { i, fd } }

describe('eval/runner 動態派工(2026-09-25):佇列認領、運行中補槽、崩潰隔離', function () {
    let t
    before(() => { t = makeTmp('runnerQueue') })
    after(() => { t.cleanup() })

    it('佇列認領:一個慢 job + 五個快 job × 2 worker ⇒ 慢者之 worker 只做 1 個, 另一 worker 接手其餘 5 個(靜態分桶時為 3 / 3)', async function () {
        this.timeout(60000)
        let jobs = [{ id: 'slow', spec: P(1, 1), protocol: { delayMs: 3000 } }, ..._.range(5).map((k) => ({ id: `f${k}`, spec: P(k + 2, 1), protocol: { delayMs: 100 } }))]
        let r = await runJobs(jobs, { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'q1' })
        assert.equal(r.nWorkers, 2)
        for (let j of jobs) { assert.equal(r.results.get(j.id).ok, true, j.id) }
        let byPid = _.countBy(jobs.map((j) => r.results.get(j.id).meta.pid))
        let pidSlow = r.results.get('slow').meta.pid
        assert.equal(byPid[pidSlow], 1, '慢 job 之 worker 只做 1 個')
        assert.equal(_.sum(_.values(byPid)), 6)
        assert.deepEqual(_.sortBy(_.values(byPid)), [1, 5])
    })

    it('運行中補槽:起跑時 3 槽只剩 1 ⇒ 先開 1 worker;他人釋放 2 槽後自動加開至 3', async function () {
        this.timeout(90000)
        let slots = { dir: path.join(t.dir, 'slots_exp'), max: 3 }
        let h0 = occupy(slots.dir, 0), h1 = occupy(slots.dir, 1)
        let jobs = _.range(6).map((k) => ({ id: `e${k}`, spec: P(k + 1, 2), protocol: { delayMs: 1500 } }))
        let run = runJobs(jobs, { mode: 'spawn', evaluatorModule: TOY, workers: 3, tmpDir: t.dir, tag: 'q2', slots, expandMs: 200 })
        await new Promise((res) => setTimeout(res, 800))
        releaseSlots([h0, h1])
        let r = await run
        assert.equal(r.nWorkers, 3, '釋放後應加開至 3 個 worker')
        for (let j of jobs) { assert.equal(r.results.get(j.id).ok, true, j.id) }
        assert(_.uniq(jobs.map((j) => r.results.get(j.id).meta.pid)).length >= 2, '結果來自多個 worker')
        assert.equal(slotsInUse(slots.dir, { max: 3 }), 0, '全部結束後槽位歸零')
    })

    it('崩潰隔離:某 job 使其 worker 中途結束 ⇒ 只有該 job 無結果, 其餘 job 由其他 worker 完成', async function () {
        this.timeout(60000)
        let jobs = [{ id: 'boom', spec: P(7, 7), protocol: { exitIf: 'P\\(7,7\\)' } }, ..._.range(4).map((k) => ({ id: `ok${k}`, spec: P(k + 1, 3), protocol: { delayMs: 300 } }))]
        let r = await runJobs(jobs, { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'q3' })
        assert.equal(r.results.get('boom').ok, false)
        assert.match(r.results.get('boom').error, /worker 無結果/)
        for (let k = 0; k < 4; k++) { assert.equal(r.results.get(`ok${k}`).ok, true, `ok${k}`) }
        assert(r.exits.includes(3), '崩潰之 worker 離開碼 3')
    })

    it('評估器壞掉(啟動即失敗)且槽位不足:不會無限重開 worker, 呼叫正常結束並回報無結果', async function () {
        this.timeout(60000)
        let slots = { dir: path.join(t.dir, 'slots_bad'), max: 2 }
        let h = occupy(slots.dir, 0)
        let r = await runJobs([{ id: 'a', spec: P(1, 1) }, { id: 'b', spec: P(2, 2) }], { mode: 'spawn', evaluatorModule: path.join(FD_TEST, 'tools', 'nullPolicy.mjs'), workers: 2, tmpDir: t.dir, tag: 'q4', slots, expandMs: 100 })
        releaseSlots([h])
        assert.equal(r.nWorkers, 1, '只開了取得之 1 個, 失敗後不再補開')
        assert.equal(r.results.get('a').ok, false); assert.equal(r.results.get('b').ok, false)
        assert.equal(slotsInUse(slots.dir, { max: 2 }), 0)
    })

    it('續跑:同 tag 前次已完成之 job(鍵相符)不入佇列;全部已完成時不開 worker', async function () {
        this.timeout(60000)
        let jobs = [{ id: 'r1', spec: P(1, 5) }, { id: 'r2', spec: P(2, 5) }]
        let a = await runJobs(jobs, { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'q5' })
        assert(a.results.get('r1').ok && a.results.get('r2').ok)
        let b = await runJobs(jobs, { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'q5' })
        assert.equal(b.nWorkers, 0, '全部已完成 ⇒ 不開 worker')
        assert.deepEqual(b.results.get('r1').raw, a.results.get('r1').raw)
    })

    it('槽位工具:tryAcquireSlots 不等待;死槽(持有者已死)自動回收;slotsStatus / reclaimDeadSlots', () => {
        let dir = path.join(t.dir, 'slots_tool')
        let live = occupy(dir, 0)
        let fdDead = path.join(dir, 's1'); fs.mkdirSync(fdDead, { recursive: true }); fs.writeFileSync(path.join(fdDead, 'owner'), `999999 ${new Date().toISOString()}`)
        let st = slotsStatus(dir, { max: 2 })
        assert.deepEqual(st.map((s) => [s.slot, s.alive, s.dead]), [['s0', true, false], ['s1', false, true]])
        let t0 = Date.now()
        let got = tryAcquireSlots(dir, { want: 2, max: 2 })
        assert(Date.now() - t0 < 1000, '不等待')
        assert.deepEqual(got.map((h) => h.i), [1], '死槽被回收後取得, 活槽不動')
        releaseSlots(got)
        let fdDead2 = path.join(dir, 's1'); fs.mkdirSync(fdDead2, { recursive: true }); fs.writeFileSync(path.join(fdDead2, 'owner'), `999999 ${new Date().toISOString()}`)
        assert.equal(reclaimDeadSlots(dir, { max: 2 }), 1)
        assert.equal(fs.existsSync(fdDead2), false)
        assert.equal(fs.existsSync(live.fd), true)
        assert.deepEqual(tryAcquireSlots(dir, { want: 1, max: 1 }), [], '唯一槽被活者占用 ⇒ 空')
        releaseSlots([live])
    })
})
