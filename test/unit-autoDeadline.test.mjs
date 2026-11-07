import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { createRsi } from '../src/index.mjs'
import { readJsonl } from '../src/core/jsonl.mjs'
import { DREAM_MUTEX, DEADLINE_WHY } from '../src/loop/auto.mjs'
import { tryAcquireSlots, releaseSlots } from '../src/core/slots.mjs'
import * as toy from './tools/toy.mjs'
import { makeTmp } from './tools/tmpdir.mjs'


//輪之截止點(2026-10-09):loop/auto.mjs 之 opt.deadlineAt / opt.mayStart(做夢開工前判)與鉤子之 deadlineAt
//  AD01 未給 deadlineAt ⇒ 舊行為(做夢照做;鉤子之參數無 deadlineAt;mayStart 縱給亦不呼叫)
//  AD02 截止點已過(未注入 mayStart ⇒ 引擎之預設判)⇒ 略過「輪截止點」:報告之做夢節照現形、不寫分數、dreamSkip 帶 detail / at / deadlineAt;鉤子收 deadlineAt
//  AD03 注入之 mayStart 為準:遠(ok)⇒ 做夢、只呼叫一次且段名 'dream';臨界 / 不足(not ok)⇒ 略過, detail / needSec / leftSec 取自判讀;截止點在未來而判不可亦略過
//  AD04 本輪本不做夢者不判截止點(--no-dream / 同批已做 / 同批進行中 ⇒ 理由照舊, mayStart 不呼叫);--accept 亦受截止點
//  AD05 deadlineAt 非數 ⇒ 探索之前拋錯(不建輪夾)
describe('loop/auto:輪之截止點', function () {
    let t
    before(() => { t = makeTmp('autoDeadline') })
    after(() => { t.cleanup() })
    let fresh = (name, cfg = {}, dom = {}) => createRsi({ root: path.join(t.dir, name), domain: toy.makeDomain(dom), budget: { arms: 6, novelty: 2, workers: 3 }, ...cfg }).init()
    let hookSpy = () => { let seen = []; return { seen, dom: { hooks: { afterRound: async (o) => { seen.push(o); return { lines: ['## 鉤子'] } } } } } }

    it('AD01 未給 deadlineAt ⇒ 舊行為', async function () {
        this.timeout(120000)
        let H = hookSpy()
        let rsi = fresh('none', {}, H.dom)
        let called = 0
        let a = await rsi.auto({ mayStart: () => { called++; return { ok: false } } })
        assert(a.dream && !a.dreamSkip, '做夢照做')
        assert.equal(called, 0, '未給 deadlineAt ⇒ 不呼叫 mayStart')
        assert.equal(H.seen.length, 1); assert(!('deadlineAt' in H.seen[0]), '鉤子之參數無 deadlineAt(= 改前)')
        assert.equal(readJsonl(rsi.paths.scores).length, 1)
    })

    it('AD02 截止點已過(引擎之預設判)⇒ 略過「輪截止點」;鉤子收 deadlineAt', async function () {
        this.timeout(120000)
        let H = hookSpy()
        let rsi = fresh('past', {}, H.dom)
        let at = Date.now() - 1000
        let a = await rsi.auto({ deadlineAt: at })
        assert.equal(a.dream, null)
        assert.equal(a.dreamSkip.why, DEADLINE_WHY); assert.equal(DEADLINE_WHY, '輪截止點')
        assert.equal(a.dreamSkip.detail, '截止點已過'); assert.equal(a.dreamSkip.deadlineAt, new Date(at).toISOString()); assert(Number.isFinite(Date.parse(a.dreamSkip.at)))
        assert.deepEqual(readJsonl(rsi.paths.scores), [], '略過者不寫分數')
        let rep = fs.readFileSync(path.join(a.fd, 'report.md'), 'utf8')
        assert(rep.includes('## 做夢(策略重放打分)\n\n- 略過:輪截止點'), rep.slice(-500))
        assert.equal(H.seen.length, 1); assert.equal(H.seen[0].deadlineAt, at, '鉤子收 deadlineAt')
        assert(Number.isFinite(a.stagesSec.dream) && Number.isFinite(a.stagesSec.hook))
        //未過(引擎之預設判:預留 0)⇒ 做夢
        let b = await fresh('future').auto({ deadlineAt: Date.now() + 3600e3 })
        assert(b.dream && !b.dreamSkip)
    })

    it('AD03 注入之 mayStart 為準(遠 / 臨界 / 不足)', async function () {
        this.timeout(180000)
        let calls = []
        let far = await fresh('far').auto({ deadlineAt: Date.now() + 1e7, mayStart: (st) => { calls.push(st); return { ok: true, why: null, needMs: 1800e3, leftMs: 9e6 } } })
        assert(far.dream && !far.dreamSkip); assert.deepEqual(calls, ['dream'], '只判做夢一次, 段名 dream')
        let edge = await fresh('edge').auto({ deadlineAt: Date.now() + 1800e3, mayStart: () => ({ ok: true, why: null, needMs: 1800e3, leftMs: 1800e3 }) })
        assert(edge.dream, '臨界(now + 預留 = 截止點)⇒ 照做')
        let short = await fresh('short').auto({ deadlineAt: Date.now() + 1e7, mayStart: () => ({ ok: false, why: '距截止點 12.0 分 < 做夢之預留 30.0 分', needMs: 1800e3, leftMs: 720e3 }) })
        assert.equal(short.dream, null)
        assert.deepEqual([short.dreamSkip.why, short.dreamSkip.detail, short.dreamSkip.needSec, short.dreamSkip.leftSec], [DEADLINE_WHY, '距截止點 12.0 分 < 做夢之預留 30.0 分', 1800, 720], '截止點未過而預留不足 ⇒ 略過')
    })

    it('AD04 本輪本不做夢者不判截止點;--accept 亦受之', async function () {
        this.timeout(180000)
        let n = 0
        let ms = () => { n++; return { ok: false, why: 'x' } }
        let a = await fresh('nd').auto({ noDream: true, deadlineAt: Date.now() - 1, mayStart: ms })
        assert.equal(a.dreamSkip.why, '--no-dream')
        let r2 = fresh('iv', { dream: { minIntervalMs: 1e9 } })
        await r2.auto({})
        let b = await r2.auto({ deadlineAt: Date.now() - 1, mayStart: ms })
        assert.equal(b.dreamSkip.why, '同批已做')
        let r3 = fresh('mx', { dream: { minIntervalMs: 1e9 } })
        let h = tryAcquireSlots(path.join(r3.paths.policies, DREAM_MUTEX), { want: 1, max: 1 })
        let c = await r3.auto({ deadlineAt: Date.now() - 1, mayStart: ms })
        assert.equal(c.dreamSkip.why, '同批進行中')
        releaseSlots(h)
        assert.equal(n, 0, '三者皆不呼叫 mayStart(本輪本不做夢 ⇒ 不記為延期)')
        let d = await fresh('acc').auto({ accept: true, deadlineAt: Date.now() - 1 })
        assert.equal(d.dream, null); assert.equal(d.dreamSkip.why, DEADLINE_WHY, '--accept 亦受截止點(時間之硬限)')
    })

    it('AD05 deadlineAt 非數 ⇒ 探索之前拋錯', async function () {
        this.timeout(60000)
        let rsi = fresh('bad')
        await assert.rejects(rsi.auto({ deadlineAt: 'soon' }), /opt\.deadlineAt 須為毫秒之數/)
        assert(!fs.existsSync(rsi.paths.rounds) || fs.readdirSync(rsi.paths.rounds).filter((d) => /^r\d+$/.test(d)).length === 0, '未建輪夾')
    })
})
