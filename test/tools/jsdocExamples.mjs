import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'


//src/ 之 JSDoc 盤點與 @example 實跑(測試輔助件;unit-package 取用,下游亦可取用)
//  - docBlocksOf(text):掃 export 宣告(let / const / function / class / default function),回其緊鄰上方之 JSDoc 區塊與函式性質
//  - examplesOf(doc):取 @example 之程式碼、import 列與 `// => ` 預期輸出列
//  - runExample(...):把範例寫成暫存 .mjs 以 node 子程序執行,核對 stdout 逐行 = 預期輸出列
//    範例慣例:同檔匯出名自動帶入(範例未自行宣告者);fs / os / path 未自行 import 者自動補;'w-recursi/src/…' 之 import 改寫為本機檔;
//    子程序之 TEMP / TMP / TMPDIR 指向呼叫端給的 test/_tmp 子夾(範例若用 os.tmpdir() 亦不落系統暫存)
export const FD_PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 遞迴列出夾下之 .mjs 檔(絕對路徑,排序)
 *
 * @param {String} fd 輸入夾
 * @returns {Array} 回傳檔案路徑陣列
 * @example
 * console.log(mjsFilesOf(path.join(FD_PACK, 'src', 'core')).length > 5)
 * // => true
 */
export let mjsFilesOf = (fd) => {
    let out = []
    for (let e of fs.readdirSync(fd, { withFileTypes: true })) {
        let fp = path.join(fd, e.name)
        if (e.isDirectory()) { out.push(...mjsFilesOf(fp)) }
        else if (e.name.endsWith('.mjs')) { out.push(fp) }
    }
    return out.sort()
}

const RE_EXPORT = /^export (?:(let|const) ([A-Za-z0-9_$]+) =|(default )?(function) ([A-Za-z0-9_$]+)|(class) ([A-Za-z0-9_$]+))/

/**
 * 掃一個檔之 export 宣告與其 JSDoc
 *
 * @param {String} text 輸入檔內容
 * @returns {Array} 回傳 [{ name, kind('function'|'class'|'const'), isDefault, hasParams, doc(區塊內文或 null), line }]
 * @example
 * let text = '/**\n * x\n *' + '/\nexport let f = (a) => a\nexport const C = 1'
 * console.log(JSON.stringify(docBlocksOf(text).map((b) => [b.name, b.kind, b.hasParams, b.doc !== null])))
 * // => [["f","function",true,true],["C","const",false,false]]
 */
export let docBlocksOf = (text) => {
    let ls = text.replace(/\r\n/g, '\n').split('\n')
    let out = []
    for (let i = 0; i < ls.length; i++) {
        let m = RE_EXPORT.exec(ls[i])
        if (!m) { continue }
        let name = m[2] || m[5] || m[7]
        let kind = m[6] ? 'class' : m[4] ? 'function' : 'const'
        let rest = ls[i].slice(m[0].length)
        let hasParams = false
        if (m[1]) {
            let fm = /^\s*(?:async\s*)?(?:\(([^)]?)|([A-Za-z_$][\w$]*)\s*=>|function\b[^(]*\(([^)]?))/.exec(rest)
            if (fm) { kind = 'function'; hasParams = !!(fm[1] || fm[2] || fm[3]) }
        }
        else if (m[4]) { hasParams = !/^\s*\(\s*\)/.test(rest) }
        else if (m[6]) { hasParams = true }
        let doc = null
        if (i > 0 && ls[i - 1].trim() === '*/') {
            let j = i - 2
            while (j >= 0 && !ls[j].trim().startsWith('/**')) { j-- }
            if (j >= 0) { doc = ls.slice(j + 1, i - 1).map((l) => l.replace(/^\s*\* ?/, '')).join('\n') }
        }
        out.push({ name, kind, isDefault: !!m[3], hasParams, doc, line: i + 1 })
    }
    return out
}

/**
 * 取 JSDoc 內文之 @example 程式碼、import 列與預期輸出列(`// => ` 起頭之列)
 *
 * @param {String} doc 輸入 JSDoc 內文(已去 * 前綴)
 * @returns {Object|null} 回傳 { code, imports, expected };無 @example 回 null
 * @example
 * let doc = '說明\n@returns {Number} x\n@example\nconsole.log(1 + 1)\n// => 2'
 * let ex = examplesOf(doc)
 * console.log(ex.code, JSON.stringify(ex.expected))
 * // => console.log(1 + 1)
 * // => // => 2 ["2"]
 */
export let examplesOf = (doc) => {
    if (!doc) { return null }
    let ls = doc.split('\n')
    let i = ls.findIndex((l) => l.startsWith('@example'))
    if (i < 0) { return null }
    let lines = []
    for (let j = i + 1; j < ls.length; j++) { if (ls[j].startsWith('@')) { break } lines.push(ls[j]) }
    let expected = lines.filter((l) => l.startsWith('// =>')).map((l) => l.slice(5).replace(/^ /, ''))
    return { code: lines.filter((l) => !/^import /.test(l)).join('\n'), imports: lines.filter((l) => /^import /.test(l)), expected }
}

/**
 * 實跑一個範例
 *
 * @param {Object} o 輸入 { file(src 檔絕對路徑), names(該檔之匯出名), isDefault, name, ex(examplesOf 之回傳), tmpDir(暫存夾,須在套件內以解析 node_modules), id(序號), timeoutMs }
 * @returns {Promise} 回傳 Promise,resolve { ok, got(實際輸出列), expected, status, stderr }
 */
export let runExample = ({ file, names, isDefault = false, name, ex, tmpDir, id, timeoutMs = 120000 }) => new Promise((resolve) => {
    let all = ex.imports.join('\n') + '\n' + ex.code
    let declared = new Set([...all.matchAll(/\b(?:import|let|const|var|function|class)\s+(?:\{([^}]*)\}|([A-Za-z0-9_$]+))/g)].flatMap((mm) => (mm[1] ? mm[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()) : [mm[2]])))
    let imports = ex.imports.map((l) => l.replace(/from '(w-recursi\/[^']+)'/, (_, p) => `from '${pathToFileURL(path.join(FD_PACK, p.replace(/^w-recursi\//, ''))).href}'`))
    let has = (n) => imports.some((l) => l.includes(`import ${n} from`))
    let std = ['fs', 'os', 'path'].filter((n) => !has(n)).map((n) => `import ${n} from '${n}'`).join('\n')
    let want = names.filter((n) => !declared.has(n))
    let prelude = `import * as __M from '${pathToFileURL(file).href}'\n${std}\n${imports.join('\n')}\n${want.length ? `const { ${want.join(', ')} } = __M\n` : ''}${isDefault ? `const ${name} = __M.default\n` : ''}`
    let fp = path.join(tmpDir, `ex${id}.mjs`)
    fs.writeFileSync(fp, `${prelude}${ex.code}\n`)
    let out = '', err = ''
    let p = spawn(process.execPath, [fp], { env: { ...process.env, TEMP: tmpDir, TMP: tmpDir, TMPDIR: tmpDir }, windowsHide: true })
    let timer = setTimeout(() => { p.kill() }, timeoutMs)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (status) => {
        clearTimeout(timer)
        let got = out.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, k, a) => !(k === a.length - 1 && l === ''))
        resolve({ ok: status === 0 && JSON.stringify(got) === JSON.stringify(ex.expected), got, expected: ex.expected, status, stderr: err.split('\n').slice(0, 4).join(' | ') })
    })
})
