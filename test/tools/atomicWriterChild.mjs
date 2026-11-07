import fs from 'fs'
import { writeJsonl, atomicStats } from '../../src/core/jsonl.mjs'


//原子寫之多程序測試子程序:於 ms 毫秒內反覆以 writeJsonl 整檔改寫 fp(內容恆為 nRows 列, 每列 i 與輪次);結束印出寫入統計
let [fp, nRows, ms] = process.argv.slice(2)
let t0 = Date.now(), round = 0
while (Date.now() - t0 < Number(ms)) {
    round++
    writeJsonl(fp, Array.from({ length: Number(nRows) }, (_, i) => ({ i, round, pad: 'x'.repeat(200) })))
}
console.log(JSON.stringify({ rounds: round, ...atomicStats }))
