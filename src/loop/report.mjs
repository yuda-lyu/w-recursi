import countBy from 'lodash-es/countBy.js'
import get from 'lodash-es/get.js'
import isArray from 'lodash-es/isArray.js'
import isFinite from 'lodash-es/isFinite.js'
import isFunction from 'lodash-es/isFunction.js'
import _round from 'lodash-es/round.js'
import size from 'lodash-es/size.js'
import uniq from 'lodash-es/uniq.js'
import { nowIso } from '../core/canonical.mjs'
import { aliasShortOfDomain } from '../core/domainContract.mjs'


let fmt = (v, d = 2) => (isFinite(v) ? _round(v, d) : '-')
//早退之現行文之內嵌(generationCheck 之 embed = { must, domainMust } | { error };2026-10-04)⇒ 報告列
//  must 逐字以引用區塊(「> 」)呈現:其標題 / 編號列不混入報告之段落結構;區塊後留空行(下一列不被併入引用)
let embedLinesOf = (g) => {
    let e = g.embed || {}
    let rd = get(g, 'existing.round', '?'), at = get(g, 'existing.at', '?')
    if (e.error) { return [`- 現行請求文未能產生(${e.error});本輪必須做的事以全域生成請求標記 ${rd} 之請求文與主代理通知為準`] }
    return [`- 現行請求文之「本輪必須做的事」(早退不寫請求文 ⇒ 以本輪之連續欠額 ${g.streak} 輪與前緣即時產生${e.domainMust ? ';領域已改寫此段' : ''};全域生成請求標記 ${rd} 之請求文寫於 ${at}, 與下列不同者以下列為準):`, '',
        ...String(e.must || '').split('\n').map((l) => (l ? `> ${l}` : '>')), '']
}

//輪次報告(通用欄位;領域可加欄 domain.reportColumns = [{ header, of(node) }] 與尾段 domain.reportExtra(nodes, plan, { items, getNode }) → [lines])
//  2026-09-29:另列 生成請求之接手 / 清除、前緣結案、閘門拒絕存根未寫、做夢略過與分數未寫、各段牆鐘
/**
 * 輪次報告(markdown;通用欄位,領域可加欄 domain.reportColumns 與尾段 domain.reportExtra):計畫與執行統計、策略備註、臂限制、各臂表、閘門拒絕、行為別名短路、轉折點提取、新區域額度與生成請求、前緣結案、做夢、領域鉤子、策略開發請求、各段牆鐘
 *
 * @param {Object} rsi 輸入實例
 * @param {Number} round 輸入輪號
 * @param {Object} plan 輸入策略之計畫
 * @param {Array} nodes 輸入本輪入樹之節點
 * @param {Array} rejected 輸入被前閘拒絕之計畫項
 * @param {Object} [extra={}] 輸入 { by, skipped, items, replans, turning, debt, generation, genClear, frontierRes, aliasShort, useArms, armsReopen, dream, dreamSkip, hook, policyDev, stagesSec }
 * @returns {String} 回傳報告全文
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 * import { createRsi } from 'w-recursi/src/index.mjs'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * let domain = {
 *     name: 'toy',
 *     score: (raw) => ({ S: raw.v, ladder: raw.v >= 2 ? 1 : 0, flags: {} }),
 *     validateSpec: (s) => { if (typeof s.x !== 'number') { throw new Error('x 須為數字') } },
 *     operators: [{ name: 'inc', family: 'f', applies: () => true, children: (s) => [{ spec: { x: s.x + 1 }, params: { by: 1 } }] }],
 *     carriers: { root: { x: 0 } },
 *     evaluator: { mode: 'inProcess', evaluate: async (spec) => ({ v: spec.x }) },
 * }
 * let rsi = createRsi({ root: dir, domain, budget: { arms: 2, novelty: 1 } }).init()
 * let ex = await rsi.explore()
 * let md = reportOf(rsi, ex.round, ex.plan, ex.nodes, ex.rejected, {})
 * console.log(md.split('\n')[0])
 * // => # RSI 第 1 輪報告
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let reportOf = (rsi, round, plan, nodes, rejected, extra = {}) => {
    let { domain } = rsi
    let summarize = domain.summarize || ((s) => JSON.stringify(s).slice(0, 80))
    let cols = domain.reportColumns || []
    let L = [`# RSI 第 ${round} 輪報告`, '', `- 時間:${nowIso()};策略:${get(plan, 'policy.name', '-')} ${get(plan, 'policy.version', '')};評估器 ${get(domain, 'evaluatorVersion', '-')};執行者 ${extra.by || `pid${process.pid}`}`,
        `- 計畫 ${(plan.expand || []).length + (plan.novelty || []).length + (plan.global || []).length} 臂(展開 ${(plan.expand || []).length} / 新區域 ${(plan.novelty || []).length} / 全域 ${(plan.global || []).length});認領 ${nodes.length};他 session 已認領而跳過 ${(extra.skipped || []).length};執行 ${nodes.filter((n) => n.status === 'executed').length};錯誤 ${nodes.filter((n) => n.status === 'error').length};閘門拒絕 ${rejected.length}`, '']
    if (plan.notes && plan.notes.length) { L.push('- 策略備註:' + plan.notes.join(';'), '') }
    //臂限制(2026-11-07;search/arms.mjs):本輪只用所選臂(explore 之 opt.useArms / cfg.arms.use)
    if (size(extra.useArms)) { L.push(`- 臂限制:${extra.useArms.join(', ')}${extra.armsReopen ? `(重啟理由:${extra.armsReopen})` : ''}`, '') }
    //治理(2026-11-14;search/governance.mjs):有待審之提案才列(無提案帳 / 無待審 ⇒ 報告與改前逐字同);提案帳或擴充檔損壞 ⇒ 各列一行(不中斷報告;與 status 同)
    if (rsi.governance && rsi.governance.exists()) {
        let gp = [], perr = null, xerr = null
        try { gp = rsi.governance.pending() } catch (e) { perr = String((e && e.message) || e).split('\n')[0].slice(0, 200) }
        try { rsi.governance.extensions() } catch (e) { xerr = String((e && e.message) || e).split('\n')[0].slice(0, 200) }
        if (perr) { L.push(`- 治理:提案帳無法讀取(${perr})`, '') }
        else if (gp.length) { L.push(`- 治理:待審之提案 ${gp.length} 筆(${gp.map((p) => `${p.id} ${p.kind}`).join('、')});主控審定後生效(提案帳 governance/PROPOSALS.md)`, '') }
        if (xerr) { L.push(`- 治理:擴充檔無法讀取(${xerr})`, '') }
    }
    //認領衝突之重計畫(2026-10-02):上一行之計畫與備註為第一次計畫 ⇒ 另列實得之組成(extra.items = 本 session 實得之計畫項);各次重計畫之策略備註在 plan.json 之 notesReplans
    if (extra.replans) { let its = extra.items || [], k = countBy(its, 'kindOf'); L.push(`- 重計畫 ${extra.replans} 次(認領衝突;${get(rsi.cfg, 'claims.replanFillOnly', false) === true ? '只補被他 session 先領之額' : '新計畫之臂全收'}):實得 ${its.length} 臂(展開 ${k.expand || 0} / 新區域 ${k.novelty || 0} / 全域 ${k.global || 0});各次重計畫之策略備註見 plan.json 之 notesReplans`, '') }
    if (plan.requests && plan.requests.length) { L.push('## 前緣待實作(策略無法自行執行)', '', ...plan.requests.map((q) => `- [${q.kind}] ${q.topic || ''} ${q.title || ''}(優先 ${q.priority ?? '-'};需 ${q.needs || '-'}):${q.reason || ''}`), '') }
    L.push('## 各臂', '', `| id | 父 | 算子 | 規格 | S | 階梯 | veto | ${cols.map((c) => c.header).join(' | ')}${cols.length ? ' | ' : ''}回放 | 秒 | 狀態 |`, `|---|---|---|---|---|---|---|${cols.map(() => '---|').join('')}---|---|---|`)
    for (let n of nodes) {
        let ex = cols.map((c) => { try { return String(c.of(n) ?? '-') } catch (e) { return '-' } })
        L.push(`| ${n.id} | ${n.parent === 'root' ? 'root' : n.parent.slice(0, 6)} | ${get(n, 'origin.operator', '')} | ${summarize(n.spec).replace(/\|/g, '/')} | ${fmt(get(n, 'score.S'))} | ${get(n, 'score.ladder', '-')} | ${get(n, 'score.flags.vetoed', '-')} | ${ex.join(' | ')}${ex.length ? ' | ' : ''}${get(n, 'cost.replays', '-')} | ${fmt(get(n, 'cost.wallSec'), 0)} | ${n.status}${n.status === 'error' ? ` ${String(get(n, 'notes.error', '')).slice(0, 80).replace(/\n/g, ' ')}` : ''} |`)
    }
    //閘門拒絕:存根未寫者(同 id 節點已被占用)附註, 免誤讀為「該節點被拒」
    if (rejected.length) { L.push('', '## 閘門拒絕(未執行)', '', ...rejected.map((r) => `- ${r.id} ${summarize(r.spec)}:${r.why}${r.stubSkipped ? `(同 id 節點已 ${r.stubSkipped}, 拒絕存根未寫)` : ''}`)) }
    //行為別名短路(cfg.aliasPre 時才列):本臂指紋 = 某父 ⇒ 評估器略過部分計算;判定與用語由領域鉤子 domain.aliasShortOf → { of, what }(2026-10-01 起)
    if (isFinite(extra.aliasShort)) {
        let aOf = aliasShortOfDomain(domain)
        let hits = nodes.map((n) => ({ n, a: aOf(n) })).filter((x) => x.a)
        let what = uniq(hits.map((x) => x.a.what).filter(Boolean)).join(';') || '部分計算'
        L.push('', `- 行為別名短路 ${extra.aliasShort}(本臂原料指紋與其父相同 ⇒ 略過${what}${hits.length ? `:${hits.map((x) => `${x.n.id.slice(0, 8)} ≡ ${String(x.a.of ?? '?').slice(0, 8)}`).join('、')}` : ''})`)
    }
    if (extra.skipped && extra.skipped.length) { L.push('', '## 他 session 已認領而跳過', '', ...extra.skipped.map((r) => `- ${r.id} ${summarize(r.spec)}:${r.why}`)) }
    if (isFunction(domain.reportExtra)) { try { L.push('', ...(domain.reportExtra(nodes, plan, { items: isArray(extra.items) ? extra.items : null, getNode: (id) => rsi.store.getNode(id) }) || [])) } catch (e) { L.push('', `(reportExtra 失敗:${e.message})`) } }
    if (extra.dream) {
        L.push('', '## 做夢(策略重放打分)', '', ...extra.dream.rows.map((r) => r.error ? `- ${r.name}:✗ ${r.error}` : `- ${r.name}:全樣本 J ${r.score.inSample.J}、留出均 ${r.score.heldOutMean}(切分 ${r.score.nCuts})、揭露 ${r.score.inSample.revealed}、未知 ${r.score.inSample.unknown}、回溯 ${r.score.targetsFound}/${r.score.nTargets}`), extra.dream.decision ? `- 接受判定:${JSON.stringify(extra.dream.decision)}` : '')
        if (extra.dream.scoresSkipped) { L.push(`- 分數未寫入 scores.jsonl(${extra.dream.scoresSkipped})`) }
    }
    else if (extra.dreamSkip) {
        let s = extra.dreamSkip
        L.push('', '## 做夢(策略重放打分)', '', `- 略過:${s.why}${s.last ? `(上次做夢 ${s.last}, 距今 ${s.gapMin} 分 < 門檻 ${s.minIntervalMin} 分)` : ''}${s.holder ? `(進行中:${s.holder})` : ''}`)
    }
    if (extra.frontierRes) {
        let f = extra.frontierRes
        if (f.executed || f.rejected || f.retried || f.blocked) { L.push('', '## 前緣結案', '', `- 執行 ${f.executed}、閘門拒絕 ${f.rejected}、評估錯誤待重試 ${f.retried}、錯誤達上限封鎖(status blocked)${f.blocked}`) }
    }
    if (extra.turning) {
        let t = extra.turning
        L.push('', '## 轉折點提取(由樹推導之新臂 → 前緣;策略之新區域額度取用)', '', `- 邊 ${t.nEdges};有效轉折(S 提升 ≥ 門檻)${t.nProductive};提案 ${t.proposals.length}`)
        for (let p of t.proposals.slice(0, 12)) { L.push(`- [${p.origin.operator}] ${summarize(p.spec).replace(/\|/g, '/')}:${p.reason}`) }
        if (t.avoid.length) { L.push(`- 負向轉折(避免重複):${t.avoid.slice(0, 5).map((a) => `${a.op}@${a.parentId.slice(0, 6)}(${a.gain > 0 ? '+' : ''}${_round(a.gain * 100)}%)`).join('、')}`) }
        //擋下之列分兩種(2026-10-04):搬移相容鉤子(transferBlock;from 為 [來源父, 來源子, 目標父])與產生端守門(by proposalBlock;外推之 from 只兩節點)⇒ 分行列;無後者時本行與舊版逐字同
        let isPb = (b) => b && b.by === 'proposalBlock'
        let nPb = isFinite(t.nProposalBlocked) ? t.nProposalBlocked : (t.blocked || []).filter(isPb).length
        let nTb = (t.nBlocked || 0) - nPb
        if (nTb > 0) { L.push(`- 搬移相容鉤子擋下 ${nTb}:${(t.blocked || []).filter((b) => !isPb(b)).slice(0, 5).map((b) => `${b.op}${b.params ? ' ' + JSON.stringify(b.params) : ''} ${b.from[0].slice(0, 6)} ⇒ ${b.from[2].slice(0, 6)}(${b.why})`).join('、')}`) }
        if (nPb > 0) { L.push(`- 產生端守門(proposalBlock)擋下 ${nPb}:${(t.blocked || []).filter(isPb).slice(0, 5).map((b) => `[${b.op}] ${(b.from || []).map((x) => String(x).slice(0, 6)).join(' → ')}(${b.why})`).join('、')}`) }
    }
    //新區域額度:cfg.generation.debtAfterClaims(2026-10-02)⇒ debt 為認領 / 重計畫後之實得, 另附 debt.firstPlan(第一次計畫之值)並列;未開 ⇒ 無 firstPlan, 本行與舊版逐字同
    if (extra.debt) {
        let g = extra.generation
        let first = extra.debt.firstPlan
        L.push('', '## 新區域額度', '', `- 需 ${extra.debt.need}、得 ${extra.debt.got}、欠 ${extra.debt.debt}${first ? `(以認領 / 重計畫後之實得計;第一次計畫得 ${first.got}、欠 ${first.debt})` : ''}${g && g.fp ? `;**已寫生成請求** ${g.fp}(本輪須生成新算子 / 載體 / 條件變數)` : g && g.why ? `;${g.why}` : ''}`)
        if (g && g.replaced) { L.push(`- 接手失效之全域生成請求標記:${g.replaced.round || '?'}(${g.replaced.at || '?'};${g.replaced.why})`) }
        //他 session 已有標記(早退)而連續欠額達升級門檻(2026-10-04;generationCheck 之 escalate)⇒ 升級文字(原只轉印 why, 升級被遮蔽)
        //  有現行文(embed.must;2026-10-04)⇒ 改指下列內嵌段(原指持有輪之舊請求文 —— 寫於升級 / 飽和模式之前者與本輪之必做事項相反)
        if (g && !g.fp && g.escalate) { L.push(`- 連續欠額 ${g.streak} 輪 ⇒ **已達 ${g.escalateRounds} 輪, 路線須重構(換載體 / 換終點層), 不得只換參數再跑**(全域生成請求標記 ${get(g, 'existing.round', '?')} 之 debt / streak 已更新;${g.embed && g.embed.must ? '本輪必須做的事見下列現行文' : '請求文見該輪夾之 GENERATION_REQUEST.md'})`) }
        //早退之現行文(升級或領域改寫了「本輪必須做的事」, 如領域之飽和模式)⇒ 內嵌;無 embed(未升級且領域未改寫)⇒ 本段與改前逐字同
        if (g && !g.fp && g.embed) { L.push(...embedLinesOf(g)) }
    }
    if (extra.genClear) { L.push(`- 生成已兌現:${extra.genClear.cleared ? `已清除全域生成請求標記(${get(extra.genClear, 'marker.round', '?')})` : `全域生成請求標記未清除 —— ${extra.genClear.why}`}`) }
    if (extra.hook && extra.hook.lines) { L.push('', ...extra.hook.lines) }
    if (extra.policyDev) { L.push('', '## 策略開發請求', '', `- 已寫 ${extra.policyDev}`) }
    if (extra.stagesSec) { let s = extra.stagesSec; L.push('', '## 各段牆鐘(秒)', '', `- 探索 ${fmt(s.explore, 1)}、做夢 ${fmt(s.dream, 1)}、領域鉤子 ${fmt(s.hook, 1)}、策略開發判定 ${fmt(s.policyDev, 1)}`) }
    return L.join('\n') + '\n'
}

export default reportOf
