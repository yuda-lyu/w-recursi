//由「生效目錄之可選臂」推導算子之玩具領域(README §2c 之用法;2026-11-14 使用端 Gitea #144 之回歸測試用)
//  每個 selectable === true 之臂登錄算子 add:<臂 id>(不適用、不產子);停用或不可選之臂不登錄 ——
//  治理之審定改變可選與否後, 下一次組裝之登錄表隨之改變(本程序組裝時之登錄表則仍含之)
let arm = (id, n) => ({ id, n, layer: 'A', title: `臂 ${id}`, status: 'proposed', selectable: true, realize: [{ kind: 'operator', op: `add:${id}` }] })

export const DERIVED_BASE = { layers: { A: '層 A' }, arms: [arm('A01_x', 1), arm('A02_y', 2)] }

export let derivedDomainOf = (catalog) => ({
    name: 'derived',
    score: () => ({ S: 0, ladder: 0, flags: {} }),
    operators: catalog.arms.filter((a) => a.selectable === true).map((a) => ({ name: `add:${a.id}`, family: a.layer, applies: () => false, children: () => [] })),
})

export default derivedDomainOf
