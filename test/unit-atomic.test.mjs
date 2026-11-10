import assert from 'assert'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { spawn, spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { readJsonl, writeJsonl, writeJson, readJson, writeFileAtomic } from '../src/core/jsonl.mjs'
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
            assert.equal(parseErrors, 0, `解析錯 ${parseErrors} / ${reads}:${sample}`)
            assert.equal(short, 0, `列數不足 ${short} / ${reads}`)
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
