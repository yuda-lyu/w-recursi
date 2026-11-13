import assert from 'assert'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { spawn, spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { readJsonl, writeJsonl, writeJson, readJson, writeFileAtomic, atomicStats } from '../src/core/jsonl.mjs'
import { makeTmp, FD_TEST, FD_PACK } from './tools/tmpdir.mjs'


let run = (args) => new Promise((resolve) => { let p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let out = '', err = ''; p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d }); p.on('exit', (code) => resolve({ code, out, err })) })
let tmpLeft = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))

describe('core/jsonl:原子寫檔(2026-09-24;某次實測重現之鎖外讀競態)', function () {
    let t
    before(() => { t = makeTmp('atomic') })
    after(() => { t.cleanup() })

    it('writeJsonl / writeJson / writeFileAtomic(Buffer):內容完整、可覆寫、不留暫存檔', () => {
        let fpL = path.join(t.dir, 'a.jsonl'), fpJ = path.join(t.dir, 'b.json'), fpG = path.join(t.dir, 'c.json.gz')
        writeJsonl(fpL, [{ a: 1 }, { a: 2 }])
        writeJsonl(fpL, [{ a: 3 }])
        assert.deepEqual(readJsonl(fpL), [{ a: 3 }])
        writeJsonl(fpL, [])
        assert.deepEqual(readJsonl(fpL), [])
        writeJson(fpJ, { k: 'v' })
        assert.deepEqual(readJson(fpJ), { k: 'v' })
        writeFileAtomic(fpG, zlib.gzipSync(Buffer.from(JSON.stringify({ id: 'n1' }), 'utf8')))
        assert.deepEqual(JSON.parse(zlib.gunzipSync(fs.readFileSync(fpG)).toString('utf8')), { id: 'n1' })
        assert.deepEqual(tmpLeft(t.dir), [])
    })

    it('他程序反覆整檔改寫時, 鎖外讀者不讀到截斷或空檔(0 解析錯、列數恆完整)', async function () {
        this.timeout(90000)
        let fp = path.join(t.dir, 'race.jsonl'), nRows = 300
        writeJsonl(fp, Array.from({ length: nRows }, (_, i) => ({ i, round: 0, pad: 'x'.repeat(200) })))
        //一次壓力試驗:寫者子程序整檔改寫 durMs, 讀者同時反覆讀;每次試驗之正確性斷言(0 解析錯、列數恆完整)皆嚴格
        let stress = async (durMs) => {
            let child = run([path.join(FD_TEST, 'tools', 'atomicWriterChild.mjs'), fp, String(nRows), String(durMs)])
            let reads = 0, parseErrors = 0, short = 0, sample = null
            let t0 = Date.now()
            while (Date.now() - t0 < durMs) {
                try { let rows = readJsonl(fp); reads++; if (rows.length !== nRows) { short++ } }
                catch (e) { parseErrors++; if (!sample) { sample = String(e.message).slice(0, 120) } }
                await new Promise((r) => setImmediate(r))
            }
            let r = await child
            assert.equal(r.code, 0, r.err)
            let st = JSON.parse(r.out.trim().split(/\r?\n/).pop())
            //寫者之統計(writes / retries / giveUps)附於失敗訊息, 供判讀(2026-11-14;第 429 項:原退回直寫之次數無從得知)
            assert.equal(parseErrors, 0, `解析錯 ${parseErrors} / ${reads}:${sample}(寫者 ${JSON.stringify(st)})`)
            assert.equal(short, 0, `列數不足 ${short} / ${reads}(寫者 ${JSON.stringify(st)})`)
            return { rounds: st.rounds, reads }
        }
        //壓力量之門檻(寫入 > 20 輪、讀取 > 50 次)是「試驗是否夠強」而非正確性:2026-10-02 某次驗收時, 脫離式迴圈之子程序於排程降級(EcoQoS, 短命子程序先於
        //  highqos 之 15 秒輪詢)只寫 16 輪而失敗, 重跑即過 ⇒ 不足時以加倍時長再試一次(每次之正確性斷言照樣嚴格), 不以放寬門檻代之
        let s = await stress(4000)
        if (s.rounds <= 20 || s.reads <= 50) { s = await stress(8000) }
        assert(s.rounds > 20, `寫入輪數過少 ${s.rounds}(加倍時長後仍不足)`)
        assert(s.reads > 50, `讀取次數過少 ${s.reads}(加倍時長後仍不足)`)
        assert.deepEqual(tmpLeft(t.dir), [])
    })
    //第 429 項(2026-11-14):改名(rename 覆蓋)持續失敗時不退回非原子之直接覆寫
    //  原:Windows 上目標檔被讀者持有 ⇒ rename 回 EPERM, 遞增重試約 2 秒用盡即 writeFileSync(目標)= 截斷再寫 ⇒ 高負載下鎖外讀者讀到截斷檔(列數不足 21 / 1322)
    //  AT10 / AT11 以真實之占用(本程序以 'r' 開啟目標檔;Windows 之 rename 因此回 EPERM, 直接覆寫則成功 —— 2026-11-14 實測)重現觸發條件;非 Windows 無此占用語意 ⇒ 略過
    //  同步一律以觀察回調之事件(opt.onTrace:retry / renamed / giveUp), 不以延時;「直接覆寫」以攔截 fs.writeFileSync 之目標路徑判定
    let spyDirect = (fp) => {
        let calls = [], orig = fs.writeFileSync
        fs.writeFileSync = function (f, ...rest) { if (typeof f === 'string' && path.resolve(f) === path.resolve(fp)) { calls.push(f) } return orig.call(this, f, ...rest) }
        return { calls, restore: () => { fs.writeFileSync = orig } }
    }
    it('AT10 目標被持有而改名持續失敗 ⇒ 拋 ERSI_ATOMIC_RENAME、目標維持原內容、從未直接覆寫目標、不留暫存檔(第 429 項)', function () {
        if (process.platform !== 'win32') { this.skip() }
        let fd = path.join(t.dir, 'at10'), fp = path.join(fd, 'held.json')
        fs.mkdirSync(fd)
        fs.writeFileSync(fp, '{"v":"old"}')
        let h = fs.openSync(fp, 'r'), ev = [], err = null, spy = spyDirect(fp)
        try { writeFileAtomic(fp, '{"v":"new"}', { retryMs: 200, onTrace: (e) => { ev.push(e) } }) }
        catch (e) { err = e }
        finally { spy.restore(); fs.closeSync(h) }
        //規格:重試用盡 ⇒ 拋錯交呼叫端(不退回非原子之直接覆寫);讀者只見舊檔或新檔之完整內容 ⇒ 此時須仍為舊檔
        assert.equal(err && err.code, 'ERSI_ATOMIC_RENAME', `應拋 ERSI_ATOMIC_RENAME(實得 ${err ? err.code : '未拋錯'})`)
        assert.deepEqual(spy.calls, [], '不得以 writeFileSync 直接覆寫目標檔(非原子)')
        assert.equal(fs.readFileSync(fp, 'utf8'), '{"v":"old"}', '目標檔維持原內容')
        assert.deepEqual(tmpLeft(fd), [], '不留暫存檔')
        //事件:最後為 giveUp(錯誤碼為占用之 EPERM、attempts = 事件數), 其前皆為 EPERM 之 retry(次數隨負載而變, 不斷言)
        let last = ev[ev.length - 1]
        assert.ok(last && last.type === 'giveUp' && last.code === 'EPERM' && last.attempts === ev.length, JSON.stringify(ev))
        assert.ok(ev.slice(0, -1).every((e, i) => e.type === 'retry' && e.code === 'EPERM' && e.attempt === i + 1), JSON.stringify(ev))
        assert.ok(Object.isFrozen(last), '事件為凍結物件')
    })
    it('AT11 目標被持有、於第 3 次重試之事件中釋放 ⇒ 下一次改名成功、內容為新、從未直接覆寫目標(事件同步)', function () {
        if (process.platform !== 'win32') { this.skip() }
        let fd = path.join(t.dir, 'at11'), fp = path.join(fd, 'held.json')
        fs.mkdirSync(fd)
        fs.writeFileSync(fp, '{"v":"old"}')
        let h = fs.openSync(fp, 'r'), closed = false, ev = [], spy = spyDirect(fp)
        try {
            writeFileAtomic(fp, '{"v":"new"}', { onTrace: (e) => { ev.push(e); if (e.type === 'retry' && e.attempt === 3 && !closed) { fs.closeSync(h); closed = true } } })
        }
        finally { spy.restore(); if (!closed) { fs.closeSync(h) } }
        assert.deepEqual(spy.calls, [], '不得以 writeFileSync 直接覆寫目標檔(非原子)')
        assert.equal(fs.readFileSync(fp, 'utf8'), '{"v":"new"}')
        assert.deepEqual(ev.slice(0, 3).map((e) => [e.type, e.attempt, e.code]), [['retry', 1, 'EPERM'], ['retry', 2, 'EPERM'], ['retry', 3, 'EPERM']], JSON.stringify(ev))
        let last = ev[ev.length - 1]
        assert.ok(last.type === 'renamed' && last.attempts === ev.length && last.attempts >= 4, JSON.stringify(ev))
        assert.deepEqual(tmpLeft(fd), [])
    })
    it('AT12 改名之暫時性失敗(注入):觀察回調五種(未傳 / 紀錄器 / 拋錯 / 回 rejection / 非函數)結果相同;retryMs 非預期之值改用預設、0 ⇒ 首敗即拋;非暫時性錯誤原樣拋出不重試;寫暫存檔中途失敗不留半寫暫存檔;暫存檔刪不掉 ⇒ tmpLeft', async () => {
        let fd = path.join(t.dir, 'at12')
        fs.mkdirSync(fd)
        //注入:對 fd 下之改名, 前 k 次拋暫時性錯誤(EPERM / EACCES / EBUSY 輪替)或指定之錯誤碼
        let inject = (k, code = null) => {
            let orig = fs.renameSync, n = 0, codes = ['EPERM', 'EACCES', 'EBUSY']
            fs.renameSync = function (a, b) { if (String(b).startsWith(fd) && n < k) { n++; throw Object.assign(new Error(`${code || codes[(n - 1) % 3]}: injected`), { code: code || codes[(n - 1) % 3] }) } return orig.call(this, a, b) }
            return { restore: () => { fs.renameSync = orig }, n: () => n }
        }
        let unhandled = []
        let onUnhandled = (e) => { unhandled.push(String(e)) }
        process.on('unhandledRejection', onUnhandled)
        try {
            let recorded = []
            let variants = [undefined, (e) => { recorded.push(e) }, () => { throw new Error('cb 拋錯') }, () => Promise.reject(new Error('cb rejection')), 'not-a-function']
            for (let [i, cb] of variants.entries()) {
                let fp = path.join(fd, `v${i}.json`)
                fs.writeFileSync(fp, 'old')
                let r0 = { ...atomicStats }, inj = inject(2)
                try { writeFileAtomic(fp, `new${i}`, cb === undefined ? undefined : { onTrace: cb }) }
                finally { inj.restore() }
                assert.equal(fs.readFileSync(fp, 'utf8'), `new${i}`, `variant ${i}`)
                assert.deepEqual([inj.n(), atomicStats.retries - r0.retries, atomicStats.giveUps - r0.giveUps], [2, 2, 0], `variant ${i}`)
            }
            //紀錄器收到之事件:2 次暫時性失敗(碼依注入之序)後改名成功;事件凍結、type 外無名為 type 之欄
            assert.deepEqual(recorded.map((e) => [e.type, e.attempt || e.attempts, e.code || null]), [['retry', 1, 'EPERM'], ['retry', 2, 'EACCES'], ['renamed', 3, null]])
            assert.ok(recorded.every((e) => Object.isFrozen(e)) && recorded.filter((e) => e.type === 'retry').every((e) => Number.isInteger(e.waitMs) && e.waitMs >= 1))
            await new Promise((r) => setImmediate(r))
            assert.deepEqual(unhandled, [], '回調之 rejection 不成為未處理之 rejection')
            //retryMs:非預期之值(字串、負數、NaN、null)⇒ 改用預設(仍重試而成功);0 ⇒ 首次失敗即拋(目標不變)
            for (let bad of ['x', -1, NaN, null]) {
                let fp = path.join(fd, 'rm.json'), inj = inject(2)
                try { writeFileAtomic(fp, String(bad), { retryMs: bad }) }
                finally { inj.restore() }
                assert.equal(fs.readFileSync(fp, 'utf8'), String(bad))
            }
            let fp0 = path.join(fd, 'zero.json'), ev = [], inj0 = inject(1)
            fs.writeFileSync(fp0, 'old')
            try { assert.throws(() => writeFileAtomic(fp0, 'new', { retryMs: 0, onTrace: (e) => ev.push(e) }), (e) => e.code === 'ERSI_ATOMIC_RENAME') }
            finally { inj0.restore() }
            assert.deepEqual([fs.readFileSync(fp0, 'utf8'), ev.map((e) => e.type)], ['old', ['giveUp']])
            //非暫時性(如 EXDEV)⇒ 原錯拋出、不重試、不留暫存檔
            let fpX = path.join(fd, 'x.json'), evX = [], injX = inject(1, 'EXDEV')
            fs.writeFileSync(fpX, 'old')
            try { assert.throws(() => writeFileAtomic(fpX, 'new', { onTrace: (e) => evX.push(e) }), (e) => e.code === 'EXDEV') }
            finally { injX.restore() }
            assert.deepEqual([fs.readFileSync(fpX, 'utf8'), evX], ['old', []])
            //寫暫存檔中途失敗(注入:寫一半後拋 ENOSPC)⇒ 原錯拋出、目標不變、半寫之暫存檔已刪
            let fpW = path.join(fd, 'w.json'), origW = fs.writeFileSync
            origW(fpW, 'old')
            fs.writeFileSync = function (f, d, ...rest) { if (String(f).startsWith(path.join(fd, '.w.json.')) && String(f).endsWith('.tmp')) { origW.call(this, f, String(d).slice(0, 1), ...rest); throw Object.assign(new Error('ENOSPC: injected'), { code: 'ENOSPC' }) } return origW.call(this, f, d, ...rest) }
            try { assert.throws(() => writeFileAtomic(fpW, 'new-content'), (e) => e.code === 'ENOSPC') }
            finally { fs.writeFileSync = origW }
            assert.equal(fs.readFileSync(fpW, 'utf8'), 'old')
            assert.deepEqual(tmpLeft(fd), [])
            //暫存檔刪不掉(注入:rmSync 對暫存檔恆拋 EPERM)⇒ 不靜默:錯誤帶 tmpLeft = 殘留之路徑(外審 terra #14)
            let fpR = path.join(fd, 'r.json'), origRm = fs.rmSync, injR = inject(1, 'EXDEV'), errR = null
            fs.writeFileSync(fpR, 'old')
            fs.rmSync = function (p, ...rest) { if (String(p).startsWith(path.join(fd, '.r.json.'))) { throw Object.assign(new Error('EPERM: injected rm'), { code: 'EPERM' }) } return origRm.call(this, p, ...rest) }
            try { writeFileAtomic(fpR, 'new') } catch (e) { errR = e } finally { fs.rmSync = origRm; injR.restore() }
            assert.ok(errR && errR.code === 'EXDEV' && typeof errR.tmpLeft === 'string' && fs.existsSync(errR.tmpLeft), String(errR))
            fs.rmSync(errR.tmpLeft)
            assert.deepEqual(tmpLeft(fd), [])
        }
        finally { process.off('unhandledRejection', onUnhandled) }
    })
    it('readJsonl:最後一列為追加中之半列 ⇒ 略過;中間列損壞 ⇒ 拋錯(2026-09-26)', () => {
        let fp = path.join(t.dir, 'partial.jsonl')
        fs.writeFileSync(fp, '{"a":1}\n{"a":2}\n{"a":')
        assert.deepEqual(readJsonl(fp), [{ a: 1 }, { a: 2 }])
        fs.writeFileSync(fp, '{"a":1}\n{"a":\n{"a":3}\n')
        assert.throws(() => readJsonl(fp), /第 2 列非 JSON/)
    })
    it('readJsonl opt.skipBad(2026-09-29):中間壞列略過、onBad 收列號、真實呼叫端之 stderr 恰一行警示;預設行為不變', () => {
        let fp = path.join(t.dir, 'skip.jsonl')
        fs.writeFileSync(fp, '{"a":1}\n{"a":\n{"a":3}\nxx\n{"a":5}\n{"a":')
        assert.throws(() => readJsonl(fp), /第 2 列非 JSON/, '預設:中間壞列仍拋錯')
        assert.throws(() => readJsonl(fp, {}), /第 2 列非 JSON/)
        let got = []
        assert.deepEqual(readJsonl(fp, { skipBad: true, onBad: (ls) => got.push(...ls) }), [{ a: 1 }, { a: 3 }, { a: 5 }])
        assert.deepEqual(got, [2, 4], '中間壞列之列號(末列之半列不計)')
        assert.deepEqual(readJsonl(path.join(t.dir, 'nope.jsonl'), { skipBad: true }), [])
        //真實呼叫端:子程序以 skipBad 讀之 ⇒ stdout 為好列、stderr 恰一行警示(含壞列數與列號)
        let code = `import { readJsonl } from ${JSON.stringify(pathToFileURL(path.join(FD_PACK, 'src', 'core', 'jsonl.mjs')).href)}; console.log(JSON.stringify(readJsonl(${JSON.stringify(fp)}, { skipBad: true })))`
        let r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true })
        assert.equal(r.status, 0, r.stderr)
        assert.deepEqual(JSON.parse(r.stdout.trim()), [{ a: 1 }, { a: 3 }, { a: 5 }])
        let lines = r.stderr.split(/\r?\n/).filter(Boolean)
        assert.equal(lines.length, 1, r.stderr)
        assert(lines[0].includes('略過非 JSON 之中間列 2 列') && lines[0].includes('第 2、4 列'), lines[0])
    })
})
