import _ from 'lodash-es'
import { sha } from '../../src/core/canonical.mjs'


//玩具領域(簡化測試問題):二維整數格點上的「策略」
//  - spec:{ kind:'point', x, y, tag? }(tag 不影響行為 ⇒ 無效變異, 供別名偵測)、{ kind:'cond', up:point, down:point }(行為 = 兩點平均;供對照臂)
//  - 評估:訓練期分數 = 凹面(最佳點 OPT)+ 確定性雜訊;留出期(backtest)最佳點 BT_OPT 不同 ⇒ 部分區域被否決(backtest ≤ 0)
//  - 全部確定性(同 spec 同結果), 可設 delayMs 模擬耗時、failIf 模擬評估失敗
export const OPT = { x: 3, y: -5 }
export const BT_OPT = { x: 3, y: 7 }
export const RANGE = 20
export const EVALUATOR_VERSION = 'toy-v1'

let rng = (seed) => {
    let h = 2166136261
    for (let ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
    return () => { h += 0x6D2B79F5; let t = Math.imul(h ^ (h >>> 15), 1 | h); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
let isInt = (v) => Number.isInteger(v)
let fail = (m) => { throw new Error(`spec 無效: ${m}`) }
let validatePoint = (p, what = 'point') => {
    if (!_.isPlainObject(p) || p.kind !== 'point') { fail(`${what} 須為 point`) }
    if (!isInt(p.x) || !isInt(p.y)) { fail(`${what} x / y 須為整數`) }
    if (Math.abs(p.x) > RANGE || Math.abs(p.y) > RANGE) { fail(`${what} 超出範圍 ±${RANGE}`) }
    if (p.tag !== undefined && !_.isString(p.tag)) { fail('tag 須為字串') }
}
export let validateSpec = (s) => {
    if (!_.isPlainObject(s)) { fail('須為物件') }
    if (s.kind === 'point') { validatePoint(s); return true }
    if (s.kind === 'cond') { validatePoint(s.up, 'up'); validatePoint(s.down, 'down'); return true }
    fail(`未知 kind ${s.kind}`)
}
export let summarize = (s) => (s.kind === 'point' ? `P(${s.x},${s.y})${s.tag ? '#' + s.tag : ''}` : `cond(up=${summarize(s.up)}|down=${summarize(s.down)})`)
export let carrierOf = (s) => s.kind
export let envHash = () => EVALUATOR_VERSION
export let behaviorOf = (spec) => (spec.kind === 'point' ? [[spec.x, spec.y]] : [[spec.up.x, spec.up.y], [spec.down.x, spec.down.y]])
let f = (p, o) => 100 - ((p[0] - o.x) ** 2 + (p[1] - o.y) ** 2) / 4
let sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export let createContext = async (opt = {}) => ({ delayMs: opt.delayMs || 0, failIf: opt.failIf || null, logFile: opt.logFile || null, createdAt: Date.now(), pid: process.pid })
export let evaluate = async (spec, ctx, protocol = {}) => {
    validateSpec(spec)
    let t0 = Date.now()
    let pts = behaviorOf(spec)
    let train = _.mean(pts.map((p) => f(p, OPT)))
    let backtest = _.mean(pts.map((p) => f(p, BT_OPT)))
    let noise = (rng(JSON.stringify(pts))() - 0.5) * 2
    let delay = _.get(protocol, 'delayMs', _.get(ctx, 'delayMs', 0))
    if (delay) { await sleep(delay) }
    let failRe = _.get(protocol, 'failIf', _.get(ctx, 'failIf', null))
    if (failRe && new RegExp(failRe).test(summarize(spec))) { throw new Error(`模擬評估失敗:${summarize(spec)}`) }
    //模擬 worker 於 job 中途崩潰(程序直接結束, 不寫結果;runner 動態派工之隔離測試用)
    let exitRe = _.get(protocol, 'exitIf', null)
    if (exitRe && new RegExp(exitRe).test(summarize(spec))) { process.exit(3) }
    //併行驗證用:每次評估之區間(pid 起 迄)追加至 logFile
    let logFile = _.get(ctx, 'logFile', null)
    if (logFile) { (await import('fs')).appendFileSync(logFile, `${process.pid} ${t0} ${Date.now()} ${summarize(spec)}\n`) }
    return { train: _.round(train + noise, 3), backtest: _.round(backtest, 3), halves: [_.round(train + noise * 3, 3), _.round(train - noise * 3, 3)], null: { mean: -50, sd: 30 }, chosen: pts.map((p) => `${p[0]},${p[1]}`), windows: pts.length * 10, cost: { replays: pts.length * 3, wallSec: _.round(delay / 1000, 3) }, extraHash: '' }
}
export let meta = (ctx) => ({ pid: ctx ? ctx.pid : null })

//判讀(評估器之分數層):S 只由訓練期;留出期(backtest)只作否決;階梯 0 → 1(真偽)→ 2 / 3(evidence)→ 4(可部署量)→ 5(evidence.extra)
export let score = (raw, node = {}) => {
    let ev = _.get(node, 'evidence', null) || {}
    let train = raw.train, bt = raw.backtest
    let halvesOK = raw.halves[0] > 0 && raw.halves[1] > 0
    let nullZ = (train - raw.null.mean) / raw.null.sd
    let nullOK = nullZ >= 2
    let vetoed = bt <= 0
    let deployable = train >= 60 && !vetoed
    let ladder = 0
    if (train > 0 && nullOK && halvesOK) { ladder = 1 }
    if (ladder >= 1 && ev.mech === true) { ladder = 2 }
    if (ladder >= 2 && ev.usability === true) { ladder = 3 }
    if (deployable && ladder >= 1) { ladder = Math.max(ladder, 4) }
    if (ladder >= 4 && ev.btcOK === true) { ladder = 5 }
    let S = vetoed ? 0 : Math.max(0, train) * (halvesOK ? 1 : 0.5) * (nullOK ? 1 : 0.5)
    return { evaluator: EVALUATOR_VERSION, S: _.round(S, 3), ladder, flags: { vetoed, deployable }, components: { train, nullZ: _.round(nullZ, 2), halvesOK, nullOK }, backtest: { eqYr: bt } }
}
export let mask = (sc) => _.omit(sc, ['backtest'])
export let forbidden = [/backtest/]
export let fingerprint = (raw) => (raw && raw.chosen ? sha(JSON.stringify(raw.chosen)) : null)
export let isAnchor = (n) => _.get(n, 'spec.kind') === 'anchor'

let step = (s, k, d) => ({ spec: { ...s, [k]: s[k] + d }, params: { [k]: s[k] + d }, reason: `${k}${d > 0 ? '+' : ''}${d}` })
export let operators = [
    { name: 'P.x', family: 'P', applies: (s) => s.kind === 'point', children: (s) => [-2, -1, 1, 2].map((d) => step(s, 'x', d)) },
    { name: 'P.y', family: 'P', applies: (s) => s.kind === 'point', children: (s) => [-2, -1, 1, 2].map((d) => step(s, 'y', d)) },
    //無效變異:tag 不進評估 ⇒ 子與父行為相同(供別名偵測與「規格不同但行為等價」之測試)
    { name: 'T.tag', family: 'T', applies: (s) => s.kind === 'point' && !s.tag, children: (s) => [{ spec: { ...s, tag: 'a' }, params: { tag: 'a' }, reason: '無效變異 tag' }] },
    //條件分支 + 對照臂(對調 / 恆用單一分支)
    { name: 'X.cond', family: 'X', applies: (s) => s.kind === 'point', controls: ['X.condSwap', 'X.condBranch'],
        children: (s) => [{ spec: { kind: 'cond', up: _.omit(s, ['tag']), down: { kind: 'point', x: -s.x, y: -s.y } }, params: {}, reason: '條件分支(down = 鏡點)' }] },
    { name: 'X.condSwap', family: 'X', applies: (s) => s.kind === 'cond', children: (s) => [{ spec: { ...s, up: s.down, down: s.up }, params: { swap: true }, reason: '分支對調' }] },
    { name: 'X.condBranch', family: 'X', applies: (s) => s.kind === 'cond', children: (s) => ['up', 'down'].map((b) => ({ spec: s[b], params: { branch: b }, reason: `恆用 ${b}` })) },
]
export const familyRank = { X: 0, P: 1, T: 2 }
export let carriers = { origin: { kind: 'point', x: 0, y: 0 }, far: { kind: 'point', x: -15, y: 15 } }

export let makeDomain = (over = {}) => ({
    name: 'toy', validateSpec, summarize, carrierOf, envHash, score, fingerprint, mask, forbidden, isAnchor, operators, familyRank, carriers, evaluatorVersion: EVALUATOR_VERSION,
    evaluator: { mode: 'inProcess', evaluate, createContext, ctxOpt: {}, meta },
    reportColumns: [{ header: 'train', of: (n) => _.get(n, 'score.components.train', '-') }],
    ...over,
})

export default makeDomain
