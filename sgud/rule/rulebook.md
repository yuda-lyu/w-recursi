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

- **規則**:樹、前緣、lore、policies、governance 之共用檔,凡讀後整檔重寫者須在 `withLock`(`core/lock.mjs`,mkdir 原子)內;逾時拋錯不靜默;持有者已死 ⇒ 立即回收,持有逾 `staleMs` ⇒ 回收;釋放只刪 owner token 相符之鎖(鎖被回收並由他方取得後,原持有者不刪新鎖);建鎖夾回 EPERM / EACCES / EBUSY(Windows:同名夾刪除待決)⇒ 視同被占用而等候,逾時拋錯並附錯誤碼;**每一條取鎖路徑皆受 `timeoutMs` 約束**(回收持續失敗時同經逾時檢查,不無限重試)(2026-11-14)。
- **持有者檔為持有之憑證(2026-11-14,第 456 項)**:①`<鎖夾>/owner` 只以 `wx`(不存在才建)寫入,建夾後寫入遇 EEXIST ⇒ 本次不算取得;②**凡依他方之持有者檔而動作(回收、釋放)者,先把該檔改名為本方唯一之名(`owner.dead-<token>` / `owner.rel-<token>`)而取得之,再核對**——回收核對原文 = 判定時所讀,才於同一鎖夾以 `wx` 寫本方之持有者檔而接手(**不以路徑刪夾**);原文不同 ⇒ 移回;釋放核對 token 相符才刪夾,不符 ⇒ 移回;③持有者檔不在(他方取得中或已被回收)⇒ 釋放不刪(本方之列在存活取得者之取得檔內 ⇒ 等其移回,上限 2 秒;在已死取得者之取得檔內 ⇒ 由本方取得後刪);④無有效持有者檔之夾:有存活之取得者(未逾 `staleMs`)⇒ 非死鎖;取得者皆已死 ⇒ 死鎖(其取得檔內為存活持有者之列者移回、不接手;讀不到或損壞而未逾 `staleMs` ⇒ 不判死);皆無 ⇒ 依夾之 mtime 逾 `staleMs`(夾內之建檔 / 改名 / 刪檔皆更新之,2026-11-14 NTFS 實測);⑤**回收途徑以 `wx` 寫入本方持有者檔之後須確認持有**(`confirmHeld`;外審 Argon #1):持有者檔之名於他方動作之窗內會暫時空出(回收者核對中、釋放者已取得而將刪夾),落在此窗內之 `wx` 會成功 ⇒ 寫入後**先列舉取得檔、後讀持有者檔**(決定性之讀取在列舉之後;外審 hydrogen:先讀後列舉 ⇒ 兩者之間他方刪夾或移回而本方之列已不在,仍憑先前之讀取進臨界區):有他方之存活取得者(其內非本方之列)、讀不到之取得檔、或任一取得檔內為他方之存活持有者列 ⇒ 撤回(`retreat`:取得本方之持有者檔後刪之,並確認本方之列不在任何取得檔內才結束)不進臨界區;本方之列被他方暫時取得 ⇒ 等其移回;判「未持有」前再列舉、再讀一次,逾時亦撤回(不得留下以本方 pid 為持有者之遺留);列舉後已不在之取得檔略去、暫時讀不到者短重試(否則誤判撤回而留下無主之夾);建夾成功後直接 `wx` 之快速途徑不需確認(新夾內不會有他方之取得檔);⑥**釋放自規範路徑移除鎖夾須原子**:先整夾改名為 `<鎖夾>.gone-<token>` 再刪(遞迴刪除先刪夾內之檔、後刪夾,其間他方以 wx 寫入之持有者檔會被當成唯一之檔而自認持有,再被重試之遞迴刪除刪掉或留下空夾;改名持續失敗 2 秒才退回遞迴刪除);釋放時取得之持有者檔暫時讀不到 ⇒ 移回後重試;⑦**空夾**(無持有者檔、無取得檔)逾 2 秒寬限即可占下(持有者檔只以 `wx` 建立 ⇒ 寬限後才寫之建夾者只會 EEXIST;損壞之持有者檔仍依 `staleMs`)。why:原「判定 stale → 以路徑刪夾 → 重建」於判定與刪除之間他方已回收並取得新鎖時誤刪新鎖而兩臨界區重疊(持有者已死之鎖 + 兩個以上同時等候者;外審以兩真程序 + 屏障實測);槽位(REC-06)之「移夾後核對」於移走期間第三方可建夾,鎖改為「移檔」使鎖夾於核對期間始終存在。**刻意不改**:槽位之回收仍為移夾法(REC-06;不在本輪範圍)。
- **盤點指令**:`git grep -nE "withLock\(" -- src`(站點全集)、`git grep -nE "writeJsonl\(|writeJson\(|writeFileAtomic\(" -- src`(寫入站點;每處須在上列鎖內,或為單一寫者且無鎖外讀後寫);`git grep -nE "rmSync|rmDir\(|renameSync|writeFileSync" -- src/core/lock.mjs`(鎖內之刪夾須只在「已取得本方之持有者檔且 token 相符」之後;持有者檔之寫入須帶 `wx`)。
- **判準**:寫入站點皆「已套鎖」或「刻意不套」(僅追加之 jsonl 以 `appendJsonl` 單次追加;槽位與鎖之 owner 檔屬協調狀態)。
- **測試**:`unit-lock`(5 程序 × 40 次 = 200 無遺失;死鎖回收;釋放只刪自己的鎖;建鎖夾之暫時性錯誤;死鎖 + 兩等候者之競態〔兩真程序、事件同步:A 於判定之讀取後停住、B 回收並進臨界區、再放行 A ⇒ 修前重疊、修後 A 回到等候〕;釋放時持有者檔不在不刪;持有者檔被暫時取得時等其移回;建夾後 wx 遇 EEXIST 不進臨界區;取得檔之存活 / 已死;回收與釋放之取得持續失敗;外審 Argon 之交錯 —— 機制 A〔三等候者:C 核對中暫時取走 B 之持有者檔〕、B〔取得者已死之取得檔 + 兩等候者:B 釋放之窗〕、C〔無主空夾 + 兩等候者〕、#4〔釋放之取得與列舉之間被移回〕、#2A〔取得檔讀不到〕,以 `test/tools/lockStepChild.mjs` 之步進鉤子事件同步)、`unit-store`(6 程序併行 `putNode`)。外審 hydrogen 之交錯(#1-A 確認中途刪夾再取得、#1-B 確認中途移回覆蓋、#2-D 釋放讀不到)、空夾寬限。探測(測試外):4 worker、臨界區內以 0.2 機率結束、每次 120 個 worker ——舊鎖 3 次重疊 7 / 11 / 2;最終之新鎖 10 次 0 重疊、0 停滯(`crashStress.mjs`,證據見該輪報告;中途版本曾停滯,見經驗 §26)。

### REC-02 整檔重寫為原子寫;只追加之紀錄檔容忍半列

- **規則**:`writeFileAtomic`(同目錄暫存檔 + rename)為整檔寫入之唯一原語(`writeJson`、`writeJsonl`、節點檔皆經它);Windows 之 EPERM / EACCES / EBUSY(目標正被讀者開啟)以帶亂數之短間隔有界重試(`opt.retryMs`,預設 15 秒),**用盡即拋 `ERSI_ATOMIC_RENAME`、目標檔不變,不得退回直接覆寫目標**(2026-11-14,第 429 項:原退回直寫 = 截斷再寫,高負載下讀者讀到截斷檔;時限以單調時鐘計,等待不越過時限);任何拋錯路徑(寫暫存檔失敗、非暫時性錯誤、用盡)皆先盡力刪暫存檔,刪不掉者錯誤帶 `tmpLeft`(不靜默);重試以觀察回調 `opt.onTrace`(wsemi `getTrace`;`retry` / `renamed` / `giveUp`)告知;`readJsonl` 最後一列解析失敗視為追加中之半列而略過,中間列壞 ⇒ 拋錯(`skipBad` 僅供唯讀之只追加紀錄檔之消費端)。
- **盤點指令**:`git grep -nE "fs\.(writeFileSync|appendFileSync)\(" -- src`(直寫站點;須為暫存檔、owner 檔、報告 md、請求文,或 `appendJsonl` 本體;`core/jsonl.mjs` 內對目標路徑之直寫須為 0)。
- **測試**:`unit-atomic`(他程序反覆改寫時鎖外讀者 0 解析錯、列數恆完整;AT10 目標被持有 ⇒ 拋錯而目標不變、從未直寫;AT11 於重試事件中釋放 ⇒ 改名成功;AT12 觀察回調五種、`retryMs`、非暫時性錯誤;`skipBad`)。

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

- **規則**:`package.json` 不設 `exports` / `files` / `type`,`main` 指 dist UMD,scripts 只有 `test` 與 `deploy`;不提供 `.npmignore`(npm 包＝git 版控內容,`sgud/`、`test/`〔含 `test/tools/`〕、`docs/` 隨包,`CLAUDE*.md` 由 `.gitignore` 排除);依賴只宣告 `wsemi`(`lodash-es` 由其依賴帶入,`src/` 一律 `lodash-es/<函數>.js` 單函數路徑,不整包匯入;`src/` 之 wsemi 只引用觀察回調之單一實作 `wsemi/src/getTrace.mjs`〔2026-11-14〕,打包進 dist);node 內建模組在 `src/` 一律無前綴,且與 `toolg/gDistRollup.mjs` 之 external / globals 一致;`src/` 每個匯出皆有 JSDoc(說明、`@param`、`@returns`、`@example`),範例實跑;**發布內容(程式、測試、`sgud/`、README、註解)不得出現宿主專案之路徑、檔名、內部輪號、工單編號與業務領域字樣**,需求出處只寫「使用端」與 Gitea 編號。
- **盤點指令**:不手寫式,以守門測試為準——判準與具名例外見 `test/unit-package.test.mjs` 之 `HOST_PATTERNS` / `HOST_EXCEPTIONS`;`git grep -nE "from 'lodash-es'" -- src` 應無輸出。
- **測試**:`unit-package`(①發布面 ②依賴與按需引入 ③打包清單 ④g.mjs 與 README ⑤JSDoc 覆蓋與範例實跑 ⑥去識別)。

### REC-19 深層路徑穩定

- **規則**:`src/` 下全部 33 檔(`index.mjs`、`protocol.mjs`、`WRecursi.mjs`、`cli.mjs`、`core/{canonical,cli,domainContract,hookResult,jsonl,lock,paths,proc,slots,writeRoot}.mjs`、`tree/{alias,node,store,view}.mjs`、`search/{arms,governance,operators,policyV0,turning}.mjs`(`governance` 2026-11-14 新增)、`loop/{auto,explore,generation,policyDev,report,status}.mjs`、`sim/{dream,replay}.mjs`、`eval/{runner,worker}.mjs`)與 `test/tools/{toy,toyArms}.mjs` 之路徑不得改名、搬動(使用端以路徑深層匯入;另有大量封存腳本經轉發檔引用)。
- **盤點指令**:`git ls-files src test/tools`(或尚未提交時 `ls -R src test/tools`)與本條清單逐一比對。
- **測試**:`unit-package`(深層路徑案)。

### REC-20 起子行程一律 `windowsHide: true`

- **規則**:`src/`、`test/`、`toolg/` 內每一處起子行程之呼叫(`spawn`、`spawnSync`、`exec`、`execSync`、`execFile`、`execFileSync`、`fork`,含 `cp.` / `child_process.` 前綴寫法)之選項物件皆含 `windowsHide: true`,不論呼叫端是否有主控台、子行程是否再起孫行程。why:Windows 上由無主控台之行程(detached、排程、常駐服務)起子行程時,未設者每個各開一個終端機視窗(使用端 Gitea #127:`runJobs` 子程序模式每個 worker 各跳一個;本套件之跟跑測試由背景行程執行,同理)。非 Windows 平台此選項無作用,不設平台分支。新增起子行程之呼叫時同輪補上,不留待後。
- **盤點指令**:`git grep -nP --untracked "(?<![.\w$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(|\b(cp|child_process|childProcess)\.(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(" -- src test toolg`(站點全集;前有 `.` 者如 `RegExp.exec` 不算;`test/unit-runnerSpawnHide.test.mjs` 自檢字串內之範例不算),逐筆核對選項含 `windowsHide: true`;對照 `git grep -n --untracked windowsHide -- src test toolg`。
- **站點全集(2026-11-14,Gitea #144 後)**:`src/eval/runner.mjs`(worker 起程,1 處);`test/` 內 20 處(`unit-arms`、`unit-atomic`×2、`unit-cli`×3、`unit-concurrency`、`unit-dreamGate`、`unit-governance`×2〔GV11、GV15〕、`unit-lock`、`unit-package`×2〔`execSync`、`execFileSync`〕、`unit-slots`、`unit-slotsAtomic`×2、`unit-store`、`unit-writeRoot`、`tools/jsdocExamples`、`tools/childEvents`〔事件同步之起子程序輔助,`unit-lock` 與 `unit-governance` 共用〕);`toolg/` 0 處。判準:21 處皆「已套」,無「刻意不套」。
- **刻意不改**:`dist/`、`docs/` 為產製物(含 runner 之編譯後副本),隨發布流程重產,不手改。
- **測試**:`unit-runnerSpawnHide`(①行為:以 `syncBuiltinESMExports` 換掉 `child_process.spawn` 記下 `runJobs` 子程序模式實際傳入之選項,每個 worker 皆 `windowsHide === true`;②盤點器自檢;③`src/` 盤點 ④`test/`、`toolg/` 盤點)。

### REC-21 治理:提案帳、主控審定、臂目錄以擴充演進、起跑之把關(2026-11-14,使用端 Gitea #138)

- **規則**:代理之分工為三層 —— 節點層(評估器)、做夢層(`hooks.afterRound`)、主控層(`rsi.governance`)。任一層以 `propose` 提案(`PROPOSAL_KINDS`:`new` / `layer` / `revise` / `retire` / `note`;形不合者不入帳、同鍵之待審者不另立),主控以 `decide` 審定(通過或不採皆須附理由;已審定者不得再審)。通過之詞彙變更寫入狀態根之 `governance/extensions.json`;**生效之目錄 = `cfg.arms.catalog`(基底)+ 該擴充**(`applyArmExtensions`,純函式、不改入參;組裝時套用,`rsi.reloadArms()` 於同程序重載)。寫入前先試建目錄(結構檢查),不合 ⇒ 提案帳與擴充檔皆不變。以下為「資料、中斷與他實例不得使狀態根無法使用、靜默遺失或以過期之目錄開輪」:①提案帳 / 擴充檔存在而損壞(提案帳逐列核對 `seq` ≥ 最大編號、`id` 唯一合式、`kind` / `status` 在值域、已審定附 `decision`)⇒ 拋錯(不當成空帳或無擴充;status 與報告則列一行不中斷);②**審定之提交點 = 擴充檔之原子寫**,其後寫提案帳(失敗 ⇒ `RSI_GOVERNANCE_PARTIAL`)、重載、重產 md(後兩者失敗只回錯誤字串);前次中斷而擴充檔已有本提案之項 ⇒ 重審之通過只補記(不重寫、不搬動該項),改判不採 ⇒ `RSI_GOVERNANCE_COMMITTED`;③擴充所加之臂、修訂了 `realize` 之臂之落成名未登錄 ⇒ 組裝不拋錯、該臂不可選並列入 `rsi.arms.warnings`(`lenientIdsOf` → `makeArms` / `validateCatalog` 之 `lenient`),基底之臂(含只改其他欄之修訂)仍嚴格;④修訂之 patch 有不可改(`id` / `n` / `origin`)或未知之欄 ⇒ 拒;⑤試建目錄另核對 `cfg.arms.use`(預設選臂被停用或變不可選 ⇒ 審定被拒;組裝與 `reloadArms` 共用同一核對);⑥`explore` 起跑時與取輪號前各 `rsi.syncArms()` 一次:擴充檔自上次組裝 / 重載後有變 ⇒ 重載並重驗選臂(他實例之審定立即生效;損壞即拋不開輪);⑦把關開啟時,再比對、終檢與取輪號於 `governance` 鎖內(與 `propose` / `decide` 線性化),終檢先於建輪夾;⑧新臂之 `name` 配號於鎖內;⑨擴充項之 `origin` 記完整審定(含 `why`),中斷後之補記以之為原決定,另給不同內容 ⇒ `RSI_GOVERNANCE_COMMITTED`;⑩提案帳之已審定列須有 `decision.at` / `by` / `why`,編號達安全整數上限即拒;擴充之深層結構不合於 `extensions()` 即拋(status / 報告 / 生效目錄一致)。(2026-11-14,使用端 Gitea #144)⑪**審定通過者,下一次組裝不得因該審定而拋錯,含「由生效目錄之可選臂推導算子」之領域**:`lenientIdsOf` = add 之臂 ∪ retire 之臂 ∪ patch 含 `realize` / `selectable` / `status`(含 `null`)之 revise 之臂;lenient 且本就不可選之臂之未登錄落成名不報錯、不警告,可選者警告並不可選;**寬鬆之名**(lenient 之臂於基底、擴充項與套用後之目錄內之落成名;`lenientNamesOf` + validateCatalog 自取)亦同此處置,不論引用之臂是否被觸及(共用落成名之他臂;外審 terra 中途所提、主責實測確認,GV17);試建與組裝為同一檢查(`makeArms(基底 + 擴充, lenientIdsOf)` + `cfg.arms.use`)、以本程序之登錄表——依目錄之其他欄決定登錄之領域不在保證內;⑫修訂之 patch:值為 `null` = 刪除該鍵,必填欄(`title` / `status` / `realize`,有層表時 `layer`)給 `null` ⇒ 拒,刪後之目錄仍須合格;`undefined` 之鍵視同未給;寫入擴充檔之項須為純資料(JSON 往返不變);⑬`new` / `revise` 之 `realize` 字串欄內之 `{id}` 代換為該臂之 id(`name` 配號者為鎖內配出之 id);⑭(外審 Argon)`cfg.arms.use` 之臂若被本次審定觸及(lenient)或其落成名為本次之寬鬆之名 ⇒ 拒(試建之登錄表不能代表下一次組裝;收嚴);`decide` 之新臂與 `applyArmExtensions` 之 add / revise 之 `undefined` 之鍵視同未給;中斷後之補記沿用已生效之 id(不重新配號,其後之審定不影響補記);`nextArmId` 不配出目錄內既有之 id。死鎖回收之競態已於 REC-01 修正(第 456 項)。停用之臂留在目錄(`blocked`、`blockedBy` 以「停用(治理)」起首、不可選);臂之 `origin` 記出處。`cfg.governance.requireReview = true` 時,逾 `maxPendingRounds` 輪未審之提案(類別 ∈ `gateKinds`)使 `explore` 於取輪號前拋 `RSI_GOVERNANCE_PENDING`(不開輪、不寫檔;乾跑與 `opt.ackPending` 不擋)。`cfg.governance` 之未知鍵 / 型別不符 ⇒ **組裝期拋錯**(`undefined` / `null` 取預設)。**未用治理者(無提案帳、無擴充檔、`requireReview` 未設)之目錄(基底之同一物件)、計畫、報告、`status` 與狀態根佈局逐字同改前**(`governance/` 夾於首次寫入時才建)。寫入皆於 `governance` 鎖內。
- **why**:再廣之目錄也是限制;原引擎之目錄為組裝期注入之靜態資料,下層發現之新機制只能掛在範圍很寬之臂之下(目錄之「已試 / 未試」因此失真),也無處提出「某臂有問題」;而「下層提、主控審、審過才續跑」若只靠呼叫端自律,漏審時迴圈照跑。
- **盤點指令**:`git grep -n "rsi\.arms\b" -- src`(引擎各處一律經 `rsi.arms` 取用,不留組裝期之舊參照;`index.mjs` 內除組裝期之 `cfg.arms.use` 預驗一處外不得以區域變數 `arms` 取用);`git grep -nE "writeJson\(paths\.gov|writeFileAtomic\(paths\.gov" -- src`(治理之寫入站點皆在 `makeGovernance` 之 `withLock` 內)。
- **刻意之取捨(主責判斷)**:停用沿用 `blocked`(不另立 `retired` 狀態);`note` 類留在引擎(主控單一收件匣),預設不計入把關;把關預設關閉;生成請求之底稿不加治理之提示(領域可經 `domain.generationText` 加);README §4 標題列不加 `governance`(標題本非全鍵清單,改標題會變錨點)。
- **測試**:`unit-governance`(GV01 ~ GV20;GV13 ~ GV17 為 #144 之 ⑪ ~ ⑬,GV16 為兩程序事件同步之同時審定,GV17 為共用落成名,GV18 ~ GV20 為 ⑭);匯出名快照 `unit-protocol`(含 `lenientIdsOf`、`lenientNamesOf`);未用者逐字不變另由既有之 `unit-arms`、`unit-explore`、`unit-auto`、`unit-genRequest`、`unit-genEmbed`(含快照)守,改動時另以改前改後對拍(同一玩具領域跑 auto / explore / 乾跑 / status,狀態根全部檔與輸出遮蔽時間後比對)佐證。

## 站點全集與判準之補充

- **不守寫域守門之寫入(刻意)**:槽位與鎖之 owner 檔與 `.max`(跨 session 之協調狀態)、runner 與 worker 之 job 暫存(`paths.tmp`)、刪除他人之鎖與槽(REC-13)。
- **刻意不套鎖之直寫**:`init()` 寫 `policies/v0.mjs` 與 `current.mjs`(缺檔時;不覆寫既有 `v0.mjs`)、心跳檔 `.alive.json`(單一寫者、寫入失敗不拋)、報告 `report.md`(輪夾為取號者獨有)。
