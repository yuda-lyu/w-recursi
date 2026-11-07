import { makeDomain } from './toy.mjs'


//CLI 測試用設定:狀態根目錄由環境變數 RSI_ROOT 指定(真實呼叫端用法:node w-recursi/src/cli.mjs --config w-recursi/test/tools/toyConfig.mjs --mode status)
//  RSI_TOY_HOOK_FAIL=1:注入會拋錯之每輪鉤子(unit-cli 驗 auto 之鉤子失敗 ⇒ 非 0 結束;2026-09-26 審查)
//  RSI_TOY_GUARD=1:注入寫入類模式之前置守門 beforeWrite(unit-cli 驗寫入類被擋 exit 3、乾跑 / 唯讀不經守門;2026-09-26)
let over = process.env.RSI_TOY_HOOK_FAIL === '1' ? { hooks: { afterRound: async () => { throw new Error('toy 鉤子失敗(測試注入)') } } } : {}
let guard = process.env.RSI_TOY_GUARD === '1' ? { beforeWrite: (what) => { process.stderr.write(`toy 守門拒絕:${what}\n`); process.exit(3) } } : {}
//evidenceKeys(2026-10-01):CLI 之 --mode evidence 只收所列之證據鍵(玩具判讀讀 mech / usability / btcOK;unit-cli 驗 --set 與未宣告之鍵被拒)
export default { root: process.env.RSI_ROOT || './w-recursi/test/_tmp/cli_default', domain: makeDomain(over), budget: { arms: 6, novelty: 2, workers: 3, maxGlobalWorkers: 4 }, evidenceKeys: ['mech', 'usability', 'btcOK'], ...guard }
