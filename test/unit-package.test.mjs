// unit-package.test.mjs — 套件結構與發布面守門:package.json、依賴對帳、按需引入、npm 打包清單、範例 g.mjs、JSDoc 覆蓋與範例實跑、發布內容去識別
//
// 【佈局】原始碼全在 src/(聚合入口 src/WRecursi.mjs,另有 src/index.mjs 與 src/protocol.mjs);套件根另有 g.mjs(範例)、toolg/(編譯與文件工具)、test/;下文路徑除註明外皆相對套件根
// ① 發布面:scripts 為 test 與 deploy;不設 exports / files / type;main 指 dist UMD;不提供 .npmignore(npm 包＝git 版控內容,依 .gitignore;
//   .gitignore 列 CLAUDE*.md、不排除 sgud / src / dist / test/tools);根目錄範本檔齊備;LICENSE 為 MIT 且署名同作者
// ② 依賴對帳:src/ 實際 import 之 npm 套件僅 lodash-es(單函數路徑;由 wsemi 之依賴帶入,package.json 只宣告 wsemi);toolg/ 只用 w-package-tools;
//   node 內建模組一律無 node: 前綴,且與 toolg/gDistRollup.mjs 之 external / globals 清單一致
// ③ npm 打包清單(npm pack --dry-run):含 sgud/ 四份索引、test/tools/ 全部檔、聚合入口、README、LICENSE、package.json;不含 CLAUDE*.md、tmp、test/_tmp、node_modules
// ④ 範例 g.mjs 離線可直接執行(不連網),輸出與檔末 // => 逐行相符,README 之 Example 含 g.mjs 全文
// ⑤ JSDoc:src/ 每個匯出皆有 JSDoc;函式另有 @param(有參數者)、@returns(class 除外)、@example;全部 @example 實跑,輸出與 // => 逐行相符
// ⑥ 發布內容(src、test、README、sgud、g.mjs、toolg、package.json)不含宿主之痕跡:磁碟機絕對路徑、宿主專案之檔名 / 目錄名 / 輪號 / 工單編號 / 業務領域字樣;
//   具名例外見 HOST_EXCEPTIONS(程式內之執行期字串,內含宿主字樣而依「程式行為與錯誤訊息文字不改」未動,待裁定;例外過時須移除)
// 執行:在套件根 node <mocha> test/unit-package.test.mjs(暫存 test/_tmp/package-<pid>_*,測完即刪;不連網)

import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { execFileSync, execSync } from 'child_process'
import { isBuiltin } from 'module'
import { makeTmp, FD_PACK } from './tools/tmpdir.mjs'
import { mjsFilesOf, docBlocksOf, examplesOf, runExample } from './tools/jsdocExamples.mjs'


const ROOT = FD_PACK.replace(/\\/g, '/')
const SELF = 'test/unit-package.test.mjs'
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const readOpt = (rel) => { try { return read(rel) } catch (e) { return null } }
const relOf = (fp) => path.relative(ROOT, fp).replace(/\\/g, '/')
const pkg = JSON.parse(read('package.json'))

/** 檔案之 import 指定詞(靜態 import / export … from / 字串常值之動態 import) */
const specifiersOf = (text) => {
    let out = []
    for (let m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n;]*?\bfrom\s*(['"])([^'"\n]+)\1/g)) { out.push(m[2]) }
    for (let m of text.matchAll(/(?:^|\n)\s*import\s*(['"])([^'"\n]+)\1/g)) { out.push(m[2]) }
    for (let m of text.matchAll(/\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g)) { out.push(m[2]) }
    return out
}
const pkgNameOf = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0])
const bareOf = (files) => {
    let set = new Map()
    for (let f of files) { for (let s of specifiersOf(read(f))) { if (!s.startsWith('.') && !s.startsWith('/') && !/^file:/.test(s)) { if (!set.has(s)) { set.set(s, new Set()) } set.get(s).add(f) } } }
    return set
}
const srcFiles = () => mjsFilesOf(path.join(FD_PACK, 'src')).map(relOf)
const testFiles = () => mjsFilesOf(path.join(FD_PACK, 'test')).map(relOf).filter((f) => !f.startsWith('test/_tmp/'))

/** 宿主之痕跡(宿主專案之檔名 / 目錄名 / 內部輪號 / 工單編號 / 業務領域字樣 / 磁碟機路徑);程式識別字(如實例變數 rsi、createRsi)不在內 */
const HOST_PATTERNS = [
    ['磁碟機絕對路徑', /\b[A-Za-z]:[\\/]/],
    ['宿主目錄 / 檔名', /\brsi\/|\.\/rsi\b|rsiPack|tmpRSI|rsiFix|packApi\.mjs|packProtocol\.mjs|packConfig\.mjs|roundBudget\.mjs/],
    ['宿主輪號 / 工單', /\brsi\s+r\d{2,3}\b|TOOL_REQUEST|loop[A-Z]|改善窗|\bUD13\b|W4 事故|審計\s*[A-Z]\d|雙獨立審|三獨立審|三方獨立審|③#\d|cap_snapshot/],
    ['宿主流程詞', /fill-null|fastNull|宇集|資料迄點|不分群|建型|送論證|論證過|既有型|機制形式|型內容/],
    ['宿主業務領域', /量化|交易|\bBTC\b|\bPIT\b|台股|pickAndPlace|sidePolicy|winEqYr|sameDose|btcOK/],
    ['宿主名(散文)', /\brsi\s+設\s*\d/],
]
/** 具名例外:執行期字串(錯誤訊息、用法字串、領域鉤子說明)內含宿主字樣,依「程式行為與錯誤訊息文字不改」未動,待主控裁定;files 為出現處,re 為該字樣 */
const HOST_EXCEPTIONS = [
    { file: 'src/core/domainContract.mjs', re: /rsi 改善窗 B 之 B9/, why: 'DOMAIN_KEYS.excludeArm.doc(領域介面錯誤訊息引用之說明文字)' },
    { file: 'src/core/domainContract.mjs', re: /rsi r128 #1/, why: 'DOMAIN_KEYS.proposalBlock.doc' },
    { file: 'src/core/domainContract.mjs', re: /如只取 PIT 節點/, why: 'DOMAIN_KEYS.turningParentOk.doc' },
    { file: 'src/cli.mjs', re: /node rsi\/run\.mjs/, why: '通用 CLI 之用法字串(--help 輸出)' },
    { file: 'src/core/domainContract.mjs', re: /如既有型/, why: 'DOMAIN_KEYS.isAnchor.doc' },
    { file: 'src/core/domainContract.mjs', re: /論證過/, why: 'DOMAIN_KEYS.excludeArm.doc(同上列)' },
    { file: 'src/index.mjs', re: /rsi 設 \d/, why: 'checkCfg 之提示訊息(cfg.dream.targetLadder)' },
    // 以下為程式識別字 / 選項名 / 資料欄位名(行為不改):證據別名旗標 --btcOK(與 --mech、--usability 同為 evidence 之別名)與舊式別名判式之原料欄位
    { file: 'src/cli.mjs', re: /btcOK/, why: '證據別名旗標 btcOK(選項名)' },
    { file: 'src/index.mjs', re: /btcOK/, why: 'CFG 說明註解提及證據別名旗標' },
    { file: 'src/loop/explore.mjs', re: /sameDose/, why: 'isAliasShort(舊式相容判式)讀領域原料之固定欄位' },
    { file: 'README.md', re: /btcOK/, why: 'CLI 說明提及證據別名旗標' },
    { file: 'sgud/state/state.md', re: /btcOK/, why: '現況記載證據別名旗標(待泛化)' },
    { file: 'test/tools/toy.mjs', re: /btcOK/, why: '玩具判讀之證據鍵' },
    { file: 'test/tools/toyConfig.mjs', re: /btcOK/, why: '玩具設定之證據鍵與說明' },
    { file: 'test/unit-cli.test.mjs', re: /btcOK/, why: 'unit-cli 以證據別名旗標驗證' },
    { file: 'test/unit-aliasPreJob.test.mjs', re: /sameDose/, why: '舊式判式之玩具評估器欄位' },
]

/** 本檔為原始碼庫之發布面守門(讀 .gitignore、devDependencies 安裝物、以 npm pack 驗清單);以套件形式安裝於 node_modules 內時略過(使用端另跑 test/ 時不誤紅) */
const INSTALLED = /[\\/]node_modules[\\/]/.test(ROOT)

describe('unit-package', function() {

    this.timeout(300_000)

    before(function() {
        if (INSTALLED) { this.skip() }
    })

    describe('① package.json 與發布面', () => {
        it('scripts 為 test(mocha --no-parallel 之標準指令)與 deploy(文件發布),不增設其他指令', () => {
            // 規則:自有套件之 package.json 提供 npm test 與 deploy;本套件之測試含跨程序鎖 / 槽位峰值 / 讀寫壓力之時序案,故維持 --no-parallel
            assert.deepStrictEqual(Object.keys(pkg.scripts), ['test', 'deploy'])
            assert.strictEqual(pkg.scripts.test, 'mocha --no-parallel "test/*.test.mjs" --timeout 180000')
            assert.strictEqual(pkg.scripts.deploy, 'gh-pages -d docs')
        })

        it('欄位:name、semver 版本、main 指 dist UMD、不設 exports / files / type、repository / keywords / author / license;LICENSE 為 MIT 且署名同作者', () => {
            assert.strictEqual(pkg.name, 'w-recursi')
            assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
            assert.strictEqual(pkg.main, 'dist/w-recursi.umd.js')
            // 規則:設 exports 即擋掉「套件名/src/…」「套件名/test/tools/…」之深層路徑;設 type: module 則 .js 之 dist 被視為 ESM 而 require 失敗
            for (let k of ['exports', 'files', 'type']) { assert.strictEqual(pkg[k], undefined, `不設 ${k}`) }
            assert.deepStrictEqual([pkg.repository.type, pkg.repository.url], ['git', 'git+https://github.com/yuda-lyu/w-recursi.git'])
            assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 3 && typeof pkg.author === 'string' && pkg.author.length > 0)
            assert.strictEqual(pkg.license, 'MIT')
            let lic = read('LICENSE')
            assert.ok(lic.startsWith('MIT License') && lic.includes(`Copyright (c) 2026 ${pkg.author}`), 'LICENSE 須為 MIT 並署名作者')
        })

        it('不提供 .npmignore;.gitignore 列 CLAUDE*.md、tmp、test/_tmp,不排除 sgud / src / dist / test/tools,不加 !CLAUDE.md', () => {
            // 規則:npm 包＝git 版控內容(依 .gitignore);sgud/、test/(含 test/tools/)、docs/ 隨包;CLAUDE*.md 由 .gitignore 排除,不入版控亦不入包
            assert.strictEqual(fs.existsSync(path.join(ROOT, '.npmignore')), false, '本套件無外部執行檔、無 ≥10MB 之非程式碼資料夾,不得有 .npmignore')
            let gi = read('.gitignore').split(/\r?\n/).map((l) => l.trim())
            for (let k of ['CLAUDE*.md', 'tmp', 'test/_tmp', 'node_modules']) { assert.ok(gi.includes(k), `.gitignore 須列 ${k}`) }
            assert.ok(!gi.some((l) => /^!?\/?sgud/.test(l) || l === '!CLAUDE.md'), '.gitignore 不得排除 sgud、不得加 !CLAUDE.md')
            assert.ok(!gi.some((l) => /^\/?(src|dist|toolg|docs)\/?$/.test(l) || /^\/?test(\/tools)?\/?$/.test(l)), '.gitignore 不得排除 src、dist、toolg、docs、test、test/tools')
        })

        it('REC-19 深層路徑穩定:src/ 全部 32 檔與 test/tools/toy.mjs、toyArms.mjs 皆在原路徑(使用端以路徑深層匯入,不得改名、搬動)', () => {
            const STABLE = [
                'src/index.mjs', 'src/protocol.mjs', 'src/WRecursi.mjs', 'src/cli.mjs',
                ...['canonical', 'cli', 'domainContract', 'hookResult', 'jsonl', 'lock', 'paths', 'proc', 'slots', 'writeRoot'].map((n) => `src/core/${n}.mjs`),
                ...['alias', 'node', 'store', 'view'].map((n) => `src/tree/${n}.mjs`),
                ...['arms', 'operators', 'policyV0', 'turning'].map((n) => `src/search/${n}.mjs`),
                ...['auto', 'explore', 'generation', 'policyDev', 'report', 'status'].map((n) => `src/loop/${n}.mjs`),
                ...['dream', 'replay'].map((n) => `src/sim/${n}.mjs`),
                ...['runner', 'worker'].map((n) => `src/eval/${n}.mjs`),
                'test/tools/toy.mjs', 'test/tools/toyArms.mjs',
            ]
            assert.strictEqual(STABLE.length, 34)
            assert.deepStrictEqual(STABLE.filter((f) => !fs.existsSync(path.join(ROOT, f))), [])
        })

        it('根目錄範本檔與 toolg/ 標準檔齊備;toolg/ 只有標準六支', () => {
            for (let f of ['.editorconfig', '.eslintignore', '.eslintrc.js', '.jsdoc', 'babel.config.js', 'SECURITY.md', 'LICENSE', 'README.md', 'script.txt', 'g.mjs', 'package.json']) {
                assert.ok(fs.existsSync(path.join(ROOT, f)), `套件根須有 ${f}`)
            }
            assert.deepStrictEqual(fs.readdirSync(path.join(ROOT, 'toolg')).sort(), ['addVersion.mjs', 'cleanFolder.mjs', 'gDistRollup.mjs', 'gDocsExams.mjs', 'genDocsDist.mjs', 'modifyReadme.mjs'])
            let g = read('toolg/gDistRollup.mjs')
            assert.ok(g.includes("let fdSrc = './src'") && g.includes("let fdTar = './dist'") && g.includes("fns: 'WRecursi.mjs'"), 'gDistRollup 須以 ./src、./dist 與聚合入口 WRecursi.mjs')
        })
    })

    describe('② 依賴對帳與按需引入', () => {
        it('src/ 之 npm 套件僅 lodash-es(單函數路徑,由 wsemi 之依賴帶入);dependencies 只宣告 wsemi、devDependencies 只宣告 w-package-tools;toolg/ 與 g.mjs 之 import 皆在宣告內', () => {
            let bare = bareOf(srcFiles())
            let pkgs = new Set([...bare.keys()].filter((s) => !isBuiltin(s)).map(pkgNameOf))
            assert.deepStrictEqual([...pkgs], ['lodash-es'], 'src/ 只應引用 lodash-es')
            let wsemi = JSON.parse(read('node_modules/wsemi/package.json'))
            assert.ok(wsemi.dependencies && wsemi.dependencies['lodash-es'], '前提:wsemi 之依賴含 lodash-es(package.json 因此不另宣告)')
            assert.deepStrictEqual(Object.keys(pkg.dependencies), ['wsemi'])
            assert.deepStrictEqual(Object.keys(pkg.devDependencies), ['w-package-tools'])
            for (let [k, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) { assert.match(v, /^\^\d+\.\d+\.\d+$/, `${k} 之版本範圍須為 semver(^x.y.z)`) }
            // 編譯與文件工具只用 w-package-tools;範例只用 node 內建與本套件
            let tool = bareOf(fs.readdirSync(path.join(ROOT, 'toolg')).map((f) => `toolg/${f}`))
            assert.deepStrictEqual([...new Set([...tool.keys()].map(pkgNameOf))], ['w-package-tools'])
            assert.deepStrictEqual([...bareOf(['g.mjs']).keys()], ['fs'])
            // 測試只用 node 內建(含 assert)與 lodash-es
            let tb = [...bareOf(testFiles()).keys()].filter((s) => !isBuiltin(s)).map(pkgNameOf)
            assert.deepStrictEqual([...new Set(tb)], ['lodash-es'])
            // mocha 隨 w-package-tools 安裝,由 scripts.test 呼叫、不被 import,但須可解析
            assert.doesNotThrow(() => import.meta.resolve('mocha'))
        })

        it('按需引入:src/ 無 lodash-es 主入口(整包匯入類),一律單函數路徑且可解析;node 內建模組一律無 node: 前綴', () => {
            let bad = [], n = 0
            for (let [s, fs_] of bareOf(srcFiles())) {
                if (s === 'lodash-es' || s === 'lodash') { bad.push(`${s} ← ${[...fs_].join(',')}`) }
                else if (s.startsWith('lodash-es/')) { n++; assert.ok(/^lodash-es\/[A-Za-z0-9]+\.js$/.test(s), `單函數路徑形:${s}`); assert.doesNotThrow(() => import.meta.resolve(s), `可解析:${s}`) }
                if (s.startsWith('node:')) { bad.push(`${s} ← ${[...fs_].join(',')}(內建模組須無前綴)`) }
            }
            assert.deepStrictEqual(bad, [])
            assert.ok(n >= 40, `單函數路徑數過少:${n}`)
        })

        it('gDistRollup 之 external 與 globals ＝ src/ 實用之 node 內建模組(圖內全部,逐字比對)', () => {
            let used = new Set([...bareOf(srcFiles()).keys()].filter((s) => isBuiltin(s)))
            let g = read('toolg/gDistRollup.mjs')
            let block = (key) => { let m = new RegExp(`${key}:\\s*[\\[{]([\\s\\S]*?)[\\]}],?\\s*\\n\\s*(?:external|\\}\\))`).exec(g); return m ? m[1] : '' }
            let ext = [...block('external').matchAll(/^\s*'([^']+)',?\s*$/gm)].map((m) => m[1])
            let glo = [...block('globals').matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1])
            // 入口圖外之檔(命令列入口、子程序入口)亦只用同一批內建模組;worker_threads 等未用者不列
            assert.deepStrictEqual([...ext].sort(), [...used].sort(), 'external 須恰為 src/ 用到之內建模組')
            assert.deepStrictEqual([...glo].sort(), [...used].sort(), 'globals 須恰為 src/ 用到之內建模組')
            assert.ok(used.size >= 7)
        })
    })

    describe('③ npm 打包清單', () => {
        it('npm pack --dry-run:含 sgud/ 四份索引與 test/tools/ 全部檔、聚合入口、README、LICENSE、package.json、toolg/;不含 CLAUDE*.md、tmp、test/_tmp、node_modules', () => {
            // 規則:npm 包＝git 版控內容(依 .gitignore);sgud/ 與 test/tools/ 隨包(下游之測試以「套件名/test/tools/…」取用),CLAUDE*.md 不入包
            let raw = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true })
            let parsed = JSON.parse(raw)
            let info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
            let packed = info.files.map((x) => x.path.replace(/\\/g, '/'))
            assert.ok(packed.length >= 100, `打包清單過少:${packed.length}`)
            for (let f of ['sgud/exp/experience.md', 'sgud/proc/process.md', 'sgud/rule/rulebook.md', 'sgud/state/state.md', 'src/WRecursi.mjs', 'src/index.mjs', 'src/protocol.mjs', 'README.md', 'LICENSE', 'package.json', 'g.mjs', 'toolg/gDistRollup.mjs']) {
                assert.ok(packed.includes(f), `打包清單須含 ${f}`)
            }
            let tools = fs.readdirSync(path.join(ROOT, 'test', 'tools'), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `test/tools/${e.name}`)
            assert.ok(tools.length >= 12, `test/tools 檔數過少:${tools.length}`)
            for (let f of tools) { assert.ok(packed.includes(f), `打包清單須含 ${f}`) }
            for (let f of ['test/tools/toy.mjs', 'test/tools/toyArms.mjs']) { assert.ok(packed.includes(f), `下游以深層路徑取用:${f}`) }
            assert.deepStrictEqual(packed.filter((f) => /(^|\/)CLAUDE[^/]*\.md$/.test(f)), [], '打包清單不得含 CLAUDE*.md')
            assert.deepStrictEqual(packed.filter((f) => /^(tmp|test\/_tmp|node_modules)\//.test(f)), [], '打包清單不得含 tmp、test/_tmp、node_modules')
            assert.deepStrictEqual(packed.filter((f) => /(^|\/)\.npmignore$/.test(f)), [])
        })
    })

    describe('④ 範例 g.mjs 與 README', () => {
        it('g.mjs 離線可直接執行(不連網、不留工作目錄),輸出與檔末 // => 逐行相符;README 之 Example 含 g.mjs 全文', () => {
            // 規則:自有套件根目錄 g.mjs 為可直接執行之範例,README 之 Example 連該檔(改 g.mjs 須同步 README)
            let g = read('g.mjs').replace(/\r\n/g, '\n')
            let rd = read('README.md').replace(/\r\n/g, '\n')
            assert.ok(g.length > 1500 && rd.includes(g.trimEnd()), 'README 之 Example 須含 g.mjs 全文')
            let lines = g.split('\n')
            let at = lines.findIndex((l) => l.startsWith('// => '))
            assert.ok(at > 0, 'g.mjs 檔末須附 `// =>` 輸出')
            let want = lines.slice(at).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ => /, '').replace(/^\/\/ ?/, ''))
            // 工作目錄 ./_test_recursi 落在 cwd;cwd 須在套件內(預設策略 v0.mjs 以套件名匯入 lodash-es,須能向上解析 node_modules)
            let tmp = makeTmp('package-g')
            try {
                let out = execFileSync(process.execPath, [path.join(ROOT, 'g.mjs')], { cwd: tmp.dir, encoding: 'utf8', timeout: 120_000, windowsHide: true })
                assert.deepStrictEqual(out.replace(/\r\n/g, '\n').trimEnd().split('\n'), want)
                assert.strictEqual(fs.existsSync(path.join(tmp.dir, '_test_recursi')), false, '範例結束須清掉工作目錄')
            }
            finally { tmp.cleanup() }
        })

        it('README 之 §6 測試表列出 test/ 下每一個測試檔(unit-*.test.mjs),且不列不存在者', () => {
            let rd = read('README.md')
            let have = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => /^unit-.*\.test\.mjs$/.test(f)).map((f) => f.replace(/\.test\.mjs$/, ''))
            let sec = rd.slice(rd.indexOf('## 6. 測試'), rd.indexOf('## 7.'))
            let listed = [...sec.matchAll(/\|\s*`(unit-[A-Za-z0-9]+(?:`\s*\/\s*`unit-[A-Za-z0-9]+)*)`\s*\|/g)].flatMap((m) => m[1].split(/`\s*\/\s*`/))
            assert.deepStrictEqual(have.filter((f) => !listed.includes(f)), [], 'README §6 漏列')
            assert.deepStrictEqual(listed.filter((f) => !have.includes(f)), [], 'README §6 列了不存在之測試檔')
        })
    })

    describe('⑤ JSDoc 覆蓋與範例', () => {
        let blocks = null
        const getBlocks = async () => {
            if (blocks) { return blocks }
            blocks = []
            for (let fp of mjsFilesOf(path.join(FD_PACK, 'src'))) {
                let bs = docBlocksOf(fs.readFileSync(fp, 'utf8'))
                if (!bs.length) { continue }
                let names = Object.keys(await import(new URL(`file:///${fp.replace(/\\/g, '/')}`).href)).filter((k) => k !== 'default')
                for (let b of bs) { blocks.push({ ...b, file: fp, rel: relOf(fp), names }) }
            }
            return blocks
        }

        it('src/ 每個匯出皆有 JSDoc;函式另有 @param(有參數者)、@returns(class 除外)、@example', async () => {
            let bs = await getBlocks()
            let bad = []
            for (let b of bs) {
                let where = `${b.rel}:${b.line} ${b.name}`
                if (b.doc === null || !b.doc.trim()) { bad.push(`${where} 無 JSDoc`); continue }
                if (b.kind === 'const') { continue }
                if (b.hasParams && !/@param /.test(b.doc)) { bad.push(`${where} 缺 @param`) }
                if (b.kind === 'function' && !/@returns /.test(b.doc)) { bad.push(`${where} 缺 @returns`) }
                if (!/@example\b/.test(b.doc)) { bad.push(`${where} 缺 @example`) }
            }
            assert.deepStrictEqual(bad, [])
            assert.ok(bs.filter((b) => b.kind === 'function').length >= 100, '函式匯出過少(掃描範圍壞了?)')
            assert.ok(bs.filter((b) => b.kind === 'const').length >= 20, '常數匯出過少(掃描範圍壞了?)')
        })

        it('輔助自檢:docBlocksOf / examplesOf 抓得到有無 JSDoc、有無參數、預期輸出列', () => {
            let t = '/**\n * d\n * @param {Number} a x\n * @returns {Number} y\n * @example\n * console.log(f(1))\n * // => 1\n */\nexport let f = (a) => a\nexport let g = () => 1\nexport const C = 1\n'
            let bs = docBlocksOf(t)
            assert.deepStrictEqual(bs.map((b) => [b.name, b.kind, b.hasParams, b.doc !== null]), [['f', 'function', true, true], ['g', 'function', false, false], ['C', 'const', false, false]])
            assert.deepStrictEqual(examplesOf(bs[0].doc), { code: 'console.log(f(1))\n// => 1', imports: [], expected: ['1'] })
            assert.strictEqual(examplesOf('只有說明'), null)
        })

        it('全部 @example 實跑:子程序輸出與 // => 逐行相符(暫存在 test/_tmp,不寫系統暫存)', async function() {
            this.timeout(280_000)
            let bs = (await getBlocks()).filter((b) => b.kind !== 'const' && b.doc && /@example\b/.test(b.doc))
            assert.ok(bs.length >= 100)
            let tmp = makeTmp('package-ex')
            try {
                let fails = [], idx = 0, id = 0
                let worker = async () => {
                    for (;;) {
                        let b = bs[idx++]
                        if (!b) { return }
                        let ex = examplesOf(b.doc)
                        let r = await runExample({ file: b.file, names: b.names, isDefault: b.isDefault, name: b.name, ex, tmpDir: tmp.dir, id: ++id })
                        if (!r.ok) { fails.push(`${b.rel}:${b.name} status=${r.status} 預期 ${JSON.stringify(r.expected)} 實得 ${JSON.stringify(r.got)} ${r.stderr}`) }
                    }
                }
                await Promise.all([worker(), worker(), worker()])
                assert.deepStrictEqual(fails, [])
            }
            finally { tmp.cleanup() }
        })
    })

    describe('⑥ 發布內容去識別', () => {
        const files = () => [
            ...srcFiles(), ...testFiles().filter((f) => f !== SELF),
            ...fs.readdirSync(path.join(ROOT, 'test', 'fixtures')).map((f) => `test/fixtures/${f}`),
            'README.md', 'g.mjs', 'package.json', 'script.txt', ...fs.readdirSync(path.join(ROOT, 'toolg')).map((f) => `toolg/${f}`),
            ...fs.readdirSync(path.join(ROOT, 'sgud'), { recursive: true }).filter((f) => /\.md$/.test(String(f))).map((f) => `sgud/${String(f).replace(/\\/g, '/')}`),
        ]

        it('判準自檢:被抓到與不誤判(實例變數 rsi、createRsi、套件名、相對路徑不算)', () => {
            let hit = (s) => HOST_PATTERNS.some(([, re]) => re.test(s))
            for (let s of ['D:/work/x', 'c:\\a', 'rsi/lib/x.mjs', './rsi/run.mjs', 'rsiPack', 'tmpRSI', 'rsi r115', 'TOOL_REQUEST', '改善窗 B', '審計 R9', '量化交易', 'PIT 節點', 'loopG_setup/x', 'fastNull 抽驗', '自動建型', '如既有型', '(③#5)']) { assert.ok(hit(s), s) }
            for (let s of ['rsi.explore()', 'let rsi = createRsi(cfg)', 'w-recursi/src/index.mjs', 'https://a.example/b', 'src/core/lock.mjs', '(rsi) => rsi.arms', 'r1000', 'unit-roundId', '非參數型節點', 'loop/explore.mjs']) { assert.ok(!hit(s), s) }
        })

        it('src、test、README、g.mjs、toolg、sgud、package.json 不含宿主之痕跡(本檔與具名例外除外);例外仍有對象', () => {
            let bad = [], exLeft = new Set(HOST_EXCEPTIONS.map((e, i) => i))
            for (let f of files()) {
                let text = read(f)
                text.split(/\r?\n/).forEach((l, i) => {
                    for (let [label, re] of HOST_PATTERNS) {
                        if (!re.test(l)) { continue }
                        let exs = HOST_EXCEPTIONS.map((e, k) => [e, k]).filter(([e]) => e.file === f && e.re.test(l)).map(([, k]) => k)
                        if (exs.length) { for (let k of exs) { exLeft.delete(k) } continue }
                        bad.push(`${f}:${i + 1} [${label}] ${l.trim().slice(0, 90)}`)
                    }
                })
            }
            assert.deepStrictEqual(bad, [])
            assert.deepStrictEqual([...exLeft].map((i) => HOST_EXCEPTIONS[i].why), [], '具名例外已無對象,須自 HOST_EXCEPTIONS 移除')
            assert.ok(files().length >= 90, '掃描量過少')
        })
    })
})
