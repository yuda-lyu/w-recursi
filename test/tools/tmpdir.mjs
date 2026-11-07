import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'


//測試專用暫存:w-recursi/test/_tmp/<案名>_<pid>_<rand>(gitignore;各測試 after 自刪)
export const FD_TEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FD_TMP = path.join(FD_TEST, '_tmp')
export const FD_PACK = path.resolve(FD_TEST, '..')

export let makeTmp = (name) => {
    let dir = path.join(FD_TMP, `${name}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`)
    fs.mkdirSync(dir, { recursive: true })
    return { dir, cleanup: () => { for (let k = 0; k < 5; k++) { try { fs.rmSync(dir, { recursive: true, force: true }); return } catch (e) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50) } } } }
}

export default makeTmp
