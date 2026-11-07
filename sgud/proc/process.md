# 處理要點(w-recursi)

> 本套件特有之處理流程與要求;規則見 `../rule/rulebook.md`,現況見 `../state/state.md`,來由見 `../exp/experience.md`。

## 1. 領域接入(讀者:要把自己的領域接上本套件之開發者)

1. 讀 README §4(依賴注入契約)取得 `createRsi({ root, domain, … })` 之全部選項;`domain.score` 必填,`domain.evaluator` 於 `explore` 才需要。鉤子之已知鍵與簽名以 `src/core/domainContract.mjs` 之 `DOMAIN_KEYS` 為準。
2. 先以最小領域跑通(範例 `g.mjs`;更完整之玩具領域見 `test/tools/toy.mjs`、臂目錄見 `test/tools/toyArms.mjs`,二者隨 npm 包發布,可深層匯入)。
3. 領域端建兩個接縫檔(各一行 `export * from 'w-recursi/src/index.mjs'` / `'w-recursi/src/protocol.mjs'`),領域碼取本套件一律經此;守門測試掃靜態 / 再匯出 / 副作用匯入 / 動態 `import()` / 以路徑組 URL 四種寫法(README §7)。
4. 領域自己之 CLI 為輪次入口;本套件 CLI(`node w-recursi/src/cli.mjs --config <cfg.mjs> --mode …`)只作通用維運(`init`、`status`、`rescore`、`evidence`、`invalidate`、`reclaim`、`turning`、`arms`)。
5. 狀態根須位於可解析 `lodash-es` 之專案內(`init()` 寫入之預設策略 `v0.mjs` 以套件名匯入它);沙箱試跑可設 `RSI_WRITE_ROOT`(REC-13)。
6. 切換驗證:`status` 與 `explore --dry` 逐臂一致(id 與順序皆同);領域端自備節點 id 對拍測試(REC-03)。

## 2. 修改本套件的驗收流程

1. 先讀 `../state/state.md`(現況與已知缺口),再讀對應規則(REC-nn)。
2. 改動後依序:`node --check`(語法)→ `npx eslint --ext .mjs --no-eslintrc --parser-options ecmaVersion:2022 --parser-options sourceType:module --env node,es2022 --rule "no-undef: error" --rule "no-unused-vars: [error, {args: none, caughtErrors: none}]" src`(未定義與未用匯入)→ 受影響之測試檔 → 全套。
3. 全套 `npm test`(約 2 分鐘;長輸出導向檔案,以 Grep 取失敗段;同機多套件並行時依該環境之測試資源規範排隊)。`scripts.test` 為 `--no-parallel`,理由:跨程序鎖、槽位峰值、讀寫壓力等時序案在平行 worker 的額外負載下會不穩。單檔:`npx mocha --no-parallel test/<檔>.test.mjs --timeout 180000`。
4. 測試暫存一律在 `test/_tmp/<案名>_*`(各案自刪,`.gitignore` 已排除);測試程式不寫 `./tmp/` 與系統暫存。
5. 新增 / 改變匯出:同步改 `test/unit-protocol.test.mjs` 之 `INDEX_EXPORTS` / `PROTOCOL_EXPORTS`、README §4、JSDoc(說明、`@param`、`@returns`、`@example`,範例輸出以 `// =>` 標示;`unit-package` ⑤ 實跑核對)。
6. 新增 `domain.<鍵>` 或 cfg 頂層鍵:先登錄 `DOMAIN_KEYS` / `CFG_KEYS`,再於使用處讀取,並補 README §4 之表(`unit-domainContract`、`unit-cfgContract` 掃原始碼核對)。
7. 新增測試檔:`test/unit-<主題>.test.mjs`,並於 README §6 之表補一列(`unit-package` ④ 核對 README 與 `test/` 一致)。
8. 不得改名、搬動 `src/**` 與 `test/tools/toy.mjs`、`toyArms.mjs`(REC-19)。

## 3. 「結構 / 文件 / 去識別」整理輪之驗證法

1. 留整理前快照;整理後以語法樹逐節點比對(忽略註解與位置;字串字面納入比對):`src/` 除 `lodash-es` 單函數路徑與一處頂層 await 外應完全相同;`test/` 只應有標題字串與不影響斷言之資料字串差異。
2. `lodash-es` 轉換之驗證:正規化比對(`_.fn` → 本地名、去除 lodash 匯入)逐節點相同,加 `no-undef` / `no-unused-vars` 掃描。
3. JSDoc 範例:`unit-package` ⑤ 以子程序實跑全部 `@example`,與 `// =>` 逐行比對;暫存在 `test/_tmp`。
4. 去識別:判準與具名例外見 `unit-package` ⑥ 之 `HOST_PATTERNS` / `HOST_EXCEPTIONS`(程式內執行期字串含宿主字樣者不動,待裁定)。

## 4. 發布與建置(`script.txt` 由使用者維護,不改)

1. 列序:`modifyReadme` → `cleanFolder` → `jsdoc` → `gDocsExams` → `gDistRollup` → `genDocsDist` → git → `deploy`(`addVersion` 為註解,首發版號由 `package.json` 之 `version` 與發布流程決定)。
2. `toolg/` 一律標準寫法(`gDistRollup.mjs` 以 `'./src'`、`'./dist'`,選項寫於本檔);不另立共用設定檔、檢查層或以腳本位置推導路徑。
3. `gDistRollup.mjs` 之 external / globals 自 `src/WRecursi.mjs` 靜態追蹤 import 圖盤點(檔頭寫明原則);`unit-package` ② 核對其與 `src/` 實用之 node 內建模組一致。
4. dist 之限制:見 `../state/state.md`〈已知缺口與待辦〉。

## 5. 公開庫守則

程式、測試、`sgud/`、README、註解皆不得寫使用端之專案名、計畫名、業主或其本機路徑;需求出處寫「使用端」與 Gitea 編號。`sgud/` 內容不得含金鑰、權杖、內網位址或帳號資訊。
