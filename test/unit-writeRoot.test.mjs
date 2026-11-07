import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import * as J from '../src/core/jsonl.mjs'
import { createRsi } from '../src/index.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp, FD_PACK } from './tools/tmpdir.mjs'


//寫域守門(2026-10-09;某次事故:預寫沙箱之 CLI 經墊片指向真模組, 漏打 --dry 即以未審之碼寫生產之輪夾 / 清單)
//  環境變數 RSI_WRITE_ROOT(一或多根, path.delimiter 分隔)有值 ⇒ jsonl 原語(writeFileAtomic / writeJson / writeJsonl / appendJsonl)與引擎之輪夾 / 報告 / 請求 / 升版 / init 之寫入, 目標須在根下;未設 ⇒ 不檢
//  WR01 未設 / 空白 ⇒ 不檢(根外照寫, 與改前逐位同)
//  WR02 根內可寫;根外拋(code ERSI_WRITE_ROOT, 訊息含目標與根)且未建目標、未留暫存檔;appendJsonl / writeJson / writeJsonl 同守
//  WR03 `..` 穿越、同前綴之兄弟夾(<根>x)、根本身 ⇒ 擋;多根(path.delimiter);相對根依 cwd;Windows 不分大小寫
//  WR04 經 junction / 符號連結指出根外 ⇒ 擋(實際路徑之判定)
//  WR05 引擎之寫者:根外之狀態根 ⇒ explore 於建輪夾之前拋(不建輪夾、不寫樹);乾跑照常;init 之策略檔、生成 / 策略開發請求之文字、升版、clearGenRequest 皆守
//  WR06 真實呼叫端:w-recursi CLI 於 RSI_WRITE_ROOT 之根外跑 explore ⇒ 非 0 結束且未落輪夾;status / explore --dry(唯讀)不受影響
describe('core/writeRoot:寫域守門', function () {
    let t, W
    before(async () => { t = makeTmp('writeRoot'); W = await import('../src/core/writeRoot.mjs').catch(() => null) })
    after(() => { t.cleanup() })
    let withEnv = (v, fn) => { let o = process.env.RSI_WRITE_ROOT; if (v === undefined) { delete process.env.RSI_WRITE_ROOT } else { process.env.RSI_WRITE_ROOT = v } try { return fn() } finally { if (o === undefined) { delete process.env.RSI_WRITE_ROOT } else { process.env.RSI_WRITE_ROOT = o } } }
    let isGuard = (e) => e && e.code === 'ERSI_WRITE_ROOT'
    let tmpsIn = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.tmp')) : [])

    it('WR01 未設 / 空白 ⇒ 不檢:根外照寫', () => {
        let out = path.join(t.dir, 'free', 'a.json')
        fs.mkdirSync(path.dirname(out), { recursive: true })
        withEnv(undefined, () => { J.writeJson(out, { a: 1 }); J.appendJsonl(path.join(t.dir, 'free', 'b.jsonl'), { b: 1 }) })
        assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { a: 1 })
        withEnv('   ', () => { J.writeJson(out, { a: 2 }) })
        assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { a: 2 })
    })

    it('WR02 根內可寫;根外拋(含目標與根)且未建目標、未留暫存;四個原語同守', () => {
        let root = path.join(t.dir, 'root'), outside = path.join(t.dir, 'outside')
        fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(outside, { recursive: true })
        withEnv(root, () => {
            J.writeJson(path.join(root, 'ok.json'), { ok: 1 })
            J.appendJsonl(path.join(root, 'ok.jsonl'), { ok: 1 })
            fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
            J.writeJsonl(path.join(root, 'sub', 'ok2.jsonl'), [{ a: 1 }])
            let fp = path.join(outside, 'x.json')
            for (let [what, fn] of [['writeJson', () => J.writeJson(fp, { x: 1 })], ['writeFileAtomic', () => J.writeFileAtomic(fp, 'x')], ['writeJsonl', () => J.writeJsonl(fp, [{ x: 1 }])], ['appendJsonl', () => J.appendJsonl(fp, { x: 1 })]]) {
                assert.throws(fn, (e) => isGuard(e) && e.message.includes(path.resolve(fp)) && e.message.includes(path.resolve(root)), `${what} 須拋寫域守門之錯`)
            }
            assert(!fs.existsSync(fp), '根外之目標未建')
            assert.deepEqual(tmpsIn(outside), [], '未留暫存檔')
        })
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'ok.json'), 'utf8')), { ok: 1 })
    })

    it('WR03 `..` 穿越、同前綴兄弟夾、根本身 ⇒ 擋;多根;相對根依 cwd;Windows 不分大小寫', () => {
        assert(W, 'core/writeRoot.mjs 須存在')
        let root = path.join(t.dir, 'r3'), sib = path.join(t.dir, 'r3x'), other = path.join(t.dir, 'r3b')
        for (let d of [root, sib, other]) { fs.mkdirSync(d, { recursive: true }) }
        let ok = (fp, v = root) => W.writeAllowed(fp, { env: { RSI_WRITE_ROOT: v } })
        assert.equal(ok(path.join(root, 'a', 'b.json')), true)
        assert.equal(ok(path.join(root, '..', 'r3x', 'b.json')), false, '`..` 穿越')
        assert.equal(ok(`${root}${path.sep}..${path.sep}outside.json`), false)
        assert.equal(ok(path.join(sib, 'b.json')), false, '同前綴之兄弟夾 r3x')
        assert.equal(ok(root), false, '根本身不作為寫入之目標')
        assert.equal(ok(path.join(other, 'b.json'), [root, other].join(path.delimiter)), true, '多根之第二根')
        assert.equal(ok(path.join(sib, 'b.json'), [root, other].join(path.delimiter)), false)
        let relRoot = path.relative(process.cwd(), root)
        assert.equal(ok(path.join(root, 'c.json'), relRoot), true, '相對根依 cwd 解析')
        assert.deepEqual(W.writeRootsOf({ RSI_WRITE_ROOT: ` ${root} ${path.delimiter}${path.delimiter} ` }), [path.resolve(root)], '去空白與空段')
        assert.equal(W.writeRootsOf({}), null)
        if (process.platform === 'win32') { assert.equal(ok(path.join(root.toUpperCase(), 'd.json'), root.toLowerCase()), true, 'Windows 不分大小寫') }
        assert.throws(() => W.assertWriteRoot(path.join(sib, 'b.json'), { env: { RSI_WRITE_ROOT: root }, what: '測試' }), (e) => isGuard(e) && /測試 之目標/.test(e.message) && e.target === path.resolve(path.join(sib, 'b.json')) && e.roots[0] === path.resolve(root))
    })

    it('WR04 經 junction / 符號連結指出根外 ⇒ 擋(實際路徑之判定)', function () {
        assert(W, 'core/writeRoot.mjs 須存在')
        let root = path.join(t.dir, 'r4'), outside = path.join(t.dir, 'r4out')
        fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(outside, { recursive: true })
        let link = path.join(root, 'link')
        try { fs.symlinkSync(outside, link, 'junction') } catch (e) { this.skip() }
        let env = { RSI_WRITE_ROOT: root }
        assert.equal(W.writeAllowed(path.join(link, 'x.json'), { env }), false, 'junction 指向根外')
        assert.equal(W.writeAllowed(path.join(link, 'deeper', 'x.json'), { env }), false, '其下之未存在段亦擋')
        withEnv(root, () => { assert.throws(() => J.writeJson(path.join(link, 'x.json'), { x: 1 }), isGuard) })
        assert(!fs.existsSync(path.join(outside, 'x.json')))
        try { fs.unlinkSync(link) } catch (e) { fs.rmdirSync(link) } //只拆連結本身(不遞迴、不跟隨)
        assert(!fs.existsSync(link) && fs.existsSync(outside), '只拆連結, 不動目標')
    })

    it('WR05 引擎之寫者:根外之狀態根 ⇒ explore 於建輪夾前拋(不建輪夾、不寫樹);乾跑照常;init / 請求 / 升版 / 清除標記皆守', async function () {
        this.timeout(60000)
        let sbxRoot = path.join(t.dir, 'sbxOnly'), prod = path.join(t.dir, 'prod')
        fs.mkdirSync(sbxRoot, { recursive: true })
        let rsi = createRsi({ root: prod, domain: makeDomain(), budget: { arms: 4, novelty: 2, workers: 2 } }).init() //守門未設時建好狀態根(= 生產)
        let o = process.env.RSI_WRITE_ROOT
        process.env.RSI_WRITE_ROOT = sbxRoot
        try {
            let dry = await rsi.explore({ dry: true })
            assert.equal(dry.dry, true); assert(dry.items.length > 0, '乾跑照常出計畫')
            await assert.rejects(rsi.explore({ by: 'sbx' }), isGuard)
            assert.deepEqual(fs.readdirSync(path.join(prod, 'rounds')), [], '未建輪夾')
            assert.equal(rsi.store.listIndex().length, 0, '未寫樹')
            assert.throws(() => rsi.clearGenRequest({}), isGuard, '清除生成請求之標記亦守')
            fs.rmSync(rsi.paths.current)
            assert.throws(() => rsi.init(), isGuard, 'init 之策略檔亦守')
        }
        finally { if (o === undefined) { delete process.env.RSI_WRITE_ROOT } else { process.env.RSI_WRITE_ROOT = o } }
        rsi.init()
        //同一實例於根內(根 = 狀態根之上層)⇒ 照常落地
        let o2 = process.env.RSI_WRITE_ROOT
        process.env.RSI_WRITE_ROOT = t.dir
        try { let ex = await rsi.explore({ by: 'in' }); assert.equal(ex.round, 1); assert(fs.existsSync(path.join(ex.fd, 'report.md'))) }
        finally { if (o2 === undefined) { delete process.env.RSI_WRITE_ROOT } else { process.env.RSI_WRITE_ROOT = o2 } }
    })

    it('WR06 真實呼叫端:w-recursi CLI 於根外跑 explore ⇒ 非 0 且未落輪夾;status / explore --dry 不受影響', function () {
        this.timeout(120000)
        let prod = path.join(t.dir, 'cliProd'), root = path.join(t.dir, 'cliRoot')
        fs.mkdirSync(root, { recursive: true })
        let cli = (env, ...args) => { let r = spawnSync(process.execPath, [path.join(FD_PACK, 'src', 'cli.mjs'), '--config', path.join(FD_PACK, 'test', 'tools', 'toyConfig.mjs'), ...args], { env: { ...process.env, RSI_ROOT: prod, ...env }, encoding: 'utf8', cwd: FD_PACK }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` } }
        assert.equal(cli({ RSI_WRITE_ROOT: '' }, '--mode', 'init').code, 0)
        let G = { RSI_WRITE_ROOT: root }
        let e = cli(G, '--mode', 'explore', '--by', 'g')
        assert.notEqual(e.code, 0, e.out)
        assert.match(e.out, /寫域守門/)
        assert.deepEqual(fs.readdirSync(path.join(prod, 'rounds')), [], '未落輪夾')
        assert.equal(cli(G, '--mode', 'status').code, 0)
        let d = cli(G, '--mode', 'explore', '--dry')
        assert.equal(d.code, 0, d.out)
    })
})
