import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { createRsi, loadPolicyFile, checkPolicySource, lastChangeAtOf } from '../src/index.mjs'
import { relativeImportsOf } from '../src/sim/dream.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp, FD_PACK } from './tools/tmpdir.mjs'


//攔截 console.warn
let captureWarn = (fn) => { let got = [], orig = console.warn; console.warn = (...a) => got.push(a.join(' ')); try { fn() } finally { console.warn = orig } return got }

//策略檔之載入與策略開發觸發、init(2026-09-29)
describe('sim/dream + loop/policyDev + init:轉匯出目標之靜態檢查、改版時刻之解析、init 不覆寫 v0', function () {
    let t
    before(() => { t = makeTmp('policyLoad') })
    after(() => { t.cleanup() })

    it('靜態檢查:loadPolicyFile 之靜態檢查涵蓋相對匯入閉包(轉匯出目標 / 鏈 / 環 / 缺檔 / 註解列)', async function () {
        this.timeout(30000)
        let fd = path.join(t.dir, 'pol')
        fs.mkdirSync(fd, { recursive: true })
        let W = (f, s) => fs.writeFileSync(path.join(fd, f), s)
        let L = (f) => loadPolicyFile(path.join(fd, f), toy.forbidden)
        W('bad.mjs', "export const meta = { name: 'bad' }\nexport default (view) => { let v = view.nodes.map((n) => n.score.backtest); return { expand: [], novelty: [] } }\n")
        W('cur.mjs', '//當前策略(一行轉匯出)\nexport { default, meta } from \'./bad.mjs\'\n')
        assert.deepEqual(checkPolicySource(fs.readFileSync(path.join(fd, 'cur.mjs'), 'utf8'), toy.forbidden), [], '對照:只查本檔原文 ⇒ 過(即原漏洞)')
        let p = await L('cur.mjs')
        assert(p.error && /靜態檢查不過/.test(p.error) && /bad\.mjs/.test(p.error), p.error)
        //乾淨目標 ⇒ 載入;checked 列本檔與目標;src 仍為本檔原文(dream --accept 以之比對 current.mjs)
        W('good.mjs', "export const meta = { name: 'good' }\nexport default (view) => ({ expand: [], novelty: [] })\n")
        W('cur2.mjs', "export { default, meta } from './good.mjs'\n")
        let g = await L('cur2.mjs')
        assert(!g.error, g.error); assert.equal(g.meta.name, 'good')
        assert.deepEqual(g.checked.map((x) => path.basename(x)), ['cur2.mjs', 'good.mjs'])
        assert.equal(g.src, fs.readFileSync(path.join(fd, 'cur2.mjs'), 'utf8'))
        //鏈:cur3 → mid → bad(第二層之違規亦擋)
        W('mid.mjs', "export { default, meta } from './bad.mjs'\n")
        W('cur3.mjs', "export { default, meta } from './mid.mjs'\n")
        assert.match((await L('cur3.mjs')).error, /bad\.mjs/)
        //環:a ↔ b(不無窮迴圈;兩檔皆受檢)
        W('a.mjs', "import './b.mjs'\nexport const meta = { name: 'a' }\nexport default () => ({ expand: [], novelty: [] })\n")
        W('b.mjs', "import './a.mjs'\nexport const x = 1\n")
        let a = await L('a.mjs')
        assert(!a.error, a.error); assert.equal(a.checked.length, 2)
        //目標不存在 ⇒ 錯誤(不載入)
        W('cur4.mjs', "export { default, meta } from './nope.mjs'\n")
        assert.match((await L('cur4.mjs')).error, /不存在/)
        //整列註解中之匯入字樣不算
        W('cur5.mjs', "// 舊:export { default, meta } from './bad.mjs'\nexport { default, meta } from './good.mjs'\n")
        let c5 = await L('cur5.mjs')
        assert(!c5.error, c5.error); assert.deepEqual(c5.checked.map((x) => path.basename(x)), ['cur5.mjs', 'good.mjs'])
        assert.deepEqual(relativeImportsOf("import _ from 'lodash-es'\nimport x from './x.mjs'\nexport * from \"../y.mjs\"\nlet m = await import('./z.mjs')\n// import './c.mjs'\n"), ['./x.mjs', '../y.mjs', './z.mjs'])
    })

    it('改版時刻:末次改版時刻 = 自末列往前第一個列首為完整 ISO 之列;手寫之日期列 / 列中之 ISO 不算;觸發之輪數以時刻比較', () => {
        assert.equal(lastChangeAtOf('- 2026-09-25T14:49:17.464Z v1 ← c9\n- 2026-09-28 v2 2.2.0(同檔)\n'), '2026-09-25T14:49:17.464Z', '列首無 ISO 之手寫列略過')
        assert.equal(lastChangeAtOf('- 2026-09-28 備註(見 2026-09-25T14:49:17.464Z)\n'), null, '列中之 ISO 不算(只取列首)')
        assert.equal(lastChangeAtOf('- 2026-09-28T10:54:00Z v2(手寫但完整 ISO)\n'), '2026-09-28T10:54:00Z')
        assert.equal(lastChangeAtOf(''), null)
        let rsi = createRsi({ root: path.join(t.dir, 'dev'), domain: toy.makeDomain() }).init()
        //末列為手寫日期列、真改版(ISO)在其前;三輪皆在改版前 ⇒ 不觸發(舊式 slice(2, 26):'2026-09-28T05…' > '2026-09-28 手寫…' ⇒ 三輪皆算改版後 ⇒ 誤觸發)
        fs.writeFileSync(rsi.paths.changelog, '- 2026-09-28T10:00:00.000Z v3 ← x\n- 2026-09-28 手寫備註(同檔改版)\n')
        let fdR = path.join(rsi.paths.rounds, 'r001'); fs.mkdirSync(fdR, { recursive: true })
        let before = ['05', '06', '07'].map((h) => ({ at: `2026-09-28T${h}:00:00.000Z`, ladderGe1: 1, nExecuted: 2 }))
        assert.equal(rsi.policyDevCheck(fdR, before), null)
        let after = ['11', '12', '13'].map((h) => ({ at: `2026-09-28T${h}:00:00.000Z`, ladderGe1: 1, nExecuted: 2 }))
        let fp = rsi.policyDevCheck(fdR, [...before, ...after])
        assert(fp && fs.existsSync(fp), '改版後 3 輪 ⇒ 觸發')
        assert.match(JSON.parse(fs.readFileSync(rsi.paths.devRequest, 'utf8')).why, /距上次策略改版已 3 輪/)
    })

    it('init:不覆寫既有之 v0.mjs(current.mjs 缺時才建之);缺 v0 ⇒ 以套件版寫入;current 缺而已有 v1 ⇒ 警告;current 已在 ⇒ 不動', async function () {
        this.timeout(30000)
        let root = path.join(t.dir, 'init')
        fs.mkdirSync(path.join(root, 'policies'), { recursive: true })
        let mine = "//領域之 v0\nexport const meta = { name: 'v0dom', version: '0.1.2' }\nexport default () => ({ expand: [], novelty: [] })\n"
        fs.writeFileSync(path.join(root, 'policies', 'v0.mjs'), mine)
        let rsi = createRsi({ root, domain: toy.makeDomain() }).init()
        assert.equal(fs.readFileSync(path.join(root, 'policies', 'v0.mjs'), 'utf8'), mine, '既有 v0.mjs 不被覆寫')
        assert.match(fs.readFileSync(rsi.paths.current, 'utf8'), /\.\/v0\.mjs/)
        assert.equal((await rsi.loadPolicy()).meta.name, 'v0dom')
        let root2 = path.join(t.dir, 'init2')
        createRsi({ root: root2, domain: toy.makeDomain() }).init()
        assert.equal(fs.readFileSync(path.join(root2, 'policies', 'v0.mjs'), 'utf8'), fs.readFileSync(path.join(FD_PACK, 'src', 'search', 'policyV0.mjs'), 'utf8'))
        let root3 = path.join(t.dir, 'init3')
        fs.mkdirSync(path.join(root3, 'policies'), { recursive: true })
        fs.writeFileSync(path.join(root3, 'policies', 'v1.mjs'), mine)
        let warns = captureWarn(() => createRsi({ root: root3, domain: toy.makeDomain() }).init())
        assert(warns.some((w) => /已有 v1\.mjs/.test(w)), warns.join('\n'))
        let cur0 = fs.readFileSync(rsi.paths.current, 'utf8')
        fs.writeFileSync(path.join(root, 'policies', 'v0.mjs'), mine + '//再改\n')
        createRsi({ root, domain: toy.makeDomain() }).init()
        assert.equal(fs.readFileSync(rsi.paths.current, 'utf8'), cur0)
        assert.equal(fs.readFileSync(path.join(root, 'policies', 'v0.mjs'), 'utf8'), mine + '//再改\n')
    })
})
