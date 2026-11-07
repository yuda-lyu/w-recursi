//玩具領域之臂目錄(test/unit-arms 用;對應 tools/toy.mjs 之算子 P.x / P.y / T.tag / X.cond 與載體 origin / far)
export const LAYERS = { P: '位置層(x / y 之步進)', T: '標籤層(無效變異)', X: '條件層(分支與對照)', R: '根(載體)', I: '評估(不可選)', J: '封鎖' }
export const ARMS = [
    { id: 'px', n: 1, layer: 'P', title: 'x 步進', desc: '±1 / ±2', status: 'partial', realize: [{ kind: 'operator', op: 'P.x' }, { kind: 'spec', path: 'x' }], grid: { x: [-2, -1, 1, 2] }, used: { x: [-1, 1] }, verdict: '進行中', refs: { lore: [1] } },
    { id: 'py', n: 2, layer: 'P', title: 'y 步進', desc: '±1 / ±2', status: 'sparse', realize: [{ kind: 'operator', op: 'P.y' }, { kind: 'spec', path: 'y' }], grid: { y: [-2, -1, 1, 2] }, used: { y: [] } },
    { id: 'tag', n: 3, layer: 'T', title: '無效變異 tag', desc: '行為等價之規格變異', status: 'done', realize: [{ kind: 'operator', op: 'T.tag' }, { kind: 'spec', path: 'tag' }], verdict: '結案:行為別名', reopen: '只供別名偵測之測試' },
    { id: 'cond', n: 4, layer: 'X', title: '條件分支(含對照)', desc: 'X.cond + 對調 / 恆用分支', status: 'partial', realize: [{ kind: 'operator', op: 'X.cond' }, { kind: 'operator', op: 'X.condSwap' }, { kind: 'operator', op: 'X.condBranch' }], conflicts: ['tag'] },
    { id: 'far', n: 5, layer: 'R', title: '遠點載體', desc: '載體 far', status: 'proposed', realize: [{ kind: 'carrier', name: 'far' }, { kind: 'origin', op: 'root' }] }, //origin:載體之根節點(origin.operator = root)計入覆蓋
    { id: 'eval', n: 6, layer: 'I', title: '評估量尺', desc: '非生成臂', status: 'done', selectable: false, realize: [{ kind: 'manual', how: '量尺' }] },
    { id: 'blk', n: 7, layer: 'J', title: '封鎖之臂', desc: '—', status: 'blocked', blockedBy: '測試之裁示', realize: [{ kind: 'manual', how: '—' }] },
    { id: 'pair', n: 8, layer: 'P', title: 'x 與 y 同步(依賴 px)', desc: '須與 px 同選', status: 'sparse', realize: [{ kind: 'operator', op: 'P.y' }], requires: ['px'] },
]
export const CATALOG = { version: 1, name: 'toy arms', layers: LAYERS, arms: ARMS }
export default CATALOG
