import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import _ from 'lodash-es'
import { createRsi, roundDirs } from '../src/index.mjs'
import { slotsInUse } from '../src/core/slots.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp, FD_TEST } from './tools/tmpdir.mjs'


let run = (args) => new Promise((resolve) => { let p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d }); p.on('exit', (code) => resolve({ code, out, err })) })
let CHILD = path.join(FD_TEST, 'tools', 'exploreChild.mjs')
let parse = (out) => out.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))

describe('併行:多 session 同時探索(認領 / 原子輪號 / 全域槽位)', function () {
    let t
    before(() => { t = makeTmp('concurrency') })
    after(() => { t.cleanup() })

    it('3 子程序 × 2 波(同程序評估):輪號唯一、規格不重複評估、無殘留認領、樹一致', async function () {
        this.timeout(240000)
        let root = path.join(t.dir, 'a')
        let seed = createRsi({ root, domain: makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 } }).init()
        for (let i = 0; i < 2; i++) { await seed.explore({}) }
        let seeded = seed.store.listIndex().filter((r) => r.status === 'executed').length
        let rs = await Promise.all([1, 2, 3].map(() => run([CHILD, root, '6', '2', '3', '120', '2'])))
        assert.deepEqual(rs.map((r) => r.code), [0, 0, 0], rs.map((r) => r.err).join('\n'))
        let rows = _.flatMap(rs, (r) => parse(r.out))
        assert.equal(rows.length, 6)
        let rounds = rows.map((r) => r.round).sort((a, b) => a - b)
        assert.deepEqual(rounds, [3, 4, 5, 6, 7, 8], '六輪輪號唯一且接續')
        assert.deepEqual(roundDirs(seed.paths), ['r001', 'r002', 'r003', 'r004', 'r005', 'r006', 'r007', 'r008'])
        let idx = seed.store.listIndex()
        assert.equal(_.uniq(idx.map((r) => r.id)).length, idx.length, 'index 無重複 id')
        assert(!idx.some((r) => ['planned', 'running'].includes(r.status)), '無殘留認領')
        let exec = seed.store.loadNodes((r) => r.status === 'executed')
        assert.equal(_.uniq(exec.map((n) => n.specHash)).length, exec.length, '同規格不會被兩個 session 各評一次')
        assert.equal(exec.length, seeded + _.sum(rows.map((r) => r.nExecuted)), '子程序回報之執行數與樹一致')
        let allIds = _.flatMap(rows, (r) => r.ids)
        assert.equal(_.uniq(allIds).length, allIds.length, '各 session 執行之節點互斥')
        for (let d of roundDirs(seed.paths)) { assert(fs.existsSync(path.join(seed.paths.rounds, d, 'summary.json')), `${d} 有 summary`) }
        console.log(`      併行摘要:${rows.map((r) => `r${r.round}:${r.nPlanned}/skip${r.nSkipped}`).join(' ')}`)
    })
    it('spawn 模式 × 全域槽位 max 3:三 session 各要 3 worker, 任一時刻運作中之 worker ≤ 3;槽位用畢歸零', async function () {
        this.timeout(300000)
        let root = path.join(t.dir, 'b')
        let log = path.join(t.dir, 'b_eval.log')
        let seed = createRsi({ root, domain: makeDomain(), budget: { arms: 8, novelty: 2, workers: 4 } }).init()
        for (let i = 0; i < 2; i++) { await seed.explore({}) }
        let rs = await Promise.all([1, 2, 3].map(() => run([CHILD, root, '8', '2', '3', '150', '1', '1', '3', log])))
        assert.deepEqual(rs.map((r) => r.code), [0, 0, 0], rs.map((r) => r.err).join('\n'))
        let rows = _.flatMap(rs, (r) => parse(r.out))
        assert(_.sum(rows.map((r) => r.nExecuted)) >= 3, '至少有節點被子程序評估')
        let iv = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => { let [pid, t0, t1] = l.split(' ').map(Number); return { pid, t0, t1 } })
        assert(iv.length >= 3)
        //掃描線:同一時刻進行中之評估(每 worker 一次只評一個)≤ 3
        let ev = []
        for (let r of iv) { ev.push([r.t0, 1]); ev.push([r.t1, -1]) }
        ev.sort((a, b) => a[0] - b[0] || a[1] - b[1])
        let cur = 0, peak = 0
        for (let [, d] of ev) { cur += d; peak = Math.max(peak, cur) }
        assert(peak <= 3, `同時運作 worker 峰值 ${peak} > 3`)
        assert(_.uniq(iv.map((r) => r.pid)).length >= 2, '確有多個 worker 子程序參與')
        assert.equal(slotsInUse(seed.paths.slots, { max: 3 }), 0)
        let idx = seed.store.listIndex()
        assert(!idx.some((r) => ['planned', 'running'].includes(r.status)))
        console.log(`      槽位峰值 ${peak};評估 ${iv.length} 次;worker pid ${_.uniq(iv.map((r) => r.pid)).length} 個`)
    })
})
