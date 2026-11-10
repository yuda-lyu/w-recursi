import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import _ from 'lodash-es'
import { createRsi, CFG_KEYS, checkCfg, makeArms, validateCatalog, checkArmsCfg, ARM_KEYS, ARMS_CFG_KEYS, unusedOf, featureOf } from '../src/index.mjs'
import { makeDomain, carriers, operators } from './tools/toy.mjs'
import { CATALOG, ARMS } from './tools/toyArms.mjs'
import { makeTmp, FD_PACK } from './tools/tmpdir.mjs'


//臂目錄(2026-11-07;search/arms.mjs):外部注入之多臂選單, 使 agent 於探索時自選單 / 多臂
//  AR01 validateCatalog:合法目錄無誤;未知鍵 / id 重複 / 狀態非法 / blocked 無來源 / 算子不在登錄表 / requires 指向不存在 ⇒ 列錯;used 無 grid ⇒ 警告
//  AR02 pick:目錄無此臂 / 封鎖 / 不可選 / done 未附 reopen ⇒ 拒;done + reopen 放行;conflicts 後選者拒;requires 未同選 ⇒ 拒
//  AR03 explore 之 opt.useArms:計畫只含所選臂之算子(展開)、全域與他臂之前緣 / 載體不入;計畫項與節點之 origin.arms;plan.json / summary 記 useArms;無 useArms 時 plan.json 與無目錄者逐欄同(只多 origin.arms)
//  AR04 compose:兩臂依序施用產子規格, 去重且全過 validateSpec, path 記算子序;無算子項之臂列 skipped
//  AR05 coverage / menu:樹上節點依 origin.arms ∪ origin.operator 計入;特徵口徵;選單含每臂與未用格點
//  AR06 CLI:--mode arms 印選單;--mode explore --dry --use-arms px 之計畫只含 P.x;--use-arms blk ⇒ exit 2 且未寫檔
//  AR07 cfg:CFG_KEYS 含 arms;cfg.arms 未知鍵 / use 非陣列 ⇒ createRsi 拋錯;目錄不合 ⇒ 拋錯
describe('search/arms:臂目錄之注入、選臂、限臂、組合、覆蓋、選單、CLI', function () {
    this.timeout(180000)
    let t
    before(() => { t = makeTmp('arms') })
    after(() => { t.cleanup() })
    const OPS = operators.map((o) => o.name)
    let fresh = (name, over = {}) => createRsi({ root: path.join(t.dir, name), domain: makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 }, arms: { catalog: CATALOG }, ...over }).init()
    let planOf = (ex) => JSON.parse(fs.readFileSync(path.join(ex.fd, 'plan.json'), 'utf8'))

    it('AR01 validateCatalog', () => {
        assert.deepEqual(validateCatalog(CATALOG, { operators: OPS, carriers: _.keys(carriers) }).errors, [])
        let bad = { layers: CATALOG.layers, arms: [
            { id: 'px', layer: 'P', title: 'a', status: 'partial', realize: [{ kind: 'operator', op: 'P.x' }], bogus: 1 },
            { id: 'px', layer: 'P', title: 'b', status: 'weird', realize: [{ kind: 'operator', op: 'Q.z' }] },
            { id: 'blk2', layer: 'J', title: 'c', status: 'blocked', selectable: true, realize: [{ kind: 'manual', how: 'x' }] },
            { id: 'r', layer: 'P', title: 'd', status: 'sparse', realize: [{ kind: 'fragment', mech: 'F9' }], requires: ['nope'], used: { x: [1] } },
            { id: '9bad', layer: 'Z', title: '', status: 'done', realize: [] },
        ] }
        let r = validateCatalog(bad, { operators: OPS, fragments: ['F1'] })
        let has = (re) => assert.ok(r.errors.some((e) => re.test(e)), `缺錯誤 ${re}:\n${r.errors.join('\n')}`)
        has(/未知鍵 bogus/); has(/id 重複/); has(/status 須為/); has(/算子 Q\.z 不在登錄表/); has(/blocked 須附 blockedBy/); has(/blocked 不可 selectable/)
        has(/片段 F9 不在 known\.fragments/); has(/requires 指向不存在之臂 nope/); has(/id 須為識別字/); has(/title 必填/); has(/layer Z 不在/); has(/realize 至少一項/)
        assert.ok(r.warnings.some((w) => /used\.x 無對應之 grid\.x/.test(w)), r.warnings.join('\n'))
        assert.deepEqual(validateCatalog(null).errors, [])
        assert.ok(validateCatalog('x').errors.length === 1)
        assert.deepEqual(unusedOf(ARMS[0]), { x: [-2, 2] })
        assert.deepEqual(unusedOf(ARMS[1]), { y: [-2, -1, 1, 2] })
        assert.deepEqual(unusedOf(ARMS[2]), {})
        assert.equal(featureOf(ARMS[2], { kind: 'point', x: 1, y: 2, tag: 'a' }), true)
        assert.equal(featureOf(ARMS[2], { kind: 'point', x: 1, y: 2 }), false)
        assert.equal(featureOf(ARMS[2], { kind: 'cond', branches: { up: { kind: 'point', x: 1, y: 2, tag: 'a' } } }), true, 'cond 之分支遞迴')
    })

    it('AR02 pick', () => {
        let A = makeArms({ catalog: CATALOG })
        let r = A.pick(['px', 'nope', 'blk', 'eval', 'tag', 'cond'])
        assert.deepEqual(r.ok.map((a) => a.id), ['px', 'cond'])
        let why = _.fromPairs(r.rejected.map((x) => [x.id, x.why]))
        assert.match(why.nope, /目錄無此臂/); assert.match(why.blk, /封鎖:測試之裁示/); assert.match(why.eval, /不可選/); assert.match(why.tag, /須附重啟理由/)
        assert.deepEqual(A.pick(['tag'], { reopen: '別名偵測之回歸' }).ok.map((a) => a.id), ['tag'])
        let c = A.pick(['tag', 'cond'], { reopen: 'x' })
        assert.deepEqual(c.ok.map((a) => a.id), ['tag']); assert.match(c.rejected[0].why, /與已選之臂 tag 衝突/)
        let q = A.pick(['pair'])
        assert.deepEqual(q.ok, []); assert.match(q.rejected[0].why, /依賴之臂 px 未同選/)
        assert.deepEqual(A.pick(['pair', 'px']).ok.map((a) => a.id), ['pair', 'px'])
        assert.deepEqual(A.opsOf(['px', 'cond']), ['P.x', 'X.cond', 'X.condSwap', 'X.condBranch'])
        assert.deepEqual(A.armsOfOp('P.y'), ['py', 'pair'])
        assert.deepEqual(A.carriersOf(['far', 'px']), ['far'])
        assert.deepEqual(A.list({ selectable: false }).map((a) => a.id), ['eval', 'blk'])
        assert.deepEqual(A.list({ layer: 'P', status: ['partial', 'sparse'] }).map((a) => a.id), ['px', 'py', 'pair'])
    })

    it('AR03 explore 之 useArms:計畫只含所選臂;origin.arms;無 useArms 與無目錄者逐欄同', async () => {
        let a = fresh('ar03a'), b = createRsi({ root: path.join(t.dir, 'ar03b'), domain: makeDomain(), budget: { arms: 6, novelty: 2, workers: 3 } }).init()
        let ea = await a.explore({ by: 'x' }), eb = await b.explore({ by: 'x' })
        let strip = (p) => ({ ...p, at: null, items: p.items.map((it) => _.omit(it, ['arms'])) })
        assert.deepEqual(strip(planOf(ea)), strip(planOf(eb)), '無 useArms:計畫與無目錄者同(只多 origin.arms)')
        assert.equal(planOf(ea).useArms, undefined)
        //第 2 輪限臂 px:展開只 P.x;無全域 / 載體 / 他臂
        let ex = await a.explore({ by: 'x', useArms: ['px'] })
        assert.ok(ex.items.length > 0, '有臂')
        assert.ok(ex.items.every((it) => it.kindOf === 'expand' && it.op === 'P.x'), JSON.stringify(ex.items.map((it) => [it.kindOf, it.op])))
        assert.ok(ex.items.every((it) => _.isEqual(it.arms, ['px'])), 'items.arms')
        for (let n of ex.nodes) { assert.deepEqual(n.origin.arms, ['px'], `節點 ${n.id} 之 origin.arms`); assert.equal(n.origin.operator, 'P.x') }
        let pj = planOf(ex)
        assert.deepEqual(pj.useArms, ['px']); assert.ok(pj.items.every((it) => _.isEqual(it.arms, ['px'])))
        assert.ok((pj.notes || []).some((s) => /臂限制/.test(s)), `計畫備註記臂限制:${(pj.notes || []).join(';')}`)
        assert.deepEqual(ex.summary.useArms, ['px'])
        assert.ok(fs.readFileSync(path.join(ex.fd, 'report.md'), 'utf8').includes('臂限制'), '報告記臂限制')
        //載體臂 far:只放行載體 far 之新區域臂, 展開為空
        let c = fresh('ar03c')
        let ec = await c.explore({ by: 'x', useArms: ['far'] })
        assert.ok(ec.items.length >= 1 && ec.items.every((it) => it.kindOf === 'novelty' && _.isEqual(it.spec, carriers.far)), JSON.stringify(ec.items.map((it) => [it.kindOf, it.reason])))
        assert.deepEqual(ec.nodes[0].origin.arms, ['far'])
        //多臂:px + py ⇒ 展開只 P.x / P.y
        let ed = await a.explore({ by: 'x', useArms: ['px', 'py'] })
        assert.ok(ed.items.every((it) => ['P.x', 'P.y'].includes(it.op)), JSON.stringify(ed.items.map((it) => it.op)))
        //拒:封鎖 / done 未附 reopen ⇒ 拋錯, 不開輪
        let n0 = fs.readdirSync(a.paths.rounds).length
        await assert.rejects(() => a.explore({ by: 'x', useArms: ['blk'] }), /封鎖/)
        await assert.rejects(() => a.explore({ by: 'x', useArms: ['tag'] }), /重啟理由/)
        assert.equal(fs.readdirSync(a.paths.rounds).length, n0, '被拒不開輪')
        let et = await a.explore({ by: 'x', useArms: ['tag'], reopen: '回歸測試' })
        assert.deepEqual(planOf(et).armsReopen, '回歸測試')
        //cfg.arms.use 為預設之選臂(opt.useArms 覆寫)
        let e = fresh('ar03e', { arms: { catalog: CATALOG, use: ['py'] } })
        let ee = await e.explore({ by: 'x' })
        assert.ok(ee.items.every((it) => it.op === 'P.y'), JSON.stringify(ee.items.map((it) => it.op)))
        let ee2 = await e.explore({ by: 'x', useArms: ['px'] })
        assert.ok(ee2.items.every((it) => it.op === 'P.x'))
    })

    it('AR04 compose', () => {
        let a = fresh('ar04')
        let r = a.arms.compose(['px', 'py'], carriers.origin, { childrenOf: a.registry.childrenOf, validateSpec: a.domain.validateSpec })
        assert.equal(r.specs.length, 16, '4 × 4 之組合, 去重後 16')
        assert.ok(r.specs.every((s) => _.isEqual(s.path, ['P.x', 'P.y']) && _.isEqual(s.arms, ['px', 'py']) && s.spec.kind === 'point'))
        assert.equal(_.uniq(r.specs.map((s) => s.specHash)).length, 16)
        assert.deepEqual(r.skipped, [])
        let r2 = a.arms.compose(['px', 'eval', 'px'], carriers.origin, { childrenOf: a.registry.childrenOf, validateSpec: a.domain.validateSpec })
        assert.deepEqual(r2.skipped, ['eval'])
        assert.ok(r2.specs.length > 0 && r2.specs.length < 16, `去重:${r2.specs.length}`) //x±1±2 兩次 ⇒ 重疊
        assert.ok(r2.specs.every((s) => _.isEqual(s.path, ['P.x', 'P.x'])))
        let r3 = a.arms.compose(['px'], carriers.origin, { childrenOf: a.registry.childrenOf, max: 2 })
        assert.equal(r3.specs.length, 2)
        assert.throws(() => a.arms.compose(['px'], carriers.origin, {}), /須給 childrenOf/)
    })

    it('AR05 coverage / menu', async () => {
        let a = fresh('ar05')
        await a.explore({ by: 'x' })
        await a.explore({ by: 'x', useArms: ['px'] })
        let nodes = a.store.loadNodes() //正式分數(status / cli / 領域之選單同用此;策略視圖為遮蔽後之量)
        let cov = a.arms.coverage(nodes)
        assert.equal(cov.nNodes, nodes.length)
        let px = cov.byArm.px
        assert.ok(px.n >= 1 && px.byOp['P.x'] === px.n, JSON.stringify(px))
        assert.equal(cov.byArm.px.feature, nodes.filter((n) => _.get(n, 'spec.x') !== undefined && n.spec.x !== null && n.spec.x !== false).length, '特徵口徑:規格路徑 x 有值')
        assert.equal(cov.byArm.blk.n, 0)
        //origin 落成(far 之 { kind:'origin', op:'root' }):載體之根節點(origin.operator = root)計入 far 之覆蓋;origin 不入限臂之算子
        assert.ok(cov.byArm.far.n >= 1 && cov.byArm.far.byOp.root === cov.byArm.far.n, JSON.stringify(cov.byArm.far))
        assert.deepEqual(a.arms.opsOfArm(a.arms.get('far')), []); assert.deepEqual(a.arms.originsOfArm(a.arms.get('far')), ['root'])
        assert.ok(_.isPlainObject(cov.unmapped) && !('root' in cov.unmapped), 'root 已對應 far ⇒ 不在未對應')
        let menu = a.arms.menu({ coverage: cov })
        for (let id of ARMS.map((x) => x.id)) { assert.ok(menu.includes(`| ${id} |`), `選單含 ${id}`) }
        assert.ok(menu.includes('x:-2,2'), '未用格點'); assert.ok(menu.includes('封鎖:測試之裁示')); assert.ok(/\| px \| partial \| 是 \|/.test(menu))
        assert.ok(a.arms.menu({ statuses: ['sparse'], withHeader: false }).includes('| py |'))
        assert.ok(!a.arms.menu({ statuses: ['sparse'], withHeader: false }).includes('| px |'))
    })

    it('AR06 CLI:--mode arms;--use-arms;封鎖 ⇒ exit 2 不寫檔', () => {
        let root = path.join(t.dir, 'ar06')
        let cfgPath = path.join(t.dir, 'ar06_cfg.mjs')
        let toyPath = pathToFileURL(path.resolve(FD_PACK, 'test', 'tools', 'toy.mjs')).href //Windows 之絕對路徑須為 file URL(D: 會被當 scheme)
        let armsPath = pathToFileURL(path.resolve(FD_PACK, 'test', 'tools', 'toyArms.mjs')).href
        fs.writeFileSync(cfgPath, `import { makeDomain } from '${toyPath}'\nimport { CATALOG } from '${armsPath}'\nexport default { root: '${root.split(path.sep).join('/')}', domain: makeDomain(), budget: { arms: 6, novelty: 2, workers: 2 }, arms: { catalog: CATALOG } }\n`)
        let run = (args) => spawnSync(process.execPath, [path.join(FD_PACK, 'src', 'cli.mjs'), '--config', cfgPath, ...args], { encoding: 'utf8', cwd: FD_PACK, windowsHide: true })
        let i = run(['--mode', 'init']); assert.equal(i.status, 0, i.stderr)
        //播種:空樹為冷啟動(全給載體)⇒ 先跑一輪真實探索(玩具評估, 秒級)使有可展開之父, 限臂之乾跑才有展開項
        let seed = run(['--mode', 'explore', '--arms', '4', '--novelty', '2', '--workers', '2', '--by', 'seed']); assert.equal(seed.status, 0, seed.stderr)
        let m = run(['--mode', 'arms'])
        assert.equal(m.status, 0, m.stderr); assert.ok(m.stdout.includes('| px |') && m.stdout.includes('可用臂選單'), m.stdout.slice(0, 300))
        let d = run(['--mode', 'explore', '--dry', '--use-arms', 'px,py'])
        assert.equal(d.status, 0, d.stderr)
        assert.ok(/\[P\.[xy]\]/.test(d.stdout) && !/\[T\.tag\]|\[X\.cond\]|\[novelty\]/.test(d.stdout) && d.stdout.includes('臂限制 px, py'), d.stdout)
        let before = fs.readdirSync(path.join(root, 'rounds')).length
        let b = run(['--mode', 'explore', '--use-arms', 'blk'])
        assert.equal(b.status, 2, b.stdout + b.stderr); assert.match(b.stderr, /封鎖/)
        assert.equal(fs.readdirSync(path.join(root, 'rounds')).length, before, '被拒未開輪')
        let r = run(['--mode', 'explore', '--use-arms', 'tag', '--reopen', '回歸'])
        assert.equal(r.status, 0, r.stderr)
        let u = run(['--mode', 'status', '--use-arms', 'px'])
        assert.equal(u.status, 2, '旗標不適用於該模式')
    })

    it('AR07 cfg 契約:CFG_KEYS 含 arms;cfg.arms 之形與目錄不合 ⇒ 拋錯', () => {
        assert.ok(CFG_KEYS.includes('arms'))
        assert.deepEqual(ARMS_CFG_KEYS, ['catalog', 'defaults', 'use', 'known'])
        assert.deepEqual(ARM_KEYS.slice(0, 3), ['id', 'n', 'layer'])
        assert.deepEqual(checkArmsCfg({ catalog: CATALOG, bogus: 1 }).errors.length, 1)
        assert.deepEqual(checkArmsCfg({ use: 'px' }).errors.length, 1)
        assert.deepEqual(checkArmsCfg(undefined).errors, [])
        assert.deepEqual(checkCfg({ root: 'x', arms: { catalog: CATALOG } }).unknown, [])
        assert.throws(() => createRsi({ root: path.join(t.dir, 'ar07a'), domain: makeDomain(), arms: { catalog: CATALOG, bogus: 1 } }), /cfg\.arms 有未知鍵 bogus/)
        assert.throws(() => createRsi({ root: path.join(t.dir, 'ar07b'), domain: makeDomain(), arms: { catalog: [{ id: 'a', layer: 'P', title: 'a', status: 'done', realize: [{ kind: 'operator', op: 'Nope.op' }] }] } }), /算子 Nope\.op 不在登錄表/)
        assert.throws(() => createRsi({ root: path.join(t.dir, 'ar07c'), domain: makeDomain(), arms: { catalog: CATALOG, use: ['blk'] } }), /封鎖/)
        let ok = createRsi({ root: path.join(t.dir, 'ar07d'), domain: makeDomain(), arms: { catalog: CATALOG, known: { carriers: ['origin', 'far'] } } })
        assert.equal(ok.arms.size, ARMS.length)
        let none = createRsi({ root: path.join(t.dir, 'ar07e'), domain: makeDomain() })
        assert.equal(none.arms.size, 0, '無目錄 ⇒ 空目錄(不拋)')
    })
})
