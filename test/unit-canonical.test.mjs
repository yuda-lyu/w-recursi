import assert from 'assert'
import { canonicalJson, specHash, nodeIdOf, sha } from '../src/core/canonical.mjs'


describe('core/canonical:規格正規化、雜湊、節點 id', () => {
    it('鍵順序無關(含巢狀與陣列內物件)', () => {
        let a = { b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }
        let b = { a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }
        assert.equal(canonicalJson(a), canonicalJson(b))
        assert.equal(specHash(a), specHash(b))
    })
    it('陣列順序有關', () => { assert.notEqual(specHash({ a: [1, 2] }), specHash({ a: [2, 1] })) })
    it('specHash 為 16 位十六進位;sha 可指定長度', () => {
        assert.match(specHash({ x: 1 }), /^[0-9a-f]{16}$/)
        assert.equal(sha('abc', 8).length, 8)
    })
    it('nodeIdOf:同規格同環境同 id;環境不同則不同', () => {
        assert.equal(nodeIdOf({ x: 1 }, 'e1'), nodeIdOf({ x: 1 }, 'e1'))
        assert.notEqual(nodeIdOf({ x: 1 }, 'e1'), nodeIdOf({ x: 1 }, 'e2'))
        assert.notEqual(nodeIdOf({ x: 1 }, 'e1'), nodeIdOf({ x: 2 }, 'e1'))
    })
    it('與領域既有實作相容:id = sha(canonicalJson|env)', () => {
        //領域端之節點 id 式:sha(`${canonicalJson(spec)}|${codeHash}|${extraHash}|${dataEnd}|${srcHash}`, 16)
        let env = `code123|extra|2026-07-31|src9`
        assert.equal(nodeIdOf({ kind: 'type', type: 'node63' }, env), sha(`${canonicalJson({ kind: 'type', type: 'node63' })}|${env}`, 16))
    })
})
