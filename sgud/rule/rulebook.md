# 規則帳本(w-recursi)

> **藍圖**:以規則為單位,記程式碼須長成什麼樣;每條附盤點指令(或站點全集)與對應測試。當前已做到哪些看 `../state/state.md`。
> **路徑基準**:原始碼在 `src/`(聚合入口 `src/WRecursi.mjs`、引擎 API `src/index.mjs`、協定件 `src/protocol.mjs`),測試在 `test/`(輔助件在 `test/tools/`,隨 npm 包發布供下游取用)。下文路徑除已標 `src/`、`test/`、`toolg/` 者外皆相對 `src/`。
> **用語**:「領域」＝以依賴注入接上本套件之一方(提供規格語法、算子、評估器、判讀、載體、遮蔽與鉤子);「使用端」＝使用本套件之專案;「宿主」＝領域所屬之專案;「狀態根」＝`createRsi({ root })` 之 `root` 目錄(佈局見 README §5)。
> **盤點指令**:以 `git grep -n <式> -- <路徑>` 為準(repo 尚未提交時加 `--untracked`);式中 `…` 為示意。

本套件為通用遞迴自我改進(RSI)迴圈,**領域無關**:領域一律以依賴注入接上,套件不得出現任何領域之規格語法、業務詞彙或路徑(REC-18 之去識別守門)。

## 本套件之鐵則

1. **領域無關**:`src/` 不認得任何領域;規格對引擎是不透明之 JSON,領域鉤子之已知鍵單一來源為 `core/domainContract.mjs` 之 `DOMAIN_KEYS`。新增鉤子:先登錄 `DOMAIN_KEYS`,再於使用處讀 `domain.<鍵>`,並補 README §4 之表(REC-07)。
2. **深層路徑穩定**:`src/**` 全部檔案與 `test/tools/toy.mjs`、`test/tools/toyArms.mjs` 之路徑為使用端以路徑深層匯入之契約(套件不設 `exports`),**不得改名、搬動**;要改須先於結案留言列新舊對照表並經使用端同意(REC-19)。
3. **對外匯出集合為快照**:`src/index.mjs` 與 `src/protocol.mjs` 之具名匯出集合、`src/WRecursi.mjs` 之聚合物件,改動須同步改 `test/unit-protocol.test.mjs` 之快照、README §4 與 JSDoc(REC-16)。
4. **狀態根佈局、`process.cwd()` 預設、節點 id 公式為凍結契約**:改動即使既有樹失效(REC-03、REC-04)。
5. **多 agent 併行之保證皆有測試**:新增共用檔之寫入點,須先回答「誰是單一寫者、鎖在哪、讀者會不會讀到半檔」(REC-01、REC-02)。
6. **程式行為不因文件、結構、編譯之整理而變**:整理輪以「去除註解後之語法樹逐節點比對」證之(見 `process.md`)。

## 規則

### REC-01 所有「讀 → 改 → 整檔重寫」皆在跨程序鎖內;釋放只刪自己的鎖

- **規則**:樹、前緣、lore、policies 之共用檔,凡讀後整檔重寫者須在 `withLock`(`core/lock.mjs`,mkdir 原子)內;逾時拋錯不靜默;持有者已死 ⇒ 立即回收,持有逾 `staleMs` ⇒ 回收;釋放只刪 owner token 相符之鎖(鎖被回收並由他方取得後,原持有者不刪新鎖)。
- **盤點指令**:`git grep -nE "withLock\(" -- src`(站點全集)、`git grep -nE "writeJsonl\(|writeJson\(|writeFileAtomic\(" -- src`(寫入站點;每處須在上列鎖內,或為單一寫者且無鎖外讀後寫)。
- **判準**:寫入站點皆「已套鎖」或「刻意不套」(僅追加之 jsonl 以 `appendJsonl` 單次追加;槽位與鎖之 owner 檔屬協調狀態)。
- **測試**:`unit-lock`(5 程序 × 40 次 = 200 無遺失;死鎖回收;釋放只刪自己的鎖)、`unit-store`(6 程序併行 `putNode`)。

### REC-02 整檔重寫為原子寫;只追加之紀錄檔容忍半列

- **規則**:`writeFileAtomic`(同目錄暫存檔 + rename;Windows 之 EPERM / EACCES / EBUSY 遞增等待重試,用盡才直寫)為整檔寫入之唯一原語(`writeJson`、`writeJsonl`、節點檔皆經它);`readJsonl` 最後一列解析失敗視為追加中之半列而略過,中間列壞 ⇒ 拋錯(`skipBad` 僅供唯讀之只追加紀錄檔之消費端)。
- **盤點指令**:`git grep -nE "fs\.(writeFileSync|appendFileSync)\(" -- src`(直寫站點;須為暫存檔、owner 檔、報告 md、請求文,或 `appendJsonl` 本體)。
- **測試**:`unit-atomic`(他程序反覆改寫時鎖外讀者 0 解析錯、列數恆完整;`skipBad`)。

### REC-03 身分雜湊為凍結契約

- **規則**:`specHash = sha(canonicalJson(spec))`(物件鍵遞迴排序、陣列保序);`nodeIdOf(spec, envHash) = sha(canonicalJson(spec) + '|' + envHash)`;同規格同環境 ⇒ 同 id ⇒ 樹中不可能重複。改正規化或公式即使全樹 id 改變。領域端若自算 id,須自備與引擎端之對拍測試。
- **盤點指令**:`git grep -nE "specHash\(|nodeIdOf\(|canonicalJson\(" -- src`(所有取 id 之站點須經 `core/canonical.mjs`)。
- **測試**:`unit-canonical`(鍵序無關、陣列有序、16 位十六進位、環境不同 id 不同、與領域既有公式相容之示例)。

### REC-04 輪夾之名與序之單一來源;輪號原子取號

- **規則**:輪夾名 = `r` + 輪號(至少 3 位,r000 與 4 位以上前導 0 非正規);`isRoundDir` / `roundNumOf` / `roundNameOf` / `listRoundDirs` 在 `core/paths.mjs`,序依輪號而非字典序(r1000 > r999);`allocateRound` 以 mkdir 非遞迴搶號,撞號 +1 重試。
- **盤點指令**:`git grep -nE "readdirSync\([^)]*rounds|\\.sort\(\)" -- src/loop`(輪夾列舉不得自行字典序排序)。
- **測試**:`unit-roundId`(r998 ~ r1001 之序、雙射、`peekRound` 跨 r1000)、`unit-concurrency`(輪號唯一接續)。

### REC-05 認領:鎖內原子檢查占用,衝突後重計畫

- **規則**:`claimNodes` 於同一鎖內「檢查是否已被占用 → 寫 planned 存根」;被他 session 先領者跳過,有跳過即以「已占用 ∪ 被跳過」重出計畫再認領(至多 3 次);`cfg.claims.replanFillOnly` 開時只補被先領之額(依各流組成,`replanFillOf`);`ctx.roundPlanned` 讓策略之每輪上限可承接。
- **測試**:`unit-explore`(真競態注入)、`unit-concurrency`(3 程序 × 2 波)、`unit-replanFill`、`unit-roundPlanned`、`unit-store`(認領 / 跳過 / 釋放 / 回收)。

### REC-06 全域 worker 槽位:總數不超上限,持有者存活即不回收,建槽原子

- **規則**:`acquireSlots` / `tryAcquireSlots` 之槽為 `dir/s{i}`(內含 owner:`pid ISO時間 token`);**持有者存活即不回收**(不論持有多久);建槽先於同夾建暫存夾寫 owner 再 rename 為 `s{i}`(槽出現即帶 owner);釋放與回收先 rename 為 `.rel-` / `.dead-` 再刪,回收核對 owner 未變(不同則移回);輔助夾之殘留依名內 pid 已死掃除(不依時間);查看 / 清理只動死槽,不以 `rm` 手刪。
- **盤點指令**:`git grep -nE "acquireSlots|tryAcquireSlots|releaseSlots|reclaimDeadSlots" -- src`(取槽站點須成對釋放或交 `runJobs` 的 finally)。
- **測試**:`unit-slots`(跨程序峰值 ≤ max;owner 半寫不回收)、`unit-slotsAtomic`(延遲寫 owner 之決定性重現、多程序併搶、回收核對、殘留)、`unit-runnerQueue`、`unit-concurrency`(spawn 模式峰值 ≤ 3)。

### REC-07 領域介面與 cfg 之契約:單一來源、開機檢查、未知鍵不靜默

- **規則**:`DOMAIN_KEYS`(領域)與 `CFG_KEYS`(cfg 頂層)為已知鍵之單一來源;`createRsi` 開機即 `checkDomain` / `checkCfg`:缺必填或型別不符 ⇒ 拋錯;未知鍵 ⇒ 警告(同鍵每程序一次),`cfg.strictDomain = true` 時拋錯;`cfg.arms` 之形不合 ⇒ 拋錯。程式讀取之 `domain.<鍵>`、cfg 頂層鍵須全數登錄。
- **盤點指令**:`git grep -noE "domain\\.[A-Za-z]+" -- src`(讀取之鍵須皆在 `DOMAIN_KEYS`);`git grep -noE "cfg\\.[A-Za-z]+" -- src`(頂層鍵須皆在 `CFG_KEYS`)。
- **測試**:`unit-domainContract`(原始碼讀取之鍵全數登錄、README 表齊全)、`unit-cfgContract`。

### REC-08 策略視圖遮蔽;策略碼靜態檢查涵蓋相對匯入閉包

- **規則**:策略(與策略開發代理)只看策略視圖(領域 `mask` / `maskNode` 遮蔽後);策略碼不得開子程序、不得寫樹、不得讀暫存夾,領域可追加禁用式;靜態檢查範圍 = 策略檔 + 其相對匯入閉包(`current.mjs` 之轉匯出目標一併受檢),目標不存在或閉包過大 ⇒ 拒載。
- **測試**:`unit-view`、`unit-policyLoad`、`unit-auto`(候選靜態檢查)。

### REC-09 做夢與單調接受:升版為單一寫者步驟,不退化

- **規則**:`dream` 在樹上重放策略打分(不跑評估器)並追加寫 `policies/scores.jsonl`(維護中 `cfg.maintenance()` 回理由 ⇒ 只印不寫、`--accept` 不升版);**`--accept` 不在 `auto` 內**;升版須 `policies` 鎖內確認 `current.mjs` 未被他 session 改寫(變則重讀重比,至多 3 次);接受規則 = 留出優於當前達 margin 且全樣本不劣於 floor,另須滿足探索保底與結構保底;飽和(空間用盡或候選與當前相差 < 1%)⇒ 不升版,轉生成;當前策略恆在池中。
- **測試**:`unit-replay`、`unit-replayAlias`、`unit-replayCarrier`、`unit-auto`、`unit-dreamGate`、`unit-structural`。

### REC-10 前緣結案:評估錯誤可重試,拒絕存根不覆寫已占用節點

- **規則**:`resolveFrontier`:executed ⇒ executed;閘門拒絕 ⇒ rejectedByGate;評估錯誤 ⇒ 維持 proposed 並記 `retries`,達 `frontier.maxRetries`(預設 2)⇒ status `blocked`;閘門拒絕存根以 `putNode(node, { skipIfStatus: OCCUPIED })` 鎖內判,不得覆寫已執行 / 認領中 / 已拒之節點。
- **測試**:`unit-frontierOutcome`、`unit-store`。

### REC-11 欠額觸發生成:全域一份標記、持有者判活、早退仍計連續欠額

- **規則**:新區域額度填不滿 ⇒ 寫 `rounds/rNNN/GENERATION_REQUEST.md` 與全域標記 `policies/.gen_request.json`(全域只留一份,`policies` 鎖內);標記記 pid / 行程啟動時刻 / 輪夾;輪夾無 summary / DONE 且(持有者已死 ∨ 心跳停逾 `heartbeatStaleMs` ∨ 心跳行程與標記不符)⇒ 失效,欠額之輪接手;清除只刪「本輪所寫或計畫當下所見」之標記;他 session 已有有效標記(早退)時連續欠額仍以 `debtStreakOf` 計並更新標記之 debt / streak,達 `escalateRounds` ⇒ 報告升級;`debtAfterClaims`(opt-in)以認領後實得計欠額。
- **測試**:`unit-genRequest`、`unit-genStreak`、`unit-genEmbed`、`unit-debtClaims`、`unit-turning`(欠額 → 請求 → 清除)。

### REC-12 runner:job 鍵比對、動態佇列、工作夾提交界線

- **規則**:job 鍵 = id + 規格 + 有效協定(續跑與讀回皆以鍵比對,舊列不污染);spawn 模式待辦依 `costOf` 由大到小入單一佇列,worker 以 mkdir 原子認領下一個,運行中每 `expandMs` 試取空槽加開(總數 ≤ 所求);worker 中途崩潰只失去進行中之 job;`keepDir: false` 時由 `commit()`(結果持久化後)才刪工作夾,刪前日誌歸檔,未提交者逾 `reclaimDays` 回收;`retryFailed` 開時續跑重算失敗列。
- **測試**:`unit-worker`、`unit-runnerQueue`、`unit-runnerCleanup`、`unit-runnerRetry`;worker 起程時隱藏視窗見 REC-20(`unit-runnerSpawnHide`)。

### REC-13 寫域守門(預寫沙箱之防誤寫)

- **規則**:環境變數 `RSI_WRITE_ROOT`(一或多根,以 `path.delimiter` 分隔)有值 ⇒ jsonl 原語與引擎之輪夾 / 報告 / 請求 / 升版 / init 之寫入於根外拋 `ERSI_WRITE_ROOT`(`..` 穿越、同前綴兄弟夾、junction 指出根外皆擋);未設 ⇒ 不檢;槽位 / 鎖之 owner 與 job 暫存不守。領域端直呼 `fs` 之寫者不經本守門,宜先呼叫 `assertWriteRoot`。
- **測試**:`unit-writeRoot`。

### REC-14 命令列統一解析器

- **規則**:凡經 `parseCli` 之 CLI:型別 / 範圍驗證、逐模式可用旗標、位置參數預設拒絕、`--help` 印用法 exit 0、錯誤 stderr 一行 + exit 2 且**未做任何事**;`--args-file <json>` 為通用參數(與命令列同鍵 ⇒ 拒、未知鍵 ⇒ 拒、值走同一驗證);`given` 回明給之鍵(命令列與 `--args-file` 皆算,預設值不算);呼叫端須在載入重模組、寫任何東西之前呼叫。
- **測試**:`unit-cli`、`unit-cliArgsFile`、`unit-cliGiven`。

### REC-15 臂目錄:資料注入、組裝期拋錯、無目錄時逐字不變

- **規則**:臂 = 探索之「可選方向」;目錄為資料(JSON 可),由 `createRsi({ arms: { catalog, defaults, use, known } })` 注入;條目鍵 `ARM_KEYS` 之外 ⇒ 拋錯;目錄不合 / `cfg.arms` 之形不合 / `use` 被拒 ⇒ **組裝期拋錯**;`pick` 拒封鎖、不可選、`requireReopenFor` 之狀態未附重啟理由、衝突、依賴缺;選臂被拒 ⇒ `explore` 於取輪號前拋 `RSI_ARMS_REJECTED`(不開輪、不寫檔);無目錄時行為與計畫 / 節點之 `origin` 與無此功能前逐字同。
- **測試**:`unit-arms`(玩具目錄 `test/tools/toyArms.mjs`)。

### REC-16 公開面:兩入口、聚合入口、匯出名快照

- **規則**:對外入口只有 `src/index.mjs`(引擎 API)與 `src/protocol.mjs`(協定件:jsonl、鎖、槽位、持有者列、規格雜湊與節點 id 公式、輪夾之名、鉤子失敗之結果形、寫域守門;另暫附 cli 統一解析器);`protocol.mjs` 只有轉匯出列、無副作用、不載引擎 index;聚合入口 `src/WRecursi.mjs` = index 之全部具名匯出 + `protocol` 一組(同實例),不放邏輯;`main` 指 `dist/w-recursi.umd.js`(來源為聚合入口)。
- **測試**:`unit-protocol`(PR01 ~ PR05;dist 存在時另核其鍵集合與型別)。

### REC-17 提案與展開之產生端守門(領域鉤子)

- **規則**:`childBlock`(展開前過濾,**以規格為單位**:視圖內任一父之路徑擋下某子規格,經他父亦不出)、`transferBlock` 與 `proposalBlock`(轉折點提案之產生端守門,於 `normSpec` / 占用 / `validateSpec` 之後呼叫;擋下者入 `blocked`、不入去重集)、`excludeArm`(生成端之臂排除,於 `validateSpec` 與 `gates.pre` 之後);鉤子未給 ⇒ 行為逐字不變;鉤子拋錯 ⇒ 視同不擋(`proposalBlock` 同 `transferBlock` 為拋出)。
- **測試**:`unit-childBlock`、`unit-proposalBlock`、`unit-excludeArm`、`unit-turning`。

### REC-18 發布面、依賴與去識別(本套件為公開庫)

- **規則**:`package.json` 不設 `exports` / `files` / `type`,`main` 指 dist UMD,scripts 只有 `test` 與 `deploy`;不提供 `.npmignore`(npm 包＝git 版控內容,`sgud/`、`test/`〔含 `test/tools/`〕、`docs/` 隨包,`CLAUDE*.md` 由 `.gitignore` 排除);依賴只宣告 `wsemi`(`lodash-es` 由其依賴帶入,`src/` 一律 `lodash-es/<函數>.js` 單函數路徑,不整包匯入);node 內建模組在 `src/` 一律無前綴,且與 `toolg/gDistRollup.mjs` 之 external / globals 一致;`src/` 每個匯出皆有 JSDoc(說明、`@param`、`@returns`、`@example`),範例實跑;**發布內容(程式、測試、`sgud/`、README、註解)不得出現宿主專案之路徑、檔名、內部輪號、工單編號與業務領域字樣**,需求出處只寫「使用端」與 Gitea 編號。
- **盤點指令**:不手寫式,以守門測試為準——判準與具名例外見 `test/unit-package.test.mjs` 之 `HOST_PATTERNS` / `HOST_EXCEPTIONS`;`git grep -nE "from 'lodash-es'" -- src` 應無輸出。
- **測試**:`unit-package`(①發布面 ②依賴與按需引入 ③打包清單 ④g.mjs 與 README ⑤JSDoc 覆蓋與範例實跑 ⑥去識別)。

### REC-19 深層路徑穩定

- **規則**:`src/` 下全部 32 檔(`index.mjs`、`protocol.mjs`、`WRecursi.mjs`、`cli.mjs`、`core/{canonical,cli,domainContract,hookResult,jsonl,lock,paths,proc,slots,writeRoot}.mjs`、`tree/{alias,node,store,view}.mjs`、`search/{arms,operators,policyV0,turning}.mjs`、`loop/{auto,explore,generation,policyDev,report,status}.mjs`、`sim/{dream,replay}.mjs`、`eval/{runner,worker}.mjs`)與 `test/tools/{toy,toyArms}.mjs` 之路徑不得改名、搬動(使用端以路徑深層匯入;另有大量封存腳本經轉發檔引用)。
- **盤點指令**:`git ls-files src test/tools`(或尚未提交時 `ls -R src test/tools`)與本條清單逐一比對。
- **測試**:`unit-package`(深層路徑案)。

### REC-20 起子行程一律 `windowsHide: true`

- **規則**:`src/`、`test/`、`toolg/` 內每一處起子行程之呼叫(`spawn`、`spawnSync`、`exec`、`execSync`、`execFile`、`execFileSync`、`fork`,含 `cp.` / `child_process.` 前綴寫法)之選項物件皆含 `windowsHide: true`,不論呼叫端是否有主控台、子行程是否再起孫行程。why:Windows 上由無主控台之行程(detached、排程、常駐服務)起子行程時,未設者每個各開一個終端機視窗(使用端 Gitea #127:`runJobs` 子程序模式每個 worker 各跳一個;本套件之跟跑測試由背景行程執行,同理)。非 Windows 平台此選項無作用,不設平台分支。新增起子行程之呼叫時同輪補上,不留待後。
- **盤點指令**:`git grep -nP --untracked "(?<![.\w$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(|\b(cp|child_process|childProcess)\.(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(" -- src test toolg`(站點全集;前有 `.` 者如 `RegExp.exec` 不算;`test/unit-runnerSpawnHide.test.mjs` 自檢字串內之範例不算),逐筆核對選項含 `windowsHide: true`;對照 `git grep -n --untracked windowsHide -- src test toolg`。
- **站點全集(2026-11-10)**:`src/eval/runner.mjs`(worker 起程,1 處);`test/` 內 17 處(`unit-arms`、`unit-atomic`×2、`unit-cli`×3、`unit-concurrency`、`unit-dreamGate`、`unit-lock`、`unit-package`×2〔`execSync`、`execFileSync`〕、`unit-slots`、`unit-slotsAtomic`×2、`unit-store`、`unit-writeRoot`、`tools/jsdocExamples`);`toolg/` 0 處。判準:18 處皆「已套」,無「刻意不套」。
- **刻意不改**:`dist/`、`docs/` 為產製物(含 runner 之編譯後副本),隨發布流程重產,不手改。
- **測試**:`unit-runnerSpawnHide`(①行為:以 `syncBuiltinESMExports` 換掉 `child_process.spawn` 記下 `runJobs` 子程序模式實際傳入之選項,每個 worker 皆 `windowsHide === true`;②盤點器自檢;③`src/` 盤點 ④`test/`、`toolg/` 盤點)。

## 站點全集與判準之補充

- **不守寫域守門之寫入(刻意)**:槽位與鎖之 owner 檔與 `.max`(跨 session 之協調狀態)、runner 與 worker 之 job 暫存(`paths.tmp`)、刪除他人之鎖與槽(REC-13)。
- **刻意不套鎖之直寫**:`init()` 寫 `policies/v0.mjs` 與 `current.mjs`(缺檔時;不覆寫既有 `v0.mjs`)、心跳檔 `.alive.json`(單一寫者、寫入失敗不拋)、報告 `report.md`(輪夾為取號者獨有)。
