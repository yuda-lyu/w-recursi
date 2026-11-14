import fs from 'fs'
import { createRsi, effectiveCatalogOf, makePaths } from '../../src/index.mjs'
import { DERIVED_BASE, derivedDomainOf } from './derivedDomain.mjs'


//治理之審定之子程序(2026-11-14,使用端 Gitea #144 第 3 項;unit-governance 之兩程序同時審定用)
//  參數:<狀態根> <提案 id> <英數名>;以 name 由引擎於鎖內配號、realize 以佔位字串 add:{id} 給
//  攔截 fs.mkdirSync:建 governance 鎖夾遇 EEXIST(鎖被占用而開始等候)時印一次 `waiting`(父程序據以確認兩方皆在等同一把鎖, 再放行)
//  結束印一行 JSON { ref, op, status };輸出以 fs.writeSync(1) 同步寫(等鎖期間以 Atomics.wait 阻塞)
let [root, id, name] = process.argv.slice(2)
let out = (s) => fs.writeSync(1, `${s}\n`)
let orig = fs.mkdirSync, said = false
fs.mkdirSync = function (p, ...rest) {
    try { return orig.call(this, p, ...rest) }
    catch (e) {
        if (!said && e.code === 'EEXIST' && String(p).endsWith('.lock_governance')) { said = true; out('waiting') }
        throw e
    }
}
let rsi = createRsi({ root, domain: derivedDomainOf(effectiveCatalogOf(makePaths(root), DERIVED_BASE)), arms: { catalog: DERIVED_BASE } })
let d = rsi.governance.decide(id, { accept: true, why: '機制獨立', by: `審定者 ${name}`, name, layer: 'A', arm: { selectable: true, realize: [{ kind: 'operator', op: 'add:{id}' }] } })
let a = d.extension.arm
out(JSON.stringify({ ref: d.item.decision.ref, op: a.realize[0].op, status: d.item.status }))
