import { makePaths } from '../../src/core/paths.mjs'
import { makeStore } from '../../src/tree/store.mjs'
import { makeNode } from '../../src/tree/node.mjs'
import { makeDomain } from './toy.mjs'


//樹寫入之多程序測試子程序:寫 n 個節點(id = prefix_i)
let [root, prefix, n] = process.argv.slice(2)
let paths = makePaths(root)
paths.ensure()
let store = makeStore({ paths, domain: makeDomain() })
for (let i = 0; i < Number(n); i++) {
    store.putNode(makeNode({ id: `${prefix}_${i}`, spec: { kind: 'point', x: i % 10, y: 0 }, status: 'executed' }, makeDomain()))
}
console.log(`done ${prefix}`)
