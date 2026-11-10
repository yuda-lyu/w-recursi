# 累積經驗(w-recursi)

> 本檔記「為何如此」:各機制之來由(曾踩到之問題與其修法),留給後續之嘗試、執行與判斷。規則在 `../rule/rulebook.md`,現況在 `../state/state.md`。各條已去識別(某次實測 = 套件在使用端專案內實戰期間之觀察)。節號固定,既有引用才對得上;過長時抽出舊者為 `experience_<年月日>.md`,並於本檔註明。

## 併行與檔案

### §1 整檔重寫須原子:鎖外讀者曾讀到截斷檔

整檔覆寫 = 先截斷再寫,鎖外之讀者可讀到截斷或空檔,`JSON.parse` 拋錯或靜默少列(2026-09-24 某次實測:舊寫法讀者 671 / 5018 次解析錯)。⇒ `writeFileAtomic`:同目錄暫存檔(字尾 `.tmp`,不被 `*.jsonl` / `*.json.gz` 之列舉誤取)+ rename。Windows 目標檔被占用時 rename 可能 EPERM / EACCES / EBUSY ⇒ 遞增等待重試(合計約 2 秒),仍失敗才直寫(不比舊行為差)。只追加之 jsonl 以單次 `appendFileSync` 追加,讀者讀到最後一列半列時略過;中間列壞則視為真損壞(`skipBad` 只給唯讀之消費端——讀後會整檔重寫者勿用,否則壞列於重寫時被丟棄)。

### §2 槽位:同槽雙持有與「建槽者寫 owner 被延遲」

(a) 2026-09-25:owner 檔為空或半寫(他程序 mkdir 後、寫入前之瞬間)時,不可只用 `Date.parse`——截斷之「2026」「2026-09-2」可解析為較早日期而被判逾時誤回收;owner 須為「正整數 pid + 完整 ISO 時間」才算數,空檔 / 半寫視同尚未寫,另有 2 秒寬限。(b) 2026-10-09:舊法 `mkdir(s{i})` 後才寫 owner,建槽者寫 owner 被延遲(排程飢餓)超過寬限時,他方判死重取,兩方同持一槽(某次驗收 peak 5 > 上限 4)⇒ 原子建槽:先於同夾建暫存夾寫 owner,再 rename 為 `s{i}`。Windows 之 rename 目標為夾一律 EPERM,POSIX 為 ENOTEMPTY / EEXIST,兩者皆視為「槽已被取」;目標不在而暫時被防毒或索引開啟 ⇒ 短重試。釋放與回收先 rename 再刪,免 POSIX 之 rename 取代空夾而刪到新持有者之槽。

### §3 槽位為租約:持有者存活即不回收

原本「逾 6 小時即判死」會奪走存活之長持有者(長流程管線持互斥可逾 6 小時 ⇒ 兩條管線並行);同步持有端(`spawnSync`)又無法心跳續約 ⇒ 以存活判定,`staleMs` 只用於顯示逾時。pid 被重用而永佔之槽由狀態列顯示持有者與起始時刻,由人判斷。同理認領(`reclaimStale`)改為認領者存活即不回收(單臂評估已有逾 1 小時之實例,逾 2 小時即回收會重複評估)。

### §4 槽位上限須記錄:CLI 預設值與領域實際上限不一致

2026-09-25 某次回報:CLI 未帶 `--max` 時印預設 8,而領域實際上限 10 ⇒ s8 / s9 不顯示、不回收,他 agent 誤判已滿。⇒ 取槽時把本次 max 記於 `<dir>/.max`,`maxOfDir` = max(記錄值或預設 8, 現存最大槽號 + 1)。

### §5 輪夾須依輪號排序,不可字典序

`r1000` 起字典序 `[r1000, r998, r999]` 之末為 r999:`peekRound` 取錯(靠撞號重試才僥倖)、`loadSummaries` 之序亂 ⇒ 連續欠額、策略開發之「最近兩輪」、`status` 之末五輪皆錯;領域端以 `^r\d{3}$` 辨識者 r1000 起靜默漏輪。⇒ 單一來源 `core/paths.mjs`;正規名為 `isRoundDir`(與 `roundNameOf` 互逆)。

### §6 pid 重用與心跳:標記持有者判活

Windows 會回收 pid:死亡輪之 pid 被他程序重用時,「pid 存活」是假象,原只以 TTL(24 小時)判失效 ⇒ 被放棄之輪之生成請求標記吸收他輪欠額。⇒ 標記記 `pid` / `pidStartedAt` / `roundDir`;探索自取號至寫出 `summary.json` 止每 60 秒重寫 `.alive.json` 心跳;輪夾無 summary / DONE 且(pid 已死 ∨ 心跳停逾 `heartbeatStaleMs`〔預設 2 小時,須大於持有者可能之最長同步阻塞,如槽位等待 1 小時〕∨ 心跳行程與標記不符)⇒ 失效。另:清除原無鎖且不驗擁有者,A 輪兌現即刪全域標記,可刪掉 B 輪剛寫之標記 ⇒ 清除於 `policies` 鎖內,只刪「本輪所寫或計畫當下所見」之標記。

### §7 runner:續跑舊列污染、靜態分桶閒置、工作夾累積

(a) 同 tag 重複呼叫 `runJobs`,worker 追加寫出之舊列(協定或規格不同)蓋掉新結果(2026-09-23 某次續抽同 tag 三批,同 id 換桶後讀回上一批之舊列,抽序被重複記)⇒ job 鍵 = id + 規格 + 有效協定,續跑與讀回皆以鍵比對。(b) 起跑時靜態輪流分桶:重 job 落同桶時他 worker 做完即閒置(某次實例閒置 18 分、另一實例 8 臂單 worker 84 分)⇒ 動態佇列 + mkdir 原子認領 + 運行中補槽;worker 中途崩潰只失去進行中之 job。(c) runner 工作夾永不清(某領域累積 369 夾 193 MB);但「讀回結果」≠「已持久化」,runner 不自行刪夾 ⇒ `keepDir: false` 時由呼叫端於持久化後 `commit()` 才刪,未提交者逾 `reclaimDays` 日回收,同 tag 併行以進行中標記 `.active_<pid>_<亂碼>` 協調。

## 探索與策略

### §8 前緣結案:原不分成敗一律標 executed

只經前緣進入之臂(生成型算子、轉折提案)評估錯誤後永不重試。⇒ `resolveFrontier`:錯誤維持 proposed 並記 `retries`,達上限 `blocked`;閘門拒絕 ⇒ rejectedByGate 並附理由。同時發現閘門拒絕存根曾以 `putNode` 直接覆寫,策略(或升版之候選)重提「已執行而 `validateSpec` 已收緊」之規格時,`raw: null` 之存根蓋掉已執行節點 ⇒ `skipIfStatus`(鎖內判)。

### §9 認領衝突之重計畫與新區域欠額

(a) 重計畫依整份預算重出計畫、新臂全收 ⇒ 實計畫臂數 = 已認領 + 整份新計畫(某些輪超出預算 2 ~ 4 臂,各流額比失真)⇒ `replanFillOnly`(依第一次計畫之各流組成補同流,不足依新計畫之原序)。(b) 第一次計畫之新區域臂被他 session 先認領、重計畫補不回(供給告罄)時,以第一次計畫計「得」仍記欠 0 ⇒ 生成請求不寫、連續欠額歸零 ⇒ `debtAfterClaims`(opt-in):以認領後實得計,生成判定移到認領之後。(c) 早退(他 session 已有有效標記)原不讀 sums、不改標記 ⇒ 連續 6 輪欠額而標記之 streak 停在 1,升級規則被遮蔽 ⇒ 早退亦以 `debtStreakOf` 計並更新標記;另標記之請求文寫於持有輪,其「本輪必須做的事」可早於本輪之升級或領域之改寫(如飽和模式)而過時 ⇒ 早退即時產生現行文並內嵌於報告。

### §10 做夢:視圖、時間切分與成本之陷阱

(a) 揭露之分數 / 階梯須讀**策略視圖**(領域遮蔽後),不可讀原始 S(含被遮蔽之驗證段);目標之階梯亦以視圖判。(b) 視圖之 `children` 只留可見節點,否則未來資訊外洩(子數已滿之父於時間切分中被「每節點子數上限」排除,領域之留出切分因此 0 揭露)。(c) 載體由領域自現存工件推導,規格 = 樹上某節點、該節點由搜尋所得且於本切分尚不可見者,是該節點被發現後才有之載體 ⇒ 不提供(某次實測 32 個切分中 26 個之 bestS 來自此類載體,等於提前揭露未來)。(d) 別名當新發現會使「提出已知父之別名」之策略得分虛高 ⇒ 別名被提出時只記成本,正本已可見則記 duplicates。(e) `cost.replays` 為 0(複製載體)時,原式 `replays || defaultReplays` 把 0 當缺,且 `defaultReplays = 'visibleMedian'` 時回傳字串,使 J 成 NaN ⇒ 以 `isFinite` 判。(f) 樹外臂成本之定值(24)曾遠低於實際中位(146),「多提樹外規格」之候選可藉低估跨過接受門檻 ⇒ `defaultReplays: 'visibleMedian'`。(g) 做夢對樹外之探索不可識別 ⇒ 探索保底(`minGlobal`)與結構保底(`structural`)使「只靠分數升版退回純利用」不可行。(h) 別名表一次做夢求一次(實測 0.31 秒 × 每策略 74 次 ≈ 23 秒),全部策略與切分共用。

### §11 策略檔之靜態檢查須涵蓋相對匯入閉包

現行策略之 `current.mjs` 只有一行轉匯出,靜態檢查原只看它 ⇒ 實際策略檔從未於載入時受檢。已知限制:同一程序內,轉匯出目標仍依 Node 模組快取(本檔 import 帶亂碼參數,其相對匯入不帶)⇒ 長程序中「同檔改版」之目標沿用舊模組(靜態檢查讀的是新原文);每輪一程序之用法影響窄(未處理,見 state)。

### §12 `init()` 不覆寫既有 `v0.mjs`

領域自有之 v0 與套件版 `search/policyV0.mjs` 已分歧,原於 `current.mjs` 缺時無條件以套件版覆寫 ⇒ 只在缺檔時寫入;`current.mjs` 缺而已有 v1…vN ⇒ 警告(以 v0 為當前策略可能非預期)。**寫入狀態根之 `v0.mjs` 以套件名 `lodash-es/<函數>.js` 匯入 lodash-es**,故狀態根須位於可向上解析 `node_modules/lodash-es` 之專案內(範例 `g.mjs` 與守門測試之 cwd 皆在套件內)。

## 契約與介面

### §13 鍵名拼錯會靜默失效

套件不讀未知鍵,領域鉤子(如 `transferBlok`)或 cfg 選項(如 `dreem`)拼錯 ⇒ 該功能靜默失效。⇒ `DOMAIN_KEYS` / `CFG_KEYS` 為單一來源,`createRsi` 開機檢查;守門測試掃原始碼讀取之鍵須全數登錄。

### §14 CLI 旗標之靜默忽略

各檔手寫 `argOf` 時,未知旗標、拼錯、缺值、位置參數一律靜默忽略且值不驗(實例:領域 CLI 之 `status` 漏 `--mode` ⇒ 起整輪;某模式之 `--nodes a` 被忽略 ⇒ 全樹處理;`--max-types abc` ⇒ NaN ⇒ 數量無上限;`--workers` 缺值 ⇒ NaN ⇒ 取槽無聲忙等)。⇒ `parseCli`:型別與範圍、逐模式旗標集、位置參數預設拒絕、錯誤一律 stderr 一行 + exit 2 且未做任何事。`given`(明給之鍵)取代呼叫端掃 `process.argv`(後者漏偵 `--args-file` 所給者)。

### §15 寫域守門之由來

預寫沙箱之 CLI 經轉發檔指向真模組,漏打 `--dry` 即以未審之碼寫生產之輪夾與清單 ⇒ `RSI_WRITE_ROOT` 守門(`..` 穿越、同前綴兄弟夾、junction 皆擋;Windows 不分大小寫)。領域端直呼 `fs` 之寫者不經守門。

### §16 臂目錄

2026-11-07 使用端需求:套件須能由外部注入指定多臂,讓節點 agent 於探索 / 測試 / 計算時自選單臂或多臂去寫程式。原引擎只認 operators(父生子)、carriers(根候選)、frontier arm(手登規格),臂種與狀態散在 lore / 前緣 / 策略碼 / 派工說明 ⇒ 臂為一級概念,目錄為資料(他專案換一份即用),組裝期對登錄表核對,選臂被拒不開輪。

## 整理輪(2026-11-07 結構、文件、去識別)之經驗

### §17 公開庫之去識別與「行為不改」之證明

(a) 以語法樹逐節點比對(忽略註解與位置)證明 `src/` 去識別與補 JSDoc 後程式碼不變——比對對象為整理前快照與現況;`test/` 之比對差異只應是 `describe` / `it` 標題字串與不影響斷言之資料字串。(b) 程式內之執行期字串(錯誤訊息、用法字串、領域鉤子之說明文字)含宿主字樣者,依「錯誤訊息文字不改」未動,列為具名例外(`test/unit-package.test.mjs` 之 `HOST_EXCEPTIONS`),例外過時即須移除。(c) 實例變數 `rsi`、`createRsi` 屬套件識別字,不是宿主痕跡,去識別之掃描須以註解與字串字面為對象,不可對全文逐字比對。

### §18 `lodash-es` 改單函數路徑

`import _ from 'lodash-es'` 改為 `import <fn> from 'lodash-es/<fn>.js'`,`_.fn` 改為 `fn`;同檔已有同名識別字(如 `arms.mjs` 之區域函式 `get`、`explore.mjs` 之 `pick` / `round` 變數)者以 `_fn` 別名。驗證:轉換前後語法樹於「`_.fn` → 本地名、去除 lodash 匯入」之正規化後須逐節點相同,另以 `eslint --rule no-undef --rule no-unused-vars` 掃 `src/`。

### §19 UMD 不支援頂層 await

`core/slots.mjs` 之命令列區塊原以 `await import('./cli.mjs')`(頂層 await)取 `parseCli`,rollup 編 UMD 時拋 `INVALID_TLA_FORMAT` ⇒ 改為頂層靜態 `import { parseCli } from './cli.mjs'`(`cli.mjs` 僅依 node 內建模組、無副作用、與 `slots.mjs` 無循環;`protocol.mjs` 本就載入它)。這是整理輪中唯一不屬註解 / 匯入形式之 `src/` 變動。

### §20 `package.json` 不可設 `type: module`

main 指 `dist/w-recursi.umd.js`(CJS / UMD)時,`"type": "module"` 會使 `.js` 之 dist 被視為 ESM 而 `require` 失敗;原始碼一律 `.mjs`,不需 `type`。`unit-protocol` 之 PR03 因此由斷言 `type === 'module'` 改為斷言不設 `type`。

### §21 已觀察之不穩定:`unit-atomic` 壓力案

整理輪基準全套(約 2 分鐘)有 1 次 `unit-atomic`「他程序反覆整檔改寫時鎖外讀者……」失敗(`列數不足 1 / 5868`);同檔未改碼單跑 5 次皆綠,其後全套 3 次皆綠(全套共 4 次中 1 次)。該案屬壓力型(以讀寫次數門檻證試驗夠強),偶發;未證實根除,後續全套仍出現時以失敗率(n / 次數)記錄,不以放寬門檻處理。

### §22 起子行程不設 `windowsHide`:Windows 無主控台時每個子行程各開一個視窗(2026-11-10,使用端 Gitea #127)

`runJobs` 子程序模式以 `spawn` 起 worker 而未設 `windowsHide`;由 detached、排程、常駐服務等無主控台之行程呼叫時,每個 worker 各跳一個終端機視窗,前景 shell 呼叫則沿用其主控台而看不出。`test/` 內起子行程之呼叫同病(本庫之跟跑測試由背景行程執行)。處置見 REC-20。

- **觀察「傳給 `spawn` 之選項」的作法**:runner 以具名匯入 `import { spawn } from 'child_process'` 取用,屬 live binding;測試對 `cp.spawn` 換一層記錄器後呼叫 `module.syncBuiltinESMExports()` 即生效,`finally` 還原並再同步一次(否則同程序之後續測試檔受影響;`--no-parallel` 下各檔同程序)。不需 stub 子行程本身,worker 照常執行,同時驗 job 完成。
- **盤點器的坑**:①`RegExp.prototype.exec` 與起子行程之 `exec(` 同名,裸名須排除前有 `.` 者(`(?<![.\w$])`),具名匯入之裸名與 `cp.` 前綴分兩支式子;②括號配對須略過字串(測試內有 `-e` 傳入之程式字串與樣板字串);③整行註解不掃;④測試檔自身之自檢字串含無 `windowsHide` 之範例呼叫,須自盤點排除;⑤只掃有匯入 `child_process` 之檔,並斷言確有抓到 `runner.mjs` 之 spawn 與 `test/` 內 ≥ 10 處,避免掃描範圍壞掉時以空集合通過。
- **原建議檔低估範圍**:建議檔稱 `test/` 內 13 處,實為 16 處未設(另有 `unit-package` 之 `execSync`、`execFileSync` 兩處;建議檔以 `spawn` / `spawnSync` 為式未涵蓋 `exec*`)。盤點式須含 `exec`、`execSync`、`execFile`、`execFileSync`、`fork` 全家。
