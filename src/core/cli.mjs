import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseArgs } from 'util'


//各 CLI 之統一參數解析(w-recursi 通用件;2026-09-26)
//  原狀:各檔手寫 argOf / has ⇒ 未知旗標、拼錯、缺值、位置參數一律靜默忽略, 且值不驗
//    (實例:領域 CLI 之 `status` 漏 --mode ⇒ 起整輪;某模式之 `--nodes a` 之 --nodes 被忽略 ⇒ 全樹處理;`--max-count abc` ⇒ NaN ⇒ 數量無上限;
//     `evidence --flag ture` ⇒ 寫成 false;`--workers` 缺值 ⇒ NaN ⇒ 取槽無聲忙等)
//  本檔:util.parseArgs(strict)之上加 ① 型別 / 範圍 ② 逐模式旗標集 ③ 位置參數預設拒絕 ④ --help / -h 印用法 exit 0 ⑤ 錯誤一律 stderr 一行 + 用法、exit 2(未做任何事)
//  **呼叫端須在載入重模組、寫任何東西之前呼叫**(help / 錯誤參數不得有副作用)
//  選項型別:'flag'(開關, 無值)| 'str' | 'int' | 'num' | 'list'(逗號分隔、去空白、不得為空)| 'bool'(值只收 true / false)| 'enum'(配 values)
//    其餘欄:short(單字母別名)、default、min / max(int / num)、values(enum)、desc(用法說明)
//  spec:{ name, usage(多行字串), options: { key: {...} }, positionals: { min, max, names }(預設不收), mode: { key: 'mode', required: true, modes: { 名: [可用選項鍵…] } } }
/**
 * 命令列參數錯誤(parseCli 之錯誤型別;預設 code 2 = 未執行任何動作)
 *
 * @param {String} msg 輸入錯誤訊息
 * @param {Number} [code=2] 輸入離開碼
 * @example
 * let e = new CliError('--n 須為整數')
 * console.log(e instanceof Error, e.code, e.message)
 * // => true 2 --n 須為整數
 */
export class CliError extends Error { constructor(msg, code = 2) { super(msg); this.code = code } }

let camel = (k) => k.replace(/-([a-z])/g, (m, c) => c.toUpperCase())
let fmtUsage = (spec) => {
    let L = [spec.usage || `用法:node ${spec.name || ''}`]
    let opts = Object.entries(spec.options || {})
    if (opts.length) {
        L.push('選項:')
        for (let [k, o] of opts) {
            let t = o.type === 'flag' ? '' : o.type === 'enum' ? ` <${(o.values || []).join('|')}>` : o.type === 'bool' ? ' <true|false>' : ` <${o.type}>`
            let d = o.default !== undefined && o.type !== 'flag' ? `(預設 ${Array.isArray(o.default) ? o.default.join(',') : o.default})` : ''
            let r = (o.min !== undefined || o.max !== undefined) ? `[${o.min ?? ''}..${o.max ?? ''}]` : ''
            L.push(`  --${k}${o.short ? ` / -${o.short}` : ''}${t}${r}${d}${o.desc ? ` ${o.desc}` : ''}`)
        }
    }
    if (spec.mode) {
        L.push(`模式(--${spec.mode.key || 'mode'}${spec.mode.required === false ? '' : ', 必填'})與其可用選項:`)
        for (let [m, ks] of Object.entries(spec.mode.modes)) { L.push(`  ${m}:${ks.length ? ks.map((k) => `--${k}`).join(' ') : '(無)'}`) }
    }
    L.push('通用:--args-file <json>  以 JSON 物件給參數(鍵 = 選項名或模式鍵;免 shell 引號;與命令列同鍵 ⇒ 拒;旗標只收 true、清單收陣列)')
    return L.join('\n')
}
/**
 * 依 spec 組用法文字(用法首行、選項表、模式與其可用選項、通用之 --args-file 說明)
 *
 * @param {Object} spec 輸入 parseCli 之 spec { name, usage, options, positionals, mode }
 * @returns {String} 回傳多行用法文字
 * @example
 * let spec = { name: 'demo.mjs', usage: '用法:node demo.mjs [選項]', options: { n: { type: 'int', min: 1, desc: '數量' } } }
 * console.log(usageOf(spec).split('\n').slice(0, 2).join(' | '))
 * // => 用法:node demo.mjs [選項] | 選項:
 */
export let usageOf = fmtUsage

//--args-file <json>(2026-10-01:免 shell 引號之包裝 —— 實測對話紀錄自製包裝腳本 24 次):
//  JSON 物件之鍵 = 選項名(或模式鍵), 值 = 該選項之值 ⇒ 展開為命令列記號(字串以 --k=值 之內嵌形, 值含空白 / 引號 / 前導減號皆原樣)後與命令列走同一驗證
//    (型別 / 範圍 / 模式可用旗標 / 未知鍵);與命令列同鍵 ⇒ 拒(免歧義);只可給一次;旗標只收 true;清單收陣列(元素不得含逗號)或逗號字串;值須為純量
let expandArgsFile = (argv, spec) => {
    let idx = argv.map((a, i) => (a === '--args-file' || a.startsWith('--args-file=') ? i : -1)).filter((i) => i >= 0)
    if (!idx.length) { return argv }
    if (idx.length > 1) { throw new CliError('--args-file 只可給一次') }
    let i = idx[0], inline = argv[i].startsWith('--args-file=')
    let fp = inline ? argv[i].slice('--args-file='.length) : argv[i + 1]
    if (!fp || (!inline && fp.startsWith('--'))) { throw new CliError('--args-file 須給 JSON 檔路徑') }
    let rest = argv.filter((a, j) => j !== i && !(!inline && j === i + 1))
    let obj
    try { obj = JSON.parse(fs.readFileSync(fp, 'utf8')) } catch (e) { throw new CliError(`--args-file 讀取 / 解析失敗:${fp}(${String(e.message).slice(0, 120)})`) }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { throw new CliError('--args-file 之內容須為 JSON 物件(鍵 = 選項名)') }
    let modeKey = spec.mode ? (spec.mode.key || 'mode') : null
    let opts = spec.options || {}
    let shortOf = Object.fromEntries(Object.entries(opts).filter(([, o]) => o.short).map(([k, o]) => [o.short, k]))
    let given = new Set()
    for (let a of rest) {
        if (a.startsWith('--')) { given.add(a.slice(2).split('=')[0]) }
        else if (/^-[A-Za-z]$/.test(a) && shortOf[a.slice(1)]) { given.add(shortOf[a.slice(1)]) }
    }
    let toks = []
    for (let [k, v] of Object.entries(obj)) {
        let o = k === modeKey ? { type: 'str' } : opts[k]
        if (!o) { throw new CliError(`--args-file 之鍵 ${k} 未知(可用:${[...(modeKey ? [modeKey] : []), ...Object.keys(opts)].join(' ')})`) }
        if (given.has(k)) { throw new CliError(`--${k} 同時見於命令列與 --args-file(擇一)`) }
        if (o.type === 'flag') { if (v !== true) { throw new CliError(`--args-file 之旗標 ${k} 只收 true(不給即 false)`) } toks.push(`--${k}`); continue }
        if (o.type === 'list' && Array.isArray(v)) {
            if (v.some((x) => x === null || typeof x === 'object')) { throw new CliError(`--args-file 之清單 ${k} 之元素須為純量`) }
            if (v.some((x) => String(x).includes(','))) { throw new CliError(`--args-file 之清單 ${k} 之元素不得含逗號`) }
            toks.push(`--${k}=${v.map(String).join(',')}`)
            continue
        }
        if (v === null || typeof v === 'object') { throw new CliError(`--args-file 之 ${k} 須為純量`) }
        toks.push(`--${k}=${String(v)}`)
    }
    return [...rest, ...toks]
}

//型別轉換與驗證;錯誤拋 CliError
let coerce = (k, o, raw) => {
    let bad = (why) => { throw new CliError(`--${k} ${why}(收到 ${JSON.stringify(raw)})`) }
    switch (o.type) {
        case 'flag': return raw === true
        case 'str': if (raw === '') { bad('不得為空') } return raw
        case 'int': {
            if (!/^-?\d+$/.test(String(raw).trim())) { bad('須為整數') }
            let v = Number(raw)
            if (o.min !== undefined && v < o.min) { bad(`須 ≥ ${o.min}`) }
            if (o.max !== undefined && v > o.max) { bad(`須 ≤ ${o.max}`) }
            return v
        }
        case 'num': {
            let v = Number(raw)
            if (String(raw).trim() === '' || !Number.isFinite(v)) { bad('須為有限數值') }
            if (o.min !== undefined && v < o.min) { bad(`須 ≥ ${o.min}`) }
            if (o.max !== undefined && v > o.max) { bad(`須 ≤ ${o.max}`) }
            return v
        }
        case 'list': {
            let v = String(raw).split(',').map((s) => s.trim())
            if (!v.length || v.some((s) => s === '')) { bad('須為逗號分隔之非空清單') }
            return v
        }
        case 'bool': { if (raw !== 'true' && raw !== 'false') { bad('只收 true / false') } return raw === 'true' }
        case 'enum': { if (!(o.values || []).includes(raw)) { bad(`須為 ${(o.values || []).join(' | ')} 之一`) } return raw }
        default: throw new Error(`cli spec:--${k} 之型別 ${o.type} 未知`)
    }
}

//解析:回 { values(鍵為原名與 camelCase 兩種), positionals, mode, help, given }
//  given(2026-10-09):**明給之鍵**(原名;命令列與 --args-file 展開後皆算, 預設值不算)—— 模式鍵(若明給)居首, 其餘依 spec.options 之序
//    用途:有預設值之選項是否為使用者所給(如「--workers 只用於 --run」);原呼叫端掃 process.argv ⇒ --args-file 所給者漏偵
//  opt.exit(預設 true):錯誤 ⇒ stderr + exit 2;help ⇒ stdout + exit 0;false 時改為拋 CliError / 回 { help: true }(單元測試用)
/**
 * 各 CLI 之統一參數解析(util.parseArgs strict 之上加型別與範圍、逐模式可用旗標、位置參數預設拒絕、--help、--args-file):
 * 錯誤 ⇒ stderr 一行 + exit 2(未做任何事);呼叫端須在載入重模組與寫任何東西之前呼叫。
 * 選項型別:flag | str | int | num | list(逗號分隔)| bool(只收 true / false)| enum(配 values)
 *
 * @param {Array} argv 輸入參數陣列(如 process.argv.slice(2))
 * @param {Object} spec 輸入 { name, usage, options:{ 鍵:{ type, short, default, min, max, values, desc } }, positionals:{ min, max, names }, mode:{ key, required, default, modes:{ 名:[可用選項鍵] } } }
 * @param {Object} [opt={}] 輸入選項 { exit:Boolean(預設 true;false 時改拋 CliError 或回 { help:true },單元測試用) }
 * @returns {Object} 回傳 { values(鍵為原名與 camelCase 兩種)、positionals、mode、help、given(明給之鍵,命令列與 --args-file 皆算,預設值不算) }
 * @throws {CliError} exit 為 false 且參數有誤時拋出
 * @example
 * let spec = { name: 'demo', options: { n: { type: 'int', min: 1 }, dry: { type: 'flag' }, 'stale-ms': { type: 'int', default: 5 } } }
 * let r = parseCli(['--n', '3', '--dry'], spec, { exit: false })
 * console.log(r.values.n, r.values.dry, r.values.staleMs, r.given.join(','))
 * // => 3 true 5 n,dry
 */
export let parseCli = (argv, spec, { exit = true } = {}) => {
    let options = { help: { type: 'boolean', short: 'h' } }
    for (let [k, o] of Object.entries(spec.options || {})) { options[k] = { type: o.type === 'flag' ? 'boolean' : 'string', ...(o.short ? { short: o.short } : {}) } }
    let modeKey = spec.mode ? (spec.mode.key || 'mode') : null
    if (modeKey && !options[modeKey]) { options[modeKey] = { type: 'string' } }
    let fail = (msg) => {
        if (!exit) { throw new CliError(msg) }
        process.stderr.write(`${msg}(未執行任何動作;完整用法:node ${spec.name || '<本檔>'} --help)\n`)
        process.exit(2)
    }
    try { argv = expandArgsFile(argv, spec) }
    catch (e) { if (e instanceof CliError) { return fail(e.message) } throw e }
    let p
    try { p = parseArgs({ args: argv, options, strict: true, allowPositionals: true }) }
    catch (e) {
        let m = String(e.message || e)
        let msg = e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? `未知參數:${(m.match(/'([^']+)'/) || [])[1] || m}`
            : e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? `參數值錯:${m}`
                : `參數錯:${m}`
        return fail(msg)
    }
    if (p.values.help) {
        if (!exit) { return { help: true, usage: fmtUsage(spec) } }
        process.stdout.write(fmtUsage(spec) + '\n')
        process.exit(0)
    }
    try {
        //位置參數
        let pos = spec.positionals || { min: 0, max: 0 }
        if (p.positionals.length < (pos.min || 0) || p.positionals.length > (pos.max ?? 0)) {
            throw new CliError(p.positionals.length > (pos.max ?? 0) ? `不收位置參數:${p.positionals.join(' ')}${modeKey && p.positionals.length === 1 && spec.mode.modes[p.positionals[0]] ? `(是要 --${modeKey} ${p.positionals[0]} 嗎?)` : ''}` : `位置參數不足(須 ${pos.min}:${(pos.names || []).join(' ')})`)
        }
        //明給之鍵(命令列與 --args-file 展開後;help 除外)
        let givenSet = new Set(Object.keys(p.values).filter((k) => k !== 'help' && p.values[k] !== undefined))
        //模式
        let mode = null
        if (modeKey) {
            mode = p.values[modeKey] ?? spec.mode.default ?? null
            if (mode === null && spec.mode.required !== false) { throw new CliError(`須指定 --${modeKey}(${Object.keys(spec.mode.modes).join(' | ')})`) }
            if (mode !== null && !spec.mode.modes[mode]) { throw new CliError(`未知 --${modeKey} ${mode}(可用:${Object.keys(spec.mode.modes).join(' | ')})`) }
            let allowed = new Set(spec.mode.modes[mode] || [])
            let given = [...givenSet].filter((k) => k !== modeKey)
            let stray = given.filter((k) => !allowed.has(k))
            if (stray.length) { throw new CliError(`${stray.map((k) => `--${k}`).join(' ')} 不適用於 --${modeKey} ${mode}(此模式可用:${[...allowed].map((k) => `--${k}`).join(' ') || '無'})`) }
        }
        //型別與預設
        let values = {}
        for (let [k, o] of Object.entries(spec.options || {})) {
            let raw = p.values[k]
            let v = raw === undefined ? (o.type === 'flag' ? false : o.default) : coerce(k, o, raw)
            values[k] = v
            values[camel(k)] = v
        }
        if (modeKey) { values[modeKey] = mode }
        let given = [...(modeKey && givenSet.has(modeKey) ? [modeKey] : []), ...Object.keys(spec.options || {}).filter((k) => k !== modeKey && givenSet.has(k))]
        return { values, positionals: p.positionals, mode, help: false, given }
    }
    catch (e) {
        if (e instanceof CliError) { return fail(e.message) }
        throw e
    }
}

//是否為本程序之進入點(各 CLI 之 isMain 判定, 單一實作;URL → 路徑只經 fileURLToPath)
/**
 * 是否為本程序之進入點(各 CLI 之 isMain 判定,單一實作;URL 轉路徑只經 fileURLToPath)
 *
 * @param {String} metaUrl 輸入 import.meta.url
 * @returns {Boolean} 回傳是否為進入點
 * @example
 * // 以 node 直接執行本檔時
 * console.log(isMainModule(import.meta.url))
 * // => true
 */
export let isMainModule = (metaUrl) => !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(metaUrl))

export default { parseCli, usageOf, CliError, isMainModule }
