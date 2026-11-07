//w-recursi 之聚合入口(自有套件慣例 src/W<Name>.mjs:預設匯出全部 API 之物件, 供 rollup 打 dist/w-recursi.umd.js 作 main;ESM 使用者仍可深層匯入 src/**)
//  內容 = src/index.mjs 之全部具名匯出(createRsi、runJobs、simulate、STATUS …)+ protocol(= src/protocol.mjs 之協定件:jsonl / 鎖 / 槽位 / cli …, 另成一組, 免與 index 同名者混淆)
//  不另放邏輯;公開面之快照見 test/unit-protocol.test.mjs(PR04 核本物件之每一鍵與 index / protocol 為同一實例)
import * as I from './index.mjs'
import * as P from './protocol.mjs'


let WRecursi = {}
for (let k of Object.keys(I)) { if (k !== 'default') { WRecursi[k] = I[k] } }
WRecursi.protocol = { ...P }
export default WRecursi
