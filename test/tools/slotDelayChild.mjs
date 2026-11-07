import fs from 'fs'
import path from 'path'
import { acquireSlots, releaseSlots } from '../../src/core/slots.mjs'


//原子建槽之多程序測試子程序(2026-10-09;unit-slotsAtomic)
//  用法:node slotDelayChild.mjs <dir> <max> <want> <holdMs> <logFile> [delayOwnerMs] [markFile] [cycles] [jitterMs]
//  delayOwnerMs > 0:本程序「第一次寫 owner」前以 Atomics.wait 凍結整個程序 delayOwnerMs(= 排程飢餓之模擬;建槽與寫 owner 之間);進入延遲前寫 markFile(父程序據以起他方)
//  cycles:「取 → 持 holdMs → 放」之輪數;jitterMs > 0:其餘每次寫 owner 前另睡 0 ~ jitterMs(加寬併搶之窗)
//  每輪之持有區間記一行 `${pid} ${t0} ${t1} ${n}` 至 logFile(t0 = acquireSlots 返回時、t1 = 釋放前)
let [dir, max, want, holdMs, logFile, delayMs = '0', markFile = '', cycles = '1', jitterMs = '0'] = process.argv.slice(2)
let sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
let orig = fs.writeFileSync
let first = true
fs.writeFileSync = function (fp, ...rest) {
    if (path.basename(String(fp)) === 'owner') {
        if (first && Number(delayMs) > 0) { first = false; if (markFile) { orig.call(fs, markFile, String(process.pid)) } sleep(Number(delayMs)) }
        else if (Number(jitterMs) > 0) { sleep(Math.floor(Math.random() * Number(jitterMs))) }
    }
    return orig.call(fs, fp, ...rest)
}
for (let c = 0; c < Number(cycles); c++) {
    let hs = acquireSlots(dir, { want: Number(want), max: Number(max), timeoutMs: 90000 })
    let t0 = Date.now()
    sleep(Number(holdMs))
    let t1 = Date.now()
    releaseSlots(hs)
    fs.appendFileSync(logFile, `${process.pid} ${t0} ${t1} ${hs.length}\n`)
}
console.log(`done ${process.pid}`)
