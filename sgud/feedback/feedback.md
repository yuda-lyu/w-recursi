# 回饋(w-recursi)

> 任務中發現之自有套件、全域技能、全域設定之調整與抽提提案。只增不改;處置結果另記一列並寫明承接哪一列。回饋是紀錄與提案,實際修改走通報管道。

| 日期 | 類別 | 對象 | 內容 | 依據 |
|---|---|---|---|---|
| 2026-11-10 | 全域技能 | `role-command-windows` §7 與全域設定 §8.3 之「起子行程」函式清單 | 清單列 `spawn`、`spawnSync`、`exec`、`execFile`、`fork`,漏 `execSync`、`execFileSync`。本套件 `test/unit-package.test.mjs` 即有此二者而未設 `windowsHide`,且使用端建議檔(僅以 `spawn` / `spawnSync` 為式)據以低估範圍(稱 13 處,實為 16 處)。建議清單與盤點式補此二者,以「`child_process` 全家」為準 | `test/unit-package.test.mjs:192,223`(修前);`sgud/exp/experience.md` §22 |
| 2026-11-10 | 自有套件 | `w-package-tools`(或各自有套件共用之測試輔助) | 「起子行程一律 `windowsHide: true`」之靜態盤點器(括號配對略過字串、排除 `RegExp.exec`、略過整行註解、含自檢與防空集合斷言)目前寫在本套件 `test/unit-runnerSpawnHide.test.mjs`。各自有套件皆適用同一守則,宜抽為共用測試輔助,避免各套件重寫與漂移;抽出前不影響本套件 | `test/unit-runnerSpawnHide.test.mjs` 之 `scanSpawnCalls`、`findUnhidden` |
| 2026-11-14 | 全域技能 | `role-coder-for-validate` Step 1 之標準軸(資料流類) | 資料流類之標準軸補「持久狀態檔之損壞(非 JSON / 形不合,含逐列之不變條件)」「跨檔寫入於兩次寫入之間中斷」「多實例 / 多程序之交錯(含長駐實例持有過期之衍生狀態)」「依賴先前決定之後續決定」四軸,並補一句「外部或累積之資料不得使組裝 / 啟動失敗而無法以正常操作復原」:本輪審計使用端草案時,這三類缺陷(提案帳損壞被當空帳覆寫、審定中斷後重審永遠失敗、擴充之臂之算子未登錄使下一次組裝拋錯而狀態根卡死)皆未被草案之自審與測試涵蓋,因測試只走正常寫入路徑 | `sgud/exp/experience.md` §24;`src/search/governance.mjs` ledger / decide;`test/unit-governance.test.mjs` GV02、GV05、GV06 |
