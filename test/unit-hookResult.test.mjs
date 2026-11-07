import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { createRsi } from '../src/index.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//鉤子失敗之結果形(2026-10-09;原於 loop/auto.mjs 與領域之尾段續跑各手寫一份)
//  HR01 hookFailureOf(err) 之形 = { failed: true, errors: [訊息], lines: ['## 領域鉤子失敗', '', '- 訊息'] };非 Error 之拋出物以字串化;協定入口與 index 轉出同一實作
//  HR02 auto 之鉤子拋錯 ⇒ 結果之 hook 欄 = hookFailureOf(該錯)(同一來源)、報告含其節
describe('core/hookResult:鉤子失敗之結果形', function () {
    this.timeout(120000)
    let t
    before(() => { t = makeTmp('hookResult') })
    after(() => { t.cleanup() })

    it('HR01 hookFailureOf 之形;非 Error 之拋出物;protocol / index 同一實作', async () => {
        let H = await import('../src/core/hookResult.mjs')
        assert.equal(H.HOOK_FAIL_HEAD, '## 領域鉤子失敗')
        assert.deepEqual(H.hookFailureOf(new Error('爆')), { failed: true, errors: ['爆'], lines: ['## 領域鉤子失敗', '', '- 爆'] })
        assert.deepEqual(H.hookFailureOf('字串').errors, ['字串'])
        assert.deepEqual(H.hookFailureOf({ message: '物件' }).errors, ['物件'])
        assert.deepEqual(H.hookFailureOf(null).errors, ['null'])
        let P = await import('../src/protocol.mjs'), I = await import('../src/index.mjs')
        assert.equal(P.hookFailureOf, H.hookFailureOf); assert.equal(I.hookFailureOf, H.hookFailureOf)
    })
    it('HR02 auto 之鉤子拋錯 ⇒ hook 欄 = hookFailureOf(該錯)、報告含其節', async () => {
        let H = await import('../src/core/hookResult.mjs')
        let r = createRsi({ root: path.join(t.dir, 'a'), domain: makeDomain({ hooks: { afterRound: async () => { throw new Error('鉤子爆了') } } }), budget: { arms: 6, novelty: 2, workers: 3 }, dream: { everyRound: false } }).init()
        let a = await r.auto({})
        assert.deepEqual(a.hook, H.hookFailureOf(new Error('鉤子爆了')))
        let md = fs.readFileSync(path.join(a.fd, 'report.md'), 'utf8')
        assert(md.includes(`${H.HOOK_FAIL_HEAD}\n\n- 鉤子爆了`), '報告含鉤子失敗之節與訊息')
    })
})
