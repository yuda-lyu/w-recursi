import assert from 'assert'
import _ from 'lodash-es'
import policy, { meta } from '../src/search/policyV0.mjs'
import { makeRegistry } from '../src/search/operators.mjs'
import { specHash } from '../src/core/canonical.mjs'
import * as toy from './tools/toy.mjs'


let P = (x, y) => ({ kind: 'point', x, y })
let reg = makeRegistry({ operators: toy.operators, validateSpec: toy.validateSpec, familyRank: toy.familyRank })
let ctxOf = (executed = new Set(), over = {}) => ({ childrenOf: reg.childrenOf, controlsFor: reg.controlsFor, rankOf: reg.rankOf, carriers: toy.carriers, specHash, executed, excludeParent: null, ...over })
let N = (id, spec, S, ladder, over = {}) => ({ id, parent: 'root', round: 1, status: 'executed', spec, children: [], aliasOf: null, score: { S, ladder }, ...over })
let mains = (plan) => plan.expand.filter((x) => !x.controlOf)

describe('search/policyV0:通用預設探索策略', () => {
    it('冷啟動(無可展開父):全部給新區域(載體), 不展開', () => {
        let plan = policy({ round: 1, nodes: [], frontier: [] }, { arms: 6, novelty: 2 }, ctxOf())
        assert.equal(plan.expand.length, 0)
        assert.equal(plan.novelty.length, 2)
        assert(plan.notes.some((s) => /冷啟動/.test(s)))
        assert.equal(plan.policy.name, meta.name)
    })
    it('預算:展開 ≤ arms − novelty;X.cond 之對照臂整族計入(放不進就跳過該子)', () => {
        let nodes = [N('p', P(1, 2), 90, 4)]
        let plan = policy({ round: 2, nodes, frontier: [] }, { arms: 5, novelty: 1 }, ctxOf())
        assert.equal(plan.expand.length, 4)
        assert(plan.expand.every((x) => /^X\./.test(x.op)), 'armsMain 4 恰容 X.cond 族(1 + 3 對照)')
        assert.equal(plan.expand.filter((x) => x.controlOf).length, 3)
        let plan2 = policy({ round: 2, nodes, frontier: [] }, { arms: 4, novelty: 1 }, ctxOf())
        assert.equal(plan2.expand.length, 3)
        assert(plan2.expand.every((x) => !/^X\./.test(x.op)), 'armsMain 3 容不下 X.cond 族 ⇒ 跳過, 改展 P 族')
        assert(plan2.expand.every((x) => !x.controlOf))
    })
    it('不重提已執行 / 已認領之規格', () => {
        let nodes = [N('p', P(1, 2), 90, 4)]
        let all = new Set(reg.childrenOf(P(1, 2)).map((k) => k.specHash))
        let plan = policy({ round: 2, nodes, frontier: [] }, { arms: 8, novelty: 0 }, ctxOf(all))
        assert.equal(plan.expand.length, 0)
        //部分已執行:X.cond 之子已執行 ⇒ 不再提(其對照亦不提)
        let xc = reg.childrenOf(P(1, 2), { ops: ['X.cond'] })[0]
        let plan2 = policy({ round: 2, nodes, frontier: [] }, { arms: 8, novelty: 0 }, ctxOf(new Set([xc.specHash])))
        assert(plan2.expand.every((x) => x.specHash !== xc.specHash && x.controlOf !== xc.specHash))
    })
    it('每父每輪最多 3 個主臂;父依 ladder、S 排序', () => {
        let nodes = [N('a', P(1, 2), 10, 1), N('b', P(-3, 4), 50, 4), N('c', P(5, -6), 40, 4)]
        let plan = policy({ round: 2, nodes, frontier: [] }, { arms: 30, novelty: 0 }, ctxOf())
        let byParent = _.countBy(mains(plan), 'parentId')
        assert(_.every(byParent, (v) => v <= 3), JSON.stringify(byParent))
        assert.equal(mains(plan)[0].parentId, 'b')
        assert.equal(_.uniq(mains(plan).map((x) => x.parentId)).indexOf('c'), 1)
    })
    it('譜系停止:連續兩代 ladder ≤ 1 且 S 未高於父 ⇒ 不展開並列入 stop', () => {
        let a = N('a', P(1, 2), 50, 4), b = N('b', P(2, 2), 40, 1, { parent: 'a' }), c = N('c', P(3, 2), 30, 1, { parent: 'b' })
        let plan = policy({ round: 3, nodes: [a, b, c], frontier: [] }, { arms: 30, novelty: 0 }, ctxOf())
        assert(plan.stop.includes('c'))
        assert(!mains(plan).some((x) => x.parentId === 'c'))
        assert(mains(plan).some((x) => x.parentId === 'b'), 'b 只有一代停滯, 仍可展開')
    })
    it('別名節點與 excludeParent 命中者不作父;children 已滿(8)者不作父', () => {
        let nodes = [N('a', P(1, 2), 50, 4, { aliasOf: 'z' }), N('b', P(2, 2), 40, 4), N('c', P(3, 3), 45, 4, { children: _.range(8).map(String) })]
        let plan = policy({ round: 2, nodes, frontier: [] }, { arms: 30, novelty: 0 }, ctxOf(new Set(), { excludeParent: (n) => n.id === 'b' }))
        assert.equal(plan.expand.length, 0)
        assert(plan.notes.some((s) => /冷啟動/.test(s)))
    })
    it('決定性:同輸入同計畫', () => {
        let nodes = [N('a', P(1, 2), 50, 4), N('b', P(-3, 4), 60, 4)]
        let p1 = policy({ round: 2, nodes, frontier: [] }, { arms: 8, novelty: 2 }, ctxOf())
        let p2 = policy({ round: 2, nodes, frontier: [] }, { arms: 8, novelty: 2 }, ctxOf())
        assert.equal(JSON.stringify(p1), JSON.stringify(p2))
    })
    it('新區域:前緣 arm 優先於載體;已執行之載體不再提;算子 / 終點請求列於 requests', () => {
        let nodes = [N('a', P(1, 2), 50, 4)]
        let fr = [{ kind: 'arm', status: 'proposed', spec: P(7, 7), specHash: specHash(P(7, 7)), reason: 'idea', priority: 1, proposedAt: '2026' }, { kind: 'operator', status: 'proposed', topic: 'T1', title: '新算子', needs: 'code', priority: 2 }]
        let exec = new Set([specHash(toy.carriers.origin)])
        let plan = policy({ round: 2, nodes, frontier: fr }, { arms: 8, novelty: 2 }, ctxOf(exec))
        assert.equal(plan.novelty.length, 2)
        assert.equal(plan.novelty[0].specHash, specHash(P(7, 7)))
        assert.equal(plan.novelty[1].specHash, specHash(toy.carriers.far))
        assert.equal(plan.requests.length, 1)
        assert.equal(plan.requests[0].kind, 'operator')
    })
})
