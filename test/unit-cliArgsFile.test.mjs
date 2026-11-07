import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { parseCli, CliError } from '../src/core/cli.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//--args-file(2026-10-01):
//  以 JSON 物件給參數(鍵 = 選項名或模式鍵), 免 shell 引號之包裝(對話紀錄自製 cliRun.mjs 24 次);展開後與命令列走同一驗證(型別 / 範圍 / 模式可用旗標 / 未知鍵)
describe('core/cli:--args-file', () => {
    let t
    before(() => { t = makeTmp('cliArgsFile') })
    after(() => { t.cleanup() })
    let SPEC = {
        name: 'x.mjs', usage: '用法:node x.mjs',
        options: { n: { type: 'int', min: 1, max: 9 }, dry: { type: 'flag' }, ids: { type: 'list' }, why: { type: 'str' }, ok: { type: 'bool' }, kind: { type: 'enum', values: ['a', 'b'] } },
        mode: { key: 'mode', modes: { run: ['n', 'dry', 'ids', 'why', 'ok', 'kind'], look: ['n'] } },
    }
    let fj = (name, obj) => { let fp = path.join(t.dir, `${name}.json`); fs.writeFileSync(fp, typeof obj === 'string' ? obj : JSON.stringify(obj)); return fp }
    let parse = (argv) => parseCli(argv, SPEC, { exit: false })
    it('AF01 檔內之鍵與命令列同效:型別轉換、清單陣列、旗標、模式鍵;字串含引號 / 反引號 / 前導減號 / 空白原樣', () => {
        let why = 'a "q" `b` $(c) -lead ;x'
        let fp = fj('ok', { mode: 'run', n: 3, ids: ['p', 'q'], dry: true, why, ok: false, kind: 'b' })
        let r = parse(['--args-file', fp])
        assert.equal(r.mode, 'run'); assert.equal(r.values.n, 3); assert.deepEqual(r.values.ids, ['p', 'q']); assert.equal(r.values.dry, true)
        assert.equal(r.values.why, why); assert.equal(r.values.ok, false); assert.equal(r.values.kind, 'b')
        let r2 = parse([`--args-file=${fp}`])
        assert.deepEqual(r2.values, r.values, '--args-file=<路徑> 形同效')
        let r3 = parse(['--mode', 'run', '--args-file', fj('part', { n: 2 }), '--dry'])
        assert.equal(r3.values.n, 2); assert.equal(r3.values.dry, true, '命令列與檔可並用(不同鍵)')
    })
    it('AF02 與命令列同鍵 ⇒ 拒(免歧義);未知鍵 ⇒ 拒;只可給一次', () => {
        assert.throws(() => parse(['--mode', 'run', '--n', '4', '--args-file', fj('dup', { n: 3 })]), (e) => e instanceof CliError && /同時見於命令列與 --args-file/.test(e.message))
        assert.throws(() => parse(['--args-file', fj('unk', { mode: 'run', nn: 3 })]), (e) => e instanceof CliError && /--args-file 之鍵 nn 未知/.test(e.message))
        assert.throws(() => parse(['--args-file', fj('a1', { mode: 'run' }), '--args-file', fj('a2', { n: 1 })]), (e) => e instanceof CliError && /只可給一次/.test(e.message))
    })
    it('AF03 值錯走同一驗證:整數 / 範圍 / 列舉 / 布林;旗標只收 true;模式不可用之旗標 ⇒ 拒', () => {
        assert.throws(() => parse(['--args-file', fj('int', { mode: 'run', n: 'abc' })]), /須為整數/)
        assert.throws(() => parse(['--args-file', fj('rng', { mode: 'run', n: 99 })]), /須 ≤ 9/)
        assert.throws(() => parse(['--args-file', fj('en', { mode: 'run', kind: 'z' })]), /須為 a \| b 之一/)
        assert.throws(() => parse(['--args-file', fj('bo', { mode: 'run', ok: 'yes' })]), /只收 true \/ false/)
        assert.throws(() => parse(['--args-file', fj('fl', { mode: 'run', dry: false })]), /旗標 dry 只收 true/)
        assert.throws(() => parse(['--args-file', fj('st', { mode: 'look', dry: true })]), /不適用於 --mode look/)
        assert.throws(() => parse(['--args-file', fj('obj', { mode: 'run', why: { a: 1 } })]), /須為純量/)
        assert.throws(() => parse(['--args-file', fj('comma', { mode: 'run', ids: ['a,b'] })]), /不得含逗號/)
    })
    it('AF04 檔缺 / 非 JSON / 非物件 ⇒ 拒;--help 照常', () => {
        assert.throws(() => parse(['--args-file', path.join(t.dir, 'nope.json')]), /讀取 \/ 解析失敗/)
        assert.throws(() => parse(['--args-file', fj('bad', '{oops')]), /讀取 \/ 解析失敗/)
        assert.throws(() => parse(['--args-file', fj('arr', [1, 2])]), /須為 JSON 物件/)
        assert.throws(() => parse(['--args-file']), /須給 JSON 檔路徑/)
        let h = parse(['--help'])
        assert.equal(h.help, true); assert.match(h.usage, /--args-file/)
    })
})
