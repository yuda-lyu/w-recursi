import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { createRsi, CFG_KEYS, checkCfg } from '../src/index.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp, FD_PACK } from './tools/tmpdir.mjs'


//cfg 之已知鍵與檢查(2026-10-01):
//  原 cfg 之拼錯靜默無效(如 dreem ⇒ 做夢設定不生效);與 checkDomain 對稱 —— 未知鍵警告一次、strictDomain 拋錯;已知鍵單一來源 CFG_KEYS(掃原始碼核對)
describe('cfg 契約:已知鍵 CFG_KEYS、checkCfg、createRsi 開機即檢', () => {
    let t
    before(() => { t = makeTmp('cfgContract') })
    after(() => { t.cleanup() })
    it('CC01 套件原始碼讀取之 cfg 頂層鍵全部登錄於 CFG_KEYS(新增 cfg 選項未登錄 ⇒ 領域設了反被警告為未知鍵)', () => {
        let read = new Set()
        let walk = (d) => {
            for (let e of fs.readdirSync(d, { withFileTypes: true })) {
                let fp = path.join(d, e.name)
                if (e.isDirectory()) { walk(fp); continue }
                if (!/\.mjs$/.test(e.name)) { continue }
                let code = fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n')
                for (let m of code.matchAll(/\b(?:rsi\.)?cfg\.([A-Za-z_]\w*)\b(?!\.mjs)/g)) { read.add(m[1]) }
                for (let m of code.matchAll(/_\.get\(\s*(?:rsi\.)?cfg\s*,\s*['"]([A-Za-z_]\w*)/g)) { read.add(m[1]) }
                for (let m of code.matchAll(/_\.get\(\s*(?:rsi\.)?cfg\s*,\s*\[\s*['"]([A-Za-z_]\w*)/g)) { read.add(m[1]) }
            }
        }
        walk(path.join(FD_PACK, 'src'))
        read.delete('mjs')
        let missing = [...read].filter((k) => !CFG_KEYS.includes(k)).sort()
        assert.deepEqual(missing, [], `原始碼讀取而未登錄於 CFG_KEYS:${missing.join(', ')}`)
        assert.ok(read.size >= 10, `掃到之 cfg 鍵數 ${read.size}(掃描樣式失效?)`)
    })
    it('CC02 checkCfg:未知鍵列出;dream 未設 targetLadder ⇒ 提示;evidenceKeys 須為識別字陣列;已知鍵無聲', () => {
        assert.deepEqual(checkCfg({ root: 'x', dreem: {}, slotz: 1 }).unknown, ['dreem', 'slotz'])
        assert.deepEqual(checkCfg({ root: 'x', dream: { targetLadder: 1 }, evidenceKeys: ['mech'] }), { unknown: [], notes: [] })
        assert.deepEqual(checkCfg({ dream: { minIntervalMs: 1 } }).notes.map((n) => n.key), ['cfg.dream.targetLadder'])
        assert.deepEqual(checkCfg({ evidenceKeys: 'mech' }).notes.map((n) => n.key), ['cfg.evidenceKeys'])
        assert.deepEqual(checkCfg({ evidenceKeys: ['ok', 'bad key'] }).notes.map((n) => n.key), ['cfg.evidenceKeys'])
    })
    it('CC03 createRsi:未知鍵 ⇒ 警告一次(同鍵不重複);strictDomain ⇒ 拋錯', () => {
        let warns = [], orig = console.warn
        console.warn = (...a) => { warns.push(a.join(' ')) }
        try {
            let key = `zzTypo${Date.now()}`
            let mk = (name, extra = {}) => createRsi({ root: path.join(t.dir, name), domain: toy.makeDomain(), [key]: 1, ...extra })
            mk('a'); mk('b')
            assert.equal(warns.filter((w) => w.includes(key)).length, 1, warns.join('\n'))
            assert.throws(() => mk('c', { strictDomain: true }), new RegExp(`cfg 有未知鍵 ${key}`))
        }
        finally { console.warn = orig }
    })
})
