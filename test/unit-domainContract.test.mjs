import assert from 'assert'
import fs from 'fs'
import path from 'path'
import _ from 'lodash-es'
import createRsi, { DOMAIN_KEYS, checkDomain } from '../src/index.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp, FD_TEST } from './tools/tmpdir.mjs'


const FD_PKG = path.resolve(FD_TEST, '..')
let listMjs = (fd) => fs.readdirSync(fd, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listMjs(path.join(fd, e.name)) : e.name.endsWith('.mjs') ? [path.join(fd, e.name)] : []))
//攔截 console.warn(未知鍵之警告)
let captureWarn = (fn) => { let got = [], orig = console.warn; console.warn = (...a) => got.push(a.join(' ')); try { fn() } finally { console.warn = orig } return got }

describe('領域介面檢查(2026-09-25):已知鍵單一來源 DOMAIN_KEYS、createRsi 開機即檢', function () {
    let t
    before(() => { t = makeTmp('domainContract') })
    after(() => { t.cleanup() })

    it('套件原始碼讀取之 domain.<鍵> 全部登錄於 DOMAIN_KEYS(新增鉤子未登錄 ⇒ 領域設了反被警告為未知鍵)', () => {
        let used = new Set()
        for (let fp of listMjs(path.join(FD_PKG, 'src'))) { for (let m of fs.readFileSync(fp, 'utf8').matchAll(/\bdomain\.([A-Za-z_]+)/g)) { used.add(m[1]) } }
        assert(used.size >= 20, `掃到 ${used.size} 個鍵`)
        assert.deepEqual([...used].filter((k) => !DOMAIN_KEYS[k]).sort(), [])
    })

    it('README §4 之表列出全部已知鍵', () => {
        let md = fs.readFileSync(path.join(FD_PKG, 'README.md'), 'utf8')
        assert.deepEqual(_.keys(DOMAIN_KEYS).filter((k) => !md.includes(`| \`${k}\``)), [])
    })

    it('玩具領域:無錯誤、無未知鍵', () => {
        assert.deepEqual(checkDomain(makeDomain()), { errors: [], unknown: [] })
    })

    it('缺必填 score ⇒ createRsi 拋錯並指出該鍵', () => {
        assert.throws(() => createRsi({ root: path.join(t.dir, 'a'), domain: _.omit(makeDomain(), ['score']) }), /domain\.score 必填/)
    })

    it('型別不符 ⇒ 拋錯並指出應為之型別;null / undefined 視為未給', () => {
        assert.throws(() => createRsi({ root: path.join(t.dir, 'b'), domain: makeDomain({ operators: {} }) }), /domain\.operators 型別應為 array, 實為 object/)
        assert.throws(() => createRsi({ root: path.join(t.dir, 'b'), domain: makeDomain({ transferBlock: 'x' }) }), /domain\.transferBlock 型別應為 function/)
        assert.deepEqual(checkDomain(makeDomain({ childBlock: null, gates: undefined })).errors, [])
        assert.deepEqual(checkDomain(makeDomain({ carriers: () => ({}) })).errors, [], 'carriers 可為函式')
        assert.deepEqual(checkDomain(makeDomain({ evaluatorVersion: 3 })).errors, [], 'evaluatorVersion 可為數字')
    })

    it('未知鍵(如拼錯 transferBlok)⇒ 警告一次(同鍵不重複);strictDomain ⇒ 拋錯', () => {
        let w1 = captureWarn(() => createRsi({ root: path.join(t.dir, 'c'), domain: makeDomain({ transferBlok: () => null }) }))
        assert.equal(w1.length, 1)
        assert.match(w1[0], /未知鍵 transferBlok/)
        let w2 = captureWarn(() => createRsi({ root: path.join(t.dir, 'c'), domain: makeDomain({ transferBlok: () => null }) }))
        assert.equal(w2.length, 0, '同一鍵每程序只警告一次')
        assert.throws(() => createRsi({ root: path.join(t.dir, 'd'), domain: makeDomain({ childBlok: () => null }), strictDomain: true }), /未知鍵 childBlok/)
    })
})
