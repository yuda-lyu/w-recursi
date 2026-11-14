# 現況(w-recursi)— 2026-11-14

> 只記現況,不寫過程(過程在 `../exp/`)。接續工作先讀本檔;完成一項功能或結束一輪工作即更新。
> **路徑基準**:原始碼在 `src/`,下文檔案路徑除已標 `src/`、`test/`、`toolg/` 者外皆相對 `src/`。

## 身分與位置

- 套件名 `w-recursi`:通用遞迴自我改進(RSI)迴圈,領域無關(領域以依賴注入接上)。`package.json` 之 `version` 設 1.0.0(首發版號由發布流程升為 1.0.1);`main` 指 `dist/w-recursi.umd.js`(來源 `src/WRecursi.mjs`,預設匯出 index 之全部 API + `protocol` 一組)。
- 依賴:`wsemi` ^1.9.52(`src/` 只引用 `wsemi/src/getTrace.mjs`〔2026-11-14,`core/jsonl.mjs` 之觀察回調〕;`src/` 所用之 `lodash-es` 由其依賴帶入,故不另宣告);devDependencies:`w-package-tools`(`toolg/`;mocha 隨之安裝)。
- 被誰用:使用端專案以路徑深層匯入 `w-recursi/src/index.mjs`、`w-recursi/src/protocol.mjs`、`w-recursi/src/search/arms.mjs` 等(套件不設 `exports`;需求出處使用端 Gitea #95),另有大量封存腳本經轉發檔引用 `src/**` 全部檔案;`test/` 隨 npm 包發布(使用端以此夾之 mocha 測試守門),`test/tools/toy.mjs`、`toyArms.mjs` 亦被深層匯入。
- 發布狀態:最新發布 1.0.9(2026-11-14 01:44,含治理 #138 與原子寫第 429 項;`npm view` 查得);其後之改動(Gitea #144、第 456 項)**尚未提交與發布**,發布與推送由使用者與自動化流程處理。
- 2026-11-10(使用端 Gitea #127):`eval/runner.mjs` 之 worker `spawn` 補 `windowsHide: true`,`test/` 內起子行程之呼叫同補(REC-20);`runJobs` 介面與其他行為未變。
- 2026-11-14:①治理(使用端 Gitea #138;新檔 `src/search/governance.mjs`,REC-21):提案帳、主控審定、臂目錄以擴充演進、起跑之把關、收件匣與 CLI `proposals` / `decide` / `--ack-pending`;審定之提交點為擴充檔(中斷後補記)、他實例起跑即重載(`rsi.syncArms`)、把關之終檢與取號同鎖、試建時核對 `cfg.arms.use`;未用治理者逐字不變(改前改後對拍 0 差異)。②原子寫不再退回直接覆寫(第 429 項;REC-02):改名重試用盡即拋 `ERSI_ATOMIC_RENAME`,`atomicStats.fallbacks` 改為 `giveUps`,`writeFileAtomic` 增 `opt.retryMs` / `opt.onTrace`、拋錯前盡力刪暫存檔(刪不掉 ⇒ `tmpLeft`);`withLock` 之建鎖夾 EPERM / EACCES / EBUSY 視同被占用、死鎖夾刪不掉時亦依逾時拋錯(REC-01)。
- 2026-11-14(使用端 Gitea #144,治理之五項不足 + 排程第 456 項):①停用之臂、修訂了 `selectable` / `status` 之臂納入 `lenientIdsOf`,本就不可選之 lenient 臂之未登錄落成名不報錯不警告,寬鬆另以「名」為單位(`lenientNamesOf`:共用落成名之他臂同此)⇒ 「由生效目錄之可選臂推導算子」之領域停用某臂後之下一次組裝不再拋錯;②修訂之 patch 以 `null` 刪除非必填鍵(必填欄拒)、`undefined` 視同未給、寫入擴充檔之項須為純資料;③`realize` 之 `{id}` 由引擎代換為鎖內配出之 id(API 與 CLI);④`lenientIdsOf` 自 `index.mjs` 匯出(另新增匯出 `lenientNamesOf`);⑤匯入介面未實作(主控初判,見缺口);第 456 項:`withLock` 之持有者檔為持有之憑證(改名取得後核對,回收於同一鎖夾接手、不刪夾;回收途徑寫入後確認無他方進行中之取得、否則撤回;釋放持有者檔不在即不刪)。外審(Argon 兩輪)所提之 `cfg.arms.use` 收嚴、`undefined`、補記沿用 id、`nextArmId` 不重複亦已修。`extensions.json` 之格式不變(新增:revise 之 patch 可含 `null` 值),既有狀態根可續用;鎖夾之 `owner` 格式不變,另有暫時之 `owner.dead-*` / `owner.rel-*`(皆在鎖夾內)。
- `dist/`、`docs/` 為產製物(`dist/` 在版控內);2026-11-14 #144 輪本機以 `toolg/gDistRollup.mjs` 重建 `dist/`(含上列改動,PR04 綠;發布時由發布流程再重產);`docs/` 未重產。

## 佈局

- 原始碼全在 `src/`(33 檔):根層 `index.mjs`(`createRsi` 組裝與 `CFG_KEYS`)、`protocol.mjs`(協定件 barrel)、`WRecursi.mjs`(聚合入口)、`cli.mjs`(通用 CLI),子目錄 `core/`(canonical、cli、domainContract、hookResult、jsonl、lock、paths、proc、slots、writeRoot)、`tree/`(store、view、node、alias)、`search/`(operators、policyV0、turning、arms、governance)、`loop/`(explore、auto、status、report、generation、policyDev)、`sim/`(dream、replay)、`eval/`(runner、worker)。
- `test/`:`unit-*.test.mjs`(49 檔;2026-11-14 加 `unit-governance`)、`tools/`(玩具領域 `toy.mjs`、`toyArms.mjs`、`toyConfig.mjs`、子程序輔助件、`tmpdir.mjs`、`jsdocExamples.mjs`;2026-11-14 #144 加 `childEvents.mjs`〔起子程序並以其輸出為事件同步點〕、`lockRaceChild.mjs`、`governChild.mjs`、`derivedDomain.mjs`〔由生效目錄之可選臂推導算子之玩具領域〕)、`fixtures/`(兩份舊版輸出快照)。
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
| 2026-11-10 | 起子行程隱藏視窗(使用端 Gitea #127)後全套(`npm test`,經測試鎖) | 272 通過／0 失敗(48 檔):原 268 + `unit-runnerSpawnHide` 4 案。新檔修前紅(4 案中 3 失敗:worker 選項 `windowsHide` 為 `[null,null]`、`src/` 1 處與 `test/` 16 處未設)、修後綠;`src/eval/runner.mjs` eslint 錯誤數 139 → 139(無新增)。Windows 視窗之實機觀察未做(負向對照會彈視窗,不在使用中之桌面做) |
| 2026-11-14 | 外審兩輪(Argon、hydrogen)後之最終(`npm test`,經測試鎖;dist 重建) | 313 通過／0 失敗(49 檔);`unit-lock` 共 24 案(本輪新 16、改 1)、`unit-governance` GV13 ~ GV20;變異 29 組中 27 組轉紅(存活 2 組皆為設計重疊);探測最終版 10 次 0 重疊 0 停滯(中途版本曾停滯,見經驗 §26) |
| 2026-11-14 | 治理之五項不足(Gitea #144)與鎖之死鎖回收競態(第 456 項)後全套(`npm test`,經測試鎖;先以 `gDistRollup` 重建 dist) | 299 通過／0 失敗(49 檔):新增 `unit-lock` 6 案(改 1 案)、`unit-governance` GV13 ~ GV16;修前副本(HEAD f213c03)跑新測試 14 敗(含競態案實際重疊、GV13 ~ 16、PR01 / PR04)。建議檔 §6 腳本:修前 `reassemble` 拋錯 / `reviseGridNull` 拋錯 / `lenientIdsOf` undefined / `op` 留 `add:{id}`,修後皆符預期。競態 / GV16 / 計數案未改碼重跑 5 次皆綠。探測(4 worker、臨界區內以 0.2 機率結束、各 120 個 worker):舊鎖重疊 7 / 11 / 2 次、異常結束 4 / 4 / 0,新鎖 0 / 0 / 0 |
| 2026-11-14 | 治理(Gitea #138)與原子寫不退回直寫(第 429 項)後全套(`npm test`,經測試鎖) | 288 通過／1 失敗(49 檔):失敗僅 `unit-protocol` PR04(dist 為舊編譯物,缺治理之 13 個匯出;以副本建置之 dist 跑 PR04 為 5/5 綠)。新增 `unit-governance` 12 案、`unit-atomic` 3 案、`unit-lock` 2 案,修前紅(改前副本:治理匯入即失敗;原子寫 4 案紅;死鎖夾刪不掉之案無限迴圈)、修後綠。未用治理者之改前改後對拍(玩具領域 auto / explore / 乾跑 / status,狀態根 23 檔與輸出遮蔽時間後)0 差異。CPU 壓力負載試驗(6 行程 × 12 次):改前 0 退回 0 短讀(未重現跟跑之數字)、改後 0 拋錯 0 短讀 |

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
| 治理:代理之三層之主控層(提案帳、審定、臂目錄以擴充演進、擴充之臂未登錄則不可選、起跑之把關、收件匣、CLI `proposals` / `decide` / `--ack-pending`) | 落地(2026-11-14;1.0.9 已發布) | REC-21;`unit-governance` GV01 ~ GV12 |
| 治理之補強(Gitea #144):停用 / 改可選與否之臂之 lenient 與寬鬆之名(共用落成名)、patch 之 `null` 刪除與純資料、`realize` 之 `{id}`、`lenientIdsOf` / `lenientNamesOf` 匯出 | 落地(2026-11-14;未發布) | REC-21 ⑪ ~ ⑬;`unit-governance` GV13 ~ GV17、`unit-protocol` |
| 原子寫不退回直寫(有界重試、用盡拋錯、觀察回調)、鎖之建夾暫時性錯誤視同被占用 | 落地(2026-11-14;1.0.9 已發布) | REC-01、02;`unit-atomic` AT10 ~ AT12、`unit-lock` |
| 鎖之持有者檔為持有之憑證(回收與釋放先改名取得再核對;第 456 項) | 落地(2026-11-14;未發布) | REC-01;`unit-lock` |
| 寫域守門、命令列統一解析器、鉤子失敗之結果形 | 落地 | REC-13、14;`unit-writeRoot`、`unit-cli`、`unit-cliArgsFile`、`unit-cliGiven`、`unit-hookResult` |
| 公開面(兩入口、聚合入口、匯出快照)、發布面、依賴與按需引入、打包清單、JSDoc 覆蓋與範例實跑、去識別、深層路徑穩定 | 落地 | REC-16、18、19;`unit-protocol`、`unit-package` |
| 起子行程一律 `windowsHide: true`(runner 之 worker 起程;`src/`、`test/`、`toolg/` 全站點盤點守門) | 落地 | REC-20;`unit-runnerSpawnHide` |

## 已知缺口與待辦

**0. 鎖之已知限制(REC-01;第 456 項修正後,2026-11-14)**:競態已修(持有者檔改名取得後核對、回收途徑寫入後確認、釋放原子移除)。**空夾之產生途徑未完全查明**:「臨界區內異常結束」之探測下偶有釋放 / 回收交錯後之空夾(無持有者檔、無取得檔),以「空夾逾 2 秒寬限即可占下」收斂為 ≤ 2 秒之停頓(最終 10 次探測 0 停滯);再查宜加觀察回調(見需裁示之 `onTrace`)。餘下皆為活性(不致兩臨界區重疊):①釋放時本方之持有者檔被存活之回收者取得逾 2 秒未歸還 ⇒ 不刪,其後移回者成為以本程序 pid 為持有者之遺留,至本程序結束或逾 `staleMs`(預設 5 分)才被回收;②釋放之刪夾持續失敗(Windows 占用)⇒ 殘留至取得者逾 `staleMs`;③與舊版(1.0.9 以前)之 `withLock` 同時作用於同一鎖夾時,舊版之「判定後以路徑刪夾」仍可誤刪(混用版本期間之限制)。槽位(REC-06)之回收仍為移夾法,移走期間第三方可建槽(既有註解已載,未在本輪範圍)。

**0b. 治理之匯入介面(Gitea #144 第 5 項,主控初判本輪不實作)**:無 API 匯入既有提案帳與擴充;README §5 已於「凍結契約」節列出 `governance/` 之路徑(#138 起),但檔內格式(`proposals.json` / `extensions.json` 之欄位)與寫入順序未明定為契約。有使用端需求時再議。

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
