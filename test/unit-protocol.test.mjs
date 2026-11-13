import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import * as I from '../src/index.mjs'
import * as P from '../src/protocol.mjs'


//公開面之快照與套件入口(2026-10-01)
//  PR01 / PR02:index(引擎 API)與 protocol(協定件)之匯出名快照 —— 公開面之變動必為有意(改匯出 ⇒ 同步改本快照與 README §4)
//  PR03:package.json 之 name = w-recursi、不設 exports / files(自有套件慣例:下游可深層匯入 src/**)、不設 type(main 為 CJS / UMD 之 dist/w-recursi.umd.js,原始碼一律 .mjs)、
//       dependencies 宣告 wsemi(lodash-es 由其提供, 不另宣告;使用端裁定 2026-10-04)、src 實用之外部套件皆已宣告
//  PR04:深層匯入(src/core/*.mjs)與兩入口(index / protocol)為同一模組實例;聚合入口 src/WRecursi.mjs 之每一鍵 = index 之同名匯出、protocol 鍵 = protocol 之匯出;
//       dist 由發布流程產製(不要求存在), 存在時以 require 載入核對鍵集合與型別同聚合入口
//  PR05:protocol 入口無副作用且不載引擎 index(輕量 CLI 由此取)
//2026-10-09:index 加 ROUND_NAME_SRC / isRoundDir / roundNumOf / roundNameOf / listRoundDirs、slotAuxOf、HOOK_FAIL_HEAD / hookFailureOf、assertWriteRoot / writeRootsOf;
//  protocol 另加 hookErrText、WRITE_ROOT_ENV / writeAllowed(README §4 之公開面段同步)
//2026-11-07 臂目錄(search/arms.mjs):index 加 ARMS_CFG_KEYS / ARMS_DEFAULTS / ARM_KEYS / ARM_STATUS / REALIZE_KINDS / catalogArmsOf / checkArmsCfg / featureOf / makeArms / selectableOf / unusedOf / validateCatalog
//2026-11-14 治理(search/governance.mjs;使用端 Gitea #138):index 加 GOVERNANCE_CFG_KEYS / GOVERNANCE_DEFAULTS / PROPOSAL_KINDS / PROPOSAL_STATUS / applyArmExtensions / checkGovernanceCfg / checkProposals / effectiveCatalogOf / makeGovernance / nextArmId / nextLayerId / readArmExtensions / renderProposals
const INDEX_EXPORTS = ['ARMS_CFG_KEYS', 'ARMS_DEFAULTS', 'ARM_KEYS', 'ARM_STATUS', 'CFG_KEYS', 'DEFAULT_BUDGET', 'DEFAULT_SIM', 'DOMAIN_KEYS', 'FRONTIER_BLOCKED', 'GOVERNANCE_CFG_KEYS', 'GOVERNANCE_DEFAULTS', 'HOOK_FAIL_HEAD', 'OCCUPIED', 'PROPOSAL_KINDS', 'PROPOSAL_STATUS', 'REALIZE_KINDS', 'ROUND_NAME_SRC', 'STATUS', 'accept', 'acquireSlots', 'aliasMapOf', 'aliasMapOfNodes', 'aliasPreOf', 'aliasShortOfDomain', 'allocateRound', 'applyArmExtensions', 'applyDiff', 'assertWriteRoot', 'canonicalJson', 'catalogArmsOf', 'checkArmsCfg', 'checkCfg', 'checkDomain', 'checkGovernanceCfg', 'checkPolicySource', 'checkProposals', 'clearGenRequest', 'createRsi', 'default', 'effectiveCatalogOf', 'evaluatePolicy', 'extractTurning', 'featureOf', 'frontierOutcomesOf', 'generationCheck', 'hookFailureOf', 'isAliasShort', 'isRoundDir', 'jobKey', 'lastChangeAtOf', 'listRoundDirs', 'loadPolicyFile', 'loadSummaries', 'makeArms', 'makeGovernance', 'makeNode', 'makePaths', 'makeRegistry', 'makeStore', 'makeView', 'markerStale', 'nextArmId', 'nextLayerId', 'nodeIdOf', 'noveltyDebtOf', 'nowIso', 'omitMask', 'parentIdsOf', 'peekRound', 'pidAlive', 'policyDevCheck', 'policySourcesOf', 'policyViewOfNode', 'readArmExtensions', 'readGenRequest', 'reclaimDeadSlots', 'reclaimJobDirs', 'releaseSlots', 'renderProposals', 'rescore', 'roundDirs', 'roundNameOf', 'roundNumOf', 'runJobs', 'selectableOf', 'sha', 'simulate', 'slotAuxOf', 'slotsInUse', 'slotsStatus', 'specDiff', 'specHash', 'tryAcquireSlots', 'unusedOf', 'validateCatalog', 'withLock', 'writeRootsOf']
const PROTOCOL_EXPORTS = ['CliError', 'HOOK_FAIL_HEAD', 'ROUND_NAME_SRC', 'WRITE_ROOT_ENV', 'acquireSlots', 'appendJsonl', 'assertWriteRoot', 'atomicStats', 'canonicalJson', 'hookErrText', 'hookFailureOf', 'isMainModule', 'isRoundDir', 'listRoundDirs', 'maxOfDir', 'newToken', 'nodeIdOf', 'nowIso', 'ownedBy', 'ownerLine', 'parseCli', 'pidAlive', 'readJson', 'readJsonl', 'readOwner', 'reclaimDeadSlots', 'releaseSlots', 'roundNameOf', 'roundNumOf', 'sha', 'sleepMs', 'slotAuxOf', 'slotsInUse', 'slotsStatus', 'specHash', 'tryAcquireSlots', 'usageOf', 'waitNote', 'withLock', 'writeAllowed', 'writeFileAtomic', 'writeJson', 'writeJsonl', 'writeRootsOf']
const FD_PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('公開面:index / protocol 之匯出快照與套件入口', () => {
    it('PR01 index 之匯出名 = 快照', () => { assert.deepStrictEqual(Object.keys(I).sort(), INDEX_EXPORTS) })
    it('PR02 protocol 之匯出名 = 快照', () => { assert.deepStrictEqual(Object.keys(P).sort(), PROTOCOL_EXPORTS) })
    it('PR03 package.json:name w-recursi、不設 exports / files / type、main 指 dist UMD、聚合入口存在;lodash-es 由 wsemi 提供(宣告 wsemi、不另宣告 lodash-es)', () => {
        let pj = JSON.parse(fs.readFileSync(path.join(FD_PACK, 'package.json'), 'utf8'))
        assert.equal(pj.name, 'w-recursi')
        assert.equal(pj.type, undefined, '不設 type(main 為 CJS / UMD 之 dist;.js 若被視為 ESM 則 require 失敗)')
        assert.equal(pj.exports, undefined, '不設 exports(自有套件慣例:下游可深層匯入 src/**)')
        assert.equal(pj.files, undefined, '不設 files(sgud/ 與 src/ 隨包發布;排除靠 .gitignore)')
        assert.equal(pj.main, 'dist/w-recursi.umd.js', 'main 指 dist UMD(由發布流程產製, 來源 src/WRecursi.mjs)')
        assert.ok(fs.existsSync(path.join(FD_PACK, 'src', 'WRecursi.mjs')), 'ESM 聚合入口 src/WRecursi.mjs 須存在')
        assert.ok(pj.dependencies && pj.dependencies.wsemi, 'dependencies 須宣告 wsemi(src 所用之 lodash-es 由其提供;使用端裁定 2026-10-04)')
        assert.ok(!pj.dependencies['lodash-es'], 'lodash-es 不另宣告(依 wsemi 所帶之版本, 免裝出第二份)')
        const VIA = { 'lodash-es': 'wsemi' } //由他套件提供之依賴 ⇒ 宣告其提供者即可
        //src 實用之外部套件皆已宣告(node 內建除外)
        let ext = new Set()
        let walk = (d) => { for (let e of fs.readdirSync(d, { withFileTypes: true })) { let fp = path.join(d, e.name); if (e.isDirectory()) { walk(fp) } else if (/\.mjs$/.test(e.name)) { for (let m of fs.readFileSync(fp, 'utf8').matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s+['"]([^'"./][^'"]*)['"]/gm)) { ext.add(m[1].split('/')[0]) } } } }
        walk(path.join(FD_PACK, 'src'))
        let builtin = new Set(['fs', 'path', 'url', 'crypto', 'zlib', 'os', 'child_process', 'module', 'util', 'string_decoder', 'events', 'worker_threads', 'readline', 'assert', 'stream', 'timers'])
        let undeclared = [...ext].filter((x) => !builtin.has(x) && !x.startsWith('node:') && !(pj.dependencies || {})[x] && !(VIA[x] && (pj.dependencies || {})[VIA[x]]))
        assert.deepStrictEqual(undeclared, [], `未宣告之外部依賴:${undeclared.join('、')}`)
    })
    it('PR04 深層匯入與兩入口同一實例;聚合入口 WRecursi 之每一鍵 = index / protocol 之同名匯出;dist(存在時)同聚合入口', async () => {
        let L = await import('../src/core/lock.mjs')
        let J = await import('../src/core/jsonl.mjs')
        assert.equal(L.withLock, P.withLock, '深層匯入之 withLock = protocol 轉出者')
        assert.equal(P.withLock, I.withLock, 'protocol 與 index 之 withLock 為同一實作(同一 core 模組)')
        assert.equal(J.readJsonl, P.readJsonl)
        let W = (await import('../src/WRecursi.mjs')).default
        let keys = INDEX_EXPORTS.filter((k) => k !== 'default')
        assert.deepStrictEqual(Object.keys(W).filter((k) => k !== 'protocol').sort(), keys, 'WRecursi 之鍵 = index 之具名匯出')
        for (let k of keys) { assert.strictEqual(W[k], I[k], `WRecursi.${k} 非 index 之同一實例`) }
        assert.deepStrictEqual(Object.keys(W.protocol).sort(), PROTOCOL_EXPORTS, 'WRecursi.protocol 之鍵 = protocol 之匯出')
        for (let k of PROTOCOL_EXPORTS) { assert.strictEqual(W.protocol[k], P[k], `WRecursi.protocol.${k} 非 protocol 之同一實例`) }
        //dist 由發布流程產製(clean 後可能不存在);存在時以 require 載入(UMD / CJS), 鍵集合與型別同聚合入口
        let fpDist = path.join(FD_PACK, 'dist', 'w-recursi.umd.js')
        if (fs.existsSync(fpDist)) {
            let D = createRequire(import.meta.url)(fpDist)
            assert.deepStrictEqual(Object.keys(D).sort(), Object.keys(W).sort(), 'dist 之鍵 = WRecursi 之鍵')
            for (let k of Object.keys(W)) { assert.strictEqual(typeof D[k], typeof W[k], `dist.${k} 之型別`) }
            assert.deepStrictEqual(Object.keys(D.protocol).sort(), PROTOCOL_EXPORTS, 'dist.protocol 之鍵')
        }
    })
    it('PR05 protocol 入口只有轉匯出(無副作用)、不引 index', () => {
        let src = fs.readFileSync(path.join(FD_PACK, 'src', 'protocol.mjs'), 'utf8')
        let code = src.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))
        assert.ok(code.length > 0)
        for (let l of code) { assert.match(l, /^export \{[^}]+\} from '\.\/core\/[\w]+\.mjs'$/, `protocol.mjs 只可有轉匯出列:${l}`) }
    })
})
