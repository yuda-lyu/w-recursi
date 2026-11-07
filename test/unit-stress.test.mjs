import assert from 'assert'
import _ from 'lodash-es'
import { createRsi } from '../src/index.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


describe('壓力與收斂:多輪大臂(同程序評估)', function () {
    let t
    before(() => { t = makeTmp('stress') })
    after(() => { t.cleanup() })

    it('12 輪 × 12 臂:節點 ≥ 80、無重複規格、最佳 S 隨輪不降且爬升、每輪與做夢皆在秒級', async function () {
        this.timeout(300000)
        let rsi = createRsi({ root: t.dir, domain: makeDomain(), budget: { arms: 12, novelty: 2, workers: 6 } }).init()
        let bests = [], secs = []
        for (let i = 0; i < 12; i++) {
            let t0 = Date.now()
            let ex = await rsi.explore({})
            secs.push((Date.now() - t0) / 1000)
            let best = _.max(rsi.store.listIndex().filter((r) => r.status === 'executed').map((r) => r.S))
            bests.push(best)
            assert(ex.summary.nExecuted > 0, `第 ${i + 1} 輪應有執行`)
        }
        let idx = rsi.store.listIndex()
        let exec = rsi.store.loadNodes((r) => r.status === 'executed')
        assert(exec.length >= 80, `執行節點 ${exec.length}`)
        assert.equal(_.uniq(exec.map((n) => n.specHash)).length, exec.length)
        for (let i = 1; i < bests.length; i++) { assert(bests[i] >= bests[i - 1]) }
        assert(bests[bests.length - 1] > bests[1], '最佳 S 應爬升')
        assert(_.max(secs) < 30, `單輪最長 ${_.max(secs)} 秒`)
        let t1 = Date.now()
        let d = await rsi.dream({})
        let dreamSec = (Date.now() - t1) / 1000
        assert(dreamSec < 20, `做夢 ${dreamSec} 秒`)
        assert(d.rows[0].score.nCuts === 11)
        let st = await rsi.status({ print: false })
        assert.equal(st.rounds, 12); assert.equal(st.claims, 0)
        console.log(`      節點 ${idx.length}(執行 ${exec.length});最佳 S ${bests[0]} → ${_.last(bests)};單輪均 ${_.round(_.mean(secs), 2)} 秒;做夢 ${_.round(dreamSec, 2)} 秒;揭露 ${d.rows[0].score.inSample.revealed} 未知 ${d.rows[0].score.inSample.unknown}`)
    })
})
