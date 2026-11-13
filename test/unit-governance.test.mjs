import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { createRsi, CFG_KEYS, checkCfg, ARM_KEYS, validateCatalog, checkGovernanceCfg, checkProposals, applyArmExtensions, readArmExtensions, effectiveCatalogOf, nextArmId, nextLayerId, renderProposals, PROPOSAL_KINDS, GOVERNANCE_DEFAULTS, makePaths } from '../src/index.mjs'
import { reportOf } from '../src/loop/report.mjs'
import { makeDomain } from './tools/toy.mjs'
import { CATALOG } from './tools/toyArms.mjs'
import { makeTmp, FD_PACK } from './tools/tmpdir.mjs'


//治理(2026-11-14;使用端 Gitea #138;search/governance.mjs):代理之三層(節點 / 做夢 / 主控)之第三層 —— 下層提案、主控審定、臂目錄以擴充演進、逾期未審即不開新輪
//  規格出處:README §2c、規則帳本 REC-21
//  GV01 純函式:checkProposals 之每一類錯誤;applyArmExtensions 之新層 / 新臂 / 修訂 / 停用(不改入參;空擴充回原物件);結構不合拋錯;nextArmId / nextLayerId
//  GV02 提案帳:propose 入帳(不合格列 invalid、同鍵之待審者記 repeated 不另立、同臂之不同修訂另立、所指之臂不在目錄者註記);渲染檔隨寫入更新;
//    提案帳損壞(非 JSON、頂層、逐列:seq、id、kind、status、decision)⇒ 拋錯不覆寫;items 非陣列 ⇒ 拋
//  GV03 審定:不採只記帳;通過新層 + 新臂 ⇒ 寫擴充檔、本程序之 rsi.arms 已重載(可 pick、選單可見、origin 記出處);修訂與停用;已審定者不得再審;缺 why / arm ⇒ 拋錯且不寫檔
//  GV04 目錄結構不合之審定(缺 realize、id 重複、patch 未知欄、空 patch)⇒ 拋錯, 擴充檔與提案帳皆不變(提案仍待審)
//  GV05 生效之目錄 = 基底 + 狀態根之擴充(另一實例、effectiveCatalogOf);擴充檔損壞即拋;擴充之臂之落成名未登錄 ⇒ 組裝不拋、該臂不可選;只改 title 之修訂不放寬基底
//  GV06 審定之提交點(擴充檔)與中斷:寫提案帳失敗 ⇒ RSI_GOVERNANCE_PARTIAL;重審補記(擴充檔逐字不變, 後續依賴之審定不受影響);改判不採 ⇒ 拒;渲染檔失敗不使審定失敗
//  GV07 起跑之把關:requireReview 預設 false ⇒ 有待審亦照常開輪;true ⇒ 逾期者 explore 拋 RSI_GOVERNANCE_PENDING 且不取輪號;ackPending / 乾跑 / 審定後 ⇒ 放行;
//    maxPendingRounds 與 gateKinds(note 不計);早檢後、取號前才提交之提案 ⇒ 取號時之終檢仍擋且不留輪夾
//  GV08 收件匣與 status / 報告:inbox 匯總待審之提案與生成請求、策略開發請求之標記;status 之 governance 欄;有待審時報告多一行;
//    提案帳或擴充檔損壞 ⇒ status 之 error 欄、報告一行(不中斷);擴充檔損壞 ⇒ 起跑即拋、不開輪
//  GV09 未用治理者之可觀察面不變:無提案帳、無擴充檔、requireReview 未設 ⇒ rsi.arms 之臂即基底之同一物件、無 governance 夾、status 無此欄、報告無治理行
//  GV10 cfg:CFG_KEYS 含 governance;cfg.governance 之未知鍵 / 型別不符 ⇒ createRsi 拋錯;null / undefined 之鍵取預設;ARM_KEYS 含 origin(須為物件)
//  GV11 CLI:--mode proposals 印提案帳;--mode decide 通過 / 不採;缺 --why 或無此筆 ⇒ exit 2 且未寫檔;把關下之 --mode explore ⇒ exit 2, 加 --ack-pending 放行;
//    --out 不得指向 governance 夾;修訂只改明給之欄;全新狀態根之 proposals / 被拒之 decide 不初始化狀態根
//  GV12 他實例之過期目錄(起跑即重載)、停用或使 cfg.arms.use 之臂不可選之審定 ⇒ 拒、以 name 配號於鎖內
describe('search/governance:提案帳、審定、臂目錄之擴充、起跑之把關、收件匣、CLI', function () {
    this.timeout(180000)
    let t
    before(() => { t = makeTmp('governance') })
    after(() => { t.cleanup() })
    let fresh = (name, over = {}) => createRsi({ root: path.join(t.dir, name), domain: makeDomain(), budget: { arms: 4, novelty: 2, workers: 2 }, arms: { catalog: CATALOG }, ...over }).init()
    const NEW = { kind: 'new', layer: 'P', title: 'z 步進', mechanism: '對 z 軸步進', boundary: '與 px / py 不同軸', evidence: '節點 n1', sources: ['n1'] }
    const ARM_Z = { id: 'pz', layer: 'P', title: 'z 步進', desc: '對 z 軸步進', realize: [{ kind: 'manual', how: '待實作' }] }

    it('GV01 純函式', () => {
        assert.deepEqual(PROPOSAL_KINDS, ['new', 'layer', 'revise', 'retire', 'note'])
        //checkProposals:每類皆合格者 0 錯;每一類錯誤各一
        assert.deepEqual(checkProposals([NEW, { kind: 'layer', title: '資訊源層', mechanism: '以資訊源為軸' }, { kind: 'revise', arm: 'px', mechanism: '只留 ±1' }, { kind: 'retire', arm: 'tag', mechanism: '與 px 重疊' }, { kind: 'note', title: '量尺', mechanism: '評估輸出缺一欄' }]).errors, [])
        let e = checkProposals([{ kind: 'merge', mechanism: 'm' }, { kind: 'new', title: 't' }, { kind: 'new', mechanism: 'm' }, { kind: 'retire', mechanism: 'm' }, { kind: 'note', mechanism: 'm' }, { kind: 'revise', arm: 'px', mechanism: 'm', sources: 'x' }]).errors
        assert.equal(e.length, 6)
        let has = (s, pre, frag) => s.startsWith(pre) && s.includes(frag)
        assert.ok(has(e[0], '提案[0]', 'kind') && has(e[1], '提案[1]', 'mechanism') && has(e[2], '提案[2]', 'kind new 須附 title') && has(e[3], '提案[3]', 'kind retire 須附 arm') && has(e[4], '提案[4]', 'kind note 須附 title') && e[5].startsWith('提案[5]'), e.join('\n'))
        assert.deepEqual(checkProposals(null).errors, ['提案須為陣列'])
        //applyArmExtensions:空擴充 ⇒ 原物件;新層 / 新臂 / 修訂 / 停用;不改入參
        let snap = JSON.stringify(CATALOG)
        assert.strictEqual(applyArmExtensions(CATALOG, null), CATALOG)
        assert.strictEqual(applyArmExtensions(CATALOG, { layers: [], arms: [] }), CATALOG)
        let out = applyArmExtensions(CATALOG, {
            layers: [{ id: 'K', title: '資訊源層' }],
            arms: [
                { op: 'add', arm: { id: 'kz', layer: 'K', title: 'z 來源', realize: [{ kind: 'manual', how: '待實作' }] }, origin: { proposal: 'P001', by: 'c' } },
                { op: 'revise', id: 'py', patch: { desc: '只留 ±1', grid: { y: [-1, 1] } }, origin: { proposal: 'P002' } },
                { op: 'retire', id: 'pair', why: '併入 px', origin: { proposal: 'P003' } },
            ],
        })
        assert.equal(JSON.stringify(CATALOG), snap, '不改入參')
        let by = Object.fromEntries(out.arms.map((a) => [a.id, a]))
        assert.equal(out.layers.K, '資訊源層')
        assert.deepEqual(by.kz, { n: 9, status: 'proposed', id: 'kz', layer: 'K', title: 'z 來源', realize: [{ kind: 'manual', how: '待實作' }], origin: { proposal: 'P001', by: 'c' } })
        assert.ok(by.py.desc === '只留 ±1' && by.py.id === 'py' && by.py.n === 2 && by.py.origin.revised.proposal === 'P002', '出處記於 origin.revised')
        assert.ok(by.pair.status === 'blocked' && by.pair.blockedBy.startsWith('停用') && by.pair.blockedBy.endsWith('併入 px') && by.pair.requires === undefined && by.pair.origin.retired.proposal === 'P003')
        assert.deepEqual(validateCatalog(out).errors, [], '套用後之目錄仍合格(停用者為 blocked 且附來源、不留 requires)')
        //結構不合 ⇒ 拋錯:層重複 / 層 id 非識別字 / 臂重複 / 層不存在 / add 缺 arm / 修訂不存在之臂 / 空 patch / patch 含不可改之欄(id、n、origin)或未知欄 / 停用不存在之臂 / op 不明 / 基底無層表而新增層
        let bads = [{ layers: [{ id: 'P', title: 'x' }] }, { layers: [{ id: '9', title: 'x' }] }, { arms: [{ op: 'add', arm: { id: 'px', layer: 'P' } }] }, { arms: [{ op: 'add', arm: { id: 'q1', layer: 'Z' } }] }, { arms: [{ op: 'add' }] },
            { arms: [{ op: 'revise', id: 'nope', patch: { desc: 'x' } }] }, { arms: [{ op: 'revise', id: 'px', patch: {} }] }, { arms: [{ op: 'revise', id: 'px', patch: { desc: 'x', id: 'hack' } }] }, { arms: [{ op: 'revise', id: 'px', patch: { n: 99 } }] }, { arms: [{ op: 'revise', id: 'px', patch: { tittle: 'x' } }] },
            { arms: [{ op: 'retire', id: 'nope' }] }, { arms: [{ op: 'merge', id: 'px' }] }]
        for (let bad of bads) { assert.throws(() => applyArmExtensions(CATALOG, bad), /^Error: 臂目錄之擴充/, JSON.stringify(bad)) }
        assert.throws(() => applyArmExtensions({ arms: CATALOG.arms.map((a) => ({ ...a })) }, { layers: [{ id: 'K', title: 'x' }] }), /基底目錄無層表/)
        assert.equal(nextArmId(CATALOG, 'K', 'z src'), 'K09_zsrc')
        assert.equal(nextArmId([{ id: 'a' }, { id: 'b' }], 'A', 'x'), 'A03_x')
        assert.equal(nextLayerId(CATALOG), 'A')
        assert.equal(nextLayerId({ layers: { A: 1, B: 1 }, arms: [] }), 'C')
    })

    it('GV02 提案帳', () => {
        let rsi = fresh('gv02')
        assert.equal(rsi.governance.exists(), false)
        assert.deepEqual(rsi.governance.pending(), [])
        let r = rsi.governance.propose({ round: 3, from: 'dream', items: [NEW, { kind: 'retire', arm: 'nope', mechanism: '不存在之臂' }, { kind: 'bogus', mechanism: 'm' }, { kind: 'note', title: '量尺', mechanism: '評估輸出缺一欄' }] })
        assert.deepEqual(r.added.map((x) => [x.id, x.kind, x.status, x.round, x.from, x.note]), [['P001', 'new', 'pending', 3, 'dream', null], ['P002', 'retire', 'pending', 3, 'dream', '所指之臂不在目錄'], ['P003', 'note', 'pending', 3, 'dream', null]])
        assert.deepEqual(r.invalid.map((x) => x.index), [2])
        assert.ok(r.invalid[0].why.startsWith('kind 須為'), r.invalid[0].why)
        //同鍵(類別 + 臂 + 層 + 名稱;空白與大小寫不計)之待審者 ⇒ 不另立, 原列補記再提(含不同之機制描述與依據)
        let r2 = rsi.governance.propose({ round: 4, from: 'node:n7', items: [{ kind: 'new', layer: 'P', title: 'z  步進', mechanism: '同一件事', evidence: '再一例' }] })
        assert.deepEqual([r2.added.length, r2.repeated.map((x) => x.id)], [0, ['P001']])
        let note = rsi.governance.list({ kind: 'new' })[0].note
        assert.ok(note.includes('第 4 輪再提(node:n7)') && note.includes('同一件事') && note.endsWith('再一例'), note)
        //同名而不同層之新臂 ⇒ 另立;同一臂之不同修訂 ⇒ 另立;同一修訂再提 ⇒ 不另立
        let r3 = rsi.governance.propose({ round: 4, from: 'dream', items: [{ kind: 'new', layer: 'X', title: 'z 步進', mechanism: '條件層之 z' }, { kind: 'revise', arm: 'py', mechanism: '只留 ±1' }, { kind: 'revise', arm: 'py', mechanism: '改為 ±3' }, { kind: 'revise', arm: 'py', mechanism: '只留  ±1' }] })
        assert.deepEqual([r3.added.map((x) => x.id), r3.repeated.map((x) => x.id)], [['P004', 'P005', 'P006'], ['P005']])
        assert.deepEqual(rsi.governance.list({ status: 'pending' }).map((x) => x.id), ['P001', 'P002', 'P003', 'P004', 'P005', 'P006'])
        let md = fs.readFileSync(rsi.paths.govProposalsMd, 'utf8')
        assert.equal(md, rsi.governance.render())
        assert.ok(md.includes('## 待審(6 筆)') && md.includes('**P001**') && md.includes('## 已審定(0 筆;新者在前)'))
        assert.equal(renderProposals(null).includes('## 待審(0 筆)'), true)
        //提案帳損壞 ⇒ propose / decide / list 拋錯, 檔案不被覆寫(不當成空帳)
        fs.writeFileSync(rsi.paths.govProposals, '{bad')
        assert.throws(() => rsi.governance.propose({ round: 5, from: 'dream', items: [NEW] }), /提案帳非 JSON/)
        assert.throws(() => rsi.governance.decide('P001', { accept: false, why: 'x' }), /提案帳非 JSON/)
        assert.throws(() => rsi.governance.pending(), /提案帳非 JSON/)
        assert.equal(fs.readFileSync(rsi.paths.govProposals, 'utf8'), '{bad')
        fs.writeFileSync(rsi.paths.govProposals, '{"seq":1}')
        assert.throws(() => rsi.governance.propose({ round: 5, from: 'dream', items: [NEW] }), /提案帳須為/)
        //逐列之形(外審 terra #5):seq 缺 / 小於最大編號 ⇒ 會重用編號;status 不在值域 ⇒ 待審被略過而把關放行;id 重複;已審定而無 decision ⇒ 皆拋、檔不動
        let row = (o = {}) => ({ id: 'P001', kind: 'new', mechanism: 'm', status: 'pending', decision: null, ...o })
        let okDec = { at: '2026-11-14T00:00:00.000Z', by: 'c', why: '理由' }
        for (let led of [{ items: [row()] }, { seq: 0, items: [row()] }, { seq: 1, items: [row({ status: 'pendng' })] }, { seq: 2, items: [row(), row()] }, { seq: 1, items: [row({ status: 'accepted' })] }, { seq: 1, items: [row({ id: 'X1' })] }, { seq: 1, items: [row({ kind: 'merge' })] },
            { seq: 1, items: [row({ status: 'rejected', decision: {} })] }, { seq: 1, items: [row({ status: 'rejected', decision: { ...okDec, why: '' } })] }, { seq: 1, items: [row({ decision: okDec })] }]) {
            let txt = JSON.stringify(led)
            fs.writeFileSync(rsi.paths.govProposals, txt)
            assert.throws(() => rsi.governance.propose({ round: 5, from: 'dream', items: [NEW] }), /提案帳須為/, txt)
            assert.throws(() => rsi.governance.gate({ round: 9 }) || rsi.governance.pending(), /提案帳須為/, txt)
            assert.equal(fs.readFileSync(rsi.paths.govProposals, 'utf8'), txt)
        }
        //序號達安全整數上限 ⇒ 入帳前拒(帳不動、仍可讀;terra 第二輪 #8)
        let maxLed = JSON.stringify({ seq: Number.MAX_SAFE_INTEGER, items: [] })
        fs.writeFileSync(rsi.paths.govProposals, maxLed)
        assert.throws(() => rsi.governance.propose({ round: 5, from: 'dream', items: [NEW] }), /編號已達上限/)
        assert.deepEqual([fs.readFileSync(rsi.paths.govProposals, 'utf8'), rsi.governance.pending()], [maxLed, []])
        //items:給了而非陣列 ⇒ 拋(不與空陣列混同);未給 / null ⇒ 空
        fs.rmSync(rsi.paths.govProposals)
        assert.throws(() => rsi.governance.propose({ round: 5, items: NEW }), /items 須為提案陣列/)
        assert.throws(() => rsi.governance.propose({ round: 5, items: 'x' }), /items 須為提案陣列/)
        assert.deepEqual(rsi.governance.propose({ round: 5, items: null }), { added: [], repeated: [], invalid: [] })
        assert.deepEqual(rsi.governance.propose({ round: 5 }), { added: [], repeated: [], invalid: [] })
        assert.equal(fs.existsSync(rsi.paths.govProposals), false, '無入帳 ⇒ 不寫帳')
    })

    it('GV03 審定:不採、通過新層 / 新臂 / 修訂 / 停用', () => {
        let rsi = fresh('gv03')
        rsi.governance.propose({ round: 1, from: 'dream', items: [NEW, { kind: 'layer', title: '資訊源層', mechanism: '以資訊源為軸' }, { kind: 'revise', arm: 'py', mechanism: '只留 ±1' }, { kind: 'retire', arm: 'pair', mechanism: '與 px 重疊' }, { kind: 'note', title: '量尺', mechanism: '評估輸出缺一欄' }] })
        assert.throws(() => rsi.governance.decide('P001', { accept: true }), /why/)
        assert.throws(() => rsi.governance.decide('P001', { accept: true, why: '好' }), /arm/)
        assert.throws(() => rsi.governance.decide('P099', { accept: false, why: 'x' }), /無此筆/)
        assert.throws(() => rsi.governance.decide('P003', { accept: true, why: '好', arm: { id: 'px', desc: 'x' } }), /須同所指之臂 py/)
        assert.equal(fs.existsSync(rsi.paths.govExtensions), false, '拋錯者不寫擴充檔')
        let n0 = rsi.arms.size
        let d5 = rsi.governance.decide('P005', { accept: false, why: '已另案處理', by: '審定者甲' })
        assert.deepEqual([d5.item.status, d5.extension, d5.item.decision.by, d5.item.decision.why, fs.existsSync(rsi.paths.govExtensions)], ['rejected', null, '審定者甲', '已另案處理', false])
        let d2 = rsi.governance.decide('P002', { accept: true, why: '七層容不下' })
        assert.deepEqual([d2.item.decision.ref, d2.reloaded, rsi.arms.layers.A], ['A', true, '資訊源層'])
        let d1 = rsi.governance.decide('P001', { accept: true, why: '機制獨立', arm: { ...ARM_Z, layer: 'A' } })
        assert.deepEqual([d1.item.status, d1.item.decision.ref, d1.reloaded, rsi.arms.size], ['accepted', 'pz', true, n0 + 1])
        let pz = rsi.arms.get('pz')
        assert.ok(pz.layer === 'A' && pz.status === 'proposed' && pz.n === 9 && pz.origin.proposal === 'P001' && pz.origin.from === 'dream' && pz.origin.round === 1 && pz.origin.by === 'controller')
        assert.deepEqual(rsi.arms.pick(['pz']).ok.map((a) => a.id), ['pz'], '新臂可選')
        assert.ok(rsi.arms.menu().includes('| pz |'))
        let d3 = rsi.governance.decide('P003', { accept: true, why: '範圍過寬', arm: { id: 'py', desc: '只留 ±1', grid: { y: [-1, 1] } } })
        assert.ok(d3.reloaded && rsi.arms.get('py').desc === '只留 ±1' && rsi.arms.get('py').origin.revised.proposal === 'P003')
        let d4 = rsi.governance.decide('P004', { accept: true, why: '與 px 重疊' })
        assert.ok(d4.reloaded && rsi.arms.get('pair').status === 'blocked' && rsi.arms.pick(['pair']).rejected.length === 1 && rsi.arms.size === n0 + 1, '停用者留在目錄、不可選')
        assert.throws(() => rsi.governance.decide('P001', { accept: false, why: 'x' }), /已審定/)
        let ext = rsi.governance.extensions()
        assert.deepEqual([ext.layers.map((l) => l.id), ext.arms.map((a) => a.op)], [['A'], ['add', 'revise', 'retire']])
        assert.deepEqual(rsi.governance.pending(), [])
        let md = rsi.governance.render()
        assert.ok(md.includes('## 待審(0 筆)') && md.includes('## 已審定(5 筆;新者在前)') && md.includes('**P001** 〔通過 ⇒ `pz`〕') && md.includes('**P005** 〔不採〕') && md.indexOf('**P005**') < md.indexOf('**P004**'), '已審定者依編號新者在前')
    })

    it('GV04 目錄結構不合之審定 ⇒ 拋錯, 擴充檔與提案帳皆不變', () => {
        let rsi = fresh('gv04')
        rsi.governance.propose({ round: 1, from: 'dream', items: [NEW, { kind: 'revise', arm: 'py', mechanism: '改欄' }] })
        let before = fs.readFileSync(rsi.paths.govProposals, 'utf8')
        assert.throws(() => rsi.governance.decide('P001', { accept: true, why: '好', arm: { id: 'pz', layer: 'P', title: 'z' } }), /realize 至少一項/)
        assert.throws(() => rsi.governance.decide('P001', { accept: true, why: '好', arm: { id: 'px', layer: 'P', title: 'z', realize: [{ kind: 'manual', how: 'x' }] } }), /已存在/)
        assert.throws(() => rsi.governance.decide('P002', { accept: true, why: '好', arm: { tittle: 'x' } }), /不可改或未知/)
        assert.throws(() => rsi.governance.decide('P002', { accept: true, why: '好' }), /須附 patch/)
        assert.equal(fs.existsSync(rsi.paths.govExtensions), false)
        assert.equal(fs.readFileSync(rsi.paths.govProposals, 'utf8'), before)
        assert.equal(rsi.governance.pending().length, 2)
        assert.equal(rsi.arms.get('pz'), null)
    })

    it('GV05 生效之目錄 = 基底 + 狀態根之擴充(另一實例、effectiveCatalogOf);擴充檔損壞即拋;擴充之臂之落成名未登錄 ⇒ 組裝不拋、不可選', () => {
        let a = fresh('gv05')
        a.governance.propose({ round: 1, from: 'dream', items: [NEW, { kind: 'new', layer: 'P', title: 'w 步進', mechanism: '對 w 軸步進(算子待領域實作)' }] })
        a.governance.decide('P001', { accept: true, why: '機制獨立', arm: ARM_Z })
        let b = createRsi({ root: a.paths.root, domain: makeDomain(), arms: { catalog: CATALOG } })
        assert.ok(b.arms.get('pz') && b.arms.size === CATALOG.arms.length + 1, '另一實例組裝時即套用擴充')
        assert.deepEqual(effectiveCatalogOf(makePaths(a.paths.root), CATALOG).arms.map((x) => x.id), b.arms.arms.map((x) => x.id))
        assert.strictEqual(b.baseCatalog, CATALOG)
        //擴充之臂之落成算子未登錄(領域尚未實作)⇒ 審定與組裝皆不拋;該臂不可選、pick 拒並說明;警告列出
        let d2 = a.governance.decide('P002', { accept: true, why: '待實作', arm: { id: 'pw', realize: [{ kind: 'operator', op: 'P.w' }] } })
        assert.equal(d2.reloaded, true)
        let c = createRsi({ root: a.paths.root, domain: makeDomain(), arms: { catalog: CATALOG } })
        assert.equal(c.arms.get('pw').selectable, false)
        assert.ok(c.arms.pick(['pw']).rejected[0].why.includes('尚未登錄'))
        assert.ok(c.arms.warnings.some((w) => w.includes('P.w') && w.includes('治理之擴充')), c.arms.warnings.join('\n'))
        assert.ok(c.arms.menu().includes('| pw | proposed | 否 |'))
        //基底之臂仍嚴格:基底目錄之算子未登錄 ⇒ 組裝拋錯(與改前同)
        assert.throws(() => createRsi({ root: path.join(t.dir, 'gv05base'), domain: makeDomain(), arms: { catalog: { layers: CATALOG.layers, arms: [...CATALOG.arms, { id: 'qq', layer: 'P', title: 'q', status: 'sparse', realize: [{ kind: 'operator', op: 'P.q' }] }] } } }), /P\.q 不在登錄表/)
        //只改 title 之修訂不放寬基底之落成名(外審 terra #9):領域少了 P.x ⇒ 有無此修訂皆拋;修訂了 realize 者才寬鬆
        let noPx = () => { let d = makeDomain(); return { ...d, operators: d.operators.filter((o) => o.name !== 'P.x') } }
        let r9 = path.join(t.dir, 'gv05rev'), p9 = makePaths(r9)
        fs.mkdirSync(p9.governance, { recursive: true })
        fs.writeFileSync(p9.govExtensions, JSON.stringify({ arms: [{ op: 'revise', id: 'px', patch: { title: '新名' }, origin: { proposal: 'P001' } }] }))
        assert.throws(() => createRsi({ root: r9, domain: noPx(), arms: { catalog: CATALOG } }), /P\.x 不在登錄表/)
        fs.writeFileSync(p9.govExtensions, JSON.stringify({ arms: [{ op: 'revise', id: 'px', patch: { realize: [{ kind: 'operator', op: 'P.x' }] }, origin: { proposal: 'P001' } }] }))
        assert.equal(createRsi({ root: r9, domain: noPx(), arms: { catalog: CATALOG } }).arms.get('px').selectable, false)
        //effectiveCatalogOf:擴充所加之臂結構不合(缺 title / realize)⇒ 拋(外審 terra #10;與 createRsi 一致)
        fs.writeFileSync(p9.govExtensions, JSON.stringify({ arms: [{ op: 'add', arm: { id: 'zz', layer: 'P' } }] }))
        assert.throws(() => effectiveCatalogOf(p9, CATALOG), /套用後之目錄不合/)
        assert.throws(() => createRsi({ root: r9, domain: makeDomain(), arms: { catalog: CATALOG } }), /臂目錄不合/)
        //擴充檔被外部改壞(指向不存在之臂)⇒ 組裝期拋錯(不靜默略過);重載失敗 ⇒ rsi.arms 維持原樣
        fs.writeFileSync(a.paths.govExtensions, JSON.stringify({ arms: [{ op: 'retire', id: 'nope' }] }))
        assert.throws(() => createRsi({ root: a.paths.root, domain: makeDomain(), arms: { catalog: CATALOG } }), /臂目錄之擴充/)
        assert.throws(() => a.reloadArms(), /臂目錄之擴充/)
        assert.ok(a.arms.get('pz'), '重載失敗 ⇒ rsi.arms 維持原樣')
        //擴充檔非 JSON 或形不合 ⇒ 同樣拋錯(不當成「無擴充」)
        fs.writeFileSync(a.paths.govExtensions, '{bad')
        assert.throws(() => createRsi({ root: a.paths.root, domain: makeDomain(), arms: { catalog: CATALOG } }), /擴充檔非 JSON/)
        assert.throws(() => effectiveCatalogOf(a.paths, CATALOG), /擴充檔非 JSON/)
        fs.writeFileSync(a.paths.govExtensions, '{"arms":{}}')
        assert.throws(() => readArmExtensions(a.paths), /擴充檔須為/)
    })

    it('GV06 審定之提交點與中斷:寫提案帳失敗 ⇒ RSI_GOVERNANCE_PARTIAL、已生效;重審補記(不重寫、不搬動,後續依賴之審定不受影響);改判不採 ⇒ 拒;渲染檔失敗不使審定失敗', () => {
        let rsi = fresh('gv06')
        rsi.governance.propose({ round: 1, from: 'dream', items: [NEW, { kind: 'revise', arm: 'pz', mechanism: '改為 z 之 ±1' }, { kind: 'layer', title: '資訊源層', mechanism: '以資訊源為軸' }] })
        //注入:寫提案帳(proposals.json 之改名)失敗一次(非暫時性 EXDEV)⇒ 擴充檔已寫入(提交點)而提案帳仍待審(外審 terra #1 之情境)
        let origRename = fs.renameSync, failOnce = true
        fs.renameSync = function (a, b) { if (failOnce && String(b) === rsi.paths.govProposals) { failOnce = false; throw Object.assign(new Error('EXDEV: injected'), { code: 'EXDEV' }) } return origRename.call(this, a, b) }
        let err = null
        try { rsi.governance.decide('P001', { accept: true, why: '機制獨立', arm: ARM_Z }) } catch (e) { err = e } finally { fs.renameSync = origRename }
        assert.equal(err && err.code, 'RSI_GOVERNANCE_PARTIAL', String(err))
        assert.equal(rsi.governance.list().find((x) => x.id === 'P001').status, 'pending', '提案帳未寫入')
        assert.ok(createRsi({ root: rsi.paths.root, domain: makeDomain(), arms: { catalog: CATALOG } }).arms.get('pz'), '擴充已提交 ⇒ 新實例即見')
        //後續之審定依賴已生效之 pz(修訂 pz)⇒ 可通過
        assert.equal(rsi.governance.decide('P002', { accept: true, why: '收窄', arm: { desc: 'z 之 ±1' } }).item.status, 'accepted')
        //改判不採 ⇒ 拒(已生效者須另提 retire / revise 撤回);兩檔不變
        let extBefore = fs.readFileSync(rsi.paths.govExtensions, 'utf8')
        assert.throws(() => rsi.governance.decide('P001', { accept: false, why: '改判' }), (e) => e.code === 'RSI_GOVERNANCE_COMMITTED')
        //重審另給不同之臂 ⇒ 拒(不把不同之請求當成原決定;terra 第二輪 #4)
        assert.throws(() => rsi.governance.decide('P001', { accept: true, why: '另案', by: '審定者乙', arm: { ...ARM_Z, desc: '不同之定義' } }), (e) => e.code === 'RSI_GOVERNANCE_COMMITTED')
        //重審之 accept ⇒ 只補記提案帳(擴充檔逐字不變:不重寫、不搬動;P002 之修訂仍在其後);決定取原決定(審定者、理由),本次呼叫記於 recovered
        let d1 = rsi.governance.decide('P001', { accept: true, why: '補記', by: '審定者乙' })
        assert.deepEqual([d1.item.status, d1.recovered, d1.item.decision.ref, d1.reloaded], ['accepted', true, 'pz', true])
        assert.deepEqual([d1.item.decision.by, d1.item.decision.why, d1.item.decision.recovered.by, d1.item.decision.recovered.why], ['controller', '機制獨立', '審定者乙', '補記'])
        assert.equal(fs.readFileSync(rsi.paths.govExtensions, 'utf8'), extBefore)
        assert.equal(rsi.arms.get('pz').desc, 'z 之 ±1')
        //渲染檔(PROPOSALS.md)寫入失敗 ⇒ 審定照常完成並回 renderError(衍生檔;外審 terra #7)
        let origW = fs.renameSync
        fs.renameSync = function (a, b) { if (String(b) === rsi.paths.govProposalsMd) { throw Object.assign(new Error('EXDEV: injected md'), { code: 'EXDEV' }) } return origW.call(this, a, b) }
        let d3 = null
        try { d3 = rsi.governance.decide('P003', { accept: true, why: '七層容不下' }) } finally { fs.renameSync = origW }
        assert.deepEqual([d3.item.status, d3.reloaded, typeof d3.renderError], ['accepted', true, 'string'])
        assert.equal(rsi.governance.list().find((x) => x.id === 'P003').status, 'accepted')
        assert.equal(rsi.arms.layers.A, '資訊源層')
    })

    it('GV07 起跑之把關', async () => {
        let off = fresh('gv07off')
        off.governance.propose({ round: 0, from: 'dream', items: [NEW] })
        assert.deepEqual([GOVERNANCE_DEFAULTS.requireReview, off.governance.gate({ round: 1 })], [false, null])
        assert.equal((await off.explore()).round, 1, '預設不把關:有待審亦照常開輪')
        let on = fresh('gv07on', { governance: { requireReview: true } })
        assert.equal((await on.explore()).round, 1)
        on.governance.propose({ round: 1, from: 'dream', items: [NEW, { kind: 'note', title: '量尺', mechanism: 'm' }] })
        let err = null
        try { await on.explore() } catch (e) { err = e }
        assert.ok(err && err.code === 'RSI_GOVERNANCE_PENDING' && /P001/.test(err.message), String(err))
        assert.deepEqual(err.pending, ['P001'], 'note 不計入把關')
        assert.equal(fs.existsSync(on.paths.fdRound(2)), false, '不取輪號、不建輪夾')
        assert.equal((await on.explore({ dry: true })).dry, true, '乾跑不經把關')
        assert.equal((await on.explore({ ackPending: true })).round, 2, '明示越過')
        on.governance.decide('P001', { accept: false, why: '不採' })
        assert.equal(on.governance.gate({ round: 3 }), null)
        assert.equal((await on.explore()).round, 3, '審定後放行(只剩 note 待審)')
        let lax = fresh('gv07lax', { governance: { requireReview: true, maxPendingRounds: 1, gateKinds: ['new', 'note'] } })
        lax.governance.propose({ round: 1, from: 'dream', items: [{ kind: 'note', title: '量尺', mechanism: 'm' }] })
        assert.equal(lax.governance.gate({ round: 2 }), null, '可待審 1 輪')
        assert.deepEqual(lax.governance.gate({ round: 3 }).pending.map((p) => p.id), ['P001'], '逾期;gateKinds 含 note 則計入')
        lax.governance.propose({ items: [{ kind: 'new', layer: 'P', title: 'u', mechanism: 'm' }] })
        assert.deepEqual(lax.governance.gate({ round: 1 }).pending.map((p) => p.id), ['P002'], '輪號不明之提案一律視為逾期')
        //早檢之後、取號之前才提交之提案(外審 terra #3;事件同步:於 explore 呼叫 loadPolicy 之當下提案)⇒ 取號時之終檢仍擋,剛建之輪夾已刪
        let race = fresh('gv07race', { governance: { requireReview: true } })
        assert.equal((await race.explore()).round, 1)
        let origLoad = race.loadPolicy, injected = 0
        race.loadPolicy = async () => { injected++; race.governance.propose({ round: 1, from: 'dream', items: [NEW] }); return origLoad() }
        let e2 = null
        try { await race.auto({ noDream: true }) } catch (e) { e2 = e } finally { race.loadPolicy = origLoad }
        assert.ok(injected === 1 && e2 && e2.code === 'RSI_GOVERNANCE_PENDING' && e2.pending.join() === 'P001', String(e2))
        assert.deepEqual(fs.readdirSync(race.paths.rounds), ['r001'], '不留 r002')
        //終檢讀提案帳即失敗(其間帳被改壞)⇒ 終檢先於建輪夾 ⇒ 拋錯且不建輪夾(terra 第二輪 #5)
        race.governance.decide('P001', { accept: false, why: '不採' })
        race.loadPolicy = async () => { fs.writeFileSync(race.paths.govProposals, '{bad'); return origLoad() }
        let e3 = null
        try { await race.explore() } catch (e) { e3 = e } finally { race.loadPolicy = origLoad }
        assert.ok(e3 && /提案帳非 JSON/.test(e3.message), String(e3))
        assert.deepEqual(fs.readdirSync(race.paths.rounds), ['r001'], '不建 r002')
    })

    it('GV08 收件匣、status、報告', async () => {
        let rsi = fresh('gv08')
        await rsi.auto({ noDream: true })
        rsi.governance.propose({ round: 1, from: 'dream', items: [NEW, { kind: 'note', title: '量尺', mechanism: 'm' }] })
        fs.writeFileSync(rsi.paths.genRequest, JSON.stringify({ at: new Date().toISOString(), round: 'r001' }))
        let ib = rsi.governance.inbox()
        assert.deepEqual([ib.proposals.length, ib.byKind, ib.generation.round, ib.policyDev, ib.n], [2, { new: 1, note: 1 }, 'r001', null, 3])
        let st = await rsi.status({ print: false })
        assert.deepEqual(st.governance, { pending: 2, byKind: { new: 1, note: 1 }, extensions: 0 })
        let ex2 = await rsi.auto({ noDream: true })
        assert.ok(fs.readFileSync(path.join(ex2.fd, 'report.md'), 'utf8').includes('- 治理:待審之提案 2 筆(P001 new、P002 note)'))
        //提案帳損壞 ⇒ status 之 error 欄、報告一行(不中斷)
        fs.writeFileSync(rsi.paths.govProposals, '{bad')
        let st2 = await rsi.status({ print: false })
        assert.ok(st2.governance.error.includes('提案帳非 JSON'), JSON.stringify(st2.governance))
        let ex3 = await rsi.auto({ noDream: true })
        assert.ok(fs.readFileSync(path.join(ex3.fd, 'report.md'), 'utf8').includes('- 治理:提案帳無法讀取'))
        //擴充檔損壞(外審 terra #12)⇒ status 之 error 欄、報告一行;起跑時之重載即拋 ⇒ 不以舊目錄開輪
        fs.writeFileSync(rsi.paths.govProposals, JSON.stringify({ seq: 0, items: [] }))
        fs.writeFileSync(rsi.paths.govExtensions, '{bad')
        let st3 = await rsi.status({ print: false })
        assert.ok(st3.governance.error.includes('擴充檔非 JSON'), JSON.stringify(st3.governance))
        assert.ok(reportOf(rsi, 9, {}, [], [], {}).includes('- 治理:擴充檔無法讀取'))
        let nr = fs.readdirSync(rsi.paths.rounds).length
        await assert.rejects(() => rsi.auto({ noDream: true }), /擴充檔非 JSON/)
        assert.equal(fs.readdirSync(rsi.paths.rounds).length, nr, '不開輪')
        //擴充檔為合法 JSON 而深層結構不合(新臂缺 title / realize;terra 第二輪 #6)⇒ status、報告、生效目錄一致識別為損壞
        fs.writeFileSync(rsi.paths.govExtensions, JSON.stringify({ arms: [{ op: 'add', arm: { id: 'zz', layer: 'P' }, origin: { proposal: 'P009' } }] }))
        let st4 = await rsi.status({ print: false })
        assert.ok(st4.governance.error && st4.governance.error.includes('套用後之目錄不合'), JSON.stringify(st4.governance))
        assert.ok(reportOf(rsi, 9, {}, [], [], {}).includes('- 治理:擴充檔無法讀取'))
        assert.throws(() => rsi.governance.effectiveCatalog(), /套用後之目錄不合/)
    })

    it('GV09 未用治理者之可觀察面不變:臂即基底之同一物件、無 governance 夾、status 無此欄、報告無治理行、唯讀查詢不建夾(逐字之改前改後對拍為測試外之實跑證據)', async () => {
        let rsi = fresh('gv09')
        assert.ok(rsi.arms.arms.length === CATALOG.arms.length && rsi.arms.arms.every((a, i) => a === CATALOG.arms[i]), '無擴充 ⇒ makeArms 收到基底目錄本身')
        assert.strictEqual(effectiveCatalogOf(rsi.paths, CATALOG), CATALOG)
        assert.deepEqual(rsi.arms.warnings, [])
        let st0 = await rsi.status({ print: false })
        assert.equal(st0.governance, undefined, '未用治理 ⇒ status 無此欄')
        let ex1 = await rsi.auto({ noDream: true })
        assert.ok(!fs.readFileSync(path.join(ex1.fd, 'report.md'), 'utf8').includes('治理:'))
        assert.equal(fs.existsSync(rsi.paths.governance), false, '未用治理 ⇒ 不建夾')
        assert.deepEqual(fs.readdirSync(rsi.paths.root).sort(), ['policies', 'rounds', 'tmp', 'tree'], '狀態根之頂層與改前同')
        //把關未開時, 唯讀之查詢不建夾
        rsi.governance.pending(); rsi.governance.inbox(); rsi.governance.gate({ round: 9 })
        assert.equal(fs.existsSync(rsi.paths.governance), false)
    })

    it('GV10 cfg 與 ARM_KEYS', () => {
        assert.ok(CFG_KEYS.includes('governance') && ARM_KEYS.includes('origin'))
        assert.deepEqual(checkGovernanceCfg({ requireReview: true, maxPendingRounds: 2, gateKinds: ['new'] }).errors, [])
        assert.deepEqual(checkGovernanceCfg({ requireReview: null, maxPendingRounds: undefined, gateKinds: null }).errors, [], 'null / undefined 取預設')
        assert.equal(checkGovernanceCfg({ requireReview: 'yes', maxPendingRounds: -1, gateKinds: ['x'], foo: 1 }).errors.length, 4)
        assert.equal(checkGovernanceCfg({ maxPendingRounds: 1.5 }).errors.length, 1)
        assert.equal(checkGovernanceCfg([]).errors.length, 1)
        assert.ok(checkCfg({ governance: { foo: 1 } }).notes.some((n) => n.key === 'cfg.governance' && n.fatal))
        assert.throws(() => createRsi({ root: path.join(t.dir, 'gv10'), domain: makeDomain(), governance: { requireReview: 1 } }), /cfg\.governance\.requireReview/)
        let r = createRsi({ root: path.join(t.dir, 'gv10b'), domain: makeDomain(), governance: { requireReview: true, gateKinds: undefined, maxPendingRounds: null } })
        assert.deepEqual(r.governance.opt, { requireReview: true, maxPendingRounds: 0, gateKinds: ['new', 'layer', 'revise', 'retire'] })
        assert.ok(validateCatalog([{ id: 'a', title: 't', status: 'sparse', realize: [{ kind: 'manual', how: 'x' }], origin: 'x' }]).errors.some((e) => /origin 須為物件/.test(e)))
    })

    it('GV11 CLI:proposals / decide / 把關下之 explore', () => {
        let root = path.join(t.dir, 'gv11')
        let cfgFp = path.join(t.dir, 'cfgGov.mjs')
        fs.writeFileSync(cfgFp, `import { makeDomain } from ${JSON.stringify(pathToFileURL(path.join(FD_PACK, 'test', 'tools', 'toy.mjs')).href)}\nimport { CATALOG } from ${JSON.stringify(pathToFileURL(path.join(FD_PACK, 'test', 'tools', 'toyArms.mjs')).href)}\nexport default { root: ${JSON.stringify(root)}, domain: makeDomain(), budget: { arms: 4, novelty: 2, workers: 2 }, arms: { catalog: CATALOG }, governance: { requireReview: true } }\n`)
        let cli = (...a) => spawnSync(process.execPath, [path.join(FD_PACK, 'src', 'cli.mjs'), '--config', cfgFp, ...a], { encoding: 'utf8', windowsHide: true })
        let rsi = createRsi({ root, domain: makeDomain(), arms: { catalog: CATALOG }, governance: { requireReview: true } }).init()
        rsi.governance.propose({ round: 0, from: 'dream', items: [NEW, { kind: 'retire', arm: 'pair', mechanism: '與 px 重疊' }] })
        let p = cli('--mode', 'proposals')
        assert.ok(p.status === 0 && p.stdout.includes('## 待審(2 筆)') && p.stdout.includes('收件匣:待審之提案 2 筆'), p.stdout + p.stderr)
        let blocked = cli('--mode', 'explore')
        assert.ok(blocked.status === 2 && /治理待審/.test(blocked.stderr) && !fs.existsSync(path.join(root, 'rounds', 'r001')), blocked.stdout + blocked.stderr)
        for (let bad of [['--id', 'P001', '--accept'], ['--id', 'P001', '--why', 'x'], ['--id', 'P001', '--why', 'x', '--accept', '--reject'], ['--id', 'P009', '--why', 'x', '--reject'], ['--id', 'P001', '--why', 'x', '--accept'], ['--id', 'P001', '--why', 'x', '--accept', '--name', 'pz', '--realize', 'bogus:x']]) {
            let r = cli('--mode', 'decide', ...bad)
            assert.equal(r.status, 2, `${bad.join(' ')}\n${r.stdout}${r.stderr}`)
        }
        assert.equal(fs.existsSync(path.join(root, 'governance', 'extensions.json')), false, '被拒之審定不寫擴充檔')
        let ok = cli('--mode', 'decide', '--id', 'P001', '--accept', '--why', '機制獨立', '--name', 'zStep', '--title', 'z 步進', '--realize', 'manual:待實作', '--by', '審定者甲')
        assert.ok(ok.status === 0 && ok.stdout.includes('P001 accepted ⇒ P09_zStep;擴充已寫入、目錄已重載'), ok.stdout + ok.stderr)
        let rej = cli('--mode', 'decide', '--id', 'P002', '--reject', '--why', '仍在用')
        assert.ok(rej.status === 0 && rej.stdout.includes('P002 rejected'), rej.stdout + rej.stderr)
        let again = createRsi({ root, domain: makeDomain(), arms: { catalog: CATALOG } })
        assert.ok(again.arms.get('P09_zStep') && again.arms.get('P09_zStep').origin.by === '審定者甲' && again.arms.get('pair').status !== 'blocked')
        let run = cli('--mode', 'explore')
        assert.ok(run.status === 0 && fs.existsSync(path.join(root, 'rounds', 'r001')), run.stdout + run.stderr)
        rsi.governance.propose({ round: 1, from: 'dream', items: [{ kind: 'layer', title: '資訊源層', mechanism: '以資訊源為軸' }] })
        assert.equal(cli('--mode', 'explore').status, 2)
        assert.equal(cli('--mode', 'explore', '--ack-pending').status, 0, '--ack-pending 放行')
        let st = cli('--mode', 'status')
        assert.ok(st.status === 0 && st.stdout.includes('治理:待審之提案 1 筆'), st.stdout + st.stderr)
        //--out 不得指向 governance 夾(外審 terra #6);修訂只改明給之欄(terra #11)
        let bo = cli('--mode', 'proposals', '--out', path.join(root, 'governance', 'proposals.json'))
        assert.ok(bo.status === 2 && JSON.parse(fs.readFileSync(path.join(root, 'governance', 'proposals.json'), 'utf8')).items.length === 3, bo.stdout + bo.stderr)
        //經 junction 別名指向 governance 夾 ⇒ 同樣拒(實際路徑之比對;terra 第二輪 #3);只拆連結本身
        let jl = path.join(t.dir, 'govLink'), made = true
        try { fs.symlinkSync(path.join(root, 'governance'), jl, 'junction') } catch (e) { made = false }
        if (made) {
            let bj = cli('--mode', 'proposals', '--out', path.join(jl, 'proposals.json'))
            try { fs.unlinkSync(jl) } catch (e) { fs.rmdirSync(jl) }
            assert.ok(bj.status === 2 && JSON.parse(fs.readFileSync(path.join(root, 'governance', 'proposals.json'), 'utf8')).items.length === 3, bj.stdout + bj.stderr)
        }
        let okOut = path.join(t.dir, 'proposals-out.md')
        assert.ok(cli('--mode', 'proposals', '--out', okOut).status === 0 && fs.readFileSync(okOut, 'utf8').startsWith('# 治理:提案帳'), '一般路徑可寫')
        rsi.governance.propose({ round: 2, from: 'dream', items: [{ kind: 'revise', arm: 'py', mechanism: '提案之新定義' }] })
        let rv = cli('--mode', 'decide', '--id', 'P004', '--accept', '--why', '改名', '--title', 'y 步進(新)')
        let py = createRsi({ root, domain: makeDomain(), arms: { catalog: CATALOG } }).arms.get('py')
        assert.ok(rv.status === 0 && py.title === 'y 步進(新)' && py.desc === '±1 / ±2', rv.stdout + rv.stderr + JSON.stringify(py))
        //全新之狀態根:proposals(唯讀)與被拒之 decide 不初始化狀態根(terra #15)
        let root2 = path.join(t.dir, 'gv11fresh'), cfg2 = path.join(t.dir, 'cfgGov2.mjs')
        fs.writeFileSync(cfg2, fs.readFileSync(cfgFp, 'utf8').replace(JSON.stringify(root), JSON.stringify(root2)))
        let cli2 = (...a) => spawnSync(process.execPath, [path.join(FD_PACK, 'src', 'cli.mjs'), '--config', cfg2, ...a], { encoding: 'utf8', windowsHide: true })
        assert.equal(cli2('--mode', 'proposals').status, 0)
        assert.equal(cli2('--mode', 'decide', '--id', 'P999', '--why', 'x', '--reject').status, 2)
        assert.equal(fs.existsSync(root2), false, '未建狀態根')
    })

    it('GV12 他實例之過期目錄與預設選臂:審定後他實例起跑即重載;停用 cfg.arms.use 之臂之審定 ⇒ 拒(不使下一次組裝失敗)', async () => {
        //外審 terra #2:B 組裝於 A 之審定前 ⇒ B 之 explore 起跑時比對擴充檔而重載, 不以過期之目錄選臂
        let A = fresh('gv12')
        let B = createRsi({ root: A.paths.root, domain: makeDomain(), budget: { arms: 4, novelty: 2, workers: 2 }, arms: { catalog: CATALOG } })
        A.governance.propose({ round: 0, from: 'dream', items: [{ kind: 'retire', arm: 'px', mechanism: '停用' }] })
        A.governance.decide('P001', { accept: true, why: '停用' })
        assert.equal(B.arms.get('px').status, 'partial', '前提:B 之目錄為審定前')
        let err = null
        try { await B.explore({ useArms: ['px'] }) } catch (e) { err = e }
        assert.ok(err && err.code === 'RSI_ARMS_REJECTED' && B.arms.get('px').status === 'blocked', String(err))
        assert.equal(fs.existsSync(B.paths.fdRound(1)), false)
        assert.equal(B.syncArms(), false, '已同步 ⇒ 不再重載')
        //審定發生於 B 起跑之同步後、取輪號前(terra 第二輪 #2;事件同步:於 B 呼叫 loadPolicy 之當下審定)⇒ 取號前再比對而重驗選臂 ⇒ 拒、不開輪
        A.governance.propose({ round: 0, from: 'dream', items: [{ kind: 'retire', arm: 'py', mechanism: '停用' }] })
        let origLoadB = B.loadPolicy
        B.loadPolicy = async () => { A.governance.decide('P002', { accept: true, why: '停用' }); return origLoadB() }
        let err2 = null
        try { await B.explore({ useArms: ['py'] }) } catch (e) { err2 = e } finally { B.loadPolicy = origLoadB }
        assert.ok(err2 && err2.code === 'RSI_ARMS_REJECTED' && /py/.test(err2.message), String(err2))
        assert.equal(fs.existsSync(B.paths.fdRound(1)), false, '不開輪')
        //外審 terra #4:停用(或使不可選)cfg.arms.use 所列之臂 ⇒ 審定於寫入前被拒, 擴充檔不寫, 原設定仍可組裝
        let U = fresh('gv12use', { arms: { catalog: CATALOG, use: ['py'] } })
        U.governance.propose({ round: 0, from: 'dream', items: [{ kind: 'retire', arm: 'py', mechanism: '停用' }, { kind: 'revise', arm: 'py', mechanism: '改落成' }] })
        assert.throws(() => U.governance.decide('P001', { accept: true, why: '停用' }), /cfg\.arms\.use 被拒/)
        assert.throws(() => U.governance.decide('P002', { accept: true, why: '改落成', arm: { realize: [{ kind: 'operator', op: 'P.unregistered' }] } }), /cfg\.arms\.use 被拒/)
        assert.equal(fs.existsSync(U.paths.govExtensions), false)
        assert.ok(createRsi({ root: U.paths.root, domain: makeDomain(), arms: { catalog: CATALOG, use: ['py'] } }).arms.get('py').status === 'sparse')
        //兩個審定者以 name 配號(terra #8):配號於鎖內依最新目錄 ⇒ 依序得不同之 id
        A.governance.propose({ round: 1, from: 'dream', items: [NEW, { kind: 'new', layer: 'P', title: 'w 步進', mechanism: '對 w 軸步進' }] })
        let d2 = A.governance.decide('P003', { accept: true, why: '一', name: 'same', arm: { realize: [{ kind: 'manual', how: '—' }] } })
        let d3 = B.governance.decide('P004', { accept: true, why: '二', name: 'same', arm: { realize: [{ kind: 'manual', how: '—' }] } })
        assert.deepEqual([d2.item.decision.ref, d3.item.decision.ref], ['P09_same', 'P10_same'])
    })
})
