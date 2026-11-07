import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import { createRsi, roundDirs, loadPolicyFile } from '../src/index.mjs'
import { readJsonl } from '../src/core/jsonl.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp, FD_TEST, FD_PACK } from './tools/tmpdir.mjs'


describe('loop/auto + sim/dream:每輪做夢快照、策略開發請求、單一寫者接受', function () {
    let t, rsi
    before(() => { t = makeTmp('auto'); rsi = createRsi({ root: path.join(t.dir, 'a'), domain: makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 } }).init() })
    after(() => { t.cleanup() })

    it('auto × 5:每輪做夢快照入 scores.jsonl;策略開發請求於第 3 輪觸發且全域只寫一份', async function () {
        this.timeout(180000)
        let reqs = []
        for (let i = 0; i < 5; i++) { let r = await rsi.auto({}); assert(r.dream && r.dream.rows[0].isCurrent); if (r.policyDev) { reqs.push(r.policyDev) } }
        assert.equal(roundDirs(rsi.paths).length, 5)
        let scores = readJsonl(rsi.paths.scores)
        assert(scores.length >= 5 && scores.every((s) => _.isFinite(s.heldOut)))
        assert.equal(reqs.length, 1, '請求只寫一份(全域標記)')
        assert(reqs[0].endsWith(path.join('r003', 'POLICY_DEV_REQUEST.md')))
        assert(fs.existsSync(rsi.paths.devRequest))
        let files = roundDirs(rsi.paths).filter((d) => fs.existsSync(path.join(rsi.paths.rounds, d, 'POLICY_DEV_REQUEST.md')))
        assert.deepEqual(files, ['r003'])
        assert(fs.readFileSync(path.join(rsi.paths.rounds, 'r003', 'report.md'), 'utf8').includes('策略開發請求'))
        assert(fs.readFileSync(path.join(rsi.paths.rounds, 'r005', 'report.md'), 'utf8').includes('做夢'))
    })
    it('dream.everyRound = false 與 minIntervalMs:做夢可交由獨立排程', async function () {
        this.timeout(120000)
        let r1 = createRsi({ root: path.join(t.dir, 'nodream'), domain: makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 }, dream: { everyRound: false } }).init()
        let a = await r1.auto({})
        assert.equal(a.dream, null)
        let r2 = createRsi({ root: path.join(t.dir, 'interval'), domain: makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 }, dream: { minIntervalMs: 1e9 } }).init()
        let b1 = await r2.auto({}); let b2 = await r2.auto({})
        assert(b1.dream && b2.dream === null)
        let d = await r2.dream({})
        assert(d.rows.length === 1 && _.isFinite(d.rows[0].score.heldOutMean), '獨立呼叫做夢仍可')
    })
    it('輪內做夢只打當前策略(currentOnly;--accept 與獨立呼叫照舊打全部;2026-10-07)', async function () {
        this.timeout(120000)
        let r3 = createRsi({ root: path.join(t.dir, 'curOnly'), domain: makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 } }).init()
        fs.copyFileSync(path.join(FD_PACK, 'src', 'search', 'policyV0.mjs'), path.join(r3.paths.candidates, 'cand.mjs'))
        let a = await r3.auto({})
        assert(a.dream && a.dream.rows.length === 1 && a.dream.rows[0].isCurrent, '輪內做夢不打候選')
        let d = await r3.dream({})
        assert.equal(d.rows.length, 2, '獨立呼叫仍打全部')
        let d2 = await r3.dream({ currentOnly: true })
        assert.equal(d2.rows.length, 1)
    })
    it('接受:相同候選不升版;當前為空策略時 v0 候選升版(v1 + current 重指 + changelog + 清除請求標記)', async function () {
        this.timeout(120000)
        fs.copyFileSync(path.join(FD_PACK, 'src', 'search', 'policyV0.mjs'), path.join(rsi.paths.candidates, 'cand.mjs'))
        let d = await rsi.dream({ accept: true })
        assert.equal(d.decision.ok, false); assert.match(d.decision.why, /未優於|飽和/)
        assert.equal(d.saturated, true, '同分候選 ⇒ 飽和判定(不升版, 轉生成)')
        assert(!fs.existsSync(path.join(rsi.paths.policies, 'v1.mjs')))
        //把當前換成空策略 → 候選(v0 之副本)必優於當前
        fs.copyFileSync(path.join(FD_TEST, 'tools', 'nullPolicy.mjs'), path.join(rsi.paths.policies, 'null.mjs'))
        fs.writeFileSync(rsi.paths.current, `export { default, meta } from './null.mjs'\n`)
        assert(fs.existsSync(rsi.paths.devRequest), '前一測試留下之請求標記')
        let d2 = await rsi.dream({ accept: true })
        assert.equal(d2.decision.ok, true, JSON.stringify(d2.decision)); assert.equal(d2.decision.version, 1); assert.equal(d2.decision.current, 'null')
        assert.equal(d2.saturated, false, '候選明顯優於當前 ⇒ 非飽和')
        assert(fs.existsSync(path.join(rsi.paths.policies, 'v1.mjs')))
        assert(fs.readFileSync(rsi.paths.current, 'utf8').includes(`./v1.mjs`))
        assert(fs.readFileSync(rsi.paths.changelog, 'utf8').includes('v1 ← cand.mjs'))
        assert(!fs.existsSync(rsi.paths.devRequest), '接受後清除請求標記')
        let cur = await rsi.loadPolicy()
        assert.equal(cur.meta.name, 'v0')
        let d3 = await rsi.dream({ accept: true })
        assert.equal(d3.decision.ok, false, '升版後同分候選不再升')
    })
    it('領域鉤子失敗(拋錯 / 回傳 failed)⇒ hook.failed 與 errors;報告仍寫(2026-09-26 審查)', async function () {
        this.timeout(120000)
        let r1 = createRsi({ root: path.join(t.dir, 'hookThrow'), domain: makeDomain({ hooks: { afterRound: async () => { throw new Error('鉤子爆了') } } }), budget: { arms: 6, novelty: 2, workers: 3 }, dream: { everyRound: false } }).init()
        let a = await r1.auto({})
        assert.equal(a.hook.failed, true); assert.deepEqual(a.hook.errors, ['鉤子爆了'])
        assert.match(fs.readFileSync(path.join(a.fd, 'report.md'), 'utf8'), /## 領域鉤子失敗/)
        let r2 = createRsi({ root: path.join(t.dir, 'hookFailed'), domain: makeDomain({ hooks: { afterRound: async () => ({ failed: true, errors: ['子程序 exit 1'], lines: ['## x', '', '- 子程序 exit 1'] }) } }), budget: { arms: 6, novelty: 2, workers: 3 }, dream: { everyRound: false } }).init()
        let b = await r2.auto({})
        assert.equal(b.hook.failed, true); assert.deepEqual(b.hook.errors, ['子程序 exit 1'])
        let r3 = createRsi({ root: path.join(t.dir, 'hookOk'), domain: makeDomain({ hooks: { afterRound: async () => ({ lines: ['## ok'] }) } }), budget: { arms: 6, novelty: 2, workers: 3 }, dream: { everyRound: false } }).init()
        let c = await r3.auto({})
        assert(!c.hook.failed)
    })
    it('候選靜態檢查不過(讀被遮蔽欄位 / 寫樹)→ 列錯不評分;current 不過則拋錯', async function () {
        this.timeout(60000)
        fs.writeFileSync(path.join(rsi.paths.candidates, 'bad.mjs'), `export const meta = { name: 'bad' }\nexport default (view) => { let v = view.nodes.map((n) => n.score.backtest); return { expand: [], novelty: [] } }\n`)
        let d = await rsi.dream({})
        let bad = d.rows.find((r) => r.name === 'bad.mjs')
        assert(bad && /靜態檢查不過/.test(bad.error))
        let p = await loadPolicyFile(path.join(rsi.paths.candidates, 'bad.mjs'), rsi.domain.forbidden)
        assert(p.error)
        fs.rmSync(path.join(rsi.paths.candidates, 'bad.mjs'))
    })
})
