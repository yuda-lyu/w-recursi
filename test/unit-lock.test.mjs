import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { withLock } from '../src/core/lock.mjs'
import { makeTmp, FD_TEST } from './tools/tmpdir.mjs'


let run = (args) => new Promise((resolve) => { let p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d }); p.on('exit', (code) => resolve({ code, out, err })) })

describe('core/lock:跨程序寫入鎖', function () {
    let t
    before(() => { t = makeTmp('lock') })
    after(() => { t.cleanup() })

    it('5 程序 × 40 次鎖內「讀 → +1 → 寫」= 200(無遺失)', async function () {
        this.timeout(120000)
        let fp = path.join(t.dir, 'counter.txt')
        fs.writeFileSync(fp, '0')
        let rs = await Promise.all([1, 2, 3, 4, 5].map(() => run([path.join(FD_TEST, 'tools', 'lockChild.mjs'), t.dir, fp, '40'])))
        assert.deepEqual(rs.map((r) => r.code), [0, 0, 0, 0, 0], rs.map((r) => r.err).join('\n'))
        assert.equal(Number(fs.readFileSync(fp, 'utf8')), 200)
        assert(!fs.existsSync(path.join(t.dir, '.lock_cnt')), '鎖應已釋放')
    })
    it('他程序持鎖時逾時拋錯(不靜默略過)', () => {
        let fd = path.join(t.dir, '.lock_x')
        fs.mkdirSync(fd)
        assert.throws(() => withLock(() => 1, { dir: t.dir, name: 'x', timeoutMs: 300, staleMs: 1e9 }), /逾時/)
        fs.rmSync(fd, { recursive: true, force: true })
    })
    it('死鎖(超過 staleMs)自動清除後可取得', () => {
        let fd = path.join(t.dir, '.lock_y')
        fs.mkdirSync(fd)
        let old = (Date.now() - 10000) / 1000
        fs.utimesSync(fd, old, old)
        assert.equal(withLock(() => 42, { dir: t.dir, name: 'y', timeoutMs: 2000, staleMs: 1000 }), 42)
        assert(!fs.existsSync(fd))
    })
    it('臨界區拋錯仍釋放鎖', () => {
        assert.throws(() => withLock(() => { throw new Error('boom') }, { dir: t.dir, name: 'z' }), /boom/)
        assert(!fs.existsSync(path.join(t.dir, '.lock_z')))
        assert.equal(withLock(() => 'ok', { dir: t.dir, name: 'z' }), 'ok')
    })
    it('持有者已死 ⇒ 立即回收(不必等 staleMs);持有者存活且未逾 staleMs ⇒ 等(2026-09-26)', () => {
        let fd = path.join(t.dir, '.lock_d')
        fs.mkdirSync(fd); fs.writeFileSync(path.join(fd, 'owner'), `999999 ${new Date().toISOString()} tokX`)
        let t0 = Date.now()
        assert.equal(withLock(() => 7, { dir: t.dir, name: 'd', timeoutMs: 5000, staleMs: 1e9 }), 7)
        assert(Date.now() - t0 < 2000, '死持有者立即回收')
        fs.mkdirSync(fd); fs.writeFileSync(path.join(fd, 'owner'), `${process.pid} ${new Date().toISOString()} tokY`)
        assert.throws(() => withLock(() => 1, { dir: t.dir, name: 'd', timeoutMs: 300, staleMs: 1e9 }), /逾時.*存活/)
        fs.rmSync(fd, { recursive: true, force: true })
    })
    it('釋放只刪自己的鎖:臨界區內鎖被他方回收並取得 ⇒ 本方結束時不刪其鎖(2026-09-26)', () => {
        let fd = path.join(t.dir, '.lock_o')
        withLock(() => { fs.writeFileSync(path.join(fd, 'owner'), `${process.pid} ${new Date().toISOString()} someoneElse`) }, { dir: t.dir, name: 'o' })
        assert(fs.existsSync(fd), '他方之鎖保留')
        fs.rmSync(fd, { recursive: true, force: true })
    })
})
