# 現況(w-recursi)— 2026-11-07

> 只記現況,不寫過程(過程在 `../exp/`)。接續工作先讀本檔;完成一項功能或結束一輪工作即更新。
> **路徑基準**:原始碼在 `src/`,下文檔案路徑除已標 `src/`、`test/`、`toolg/` 者外皆相對 `src/`。

## 身分與位置

- 套件名 `w-recursi`:通用遞迴自我改進(RSI)迴圈,領域無關(領域以依賴注入接上)。`package.json` 之 `version` 設 1.0.0(首發版號由發布流程升為 1.0.1);`main` 指 `dist/w-recursi.umd.js`(來源 `src/WRecursi.mjs`,預設匯出 index 之全部 API + `protocol` 一組)。
- 依賴:`wsemi` ^1.9.52(`src/` 未直接引用;`src/` 所用之 `lodash-es` 由其依賴帶入,故不另宣告);devDependencies:`w-package-tools`(`toolg/`;mocha 隨之安裝)。
- 被誰用:使用端專案以路徑深層匯入 `w-recursi/src/index.mjs`、`w-recursi/src/protocol.mjs`、`w-recursi/src/search/arms.mjs` 等(套件不設 `exports`;需求出處使用端 Gitea #95),另有大量封存腳本經轉發檔引用 `src/**` 全部檔案;`test/` 隨 npm 包發布(使用端以此夾之 mocha 測試守門),`test/tools/toy.mjs`、`toyArms.mjs` 亦被深層匯入。
- 發布狀態:已依自有套件佈局整理(2026-11-07);**尚未提交與發布**,發布與推送由使用者與自動化流程處理。

## 佈局

- 原始碼全在 `src/`:根層 `index.mjs`(`createRsi` 組裝與 `CFG_KEYS`)、`protocol.mjs`(協定件 barrel)、`WRecursi.mjs`(聚合入口)、`cli.mjs`(通用 CLI),子目錄 `core/`(canonical、cli、domainContract、hookResult、jsonl、lock、paths、proc、slots、writeRoot)、`tree/`(store、view、node、alias)、`search/`(operators、policyV0、turning、arms)、`loop/`(explore、auto、status、report、generation、policyDev)、`sim/`(dream、replay)、`eval/`(runner、worker)。
- `test/`:`unit-*.test.mjs`(47 檔)、`tools/`(玩具領域 `toy.mjs`、`toyArms.mjs`、`toyConfig.mjs`、子程序輔助件、`tmpdir.mjs`、`jsdocExamples.mjs`)、`fixtures/`(兩份舊版輸出快照)。
- `toolg/`:標準六支(`addVersion`、`modifyReadme`、`cleanFolder`、`gDocsExams`、`gDistRollup`、`genDocsDist`);`g.mjs`:離線範例(玩具領域跑 4 輪探索 + 狀態 + 做夢,不連網);`dist/`、`docs/` 為產製物(未追蹤)。
- 編譯:`node toolg/gDistRollup.mjs` 產出 `dist/w-recursi.umd.js`(`runin: 'nodejs'`;external 為 node 內建七項 `fs path url crypto zlib child_process util`;`lodash-es/*` 單函數路徑打包進 dist);警告一條(umd 以 browser 環境編譯時提示 node 內建模組,皆已 external);dist 以 `require` 載入之鍵集合(84,含 `protocol`)與型別同 `src/WRecursi.mjs`,`protocol` 44 鍵同。
- JSDoc:`src/` 匯出函數 110 個,說明、`@param`、`@returns`、`@example` 皆全;匯出常數 27/27;`@example` 110 則皆經 `unit-package` ⑤ 實跑核對。

## 最近驗證

| 日期 | 項 | 結果 |
|---|---|---|
| 2026-11-07 | 整理輪(結構、JSDoc、去識別、編譯、sgud、打包守門)後全套(`npm test`,經測試鎖) | 268 通過／0 失敗／0 待決(47 檔):原 252 項全綠(`unit-protocol` PR03／PR04 因套件形態改變而更新斷言,匯出名快照未動)+ `unit-package` 16 案。`unit-atomic` 壓力案:單檔重跑 5 次 0 敗、全套 4 次中 1 次偶發(未證實根除)。`unit-package` 變異 14 組皆紅、還原後綠 |
| 2026-11-07 | 打包清單(`npm pack --dry-run --json`) | 178 檔:根 11、`dist/` 2、`docs/` 62、`sgud/` 4、`src/` 32、`test/` 61(`test/tools/` 12);`CLAUDE*.md`、`tmp/`、`test/_tmp/`、`.npmignore` 皆 0 |
| 2026-11-07 | 安裝後驗收(本地 tarball 裝入全新最小專案) | `typeof createRsi` = function、`CFG_KEYS` 含 `arms`;34 條深層路徑 32 條 `import` 成功、2 條(命令列與子程序入口)解析 + 實檔,`cli.mjs --help` 離開碼 0;兩入口 `withLock` 同一實例;`require('w-recursi')` 鍵集合與型別同聚合入口;包內 `g.mjs` 輸出與檔末相符;包內 `CLAUDE*.md` 為 0 |
| 2026-11-07 | 建置與文件 | `gDistRollup` 無錯誤(警告一條,見上);`jsdoc -c .jsdoc` 無錯誤;`gDocsExams`、`genDocsDist` 可執行;dist 鍵集合與型別同聚合入口 |

## 功能現況(對應規則帳本)

| 功能 | 狀態 | 規則／測試 |
|---|---|---|
| 發現樹(節點 / 前緣 / lore)、鎖、原子寫、認領、前緣結案、拒絕存根 | 落地 | REC-01、02、05、10;`unit-store`、`unit-lock`、`unit-atomic`、`unit-frontierOutcome` |
| 身分(規格雜湊、節點 id)、輪夾之名與序、原子取號 | 落地 | REC-03、04;`unit-canonical`、`unit-roundId`、`unit-concurrency` |
| 全域 worker 槽位(原子建槽、租約、死槽回收、CLI 狀態 / 回收) | 落地 | REC-06;`unit-slots`、`unit-slotsAtomic`、`unit-runnerQueue` |
| 算子登錄、通用預設策略、策略視圖與靜態檢查、轉折點提取與產生端守門、展開鉤子、臂排除 | 落地 | REC-08、17;`unit-operators`、`unit-policy`、`unit-view`、`unit-turning`、`unit-proposalBlock`、`unit-childBlock`、`unit-excludeArm`、`unit-policyLoad` |
| 評估器介面(spawn / inProcess)、動態佇列、補槽、工作夾提交與回收、續跑重試 | 落地 | REC-12;`unit-worker`、`unit-runnerQueue`、`unit-runnerCleanup`、`unit-runnerRetry` |
| 做夢(重放、時間切分、回溯、飽和)、單調接受、保底(探索 / 結構)、維護旗標、同批互斥、輪之截止點 | 落地 | REC-09;`unit-replay`、`unit-replayAlias`、`unit-replayCarrier`、`unit-auto`、`unit-dreamGate`、`unit-autoDeadline`、`unit-structural`、`unit-stress` |
| 欠額觸發生成(標記、心跳、失效接手、早退計連續欠額與內嵌現行文、認領後計欠額)、策略開發請求 | 落地 | REC-11;`unit-genRequest`、`unit-genStreak`、`unit-genEmbed`、`unit-debtClaims`、`unit-roundPlanned`、`unit-replanFill` |
| 領域介面與 cfg 契約、行為別名短路提示 | 落地 | REC-07;`unit-domainContract`、`unit-cfgContract`、`unit-aliasPreJob` |
| 臂目錄(注入、選臂、限臂、組合、覆蓋、選單、CLI) | 落地 | REC-15;`unit-arms` |
| 寫域守門、命令列統一解析器、鉤子失敗之結果形 | 落地 | REC-13、14;`unit-writeRoot`、`unit-cli`、`unit-cliArgsFile`、`unit-cliGiven`、`unit-hookResult` |
| 公開面(兩入口、聚合入口、匯出快照)、發布面、依賴與按需引入、打包清單、JSDoc 覆蓋與範例實跑、去識別、深層路徑穩定 | 落地 | REC-16、18、19;`unit-protocol`、`unit-package` |

## 已知缺口與待辦

**A. dist(UMD)之限制(行為未改,待裁示)**:`init()` 寫入預設策略時以 `import.meta.url` 相對位置讀 `src/search/policyV0.mjs`、spawn 模式以相對位置取 `src/eval/worker.mjs`;此二檔不在 `src/WRecursi.mjs` 之 import 圖內,**不隨 dist 打包**。實測 `require('w-recursi')` 取得之 `createRsi(...).init()` 拋 `ENOENT`(找不到 `dist/search/policyV0.mjs`);spawn 模式同理。ESM 深層路徑(`w-recursi/src/index.mjs` 等,使用端現行用法)不受影響。可選處置:接受(dist 僅供不需 `init()` / spawn 之輕量取用)、或後續輪改為以套件根解析資產(行為改動)。

**B. 程式內執行期字串含宿主字樣(依「錯誤訊息文字不改」未動,待裁定)**:`core/domainContract.mjs` 之 `DOMAIN_KEYS` 內三條說明文字(`excludeArm`、`proposalBlock`、`turningParentOk`;錯誤訊息引用之)、`index.mjs` 之 `checkCfg` 提示訊息(`cfg.dream.targetLadder` 一句)、`cli.mjs` 之用法字串(領域 CLI 範例一處)。另 `loop/generation.mjs`、`loop/policyDev.mjs` 之請求文標題內有宿主角色代號(R2 生成代理、R4 策略開發代理),`test/fixtures/turnGenOldSnapshot.json` 之快照文字含之。清單與判準見 `test/unit-package.test.mjs` 之 `HOST_EXCEPTIONS`。

**C. 程式識別字 / 資料形狀偏宿主領域(行為未動)**:CLI 之 evidence 三個別名旗標(`--mech`、`--usability`、`--btcOK`;通用形為 `--set k=v` 與 `cfg.evidenceKeys`)、`loop/explore.mjs` 之 `isAliasShort`(舊式相容判式,2026-10-01 起引擎不使用,讀領域原料之固定欄位)、`search/arms.mjs` 之 `featureOf`(規格特徵口徑假設規格有 `mechs`、`branches`、`books`、`params.pools` 之形)、玩具領域 `test/tools/toy.mjs` 之證據鍵、階梯 4 / 5 之命名與評估原料欄位(`backtest.eqYr`、`halves`、`null`、`windows`、`nullZ`、`deployable`;沿用量化評估風格,另 `test/unit-view.test.mjs` 引之)、前緣條目 `kind: 'endpoint'` 與請求文字中之「終點層 / 終點請求」用語(`loop/generation.mjs`、`loop/report.mjs`、`search/policyV0.mjs`)。建議後續輪泛化(屬行為改動,需使用端同意)。

**D. 原 README「待辦」**(去識別後):
1. 做夢之成本模型(`costOf`)與 `defaultReplays` 目前為常數,樹大時改依評估器回報之實際牆鐘。
2. 策略開發代理之自動觸發只寫請求;是否由套件直接派工另議(涉及模型與額度)。
3. 同一程序內策略檔之轉匯出目標仍依 Node 模組快取(長程序中「同檔改版」之目標沿用舊模組;靜態檢查讀的是新原文)——每輪一程序之用法影響窄,未處理。
4. 引擎契約之待辦(抽成獨立套件前之前置清單,其中使用端轉發檔、依賴宣告、封存腳本相容三項已由使用端完成):
   - ④ 狀態根佈局、`process.cwd()` 預設、節點 id 公式為凍結契約(改 id 公式 ⇒ 全樹 id 變;領域端宜自備對拍測試);
   - ⑤ 策略開發請求標記(`policies/.dev_request.json`)之認領(領域端直寫)與 `DONE.json`(領域端寫、`loop/generation.mjs` 以「`summary.json` 或 `DONE.json`」讀)宜改為引擎 API / 契約明文;
   - ⑥ `loop/generation.mjs` 之 `spec.kind === 'operator'` 與 `origin.topic` 保留字(`generated`、`global`、`backfill`、`carrier`、`policy`)為引擎詞彙,宜登錄於契約或鉤子化;
   - ⑦ 未用匯出之盤點(`index.mjs` 之 59 名中推定約半數無外部使用者,不刪,標 internal)。

**E. 整理輪之變動(供使用端與複審)**:`core/slots.mjs` 之命令列區塊由頂層 `await import('./cli.mjs')` 改為頂層靜態 `import { parseCli } from './cli.mjs'`(UMD 不支援頂層 await;行為同);`test/unit-protocol.test.mjs` 之 PR03 / PR04 因 `package.json` 改為 `main` 指 dist、不設 `type` 而更新斷言(匯出名快照 `INDEX_EXPORTS` / `PROTOCOL_EXPORTS` 未動);其餘 `src/` 變動僅註解去識別、JSDoc 與 `lodash-es` 單函數路徑。
