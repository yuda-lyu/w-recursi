import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import _ from 'lodash-es'
import { createRsi } from '../src/index.mjs'
import { makeDomain } from './tools/toy.mjs'
import { makeTmp, FD_PACK } from './tools/tmpdir.mjs'


//重計畫之 ctx.roundPlanned(2026-10-02;loop/explore.mjs):認領衝突後之重計畫, 策略收到本 session 本輪已認領之臂(首次出計畫為 [])
//  為何:策略之「每輪上限」(如領域策略之每輪每族 ≤ 1)於重計畫時須承接已認領者, 否則每次呼叫各自歸零而可超額
describe('loop/explore:重計畫之 ctx.roundPlanned', function () {
    let t
    before(() => { t = makeTmp('roundPlanned') })
    after(() => { t.cleanup(); delete globalThis.__wRecursiRoundPlanned })

    it('RP01 首次出計畫 [];部分臂被他 session 領走 ⇒ 重計畫收到本 session 已認領之臂(id / op / parentId / specHash / spec), 不含被領走者', async function () {
        this.timeout(60000)
        let rsi, dry = null, raced = false
        //競態:本輪計畫之首臂於過閘時被他 session 搶先認領(其餘由本 session 認領)
        let pre = () => {
            if (dry && !raced) { raced = true; let it = dry.items[0]; rsi.store.claimNodes([{ id: it.id, spec: it.spec, specHash: it.specHash, parentId: it.parentId }], { round: 99, by: 'other' }) }
            return { ok: true }
        }
        rsi = createRsi({ root: path.join(t.dir, 'rp'), domain: makeDomain({ gates: { pre } }), budget: { arms: 6, novelty: 2, workers: 3 } }).init()
        await rsi.explore({})
        //間諜策略:記每次呼叫之 ctx.roundPlanned, 計畫照 v0
        let v0 = pathToFileURL(path.join(FD_PACK, 'src', 'search', 'policyV0.mjs')).href
        fs.writeFileSync(path.join(rsi.paths.policies, 'spy.mjs'), `import v0 from '${v0}'\nexport const meta = { name: 'spy' }\nexport default function policy(view, budget, ctx) { (globalThis.__wRecursiRoundPlanned = globalThis.__wRecursiRoundPlanned || []).push(ctx.roundPlanned); return v0(view, budget, ctx) }\n`)
        fs.writeFileSync(rsi.paths.current, "export { default, meta } from './spy.mjs'\n")
        globalThis.__wRecursiRoundPlanned = []
        dry = await rsi.explore({ dry: true })
        assert(dry.items.length >= 2, `乾跑臂數 ${dry.items.length}`)
        assert.deepEqual(globalThis.__wRecursiRoundPlanned, [[]], '首次出計畫 ⇒ []')
        globalThis.__wRecursiRoundPlanned = []
        let ex = await rsi.explore({})
        assert(raced)
        assert(ex.replans >= 1, `replans ${ex.replans}`)
        let calls = globalThis.__wRecursiRoundPlanned
        assert(calls.length >= 2, `呼叫 ${calls.length} 次`)
        assert.deepEqual(calls[0], [], '首次 []')
        let rp = calls[1]
        assert(_.isArray(rp) && rp.length >= 1, `重計畫之 roundPlanned ${JSON.stringify(rp)}`)
        let raceId = dry.items[0].id
        assert(rp.every((x) => x.id !== raceId), '不含被他 session 領走者')
        assert(rp.every((x) => x.id && x.op !== undefined && x.parentId && x.specHash && x.spec), JSON.stringify(rp[0]))
        let mineIds = new Set(dry.items.slice(1).map((x) => x.id))
        assert(rp.every((x) => mineIds.has(x.id)), '皆為本 session 首次認領之臂')
    })
})
