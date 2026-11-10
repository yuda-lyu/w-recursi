# w-recursi
A general-purpose, domain-agnostic recursive self-improvement (RSI) loop: a discovery tree, operators, exploration policies, an evaluator interface, dream simulation with monotonic acceptance, and multi-agent concurrency (claims, atomic round numbers, global worker slots); the domain is plugged in through dependency injection.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg)
[![npm version](http://img.shields.io/npm/v/w-recursi.svg?style=flat)](https://npmjs.org/package/w-recursi)
[![license](https://img.shields.io/npm/l/w-recursi.svg?style=flat)](https://npmjs.org/package/w-recursi)
[![npm download](https://img.shields.io/npm/dt/w-recursi.svg)](https://npmjs.org/package/w-recursi)
[![npm download](https://img.shields.io/npm/dm/w-recursi.svg)](https://npmjs.org/package/w-recursi)
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-recursi.svg)](https://www.jsdelivr.com/package/npm/w-recursi)

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-recursi/global.html).

## Installation

### Using npm(ES6 module):
```alias
npm i w-recursi
```
依賴:`wsemi`(其依賴帶入原始碼所用之 `lodash-es`,故 `package.json` 不另宣告 `lodash-es`).原始碼為 ESM、不設 `exports`,以深層路徑取用:`w-recursi/src/WRecursi.mjs`(聚合入口)、`w-recursi/src/index.mjs`(引擎 API)、`w-recursi/src/protocol.mjs`(協定件);`main` 指向 `dist/w-recursi.umd.js`(`require('w-recursi')`,限制見 §8).

#### Example:
> **Link:** [[dev source code](https://github.com/yuda-lyu/w-recursi/blob/master/g.mjs)]
```alias
import fs from 'fs'
import WRecursi from './src/WRecursi.mjs'


let { createRsi } = WRecursi


let test = async () => {
    let ms = []

    //workDir, 狀態根目錄(唯一必填): tree/(節點、前緣、lore)、rounds/(每輪報告)、policies/(策略與做夢分數)等皆由此展開
    //  須位於可解析 lodash-es 之專案內(init() 寫入之預設策略 v0.mjs 以套件名匯入 lodash-es)
    let workDir = './_test_recursi'
    fs.rmSync(workDir, { recursive: true, force: true })

    //domain, 領域(依賴注入): 本套件不認得任何領域, 規格、算子、評估、判讀全由此注入; 以下為玩具問題, 規格為整數 x, 評估值 v = 9 - (x - 3)^2(最佳點 x = 3)
    let domain = {
        name: 'toy',

        //validateSpec, 規格檢查(拋錯即無效)
        validateSpec: (spec) => {
            if (!Number.isInteger(spec.x)) {
                throw new Error('x 須為整數')
            }
        },
        summarize: (spec) => `x=${spec.x}`,

        //operators, 算子(parent spec → 子 spec): 往兩個方向各走一步
        operators: [{
            name: 'step',
            family: 'move',
            applies: () => true,
            children: (s) => [
                { spec: { x: s.x + 1 }, params: { d: 1 }, reason: '+1' },
                { spec: { x: s.x - 1 }, params: { d: -1 }, reason: '-1' },
            ],
        }],

        //carriers, 冷啟動之根候選(樹中尚無節點時, 策略自此取新區域之臂)
        carriers: { origin: { x: 0 } },

        //evaluator, 評估器(spec → raw): inProcess 於同程序評估; spawn 則另派子程序(須給模組路徑, 子程序總數受全域槽位限制)
        evaluator: { mode: 'inProcess', evaluate: async (spec) => ({ v: 9 - (spec.x - 3) ** 2 }) },

        //score, 判讀(raw → { S, ladder, flags }): 可重算而不重跑評估; ladder 大於等於 1 代表通過領域之第一道真偽
        score: (raw) => ({ S: raw.v, ladder: raw.v > 0 ? 1 : 0, flags: {} }),
    }

    //createRsi, 組裝實例並 init(): 建狀態根與預設策略 v0.mjs
    let rsi = createRsi({ root: workDir, domain, budget: { arms: 3, novelty: 1, workers: 1 } }).init()

    //explore, 每輪探索: 策略出計畫 → 認領(多 session 併行時, 他方已領者跳過)→ 評估 → 入樹 → 寫報告
    for (let i = 0; i < 4; i++) {
        let ex = await rsi.explore({ by: 'demo' })
        ms.push({ [`r${ex.round}`]: `${ex.items.map((it) => domain.summarize(it.spec)).join(', ')}｜最佳 S ${ex.summary.bestS.S}` })
    }

    //status, 樹之摘要(唯讀)
    let st = await rsi.status({ print: false })
    ms.push({ tree: `${st.nNodes} 節點, 最佳 ${st.top[0].summary}(S ${st.top[0].S})` })

    //dream, 做夢: 讓當前策略在既有之樹上重放並打分(不呼叫評估器); 候選策略放 policies/candidates/*.mjs, dream({ accept: true }) 依單調接受規則才升版
    let d = await rsi.dream()
    ms.push({ dream: `${d.rows[0].name}｜樹 ${d.nodes} 節點｜飽和 ${d.saturated}` })

    //clear
    fs.rmSync(workDir, { recursive: true, force: true })

    console.log('ms', ms)
    return ms
}
await test()
    .catch((err) => {
        console.log(err)
    })
// => ms [
//   { r1: 'x=0｜最佳 S 0' },
//   { r2: 'x=1, x=-1｜最佳 S 5' },
//   { r3: 'x=2, x=-2｜最佳 S 8' },
//   { r4: 'x=3｜最佳 S 9' },
//   { tree: '6 節點, 最佳 x=3(S 9)' },
//   { dream: 'current(v0)｜樹 6 節點｜飽和 false' }
// ]
```

---

## 概述

通用遞迴自我改進(RSI)迴圈之**領域無關**套件:發現樹、算子、探索策略、評估器介面、夢境模擬與單調接受、多 agent 併行.領域(規格語法、評估器、判讀、算子、載體、遮蔽、鉤子)全部以**依賴注入**接上;套件本身可用簡化之玩具問題(`test/tools/toy.mjs`)做完整、大量、可重複之測試,再套回真實領域.

> 驗證方式:①玩具領域之單元測試(`npm test`;`test/` 下之 `unit-*.test.mjs`,見 §6);②接回真實領域時,乾跑計畫與領域 CLI 之 `explore --dry` **逐臂一致(id 與順序皆同)**,`status` 讀同一份 index 亦正常(見 §7).
>
> 讀者:要把自己的領域接上本套件之開發者.需提供之物見 §4(依賴注入契約:`createRsi({ root, domain, … })`),狀態根目錄之檔案佈局見 §5,多 agent 併行之保證見 §3,最小可執行範例見上方 Example(`g.mjs`).待辦與已知限制見 §8.

## 1. 概念(六個角色,三層)

| 層 | 角色 | 套件內 | 領域注入 |
|---|---|---|---|
| 資料 | **樹**(節點 / 前緣 / lore) | `tree/store.mjs`:節點 `nodes/{id}.json.gz` + `index.jsonl` 摘要;前緣 `frontier.jsonl`;lore `lore.jsonl` 只追加 | `summarize(spec)`、`carrierOf(spec)`、`indexExtra(node)` |
| 資料 | **身分** | `core/canonical.mjs`:`specHash = sha(canonicalJson(spec))`;`nodeIdOf(spec, envHash)`;同規格同環境 ⇒ 同 id ⇒ 樹中不可能重複 | `envHash(spec)`(如引擎碼雜湊 / 資料版本 / 環境指紋…) |
| 搜尋 | **算子**(parent spec → 子 spec) | `search/operators.mjs`:登錄、驗證、去重、`controlsFor`(對照臂)、`rankOf` | `operators[]`(`applies` / `children` / `controls`)、`familyRank`、`validateSpec` |
| 搜尋 | **策略**(每輪提哪些臂) | `search/policyV0.mjs`(通用預設:譜系停止 / 父優先序 / 每父上限 / 對照臂整族計入預算 / 新區域額度);策略檔存於狀態根 `policies/`,只由做夢接受升版 | `carriers`(冷啟動 / 新區域之根候選)、`excludeParent(view)`、`forbidden[]`(策略碼靜態檢查) |
| 評估 | **評估器**(spec → raw)與**判讀**(raw → score) | `eval/runner.mjs`(spawn 子程序 / 同程序)、`eval/worker.mjs`(通用 worker) | `evaluator`(`module` 匯出 `createContext` / `evaluate`,或 `evaluate` 函式)、`score(raw, node)`、`gates.pre / post`、`fingerprint(raw)`(行為別名) |
| 模擬 | **做夢**(策略在樹上重放)+ **單調接受** | `sim/replay.mjs`(揭露 / 未知 / 成本 / 時間切分 / 回溯測)、`sim/dream.mjs`(候選打分、`--accept` 單一寫者) | `mask(score, node)`(策略視圖之遮蔽)、`costOf(node)` |
| 控制 | **輪次**與**自動** | `loop/explore.mjs`、`loop/auto.mjs`、`loop/status.mjs`、`loop/policyDev.mjs`、`loop/report.mjs` | `hooks.afterRound`(如自動衍生處理)、`reportColumns` / `reportExtra`、`policyDevText` |
| 併行 | 鎖 / 認領 / 原子輪號 / 全域槽位 | `core/lock.mjs`、`core/slots.mjs`、`tree/store.mjs` 之 `claimNodes` / `reclaimStale`、`loop/explore.mjs` 之 `allocateRound` | `budget.maxGlobalWorkers`、`claims.staleMs` |

## 2. 每輪流程(`auto`)

1. `reclaimStale`:認領者行程已死或逾時之 planned 節點 → `stale`(可重提).
2. 策略出計畫(只看**策略視圖**:遮蔽後之分數;別名節點不作父;已占用集合 = executed ∪ rejectedByGate ∪ planned ∪ running).
3. 驗證規格、前置閘 → `rejectedByGate` 節點(留紀錄);**同 id 節點已被占用(已執行 / 認領中 / 已拒)⇒ 不寫拒絕存根**(`putNode` 之 `skipIfStatus`, 鎖內判;2026-09-29,原會以 `raw: null` 之存根蓋掉已執行節點).
4. **認領**(鎖內原子):他 session 已領走者跳過;有跳過即以「已占用 ∪ 被跳過」重新出計畫再認領(最多 3 次)⇒ 併行 session 自然分到不同臂,不空轉.
5. 平行評估(spawn 模式受**全域槽位**限制:所有 session 之 worker 合計 ≤ `maxGlobalWorkers`;job 依 `evaluator.costOf` 由大到小入**單一佇列**,worker 原子認領下一個 ⇒ 先做完者自動接手;起跑時槽位不足者運行中補槽加開)→ 判讀 → 後置閘 → 入樹(覆寫存根,清除認領)→ **提交 runner 工作夾**(`commit()`,見 §5)→ **前緣結案**(`store.resolveFrontier`;2026-09-29):executed ⇒ `executed`;閘門拒絕 ⇒ `rejectedByGate`(附理由);**評估錯誤 ⇒ 維持 `proposed` 並記 `retries`(下一輪可重提),達 `frontier.maxRetries`(預設 2)⇒ status `blocked`**(原不分成敗一律標 executed ⇒ 只經前緣進入之臂錯誤後永不重試).
6. 做夢(**寫** `policies/scores.jsonl`,每策略一列;樹大時一次 1 ~ 18 分(2026-09 某次實測);`dream.everyRound=false` 或 `dream.minIntervalMs`(距 scores.jsonl 末列不足即略過, 報告寫「略過:同批已做」;2026-10-01 起另以租約 `policies/.mtx_dream` 互斥, 他 session 正在做夢 ⇒「略過:同批進行中」)可交獨立排程;`cfg.maintenance()` 回理由時只印不寫, 見 §4).
7. 領域鉤子 `afterRound`(如自動衍生處理).
   - **輪之截止點**(2026-10-09):`auto({ deadlineAt, mayStart })` —— `deadlineAt`(毫秒;未給 ⇒ 行為逐位同改前)⇒ 做夢開工前判 `mayStart('dream')`(領域注入「現在 + 做夢之預留 ≤ 截止點」;未注入 ⇒ 截止點已過才不做), 不可 ⇒ 略過「輪截止點」(`dreamSkip.why = DEADLINE_WHY`;只在本會做夢時判);鉤子收 `afterRound({ …, deadlineAt })` 自判其子步驟.截止點與預留之單一來源在領域.
8. 策略開發觸發判定(連續兩輪無階梯≥1、或距上次改版 ≥ `policyDev.minRounds` 輪;末次改版時刻 = `changelog.md` 自末列往前第一個「列首為完整 ISO」之列,列首無 ISO 之手寫列略過)→ 寫 `POLICY_DEV_REQUEST.md`;**全域只留一份**(`policies/.dev_request.json` 標記,接受新策略時清除).
9. 報告 `rounds/r{nnn}/report.md` + `summary.json` + `plan.json`;結果之 `stagesSec = { explore, dream, hook, policyDev }`(各段牆鐘秒)亦列於報告末.

**接受新策略(`dream --accept`)刻意不在 auto 內**:那是單一寫者步驟(`policies` 鎖內確認 `current.mjs` 未被他 session 改寫才升版),由策略開發 agent 另行執行;其餘 session 下一輪起跑即載入新策略.策略檔之靜態檢查涵蓋**相對匯入閉包**(`current.mjs` 之轉匯出目標如 `./v2.mjs` 一併受檢;2026-09-29).

## 2b. 自延伸:轉折點提取與欠額觸發生成(2026-09-23)

參數型算子字母表是**有限空間**;開放性來自兩件事,皆已內建:

- **轉折點提取**(`search/turning.mjs`;每輪起跑時執行,`cli --mode turning` 唯讀預覽):由樹自己推導新臂,不靠人定軸——①搬移:某算子(含參數)在某父上使 S 提升 ≥ `turning.minGain` ⇒ 對其他高分父施同一算子同一參數;②外推:父 → 子為單一數值路徑之改變且子更好 ⇒ 同方向再走一步(格點外;由 `validateSpec` 擋不合法值);③交叉:兩高分節點相對最近共同祖先之差異落在不同路徑 ⇒ 合併.產物為前緣 arm(`origin.topic:"turning"`),由策略之新區域額度取用;負向轉折列於報告「避免」.回填 / 錨點之邊不算轉折.**三種提案共用之產生端守門**(2026-10-04):領域鉤子 `domain.proposalBlock(spec, ctx)` 於 `normSpec` / 占用 / `validateSpec` 之後對搬移 / 外推 / 交叉一律呼叫(`ctx = { op, origin, byId, parent?, parents, kidOp? }`;外推之 `parent` = 邊之子、交叉之 `parents` = 祖先與兩親代),擋下者入回傳之 `blocked`(`by: 'proposalBlock'`)、不入本次之去重集(他路徑之同規格仍再判);未給鉤子 ⇒ 逐字舊行為(例:外推 9999 → 40 ⇒ −9919 之越域臂即此擋).
- **欠額觸發生成**(`loop/generation.mjs`):新區域額度填不滿(含轉折提案後仍不足)⇒ 寫 `rounds/rNNN/GENERATION_REQUEST.md`(全域一份, `policies/.gen_request.json`),要求生成代理於本輪生成新算子 / 載體 / 條件變數(領域以 `domain.generationText` 給指引);`origin.topic:"generated"` 或經新區域之 `kind:"operator"` 節點執行後清除;連續 `generation.escalateRounds`(3)輪欠額 ⇒ 報告升級為「路線飽和」.冷啟動不算欠額.**他 session 已有有效標記時**(早退,不寫新請求;2026-10-04 起):連續欠額仍以同式(`debtStreakOf(sums)`)計,鎖內寫回標記之 `debt` / `streak`(`at` / `round` / `pid` 不改 ⇒ 清除之判定不受影響),回傳 `{ existing, streak, escalate }`,報告於 `escalate` 時加「連續欠額 N 輪 ⇒ 路線須重構」一行(原早退不讀 sums ⇒ 升級被遮蔽).**早退之現行文**(2026-10-04 起):持有輪之請求文寫於當時(其「本輪必須做的事」可早於升級或領域之改寫),早退另以本輪之 streak 組底稿(`requestBaseOf`)經 `domain.generationText` 即時產生現行文,於升級或領域改寫了該段(如領域之飽和模式)時回傳 `embed`,報告以引用區塊內嵌該段、升級行改指之;不寫任何輪夾、不改標記之 `at` / `round`;皆否 ⇒ 報告與改前逐字同.
  - **標記之持有者與清除**(2026-09-29):標記記 `pid`、`pidStartedAt`、`roundDir`;explore 自取號至寫出 `summary.json` 止每 60 秒重寫本輪夾之 `.alive.json`(心跳)⇒ **輪夾無 `summary.json` / `DONE.json` 且(持有者 pid 已死 ∨ 心跳停逾 `generation.heartbeatStaleMs`(預設 2 小時)∨ 心跳行程與標記不符)⇒ 標記失效,欠額之輪接手**(寫本輪之標記;原為只以 TTL 24 小時判 ⇒ 死亡輪之標記吸收他輪欠額;心跳防 Windows 回收 pid 之假存活).清除於 `policies` 鎖內、**只刪本輪所寫或本輪計畫當下所見之標記**(計畫後才出現之他輪標記保留);作廢輪次用 `rsi.clearGenRequest({ round: 'rNNN' })`(只刪該輪之標記).
  - **計數之時點**(2026-10-02;opt-in `generation.debtAfterClaims`):預設於策略之**第一次計畫**後計「得」(舊行為)⇒ 第一次計畫之新區域臂被他 session 先認領、重計畫補不回(供給告罄)時仍記欠 0, 生成請求不寫、連續欠額歸零(某次實測:需 2、實得 0 而記欠 0).opt 開 ⇒「得」改以認領 / 重計畫後**本 session 實際認領之臂**計(與計畫同一定義:`noveltyDebtOf(plan, budget, frontierHashes, items)` 之 items —— novelty 項 + 取自前緣之展開, 全域臂不計;被閘門拒絕者亦不計), 生成判定(寫請求 / streak)移至認領之後;`summary.noveltyDebt` 為生成判定所用之值, `summary.noveltyDebtPlan`(僅 opt 開時有此欄)為第一次計畫之值, 報告「新區域額度」並列兩者;乾跑無認領 ⇒ 恆為計畫值;本輪所見之標記(清除用)仍取第一次計畫當下者.
- **載體自動登錄**:`domain.carriers` 可為函式(每次出計畫時求值),領域可自既有工件推導新區域之根候選,不靠人手登(如自既有工件推導);策略之新區域額度自此取用(`unit-explore` 有案).**推導出的等價宣稱須經驗證**:領域宜把推導出之載體回放與既有節點逐位比對,ok 者才取得等價身分(某次實測 41 個中 39 個逐位相同,2 個因設定解析遺失一欄而不同 ⇒ 驗證即為擋此類事而設;修解析後 43 / 43 逐位相同;驗證後才准用於後續之排除 / 清單同步).
- **做夢飽和判定**(`sim/dream.mjs`):全部策略於全部時間切分皆提不出樹外之臂(unknown = 0),或全部候選之留出分數與當前相差 < 1% ⇒ `saturated`;`--accept` 時拒絕升版(理由「飽和 ⇒ 不升版,轉生成」),由欠額觸發生成承接,不以人工升版補(`unit-auto` 有案).

## 3. 多 agent 併行之保證(皆有測試)

| 風險 | 機制 | 測試 |
|---|---|---|
| 共用檔互相蓋掉 | 所有「讀 → 改 → 整檔重寫」在跨程序鎖(mkdir 原子;逾時拋錯;死鎖自動清) | `unit-lock`(5 程序 × 40 次 = 200 無遺失)、`unit-store`(6 程序併行 putNode) |
| 兩 session 出同一份計畫、重複評估 | 認領(鎖內原子)+ 認領衝突後重新出計畫 | `unit-explore`(真競態注入)、`unit-concurrency`(3 程序 × 2 波:規格不重複評估、各 session 執行節點互斥) |
| 輪號重複、報告互蓋;r1000 起字典序取錯末輪 / 摘要序亂 | `allocateRound` 以 mkdir 非遞迴搶號;輪夾之名與數值序之單一來源 `core/paths.mjs`(`isRoundDir` / `roundNumOf` / `listRoundDirs`;2026-10-09) | `unit-concurrency`(輪號 r003 ~ r008 唯一接續)、`unit-roundId`(r998 ~ r1001 之序、peekRound、取號、摘要序與連續欠額) |
| 子程序總數超過機器上限;建槽者寫 owner 被延遲 > 2 秒 ⇒ 他方判死重取而同持一槽(已觀察某次驗收 peak 5 > 4) | 全域槽位(持有者存活即不回收);**原子建槽**(暫存夾內寫 owner 後 rename 為 `s{i}` ⇒ 槽出現即帶 owner)、釋放 / 回收先移走再刪、回收核對 owner 未變(不同則移回)、輔助夾之殘留依名內 pid 掃除(2026-10-09) | `unit-slots`(跨程序峰值 ≤ max)、`unit-slotsAtomic`(延遲寫 owner 之決定性重現、多程序併搶、回收之核對、殘留)、`unit-concurrency`(spawn 模式三 session 峰值 ≤ 3) |
| 認領者中途死亡 | `reclaimStale`(pid 死或逾時 → stale);評估層整體失敗 → 認領釋放 | `unit-store`、`unit-explore` |
| 兩 session 同時接受不同策略 | `policies` 鎖 + 鎖內確認 current 未變(變則重讀重比,最多 3 次) | `unit-auto` |
| 策略開發請求重複 | 全域標記(TTL)| `unit-auto`(5 輪只寫一份) |
| 被放棄之輪(寫生成請求後死亡)之標記吸收他輪欠額;A 輪兌現時刪掉 B 輪剛寫之標記 | 標記記 pid / 行程啟動時刻 / 輪夾 + 輪次心跳:輪次未完成且持有者已死或心跳停止 ⇒ 失效接手;清除於 `policies` 鎖內且只刪本輪所寫 / 所見之標記(2026-09-29) | `unit-genRequest` |
| 閘門拒絕存根覆寫已執行 / 認領中之節點(策略重提已執行而驗證已收緊之規格) | `putNode(node, { skipIfStatus: OCCUPIED })`(鎖內判)(2026-09-29) | `unit-frontierOutcome` |
| 只經前緣進入之臂評估錯誤後永不重試 | `resolveFrontier`:錯誤維持 proposed 並記 retries,達上限 status blocked(2026-09-29) | `unit-frontierOutcome` |
| 同 tag 重複呼叫 `runJobs`,worker 追加寫出之舊列蓋掉新結果(同 id 換桶 / 換協定) | job 鍵 = id + 規格 + 有效協定:worker 續跑與 runner 讀回皆以鍵比對(2026-09-23 實際踩到) | `unit-worker`(同 tag 兩次呼叫,舊列不污染、不在本次之 id 不出現) |
| runner 工作夾永不清(某領域累積 369 夾 193 MB);讀回結果後、持久化前被殺即無可續 | `keepDir: false` 時由呼叫端於持久化後 `commit()` 才刪(全部 ok ∧ 無他方同 tag 進行中;刪前日誌歸檔);未提交者保留, 逾 `reclaimDays` 日回收(2026-09-29) | `unit-runnerCleanup` |
| 整檔重寫中途被鎖外讀者讀到截斷 / 空檔(index / 節點檔) | `writeFileAtomic`(同目錄暫存檔 + rename;Windows 之 EPERM / EACCES / EBUSY 重試,重試用盡才直寫)(2026-09-24 實測:舊寫法讀者 671 / 5018 次解析錯) | `unit-atomic`(他程序反覆改寫時讀者 0 解析錯、列數恆完整) |
| 只追加之紀錄檔中間一列損壞 ⇒ 全部讀者失敗(單點故障) | `readJsonl(fp, { skipBad: true })`:中間壞列略過並 stderr 一行警示(預設仍拋錯;只給唯讀之消費端)(2026-09-29) | `unit-atomic` |
| 重 job 落同一 worker、他 worker 做完即閒置;爭用時晚到者只拿到少數槽位整批序列跑 | 2026-09-25 起 runner 為**動態佇列**:待辦 job 依 `costOf` 由大到小寫成單一佇列,worker 以 `mkdir(claims/<序>)` 原子認領下一個;**運行中補槽**:每 `expandMs`(5 秒)試取空槽加開 worker(總數 ≤ 所求;全部 worker 已結束即停,壞評估器不無限重開)(原:起跑時靜態輪流分桶且不擴增;某次實例閒置 18 分、另一實例 8 臂單 worker 84 分) | `unit-runnerQueue`(慢 1 快 5 × 2 worker ⇒ 1 / 5,靜態分桶為 3 / 3;3 槽剩 1 ⇒ 釋放後加開至 3) |
| worker 中途崩潰 | 動態佇列下只失去進行中之那個 job(記「worker 無結果」),其餘由他 worker 認領完成(原:同桶之後續 job 全失) | `unit-runnerQueue` |
| 持有者已死之槽位佔位 | 取槽時自動回收;`slotsStatus` / `reclaimDeadSlots` 與 CLI(`node w-recursi/src/core/slots.mjs --status <dir>` / `--reclaim <dir>`)⇒ 查看 / 清理**只動死槽**,不以 `rm` 手刪(手刪會誤刪活槽而超開) | `unit-runnerQueue`、`unit-slots` |
| 領域鉤子鍵名拼錯 ⇒ 靜默失效(套件不讀未知鍵) | 已知鍵單一來源 `core/domainContract.mjs` 之 `DOMAIN_KEYS`;`createRsi` 開機檢查:缺必填 / 型別不符拋錯,未知鍵警告(`strictDomain` 拋錯) | `unit-domainContract`(套件原始碼讀取之 `domain.<鍵>` 全數已登錄、README 表齊全) |
| cfg 鍵名拼錯 ⇒ 靜默失效(如 `dreem` ⇒ 做夢設定不生效) | 已知頂層鍵 `CFG_KEYS`(`index.mjs`;純函式 `checkCfg`):未知鍵警告一次、`strictDomain` 拋錯;有 `cfg.dream` 而未設 `targetLadder` 提示(2026-10-01) | `unit-cfgContract`(套件原始碼讀取之 cfg 頂層鍵全數已登錄) |
| 兩 session 同批各做一次全量做夢(判定讀 scores.jsonl 末列 = 做夢**結束**時刻;每批多 16 ~ 29 分) | `minIntervalMs > 0` 時以槽位租約 `policies/.mtx_dream`(max 1;pid / ISO / token、死者回收)登記進行中:取不到 ⇒「同批進行中」略過;取得後重讀末列;`--accept` 與 `minIntervalMs 0` 不經互斥(2026-10-01) | `unit-dreamGate`(他方持有 ⇒ 略過且不寫分數;持有者已死 ⇒ 回收並做夢、做完釋放) |
| 新區域臂被他 session 先認領、重計畫補不回 ⇒ 仍以第一次計畫記欠 0(生成請求不寫、連續欠額歸零) | `generation.debtAfterClaims`(opt-in):欠額以認領 / 重計畫後之實得計、生成判定於認領之後;summary 另記第一次計畫之值(2026-10-02) | `unit-debtClaims` |
| 認領衝突之重計畫依整份預算重出計畫、新臂全收 ⇒ 實計畫臂數超出預算(某些輪超 2 ~ 4 臂)、各流額比失真;plan.json 之策略備註只有第一次計畫 | `claims.replanFillOnly`(opt-in):只補被他 session 先領之額(`replanFillOf`:依第一次計畫之各流組成補同流, 不足依新計畫之原序);plan.json 另寫 `notesReplans` / `replanFillOnly`、報告列實得之組成、`reportExtra` 第三參數 `{ items, getNode }`(2026-10-02) | `unit-replanFill` |

## 4. 依賴注入契約(`createRsi({ root, domain, budget, claims, dream, policyDev, generation, frontier, turning, slots, runner, maintenance, tmpDir, arms })`)

**臂目錄**(`arms`;2026-11-07 使用端需求:套件須能由外部注入指定多臂, 讓節點 agent 於探索 / 測試 / 計算時自選單臂或多臂去寫程式;`src/search/arms.mjs`):臂 = 探索之「可選方向」之一級概念(原只有 operators / carriers / frontier arm, 臂種與狀態散在 lore / 前緣 / 策略碼 / 派工說明). `cfg.arms = { catalog, defaults?, use?, known? }`(已知鍵 `ARMS_CFG_KEYS`;未知鍵 / 形不合 / 目錄不合 / `use` 被拒 ⇒ **組裝期拋錯**;無目錄 ⇒ `rsi.arms` 為空目錄, 行為與無此功能前逐字同). 目錄為**資料**(JSON 可;他專案換一份即用):`{ layers?: { 代號: 名 }, arms: [{ id, layer, title, desc?, status: done|partial|sparse|proposed|blocked, selectable?(預設非 blocked 即可選), realize: [{ kind: operator|fragment|spec|carrier|generative|manual|origin, op|mech|path|name|module|how|op }](`origin` 只供覆蓋對應:節點 `origin.operator` 為此值者計入, 如全域取樣 / 轉折 / 生成之來源名, 不可限臂), grid?, used?, verdict?, reopen?, blockedBy?(blocked 必填), requires?, conflicts?, n?, refs? }] }`(條目鍵 `ARM_KEYS`, 未知鍵拋錯;`realize` 之算子須在登錄表, 片段 / 生成模組 / 載體之名給了 `known` 才核對). 實例 `rsi.arms`:`validate / get / list / pick(ids, { reopen })`(封鎖、不可選、`defaults.requireReopenFor`(預設 `['done']`)之狀態未附重啟理由、`conflicts`、`requires` 缺 ⇒ 拒)、`restrict(ids)`(本輪只用所選臂之算子與載體)、`compose(ids, parentSpec, { childrenOf, validateSpec, max })`(多臂依序施用產子規格, 去重、過 validateSpec)、`coverage(nodes)`(每臂之節點 / 階 ≥ 1 / 階 ≥ 4, 依 `origin.arms` ∪ `origin.operator`;另 `feature` = 規格含該臂特徵之節點)、`menu({ coverage, statuses, selectable })`(markdown 選單)、`unusedOf(a)`(grid − used = 待探索空間). 接線:`explore` 之 `opt.useArms` / `cfg.arms.use`(選臂被拒 ⇒ 於取輪號前拋 `RSI_ARMS_REJECTED`, 不開輪;計畫項與節點記 `origin.arms`;策略仍可能自行取樣 ⇒ 計畫後濾只留所選臂之算子 / 載體, 略過數記計畫備註「臂限制」;plan.json / summary / 報告記 `useArms`)、`makeCtx(…, { useArms })`(childrenOf / controlsFor / carriers 限所選臂, `ctx.useArms`)、生成請求文加一節「臂目錄之待探索臂」(sparse / proposed 且可選者)、`status` 印覆蓋前 8、CLI `--use-arms <id,…> [--reopen <理由>]` 與 `--mode arms [--out]`. 測試 `unit-arms`(玩具目錄 `test/tools/toyArms.mjs`).

`domain` 之已知鍵、型別與簽名以 `src/core/domainContract.mjs` 之 `DOMAIN_KEYS` 為單一來源(本表由其抄錄;`unit-domainContract` 驗兩者一致,且套件原始碼讀取之 `domain.<鍵>` 全數已登錄).`createRsi` 開機即檢:缺必填或型別不符 ⇒ 拋錯;未知鍵(多為拼錯,套件不讀 ⇒ 該鉤子靜默失效)⇒ 警告(同鍵每程序一次),`cfg.strictDomain = true` 時拋錯.新增鉤子:先登錄 `DOMAIN_KEYS`,再於使用處讀 `domain.<鍵>`,並補本表.

| 鍵 | 型別 | 說明 |
|---|---|---|
| `score` | 函式(**必填**) | `score(raw, node) → { S, ladder, flags:{ vetoed, … }, evaluator, … }`:判讀層,可重算不重跑(`rescoreAll`) |
| `evaluator` | 物件 | `{ mode:'spawn', module:'<abs .mjs>', ctxOpt, protocol, costOf(job) }`(模組匯出 `createContext(ctxOpt)`、`evaluate(spec, ctx, protocol)`、可選 `meta(ctx)` / `dispose(ctx)`)或 `{ mode:'inProcess', evaluate, createContext, ctxOpt, protocol }`;`costOf` 供 runner 大者先入佇列;`explore` 才需要 |
| `evaluatorVersion` | 數字 / 字串 | 評估器版本(`status` 顯示) |
| `name` | 字串 | 領域名稱 |
| `validateSpec` | 函式 | `validateSpec(spec)`:拋錯即無效 |
| `summarize` | 函式 | `summarize(spec) → 字串` |
| `carrierOf` | 函式 | `carrierOf(spec) → 分組標籤` |
| `envHash` | 函式 | `envHash(spec) → 節點 id 之環境雜湊` |
| `operators` | 陣列 | `[{ name, family, applies(spec), children(spec) → [{ spec, params, reason }], controls?:[算子名], rank? }]` |
| `familyRank` | 物件 | `{ family: rank }`(策略展開順位) |
| `carriers` | 物件 / 函式 | `{ name: spec }` 或 `() => ({ name: spec })`(函式每次出計畫時求值;非物件回傳視為無載體) |
| `fingerprint` | 函式 | `fingerprint(raw, node)`:行為指紋 → 別名(規格不同而行為相同者不再展開、不重複後續處理) |
| `aliasShortOf` | 函式 | `aliasShortOf(node) → { of, what? } \| null`:評估器是否因本臂原料指紋 = 某父(`cfg.aliasPre` 之提示)而略過部分計算;`summary.nAliasShort` 與報告「行為別名短路」計之(`what` 為報告用語;未給 ⇒ 0)。2026-10-01 起引擎不再讀領域原料之欄位(原寫死讀領域原料之固定欄位, 已移為領域之鉤子) |
| `isAnchor` | 函式 | `isAnchor(node)`:如基準節點,不作別名亦不作正本 |
| `excludeParent` | 函式 | `excludeParent(view)`:不作父節點 |
| `mask` | 函式 | `mask(score, node)`:策略視圖(遮蔽) |
| `maskNode` | 函式 | `maskNode(view, node) → view`:策略視圖之節點層遮蔽 / 附加(於 `mask` 之後;如移除可能含窗外資訊之 `evidence` / `notes`、加領域標記;2026-09-27) |
| `ctxExtra` | 函式 | `ctxExtra({ executed, views, lineage }) → 物件`:併入策略之 `ctx`(如全域取樣器 `sampleGlobal(n, opt)`、規格判定;不得覆寫引擎之鍵;2026-09-27) |
| `turningParentOk` | 函式 | `turningParentOk(view) → bool`:轉折點提取之父 / 有效邊之子之領域條件(如只取某類節點;2026-09-27;引擎不再以 `score.flags.vetoed` 篩) |
| `normSpec` | 函式 | `normSpec(spec) → spec`:規格之正規形 —— 轉折點提取之提案先正規化再判占用 / 去重 / `validateSpec`(如某哨兵值一律歸一;未給時不正規化;2026-09-30) |
| `proposalBlock` | 函式 | `proposalBlock(spec, ctx) → 擋下理由 或 null`:轉折點提取之三種提案(搬移 / 外推 / 交叉)共用之產生端守門,於 `normSpec` / 占用 / `validateSpec` 之後呼叫;`ctx = { op, origin, byId, parent?, parents, kidOp? }`(`parent`:搬移 = 目標父、外推 = 邊之子;`kidOp` = 邊之算子);擋下者入回傳之 `blocked`(`by: 'proposalBlock'`,另回 `nProposalBlocked`)、不入去重集;未給時逐字不變(2026-10-04) |
| `forbidden` | 陣列 | `[regex]`:策略碼靜態檢查(套件另擋 child_process / 樹寫入 / 暫存;範圍 = 策略檔 + 其相對匯入閉包) |
| `gates` | 物件 | `{ pre(spec, { view }) → { ok, why }, post(node) → { ok, why } }` |
| `excludeArm` | 函式 | `excludeArm(spec, ctx) → { exclude, why? } 或 null`:生成端之臂排除(`explore` 出計畫時, 於 `validateSpec` 與 `gates.pre` 之後;如領域已結案之臂 —— 再評估無新資訊);`ctx = { id, spec, specHash, parent, kindOf, op, origin: { topic, operator, controlOf, … }, round, item }`(節點形, 可直接交領域之對照臂判定;`item` = 計畫項之 `op` / `controlOf` / `kindOf` / `parentId` / `reason` / `origin`);`exclude === true` ⇒ 入計畫之 `rejected`(`excluded: true`;`why` 缺 ⇒ `excludeArm`)、寫拒絕存根(`notes.excluded`, 已占用 ⇒ 策略不再提;要重開以 `invalidate`)、前緣結案 `rejectedByGate`、本輪重計畫不再提;拋錯 ⇒ 不排除並記計畫備註;未給 ⇒ 逐字不變;做夢重放不經此鉤子(同 `gates.pre`)(2026-10-09) |
| `hooks` | 物件 | `{ afterRound({ rsi, round, fd, nodes, … }) → { lines } }`(如自動衍生處理) |
| `childBlock` | 函式 | `childBlock({ op, params, parent, child, byId }) → 擋下理由 或 null`:策略展開之參數型子臂前過濾(`makeCtx(executed, views, lineage?)` 給出視圖時生效;擋下者記 `ctx.blockedChildren`);`byId` = 譜系 Map(id → 視圖;由 `lineage` 建, 省略則由 `views` 建, 惰性一次;2026-09-25 起, 供「同一改動已於父之父大跌」一類之譜系判定);`explore` 傳全樹視圖(含別名)、做夢重放傳可見節點(含別名)為 lineage;**以規格為單位**(2026-09-25):計畫以 specHash 去重、同一規格可經多條路徑(兩改動可交換), 故視圖內任一父之路徑擋下某子規格, 經他父展開亦不出(記錄沿用擋下路徑之父 / 算子 / 理由;首次展開時預掃視圖內全部父一次) |
| `transferBlock` | 函式 | `transferBlock({ op, params, from, child, to, spec, byId }) → 擋下理由 或 null`:轉折點搬移提案前過濾(`byId` = 已執行節點 Map) |
| `costOf` | 函式 | `costOf(spec)`:做夢重放之成本估算(未給時用預設) |
| `reportColumns` | 陣列 | `[{ header, of(node) }]`:輪次報告之欄 |
| `reportExtra` | 函式 | `reportExtra(nodes, plan, { items, getNode }) → [lines]`(第三參數 2026-10-02 起:items = 本 session 實得之計畫項, 含認領衝突之重計畫, 無則 null;getNode(id) → 節點或 null) |
| `indexExtra` | 函式 | `indexExtra(node)`:index 列之附加欄 |
| `policyDevText` | 函式 | `policyDevText({ why })`:策略開發請求之文字 |
| `generationText` | 函式 | `generationText({ base, debt, streak })`:生成請求之文字 |

**cfg 之非 domain 選項**(2026-09-29 所加者皆 opt-in,未設 = 舊行為):`runner = { keepDir(預設 true;false ⇒ runJobs 之 commit() 刪工作夾), logDir(刪夾前歸檔 worker 日誌), reclaimDays(keepDir false 時回收逾期未動之 tag 夾, 預設 7) }`;runJobs 之 `retryFailed`(2026-10-02;預設 false):同 tag 續跑時重算失敗列(讀回以 ok 列為準);`maintenance: () → 理由字串 | null`(維護中 ⇒ 做夢只印不寫 `scores.jsonl`、`--accept` 不升版);`dream.minIntervalMs`(0 = 每輪);`generation.heartbeatMs` / `heartbeatStaleMs`;`claims.replanFillOnly`(2026-10-02):認領衝突之重計畫只補被他 session 先領之額(依第一次計畫之各流(kindOf)組成補同流, 不足依新計畫之原序;純函式 `replanFillOf`), 未設 ⇒ 新計畫之臂全收(實計畫臂數可超出預算);有重計畫之輪 plan.json 另寫 `notesReplans`(各次重計畫之策略備註)與 `replanFillOnly`;`generation.debtAfterClaims`(2026-10-02;預設 false = 舊行為):真 ⇒ 新區域欠額以認領 / 重計畫後實際認領之臂計「得」、生成判定(請求 / streak)移至認領之後, `summary.noveltyDebtPlan` 與報告另記第一次計畫之值(乾跑恆為計畫值;見 §2b);`frontier.maxRetries`(預設 2);`aliasPre: true` ⇒ 帶父之臂(計畫項之 `parentId`(≠ root)、`parents`、轉折點提取之 `origin.from` 全部來源節點)之 job 協定附 `aliasPre: { fps: [{ id, fp }] }`(`fp = domain.fingerprint(父.raw, 父)`, null 者略過),供領域評估器於本臂評估後判「行為別名」而略過虛無(逐位精確之指紋相等, 非抽樣);`summary.nAliasShort` 與報告「行為別名短路 N」計領域鉤子 `domain.aliasShortOf(node)` 為真者(2026-09-29;2026-10-01 起由鉤子判, 原寫死讀領域原料之固定欄位).**2026-10-01 起**:`evidenceKeys`(陣列 ⇒ CLI 之 evidence 只收所列之證據鍵);已知頂層鍵 = `CFG_KEYS`(未知鍵警告一次、`strictDomain` 拋錯;純函式 `checkCfg`);`dream.targetLadder` 由領域明設(引擎預設 3 為玩具領域之值, 階梯之意義由領域定;有 `cfg.dream` 而未設即提示).**階梯之語義**(契約,`DOMAIN_KEYS.score`):序數,≥ 1 = 通過領域之第一道真偽 —— 引擎據以計 `summary.ladderGe1` 與策略開發之停滯判定(連續兩輪無 ladder ≥ 1);`flags.vetoed` = 否決(不入做夢之目標).

策略介面(與 `policies/v0.mjs` 相同,既有策略可直接沿用):`policy(view, budget, ctx) → { expand, novelty, global?, requests, stop, notes }`,`budget = { arms, novelty, global, workers }`,`ctx = { childrenOf, controlsFor, rankOf, carriers, specHash, executed:Set, excludeParent, blockedChildren, …domain.ctxExtra }`.**`global`**(2026-09-27):全域取樣臂(根節點;`explore` 以 `kindOf 'global'` 入計畫)—— 與 `novelty` 分列, **不計入新區域欠額**(生成請求照常觸發).做夢(`sim/replay.mjs`)讀策略視圖之分數 / 階梯;視圖有 `score.cell` 時品質項為各格之最高 S 之和(QD);`defaultReplays: 'visibleMedian'` 以可見節點之成本中位記樹外臂;`minGlobal > 0` 時未達之候選不得升版(探索保底);別名表於一次做夢內求一次、全部策略與切分共用(`opt.aliasMap`,2026-09-29).

實例 API:`init()`(`current.mjs` 缺時建之;**不覆寫既有之 `v0.mjs`**,2026-09-29)、`explore(opt)`、`dream({ accept })`、`auto(opt)`、`status()`、`setEvidence(id, set, { ref, note })`、`rescoreAll()`、`invalidate(ids, why)`、`clearGenRequest({ round })`、`store.*`(`putNode / claimNodes / reclaimStale / pushFrontier / resolveFrontier / appendLore …`)、`idOf(spec)`、`aliasMap()`.

CLI:`node w-recursi/src/cli.mjs --config <cfg.mjs> --mode init|status|explore|dream|auto|reclaim|rescore|evidence|invalidate|turning [--arms --novelty --workers --dry --accept --rounds --no-dream --by …]`;evidence 之證據鍵以 `--set k=v,…` 給(`cfg.evidenceKeys` 有宣告時只收所列之鍵;`--mech / --usability / --btcOK` 為別名;2026-10-01).**統一解析器之通用參數 `--args-file <json>`**(`core/cli.mjs`,凡經 `parseCli` 之 CLI 皆可;2026-10-01):以 JSON 物件給參數(鍵 = 選項名或模式鍵)⇒ 免 shell 引號之包裝;與命令列同鍵 ⇒ 拒、未知鍵 ⇒ 拒、值走同一驗證.**用途界線**:領域另有 CLI 者**輪次一律經領域 CLI**(如領域 CLI 之 `auto` 之後另重產清單 / 總表、可設旗標、worker 上限較嚴;同名模式之語義以領域 CLI 為準);本 CLI 供玩具領域 / 測試,以及 init / status / rescore / evidence / invalidate / reclaim / turning 之通用維運.

槽位工具:`node w-recursi/src/core/slots.mjs --status <slotsDir> [--max N]`(各槽持有者 pid / 取得時刻 / 存活 / 逾時)、`--reclaim <slotsDir>`(只回收持有者已死或逾時之槽;活槽不動);**未帶 `--max` ⇒ `maxOfDir`**(取槽時記於 `<slotsDir>/.max` 之上限、現存最大槽號 + 1、8 之大者;2026-09-25 起, 原固定印 8 ⇒ 上限 10 之領域看不到 s8 / s9).程式介面 `tryAcquireSlots(dir, { want, max, staleMs })`(不等待)、`slotsStatus`、`reclaimDeadSlots`、`maxOfDir`.持有者檔 `owner` 須為「正整數 pid + 完整 ISO 時間」才算數, 空檔 / 半寫視同尚未寫(建槽之 2 秒寬限內不回收;2026-09-25 修同槽雙持有之競態, 見 `unit-slots`).**原子建槽**(2026-10-09;已觀察之上限違反 peak 5 > 4):新碼之槽於出現時即帶 owner —— 先於同夾建 `s{i}.tmp-<pid>.…` 寫 owner, 再 rename 為 `s{i}`(目標已存在 ⇒ Windows 一律 EPERM、POSIX 非空夾 ENOTEMPTY ⇒ 只有一方取得;目標不在而暫時被開啟 ⇒ 短重試);2 秒寬限只對舊形(無 owner 之 `s{i}`:舊碼之槽 / 刪到一半);釋放 / 回收先 rename 為 `.rel-` / `.dead-` 再刪(回收另核對 owner 未變, 不同則移回);輔助夾之殘留依名內 pid 已死掃除(不依時間), `slotAuxOf(dir)` 列之, CLI `--status` 另印一行.

**公開面**(2026-10-01):套件入口只有二 ——
- `w-recursi/src/index.mjs`:引擎 API(`createRsi`、`runJobs` / `jobKey`、`simulate` / `accept`、`STATUS`、`specDiff` …).
- `w-recursi/src/protocol.mjs`:**協定件** = 引擎與領域共用同一批檔案與鎖時必須同格式之讀寫件 —— jsonl(原子寫 / 逐列讀)、鎖、槽位(租約:pid / ISO 時刻 / token、半寫寬限、死者回收)、持有者列、規格雜湊與節點 id 公式(凍結契約);輪夾之名與數值序(`isRoundDir` / `roundNumOf` / `roundNameOf` / `listRoundDirs` / `ROUND_NAME_SRC`)、鉤子失敗之結果形(`hookFailureOf` / `HOOK_FAIL_HEAD`)、寫域守門(`assertWriteRoot` / `writeAllowed` / `writeRootsOf`:環境變數 `RSI_WRITE_ROOT`(一或多根, 以 `path.delimiter` 分隔)有值 ⇒ jsonl 原語與引擎之輪夾 / 報告 / 請求 / 升版 / init 之寫入於根外拋 `ERSI_WRITE_ROOT`;未設 ⇒ 不檢;槽位 / 鎖之 owner 與 job 暫存不守 —— 預寫沙箱之防誤寫)(2026-10-09);另暫附 cli 統一解析器(非協定, 抽提時可能分出;`parseCli` 回傳另有 `given` = 明給之鍵, 命令列與 `--args-file` 皆算, 2026-10-09).只轉匯出、無副作用、不載引擎 index(實測 index 約 0.2 秒、本入口數毫秒)⇒ 輕量 CLI 由此取.
- `package.json` **不設 `exports` / `files` / `type`**(自有套件慣例:下游可深層匯入 `src/**`;兩入口以路徑取 `w-recursi/src/index.mjs` / `w-recursi/src/protocol.mjs`).`main` 指 rollup 產出之 `dist/w-recursi.umd.js`(來源為聚合入口 `src/WRecursi.mjs`:預設匯出 index 之全部 API + `protocol` 一組, 不放邏輯;`require('w-recursi')` 得此物件;dist 之限制見 `sgud/state/state.md`).匯出名快照在 `test/unit-protocol.test.mjs`(改匯出 ⇒ 同步改快照與本段;PR04 核深層匯入 / `WRecursi` 與兩入口同一實例, dist 存在時另核其鍵集合與型別).

## 5. 狀態根目錄佈局(凍結契約:領域與引擎共用同一佈局,可互換)

```
<root>/tree/nodes/{id}.json.gz  index.jsonl  frontier.jsonl  lore.jsonl  .lock_*  .slots/
<root>/rounds/r{nnn}/plan.json  summary.json  report.md  [POLICY_DEV_REQUEST.md]  [GENERATION_REQUEST.md]  [.alive.json(探索期間之心跳, 完成即刪)]
<root>/policies/current.mjs  v{n}.mjs  candidates/*.mjs  scores.jsonl  changelog.md  .dev_request.json  .gen_request.json
<tmpDir>/jobs/<tag>/  (runner 工作夾;tmpDir 未給 ⇒ <root>/tmp;領域另設 tmpDir 時 ⇒ <tmpDir>/jobs/<tag>)
<logDir>/<tag>.log    (runner.logDir 有給時:提交 / 回收刪夾前之 worker 日誌;如 <tmpDir>/jobs/_logs)
```

runner 工作夾之生命週期(2026-09-29):`queue_<run>.json` / `claims_<run>/` / `out_w<i>.jsonl` / `w<i>.log` / 進行中標記 `.active_<pid>_<亂碼>`;`keepDir: false` 時呼叫端於結果持久化後呼叫 `runJobs` 回傳之 `commit()` 才刪(全部 job ok 讀回且無他方同 tag 進行中;否則保留供診斷與同 tag 續跑);未提交者(中斷 / 失敗 / 呼叫端未接)保留,**逾 `reclaimDays` 日未動且無存活標記者於該程序首次派工時回收**(`reclaimJobDirs(fdJobs, { days, logDir })` 亦可單獨呼叫,如維護窗清理舊佈局).`explore` 於入樹後自動提交.**worker 日誌**(含「抽驗不符」一類之警示):進行中或未提交者在 `<tag>/w*.log`,已提交者在 `<logDir>/<tag>.log`.

節點狀態:`planned`(已認領)→ `executed` | `error`;`rejectedByGate`;`invalid`;`stale`.已占用(策略不再提)= executed / rejectedByGate / planned / running;error / stale / invalid 可重提.前緣條目之 status:`proposed` → `executed` | `rejectedByGate` | `blocked`(評估錯誤達重試上限;與 kind `blocked` 之裁示封鎖不同)| 生成代理認領之 `implementing` / `implemented` / `stopped`.

## 6. 測試(`npm test`;mocha,`test/unit-*.test.mjs`,暫存 `test/_tmp/` 各案自刪)

玩具領域 `test/tools/toy.mjs`:二維整數格點,訓練期為有確定性雜訊之凹面(最佳 (3,−5)),留出期(backtest)最佳點不同以製造否決;`tag` 為無效變異(供別名);`cond` 為兩分支複合(供對照臂:對調 / 恆用單分支);可設 `delayMs`(模擬耗時)、`failIf`(模擬失敗)、`logFile`(記錄每次評估區間供併行驗證).

| 檔 | 驗什麼 |
|---|---|
| `unit-canonical` | 正規化、雜湊、id 與領域既有公式相容(領域端宜自備對拍測試) |
| `unit-lock` / `unit-slots` | 多程序鎖無遺失;槽位跨程序峰值 ≤ max;逾時 / 死鎖 / 死行程回收;owner 空檔 / 每個截斷位置之半寫皆不回收(寬限後才回收);上限記錄 `.max` 與 CLI 據之顯示 / 回收 |
| `unit-store` | 覆寫、反向連結、認領 / 跳過 / 釋放 / 回收、前緣、lore、併行寫入 |
| `unit-operators` / `unit-policy` | 算子閉包與對照臂;策略預算(對照整族)、不重提、每父上限、譜系停止、別名不作父、決定性、新區域 |
| `unit-view` | 遮蔽、靜態檢查、別名(全樹判定) |
| `unit-replay` | 揭露 / 未知 / 成本會計、時間切分、時間切分不外洩未來(視圖 `children` 只含可見節點;2026-09-23 補)、回溯、接受規則 |
| `unit-explore` | 乾跑、落地、前緣拒絕、評估失敗、後置閘、整體失敗釋放認領、真競態重新出計畫、遺留回收 |
| `unit-worker` | 子程序評估與同程序一致、續跑、模組錯誤 |
| `unit-concurrency` | 3 session 併行:輪號唯一、規格不重複、樹一致;spawn + 全域槽位峰值 ≤ 3 |
| `unit-auto` | 每輪做夢快照、請求全域一份、`everyRound` / `minIntervalMs`、接受升版與拒絕、候選靜態檢查 |
| `unit-cli` | 真實呼叫端(CLI)之 init / explore / auto / status / dream / evidence / invalidate / reclaim;evidence 之 `--set k=v` 與別名同效、未宣告於 `cfg.evidenceKeys` 之鍵 / 格式錯 / 同鍵重複 ⇒ exit 2 且未寫(2026-10-01) |
| `unit-cliArgsFile` | `--args-file`(2026-10-01):檔內之鍵與命令列同效(型別、清單陣列、旗標、模式鍵;字串之引號 / 反引號 / 前導減號原樣);與命令列同鍵、未知鍵、重複給檔 ⇒ 拒;值錯走同一驗證;檔缺 / 非 JSON / 非物件 ⇒ 拒 |
| `unit-cfgContract` | cfg 契約(2026-10-01):套件原始碼讀取之 cfg 頂層鍵全數登錄於 `CFG_KEYS`;`checkCfg` 之未知鍵 / targetLadder 提示 / evidenceKeys 型別;`createRsi` 未知鍵警告一次、`strictDomain` 拋錯 |
| `unit-stress` | 12 輪 × 12 臂:≥ 80 節點、無重複、最佳 S 爬升、單輪與做夢秒級 |
| `unit-turning` | specDiff / applyDiff;搬移 / 外推(越界被擋)/ 交叉(同路徑不合併、去重);占用 / 別名 / 否決 / 排除來源;整合(前緣出現 turning 臂並被取用);欠額 → 生成請求全域一份 → 生成節點入樹後清除;冷啟動不算欠額 |
| `unit-proposalBlock` | 三種提案之產生端守門(2026-10-04;`opt.proposalBlock`):未給 / 回 null ⇒ 提案與回傳逐字同舊版(無 `nProposalBlocked`);搬移 / 外推 / 交叉三分支皆呼叫且 ctx 之 `op` / `origin` / `byId` / `parent` / `parents` / `kidOp` 正確;擋下者入 `blocked`(`by: 'proposalBlock'`)、不入去重集(他路徑之同規格再判)、已占用 / 不合法者不問鉤子;報告分列兩種擋下(無守門之列時與舊版逐字同);`createRsi().turning` 與 `explore` 皆傳 `domain.proposalBlock` |
| `unit-genStreak` | 早退之連續欠額(2026-10-04;`loop/generation.mjs`):有效標記 + 本輪欠 ⇒ 回傳之 `streak` = `debtStreakOf(sums)`、標記之 `at` / `round` / `pid` 不變而 `debt` / `streak` 更新、達門檻 `escalate` 且報告有升級行;無標記 ⇒ 寫檔內容與舊版逐字同;`clearGenRequest` 之 `seen` 判定不受 streak 更新影響 |
| `unit-atomic` | 原子寫檔:內容完整、可覆寫、不留暫存檔;他程序反覆改寫時鎖外讀者 0 解析錯;`readJsonl` 之 `skipBad`(中間壞列略過 + stderr 警示;預設仍拋錯) |
| `unit-childBlock` | 展開鉤子:未給鉤子 / 未傳視圖時逐字不變;擋下之子不回傳並記 `blockedChildren`;鉤子拋錯視同不擋;explore 與做夢重放皆生效;譜系 `byId`(給 lineage 以之建、否則以 views 建, 同一 ctx 共用;重放傳 lineage ⊇ views);規格級(同一子規格經兩父可達、只在其一路徑被擋 ⇒ 兩路徑皆不出, 同一列只記一次) |
| `unit-replayAlias` | 做夢重放之別名揭露:正本已可見 ⇒ 只記成本(duplicates);正本未可見 ⇒ 以正本計揭露;回溯目標不含別名 |
| `unit-runnerQueue` | 動態派工:佇列認領(慢 1 快 5 ⇒ 1 / 5)、運行中補槽加開、崩潰隔離、壞評估器不無限重開、續跑不開 worker、槽位工具(不等待取槽 / 死槽回收 / 狀態) |
| `unit-domainContract` | 領域介面:原始碼讀取之鍵全數登錄、README 表齊全、缺必填 / 型別不符拋錯、未知鍵警告一次、`strictDomain` 拋錯 |
| `unit-genRequest` | 生成請求標記(2026-09-29):新標記記 pid / 行程啟動時刻 / 輪夾;活標記照舊吸收欠額;死亡標記(pid 已死 ∧ 輪夾無 summary / DONE)被接手;完成之輪之標記不失效;pid 存活而心跳停止 / 心跳行程不符 ⇒ 失效;他輪於本輪計畫後寫之標記不被本輪清除;作廢用 `clearGenRequest({ round })` 只刪該輪 |
| `unit-frontierOutcome` | 前緣結案與拒絕存根(2026-09-29):評估錯誤之前緣臂維持 proposed、retries 遞增、第 2 次 blocked;後閘 / 前閘拒絕 ⇒ rejectedByGate;閘門拒絕存根不覆寫已執行節點;`putNode` 之 `skipIfStatus` |
| `unit-policyLoad` | 策略載入與觸發(2026-09-29):轉匯出目標之靜態檢查(含鏈、環、缺檔、註解列);changelog 之末次改版時刻只取列首 ISO;`init` 不覆寫既有 v0.mjs |
| `unit-dreamGate` | 做夢(2026-09-29):維護中不寫 scores.jsonl 且不升版;`minIntervalMs` 略過(報告「略過:同批已做」)、`--accept` 不略過;別名表一次做夢只算一次且分數逐位不變;auto 回傳各段牆鐘;同批互斥(2026-10-01):他方持租約 ⇒「同批進行中」且不寫分數、`--accept` 與 `minIntervalMs 0` 不經互斥、持有者已死 ⇒ 回收並做夢、做完釋放 |
| `unit-autoDeadline` | 輪之截止點(2026-10-09):`deadlineAt` 未給 ⇒ 舊行為(做夢照做、鉤子之參數無 `deadlineAt`、不呼叫 `mayStart`);已過 ⇒ 略過「輪截止點」(報告照現形、不寫分數、鉤子收 `deadlineAt`);注入之 `mayStart` 為準(臨界 / 遠);「--no-dream / 同批已做 / 同批進行中」不判截止點;`--accept` 亦受之;`deadlineAt` 非數 ⇒ 探索前拋錯 |
| `unit-runnerCleanup` | runner 工作夾(2026-09-29):預設保留;`keepDir: false` 須 `commit()` 才刪(日誌歸檔);有失敗保留;同 tag 併行由最後提交者清;逾期回收只動 runner 夾;explore 入樹後自動提交 |
| `unit-runnerRetry` | 續跑之失敗列(2026-10-02):預設失敗列視為已完成(舊行為);`retryFailed: true` 只重算失敗之 job、讀回以 ok 列為準 |
| `unit-runnerSpawnHide` | 起子行程隱藏視窗(2026-11-10;使用端 Gitea #127):spawn 模式每個 worker 之 `spawn` 選項皆含 `windowsHide: true` 且 job 照常完成;`src/`、`test/`、`toolg/` 內每一處起子行程之呼叫(`spawn`、`spawnSync`、`exec*`、`fork`)皆含 `windowsHide: true`(附盤點器自檢) |
| `unit-structural` | 做夢之結構保底(2026-10-02;sim/replay.mjs ⑥):`cfg.dream.structural(plan, { view, round })` → 違規數;違規(或拋錯)之重放輪計 structuralShort、evaluatePolicy 彙總、accept 與 dream 之升版皆拒、scores.jsonl 記之;未給 ⇒ 舊行為 |
| `unit-roundPlanned` | 重計畫之 `ctx.roundPlanned`(2026-10-02;loop/explore.mjs):首次出計畫為 [];認領衝突後之重計畫收到本 session 本輪已認領之臂(策略之每輪上限可承接);不讀者行為不變 |
| `unit-replanFill` | 認領衝突之重計畫只補被先領之額(2026-10-02;`cfg.claims.replanFillOnly`):純函式 `replanFillOf`(先補各流之缺、再依原序補足、總數已足 ⇒ []、新臂不足 ⇒ 全收);固定策略之真競態(第一次計畫 = 新區域 2 + 全域 4, 他 session 先領 2 全域臂)⇒ opt 開:實得 6(= 第一次計畫之臂數)且補回全域(依原序會補新區域)、plan.json 之 `notesReplans` 與 `replanFillOnly`、報告之重計畫行;opt 關:新臂全收(實得 8 > 預算);`reportExtra` 之第三參數(items = 實得、getNode)於 explore 與 auto 之重繪皆傳;無重計畫之輪 plan.json 無 `notesReplans` |
| `unit-debtClaims` | 新區域欠額於認領之後計(2026-10-02;`cfg.generation.debtAfterClaims`):兩 session 真競態 —— 第一次計畫之新區域 2 臂於認領前被他 session 領走、重計畫補不回(前緣臂已占用、載體皆已入樹)⇒ opt 開:`noveltyDebt` 2(= need)、`noveltyDebtPlan` 0、認領後寫生成請求且 streak 承接(下一輪達 3 輪之升級文字);opt 關(預設):欠 0、summary 無 `noveltyDebtPlan`、不寫請求、streak 歸零(舊行為);對稱:重計畫補得回(前緣另有臂)⇒ opt 開亦欠 0;新區域臂被閘門拒絕 ⇒ opt 開計為未填(欠 1)、opt 關仍計得;乾跑恆為計畫值;`noveltyDebtOf` 之 items 與計畫同一定義(全域臂不計) |
| `unit-protocol` | 公開面(2026-10-01):index / protocol 之匯出名快照;`package.json` 之 name = `w-recursi`、不設 `exports` / `files` / `type`、`main` 指 dist UMD、聚合入口存在、src 實用之外部套件皆已宣告於 `dependencies`;深層匯入 / `WRecursi` 與兩入口為同一模組實例(dist 存在時另核);protocol 入口只有轉匯出列 |
| `unit-aliasPreJob` | 父指紋提示(2026-09-29):`parentIdsOf`(parentId / parents / origin.from, 去 root 去重)、`aliasPreOf`(指紋 null 者略過、全無則不附);`cfg.aliasPre` 時展開臂之 job 協定附 `aliasPre.fps`(新區域不附;預設不附);`summary.nAliasShort` 與報告之「行為別名短路」(2026-10-01 起由領域鉤子 `aliasShortOf` 判, 報告用語取其 `what`;未給鉤子 ⇒ 計 0、用語中性);0 回放之節點於做夢之成本為 0(不再成字串 / NaN) |
| `unit-roundId` | 輪夾之名與數值序(2026-10-09):`isRoundDir` 只收正規名(前導零 / r000 / 非法名拒)、與 `roundNameOf` 之雙射(1 ~ 12,000 與 3 ~ 5 位之全部字串)、`listRoundDirs` / `roundDirs` 依輪號升冪(r998 < r999 < r1000 < r1001)、`peekRound` / `allocateRound` 跨 r1000、`loadSummaries` 之序與連續欠額 / 策略開發之「最近兩輪」 |
| `unit-slotsAtomic` | 原子建槽(2026-10-09):同程序注入「寫 owner 前之延遲」⇒ 他方不可同持(改前 2 > 1);真程序延遲寫 owner 之決定性重現(峰值 ≤ max);多程序 × 多輪併搶(峰值 ≤ max、皆 exit 0);回收之核對(判死後被重取 ⇒ 移回);死槽 / 舊形回收;輔助夾依 pid 掃除(不依時間);CLI 之輔助夾行 |
| `unit-cliGiven` | `parseCli` 之明給之鍵 `given`(2026-10-09):命令列(長名 / 短名 / `--k=v` / 旗標)與 `--args-file` 皆算、預設不算、模式鍵居首、依 spec 之序;`values` 不變 |
| `unit-writeRoot` | 寫域守門(2026-10-09):未設 ⇒ 不檢;根內可寫、根外拋(訊息含目標與根、`ERSI_WRITE_ROOT`、不留暫存檔);`..` 穿越、同前綴兄弟夾、junction 指出根外皆擋;多根;Windows 不分大小寫;引擎之輪夾 / 報告 / 請求 / 升版 / init 之寫皆守 |
| `unit-excludeArm` | 生成端之臂排除(2026-10-09;`domain.excludeArm`):未給 ⇒ 計畫 / plan.json 逐字同;排除者入 `rejected`(`excluded`)、寫拒絕存根(`notes.excluded`)、不評估、前緣 `rejectedByGate`、重計畫與下一輪不再提;`ctx` 之欄;拋錯 ⇒ 不排除並記備註 |
| `unit-hookResult` | 鉤子失敗之結果形(2026-10-09):`hookFailureOf` 之形與 auto 之 `hook` 欄 / 報告節同一來源 |
| `unit-arms` | 臂目錄(2026-11-07;§4):目錄檢查之每一類錯誤;`pick` 之拒 / 放行 / 衝突 / 依賴;`explore` 之 `useArms`(計畫只含所選臂、`origin.arms`、plan.json / summary / 報告、`cfg.arms.use` 預設、被拒不開輪;無 useArms 與無目錄者逐欄同);`compose` 之去重與 path;`coverage` 兩口徑與 `menu`;CLI `--mode arms` / `--use-arms` / 封鎖 ⇒ exit 2 不寫檔;cfg 契約(`CFG_KEYS` 含 arms、未知鍵拋錯) |
| `unit-genEmbed` | 生成請求早退分支內嵌現行文(2026-10-04;`earlyEmbedOf`):`requestBaseOf` 為改前寫新請求之底稿、`requestMustOf` 取「本輪必須做的事」段;早退 + 未升級 + 領域未改寫該段 ⇒ 無 embed 且報告與改前逐字同;早退 + 升級 ⇒ embed 為一般段、報告改指內嵌段(引用區塊);早退 + 領域改寫(玩具飽和模式)⇒ 內嵌領域之段、不寫任何輪夾、標記只更新 debt / streak;領域文字拋錯 ⇒ `embed.error`(不拋);explore 整合 |
| `unit-replayCarrier` | 做夢重放之載體時間切分(2026-09-25):`ctx.carriers` 由領域自現存工件推導、不依時間切分;由搜尋所得(`origin.topic` 非 carrier)而於切分時尚不可見之節點,其規格不提供(否則提前揭露未來之發現);carrier 起源之節點與不在樹上之規格照常提供 |
| `unit-package` | 套件結構與發布面:`package.json`(scripts / 欄位 / 不設 exports、files、type)、無 `.npmignore`、根目錄範本檔與 `toolg/`、深層路徑穩定、依賴對帳與 `lodash-es` 按需引入、`gDistRollup` 之 external 一致、`npm pack --dry-run` 打包清單、`g.mjs` 輸出與 README Example、README §6 與 `test/` 一致、JSDoc 覆蓋與全部 `@example` 實跑、發布內容去識別 |

## 7. 接回領域(示例)

領域以依賴注入接上本套件.領域端之程式只經**兩個接縫**取用本套件(守門測試宜掃靜態 import / 再匯出 / 副作用匯入 / 動態 `import()` / 以路徑組 URL 四種寫法,確保領域碼取本套件一律經此;套件換來源或改版時只改此兩檔):

```js
//領域端 lib/engineApi.mjs:引擎 API 之接縫(無副作用;閉包不含領域他檔)
export * from 'w-recursi/src/index.mjs'
```

```js
//領域端 lib/engineProtocol.mjs:協定件之接縫(輕量 CLI 由此取,不載引擎 index)
export * from 'w-recursi/src/protocol.mjs'
```

- **主入口(實例)**:領域端單例 `inst = createRsi(cfg).init()`(`createRsi` 經 engineApi 接縫;`cfg` 由領域模組之 `makeCfg()` 給出).
- **領域模組(`domain`)**:領域注入定義(規格 / 算子 / 載體 / 判讀 / 指紋 / 遮蔽 / 報告欄 / 自動衍生處理之鉤子 / 策略開發文字)與 `makeCfg()`(`tmpDir`、`runner` 清理、`dream.minIntervalMs`、`maintenance` 等 cfg 選項).鉤子之已知鍵與簽名見 §4.
- **薄封裝**:領域端若已有既定介面名(鎖、節點、指紋、worker、CLI 解析、重放、樹儲存),可保留原名,內部一律經接縫轉呼叫本套件.
- **領域 CLI**:領域自己之 CLI(`status` / `explore` / `dream` / `auto` 及領域專屬模式)為**輪次入口**;另提供一份設定檔(default 匯出 `createRsi` 之 cfg 物件)供本套件 CLI(`node w-recursi/src/cli.mjs --config <cfg.mjs>`)共用同一設定,只作通用維運(用途界線見 §4).
- **切換驗證**:接上前後 `status` 與 `explore --dry` 逐臂一致;真實引擎單筆評估與樹上節點逐位相同;多 agent 併行實跑無重複評估、輪號唯一、槽位不超限(§3 各列之測試即此類保證之玩具版).
- **凍結契約**:狀態根目錄佈局(§5)、`process.cwd()` 預設、節點 id 公式(`nodeIdOf` / `specHash`)改動即使既有樹失效;領域端宜自備對拍測試(同一規格於領域端與引擎端算出同一 id).

## 8. 待辦與已知限制

待辦(含引擎契約之待辦與 dist 之限制)見 `sgud/state/state.md` 之〈已知缺口與待辦〉.
