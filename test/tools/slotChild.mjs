import fs from 'fs'
import { acquireSlots, releaseSlots } from '../../src/core/slots.mjs'


//槽位之多程序測試子程序:取 want 個槽(max 上限), 持有 holdMs 後釋放;起迄與持有數寫入 logFile
let [dir, max, want, holdMs, logFile] = process.argv.slice(2)
let hs = acquireSlots(dir, { want: Number(want), max: Number(max), timeoutMs: 30000 })
let t0 = Date.now()
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs))
let t1 = Date.now()
releaseSlots(hs)
fs.appendFileSync(logFile, `${process.pid} ${t0} ${t1} ${hs.length}\n`)
console.log(`done ${process.pid} held ${hs.length}`)
