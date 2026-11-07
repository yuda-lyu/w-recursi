import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { parseCli } from '../src/core/cli.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//parseCli 之明給之鍵 given(2026-10-09;審查:領域端掃 process.argv 判「是否明給」⇒ --args-file 所給者漏偵)
//  CG01 命令列:長名 / 短名 / --k=v / 旗標皆算;預設值不算;模式鍵(明給時)居首, 其餘依 spec.options 之序(與命令列之序無關)
//  CG02 --args-file 之鍵亦算(與命令列並用時為聯集);有預設值之選項經檔給 ⇒ 在 given
//  CG03 values / mode / positionals 與舊回傳逐欄同(只多 given);無模式之 spec 亦有 given;--help 之回傳不變
describe('core/cli:parseCli 之 given', () => {
    let t
    before(() => { t = makeTmp('cliGiven') })
    after(() => { t.cleanup() })
    let SPEC = {
        name: 'x.mjs', usage: '用法:node x.mjs',
        options: { workers: { type: 'int', min: 1, max: 9, default: 2, short: 'w' }, dry: { type: 'flag' }, ids: { type: 'list' }, why: { type: 'str', default: 'none' }, force: { type: 'flag' } },
        mode: { key: 'mode', required: false, default: 'look', modes: { run: ['workers', 'dry', 'ids', 'why', 'force'], look: ['workers', 'why'] } },
    }
    let fj = (name, obj) => { let fp = path.join(t.dir, `${name}.json`); fs.writeFileSync(fp, JSON.stringify(obj)); return fp }
    let parse = (argv, spec = SPEC) => parseCli(argv, spec, { exit: false })

    it('CG01 命令列之明給之鍵(長名 / 短名 / --k=v / 旗標);預設不算;模式鍵居首、其餘依 spec 之序', () => {
        let r = parse(['--force', '--ids', 'a,b', '--mode', 'run', '-w', '3'])
        assert.deepEqual(r.given, ['mode', 'workers', 'ids', 'force'])
        assert.equal(r.values.workers, 3); assert.equal(r.values.why, 'none')
        let r2 = parse(['--workers=4'])
        assert.deepEqual(r2.given, ['workers'], '未給 --mode(用預設 look)⇒ 模式鍵不在 given')
        assert.equal(r2.mode, 'look')
        let r3 = parse([])
        assert.deepEqual(r3.given, [], '全用預設 ⇒ 空')
        assert.equal(r3.values.workers, 2)
    })
    it('CG02 --args-file 之鍵亦算;與命令列並用為聯集', () => {
        let r = parse(['--args-file', fj('a', { mode: 'run', workers: 5 })])
        assert.deepEqual(r.given, ['mode', 'workers'], '有預設值之 workers 經檔給 ⇒ 在 given(原掃 argv 漏偵)')
        let r2 = parse(['--dry', `--args-file=${fj('b', { mode: 'run', why: 'x' })}`])
        assert.deepEqual(r2.given, ['mode', 'dry', 'why'])
        assert.equal(r2.values.why, 'x')
    })
    it('CG03 其餘回傳不變;無模式之 spec;--help', () => {
        let r = parse(['--mode', 'run', '--dry'])
        assert.deepEqual(Object.keys(r).sort(), ['given', 'help', 'mode', 'positionals', 'values'])
        assert.equal(r.help, false); assert.deepEqual(r.positionals, []); assert.equal(r.values.dry, true); assert.equal(r.values.force, false)
        let r2 = parse(['--n', '7'], { name: 'y', options: { n: { type: 'int', default: 1 }, m: { type: 'int', default: 2 } } })
        assert.deepEqual(r2.given, ['n'])
        assert.equal(r2.values.m, 2)
        let h = parse(['--help'])
        assert.equal(h.help, true); assert.equal(h.given, undefined)
    })
})
