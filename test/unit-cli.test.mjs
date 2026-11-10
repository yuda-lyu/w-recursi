import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { makePaths } from '../src/core/paths.mjs'
import { makeStore } from '../src/tree/store.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp, FD_TEST, FD_PACK } from './tools/tmpdir.mjs'


describe('cli:真實呼叫端用法(node src/cli.mjs --config <cfg.mjs> --mode …)', function () {
    let t, cli, store
    before(() => {
        t = makeTmp('cli')
        cli = (...args) => { let r = spawnSync(process.execPath, [path.join(FD_PACK, 'src', 'cli.mjs'), '--config', path.join(FD_TEST, 'tools', 'toyConfig.mjs'), ...args], { env: { ...process.env, RSI_ROOT: t.dir }, encoding: 'utf8', cwd: FD_PACK, windowsHide: true }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') } }
        store = makeStore({ paths: makePaths(t.dir), domain: makeDomain() })
    })
    after(() => { t.cleanup() })

    it('init:建 policies/current.mjs 與 v0.mjs', () => {
        let r = cli('--mode', 'init')
        assert.equal(r.code, 0, r.out); assert.match(r.out, /已初始化/)
        assert(fs.existsSync(path.join(t.dir, 'policies', 'current.mjs')) && fs.existsSync(path.join(t.dir, 'policies', 'v0.mjs')))
    })
    it('explore --dry 不佔輪號;explore 落地 r001 並印計畫與完成行', function () {
        this.timeout(60000)
        let d = cli('--mode', 'explore', '--dry')
        assert.equal(d.code, 0, d.out); assert.match(d.out, /乾跑/)
        assert(!fs.existsSync(path.join(t.dir, 'rounds', 'r001')))
        let r = cli('--mode', 'explore', '--by', 'tester')
        assert.equal(r.code, 0, r.out); assert.match(r.out, /第 1 輪:計畫 2 臂/); assert.match(r.out, /第 1 輪完成:執行 2/)
        assert(fs.existsSync(path.join(t.dir, 'rounds', 'r001', 'report.md')))
        assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'rounds', 'r001', 'summary.json'), 'utf8')).by, 'tester')
    })
    it('auto / status / dream 之輸出', function () {
        this.timeout(120000)
        let a = cli('--mode', 'auto')
        assert.equal(a.code, 0, a.out); assert.match(a.out, /第 2 輪完成/); assert.match(a.out, /current\(v0\)/); assert.match(a.out, /樹:\d+ 節點/)
        let s = cli('--mode', 'status')
        assert.equal(s.code, 0, s.out); assert.match(s.out, /已完成輪次 2/); assert.match(s.out, /最佳節點/)
        let dr = cli('--mode', 'dream', '--rounds', '3')
        assert.equal(dr.code, 0, dr.out); assert.match(dr.out, /留出均/)
    })
    it('evidence --set(2026-10-01):k=v 與別名同效;未宣告於 cfg.evidenceKeys 之鍵、格式錯、同鍵重複 ⇒ exit 2 且未寫', function () {
        this.timeout(60000)
        let row = store.listIndex().find((r) => r.status === 'executed' && r.ladder !== 4) //不動下一案所需之階梯 4 節點
        assert(row, '應有已執行之非階梯 4 節點')
        let e = cli('--mode', 'evidence', '--node', row.id, '--set', 'mech=true,usability=false', '--ref', 'proof/set')
        assert.equal(e.code, 0, e.out)
        let n = store.getNode(row.id)
        assert.equal(n.evidence.mech, true); assert.equal(n.evidence.usability, false)
        let nRefs = n.evidence.refs.length
        for (let [args, re] of [[['--set', 'mechh=true'], /未於 cfg\.evidenceKeys 宣告/], [['--set', 'mech'], /須為 k=v/], [['--set', 'mech=false', '--mech', 'true'], /重複給定/]]) {
            let r = cli('--mode', 'evidence', '--node', row.id, ...args, '--ref', 'proof/bad')
            assert.equal(r.code, 2, r.out); assert.match(r.out, re)
        }
        let n2 = store.getNode(row.id)
        assert.equal(n2.evidence.mech, true, '被拒者未寫'); assert.equal(n2.evidence.refs.length, nRefs)
    })
    it('evidence 寫回:階梯 4 → 5(btcOK);invalidate;reclaim', function () {
        this.timeout(60000)
        let row = store.listIndex().find((r) => r.status === 'executed' && r.ladder === 4)
        assert(row, '應有階梯 4 節點')
        let e = cli('--mode', 'evidence', '--node', row.id, '--btcOK', 'true', '--ref', 'proof/x', '--note', 'test')
        assert.equal(e.code, 0, e.out); assert.match(e.out, /階梯 5/)
        let n = store.getNode(row.id)
        assert.equal(n.evidence.btcOK, true); assert.equal(n.evidence.refs.length, 1); assert.equal(n.score.ladder, 5)
        let inv = cli('--mode', 'invalidate', '--ids', row.id, '--why', 'test')
        assert.equal(inv.code, 0, inv.out); assert.match(inv.out, /標無效 1/)
        assert.equal(store.getNode(row.id).status, 'invalid')
        let rc = cli('--mode', 'reclaim')
        assert.equal(rc.code, 0, rc.out); assert.match(rc.out, /回收遺留認領 0/)
        let bad = cli('--mode', 'nope')
        assert.notEqual(bad.code, 0)
    })
    it('auto 之領域鉤子失敗 ⇒ 離開碼 1、印錯誤, 報告仍落地(2026-09-26 審查:原離開碼 0)', function () {
        this.timeout(120000)
        let root = path.join(t.dir, 'hookfail')
        let run = (...args) => { let r = spawnSync(process.execPath, [path.join(FD_PACK, 'src', 'cli.mjs'), '--config', path.join(FD_TEST, 'tools', 'toyConfig.mjs'), ...args], { env: { ...process.env, RSI_ROOT: root, RSI_TOY_HOOK_FAIL: '1' }, encoding: 'utf8', cwd: FD_PACK, windowsHide: true }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') } }
        assert.equal(run('--mode', 'init').code, 0)
        let a = run('--mode', 'auto')
        assert.equal(a.code, 1, a.out)
        assert.match(a.out, /第 1 輪完成/)
        assert.match(a.out, /領域鉤子失敗:toy 鉤子失敗/)
        assert.match(fs.readFileSync(path.join(root, 'rounds', 'r001', 'report.md'), 'utf8'), /## 領域鉤子失敗/)
    })
    it('寫入類模式之前置守門 cfg.beforeWrite:explore / evidence / reclaim 被擋(exit 3、未寫);乾跑與唯讀不經守門(2026-09-26)', function () {
        this.timeout(120000)
        let root = path.join(t.dir, 'guard')
        let run = (env, ...args) => { let r = spawnSync(process.execPath, [path.join(FD_PACK, 'src', 'cli.mjs'), '--config', path.join(FD_TEST, 'tools', 'toyConfig.mjs'), ...args], { env: { ...process.env, RSI_ROOT: root, ...env }, encoding: 'utf8', cwd: FD_PACK, windowsHide: true }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') } }
        assert.equal(run({}, '--mode', 'init').code, 0)
        let G = { RSI_TOY_GUARD: '1' }
        let e = run(G, '--mode', 'explore', '--by', 'g')
        assert.equal(e.code, 3, e.out); assert.match(e.out, /toy 守門拒絕:w-recursi cli --mode explore/)
        assert(!fs.existsSync(path.join(root, 'rounds', 'r001')), '被擋 ⇒ 未落輪次')
        assert.equal(run(G, '--mode', 'reclaim').code, 3)
        assert.equal(run(G, '--mode', 'evidence', '--node', 'x', '--ref', 'proof/x').code, 3)
        let d = run(G, '--mode', 'explore', '--dry')
        assert.equal(d.code, 0, d.out)
        assert.equal(run(G, '--mode', 'status').code, 0)
        assert.equal(run(G, '--mode', 'turning').code, 0, '唯讀之 turning 不經守門')
        assert.equal(run(G, '--mode', 'turning', '--push').code, 3, '--push 寫前緣 ⇒ 經守門')
    })
})
