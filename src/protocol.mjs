//w-recursi 之協定子入口(2026-10-01)
//  協定 = 引擎與領域共用同一批檔案與鎖時必須同格式之讀寫件(與狀態根之佈局同版;升版須相容):
//    jsonl(原子寫 / 逐列讀)、鎖(withLock)、槽位(全域 worker 與互斥之租約:pid / ISO 時刻 / token 之持有者列、原子建槽、死者回收)、持有者列(proc)
//    例:領域之策略開發請求認領與引擎之 policyDev 用同一把 policies 鎖;領域之長流程互斥與引擎 runner 用同一組 .slots 語義 —— 搬回領域各寫一份即破壞互斥
//  canonical(規格正規化 / 雜湊 / 節點 id 公式):引擎寫入之 specHash / 節點 id 與領域查樹 / 去重 / 快取鍵必須逐位同 ⇒ 凍結契約, 亦屬協定(領域宜自備對拍測試)
//  輪夾之名(2026-10-09;core/paths.mjs):引擎建之 rounds/r{nnn} 與領域讀之輪夾同一命名與數值序(isRoundDir / roundNumOf / roundNameOf / listRoundDirs)
//  鉤子失敗之結果形(2026-10-09;core/hookResult.mjs):引擎之 auto 與領域之尾段續跑同一形(報告之「## 領域鉤子失敗」節由驗收偵測)
//  寫域守門(2026-10-09;core/writeRoot.mjs):環境變數 RSI_WRITE_ROOT 之根外拒寫(預寫沙箱之防誤寫);領域之寫者可先呼叫 assertWriteRoot
//  cli(統一解析器 parseCli / usageOf / isMainModule)非協定, 為通用便利, 暫隨本入口匯出(抽提時可能分出)
//  只轉匯出、無副作用;載入成本低(不載引擎 index:實測 index 約 212 ms、本入口數 ms)⇒ 輕量 CLI 宜由此取
//  以套件名深層路徑匯入:import { … } from 'w-recursi/src/protocol.mjs'(package.json 不設 exports)
export { atomicStats, writeFileAtomic, readJsonl, writeJsonl, appendJsonl, readJson, writeJson } from './core/jsonl.mjs'
export { pidAlive, readOwner, newToken, ownerLine, ownedBy, waitNote } from './core/proc.mjs'
export { maxOfDir, acquireSlots, tryAcquireSlots, releaseSlots, slotsInUse, slotsStatus, reclaimDeadSlots, slotAuxOf } from './core/slots.mjs'
export { sleepMs, withLock } from './core/lock.mjs'
export { specHash, nodeIdOf, canonicalJson, sha, nowIso } from './core/canonical.mjs'
export { usageOf, parseCli, isMainModule, CliError } from './core/cli.mjs'
export { ROUND_NAME_SRC, isRoundDir, roundNumOf, roundNameOf, listRoundDirs } from './core/paths.mjs'
export { HOOK_FAIL_HEAD, hookErrText, hookFailureOf } from './core/hookResult.mjs'
export { WRITE_ROOT_ENV, writeRootsOf, writeAllowed, assertWriteRoot } from './core/writeRoot.mjs'
