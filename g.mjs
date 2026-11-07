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
