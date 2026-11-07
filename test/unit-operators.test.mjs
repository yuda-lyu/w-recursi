import assert from 'assert'
import { makeRegistry } from '../src/search/operators.mjs'
import { specHash } from '../src/core/canonical.mjs'
import * as toy from './tools/toy.mjs'


let P = (x, y, tag) => (tag ? { kind: 'point', x, y, tag } : { kind: 'point', x, y })

describe('search/operators:算子登錄與對照臂', () => {
    let reg = makeRegistry({ operators: toy.operators, validateSpec: toy.validateSpec, familyRank: toy.familyRank })
    it('childrenOf 去除與父相同者、規格無效者(超出範圍)、重複者', () => {
        let kids = reg.childrenOf(P(20, 0))
        let px = kids.filter((k) => k.op === 'P.x')
        assert.deepEqual(px.map((k) => k.spec.x).sort((a, b) => a - b), [18, 19])
        let ph = specHash(P(20, 0))
        assert(kids.every((k) => k.specHash !== ph))
        assert.equal(new Set(kids.map((k) => k.specHash)).size, kids.length)
    })
    it('ops 過濾只展開指定算子', () => {
        let kids = reg.childrenOf(P(0, 0), { ops: ['P.y'] })
        assert.equal(kids.length, 4)
        assert(kids.every((k) => k.op === 'P.y' && k.family === 'P'))
    })
    it('controlsFor:X.cond 之子附 對調 + 恆用 up / down;恆用 up 之 specHash = 父本身(策略可由已執行集合濾掉)', () => {
        let c = reg.childrenOf(P(1, 2), { ops: ['X.cond'] })[0]
        assert.equal(c.spec.kind, 'cond')
        let ctrls = reg.controlsFor(c)
        assert.deepEqual(ctrls.map((x) => x.op).sort(), ['X.condBranch', 'X.condBranch', 'X.condSwap'])
        assert(ctrls.every((x) => x.controlOf === c.specHash))
        let up = ctrls.find((x) => x.params && x.params.branch === 'up')
        assert.equal(up.specHash, specHash(P(1, 2)))
        assert.equal(reg.controlsFor({ op: 'P.x', spec: P(2, 2), specHash: specHash(P(2, 2)) }).length, 0, '無 controls 宣告者為空')
    })
    it('rankOf 依 family;未知算子 9;isControlOp', () => {
        assert.equal(reg.rankOf('X.cond'), 0); assert.equal(reg.rankOf('P.x'), 1); assert.equal(reg.rankOf('T.tag'), 2); assert.equal(reg.rankOf('nope'), 9)
        assert(reg.isControlOp('X.condSwap') && reg.isControlOp('X.condBranch') && !reg.isControlOp('X.cond') && !reg.isControlOp('P.x'))
    })
    it('算子 applies / children 拋錯不中斷其他算子', () => {
        let r = makeRegistry({ operators: [{ name: 'bad', family: 'B', applies: () => true, children: () => { throw new Error('x') } }, { name: 'bad2', family: 'B', applies: () => { throw new Error('y') }, children: () => [] }, ...toy.operators.filter((o) => o.name === 'P.x')], validateSpec: toy.validateSpec })
        assert.equal(r.childrenOf(P(0, 0)).length, 4)
    })
    it('無效變異(tag)是不同規格:specHash 不同, 行為指紋相同', async () => {
        let a = await toy.evaluate(P(1, 1), null), b = await toy.evaluate(P(1, 1, 'a'), null)
        assert.notEqual(specHash(P(1, 1)), specHash(P(1, 1, 'a')))
        assert.equal(toy.fingerprint(a), toy.fingerprint(b))
    })
})
