import assert from 'assert'
import cp from 'child_process'
import fs from 'fs'
import path from 'path'
import { syncBuiltinESMExports } from 'module'
import { fileURLToPath } from 'url'
import { runJobs } from '../src/eval/runner.mjs'
import { makeTmp, FD_TEST, FD_PACK } from './tools/tmpdir.mjs'


let P = (x, y) => ({ kind: 'point', x, y })
const TOY = path.join(FD_TEST, 'tools', 'toy.mjs')

//起子行程一律隱藏視窗(使用端 Gitea #127;rulebook 規則 REC-20)
//  Windows 上, 由無主控台之行程(detached / 排程 / 常駐服務)起子行程時, 未設 windowsHide: true 者每個各開一個終端機視窗
//  本檔兩層驗證: (1) 行為: runJobs 子程序模式實際傳給 spawn 之選項; (2) 盤點: src / test 內每一處起子行程之呼叫皆含 windowsHide: true

//盤點: 抓「起子行程之呼叫」並取出其完整引數文字(括號配對, 略過字串), 回傳 [{ line, name, args }]
//  僅掃有匯入 child_process 之檔; 裸名呼叫(具名匯入)與 cp. / child_process. 前綴呼叫都算; 前面有 . 者(如 RegExp 之 .exec)不算
const RE_IMPORT_CP = /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)|import\(\s*['"](?:node:)?child_process['"]\s*\)/
const NAMES = 'spawn|spawnSync|exec|execSync|execFile|execFileSync|fork'
const RE_CALL = new RegExp(`(?<![.\\w$])(?:${NAMES})\\s*\\(|(?<![\\w$])(?:cp|child_process|childProcess)\\.(?:${NAMES})\\s*\\(`, 'g')
export const scanSpawnCalls = (code) => {
    //整行註解不掃(其內可含呼叫範例字樣)
    let src = code.split(/\r?\n/).map((l) => (/^\s*(?:\/\/|\*|\/\*)/.test(l) ? ' '.repeat(l.length) : l)).join('\n')
    let out = []
    let m
    RE_CALL.lastIndex = 0
    while ((m = RE_CALL.exec(src)) !== null) {
        let i = RE_CALL.lastIndex
        let from = i
        let depth = 1
        while (i < src.length && depth > 0) {
            let c = src[i]
            if (c === '\'' || c === '"' || c === '`') {
                i++
                while (i < src.length && src[i] !== c) { if (src[i] === '\\') { i++ } i++ }
            }
            else if (c === '(') { depth++ }
            else if (c === ')') { depth-- }
            i++
        }
        out.push({ line: src.slice(0, m.index).split('\n').length, name: m[0].replace(/\s*\($/, ''), args: src.slice(from, i - 1) })
    }
    return out
}
//回傳未設 windowsHide: true 之呼叫
export const findUnhidden = (code) => scanSpawnCalls(code).filter((c) => !/windowsHide\s*:\s*true/.test(c.args))

let listMjs = (fd, skip = []) => {
    let out = []
    for (let e of fs.readdirSync(fd, { withFileTypes: true })) {
        let fp = path.join(fd, e.name)
        if (e.isDirectory()) { if (!skip.includes(e.name)) { out.push(...listMjs(fp, skip)) } }
        else if (e.isFile() && e.name.endsWith('.mjs')) { out.push(fp) }
    }
    return out
}


//runner 之子程序模式: 起 worker 之 spawn 須帶 windowsHide: true
//  作法: 以 syncBuiltinESMExports 換掉 child_process.spawn(runner 以具名匯入取用, 為 live binding), 記下實際傳入之選項後照常執行
describe('eval/runner:spawn 模式起 worker 時隱藏視窗(windowsHide)', function () {
    let t
    before(() => { t = makeTmp('runnerSpawnHide') })
    after(() => { t.cleanup() })

    it('每個 worker 之 spawn 選項皆含 windowsHide: true;worker 照常完成', async function () {
        this.timeout(60000)
        let seen = []
        let orig = cp.spawn
        cp.spawn = function (cmd, args, opts) {
            seen.push(opts)
            return orig.apply(this, arguments)
        }
        syncBuiltinESMExports()
        let r
        try {
            r = await runJobs([{ id: 'a', spec: P(1, 1) }, { id: 'b', spec: P(2, 2) }], { mode: 'spawn', evaluatorModule: TOY, workers: 2, tmpDir: t.dir, tag: 'wh' })
        }
        finally {
            cp.spawn = orig
            syncBuiltinESMExports()
        }
        assert(r.results.get('a').ok && r.results.get('b').ok, 'worker 照常完成')
        assert(seen.length >= 1, '應至少起 1 個 worker')
        assert.deepEqual(seen.map((o) => !!(o && o.windowsHide === true)), seen.map(() => true), `各 worker 之 windowsHide: ${JSON.stringify(seen.map((o) => o && o.windowsHide))}`)
    })
})


describe('起子行程一律 windowsHide: true(盤點 src / test / toolg)', function () {
    it('盤點器自檢: 抓得到未設者、放得過已設者、不誤抓 RegExp.exec 與註解', function () {
        let bad = findUnhidden(`import { spawn } from 'child_process'\nlet p = spawn(process.execPath, ['a'], { stdio: 'ignore' })`)
        assert.equal(bad.length, 1)
        assert.equal(bad[0].name, 'spawn')
        assert.equal(bad[0].line, 2)
        assert.equal(findUnhidden(`import { spawn } from 'child_process'\nlet p = spawn(process.execPath, [fp], { env: { ...process.env }, windowsHide: true })`).length, 0)
        assert.equal(findUnhidden(`import { spawnSync as s } from 'child_process'\nlet r = spawnSync(x, ['--input-type=module', '-e', "a(b"], { encoding: 'utf8' })`).length, 1, '字串內不成對之括號不得擾亂配對')
        assert.equal(findUnhidden(`import cp from 'child_process'\ncp.execSync('npm pack', { cwd: x })\ncp.execFileSync(a, [b], { windowsHide: true })`).length, 1)
        assert.equal(scanSpawnCalls(`import { spawn } from 'child_process'\nlet m = RE.exec(s)\n//spawn(a, b)\n * exec(a)`).length, 0)
    })

    it('src 內每一處起子行程之呼叫皆設 windowsHide: true(且確有掃到 runner 之 spawn)', function () {
        let files = listMjs(path.join(FD_PACK, 'src'))
        let hits = []
        let bad = []
        for (let fp of files) {
            let code = fs.readFileSync(fp, 'utf8')
            if (!RE_IMPORT_CP.test(code)) { continue }
            for (let c of scanSpawnCalls(code)) {
                hits.push(`${path.relative(FD_PACK, fp)}:${c.line}`)
                if (!/windowsHide\s*:\s*true/.test(c.args)) { bad.push(`${path.relative(FD_PACK, fp)}:${c.line} ${c.name}(`) }
            }
        }
        assert(files.length > 10, `應掃到 src 全部 mjs(實得 ${files.length})`)
        assert(hits.some((h) => h.replace(/\\/g, '/').startsWith('src/eval/runner.mjs:')), `掃描器應抓到 runner 之 spawn(實得 ${JSON.stringify(hits)})`)
        assert.deepEqual(bad, [], `未設 windowsHide: true:${JSON.stringify(bad)}`)
    })

    it('test / toolg 內每一處起子行程之呼叫皆設 windowsHide: true', function () {
        //本檔自身之自檢字串內含無 windowsHide 之範例呼叫, 不納入盤點
        let self = fileURLToPath(import.meta.url)
        let files = [...listMjs(FD_TEST, ['_tmp', 'fixtures']), ...listMjs(path.join(FD_PACK, 'toolg'))].filter((fp) => path.resolve(fp) !== self)
        let n = 0
        let bad = []
        for (let fp of files) {
            let code = fs.readFileSync(fp, 'utf8')
            if (!RE_IMPORT_CP.test(code)) { continue }
            for (let c of scanSpawnCalls(code)) {
                n++
                if (!/windowsHide\s*:\s*true/.test(c.args)) { bad.push(`${path.relative(FD_PACK, fp)}:${c.line} ${c.name}(`) }
            }
        }
        assert(n >= 10, `應掃到 test 內既有之起子行程呼叫(實得 ${n})`)
        assert.deepEqual(bad, [], `未設 windowsHide: true:${JSON.stringify(bad)}`)
    })
})
