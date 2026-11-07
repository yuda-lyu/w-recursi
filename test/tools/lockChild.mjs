import fs from 'fs'
import { withLock } from '../../src/core/lock.mjs'


//鎖之多程序測試子程序:對共用計數檔做 n 次「讀 → +1 → 寫」, 每次都在鎖內
let [dir, fpCounter, n] = process.argv.slice(2)
for (let i = 0; i < Number(n); i++) {
    withLock(() => {
        let v = Number(fs.readFileSync(fpCounter, 'utf8') || 0)
        //刻意拉長臨界區, 放大競爭
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
        fs.writeFileSync(fpCounter, String(v + 1))
    }, { dir, name: 'cnt', timeoutMs: 60000 })
}
console.log(`done ${process.pid}`)
