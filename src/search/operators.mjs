import get from 'lodash-es/get.js'
import includes from 'lodash-es/includes.js'
import isFunction from 'lodash-es/isFunction.js'
import isNumber from 'lodash-es/isNumber.js'
import keyBy from 'lodash-es/keyBy.js'
import size from 'lodash-es/size.js'
import some from 'lodash-es/some.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { specHash } from '../core/canonical.mjs'


//算子登錄(參數型;免 LLM):parent spec → 候選子 spec
//  operator: { name, family, applies(spec) → bool, children(spec) → [{ spec, params, reason }], controls?: [算子名](此算子之子必附之對照臂由哪些算子產生), rank? }
//  familyRank:{ family: rank }(小者優先);rankOf(opName) 供策略排序
/**
 * 算子登錄(參數型;免 LLM):parent spec → 候選子 spec;驗證(validateSpec)、去重(specHash)、對照臂(controls)、排序(familyRank、op.rank)
 *
 * @param {Object} [o={}] 輸入 { operators:Array([{ name, family, applies(spec), children(spec) → [{ spec, params, reason }], controls?:[算子名], rank? }]), validateSpec:Function, familyRank:Object }
 * @returns {Object} 回傳 { operators, childrenOf(spec, { ops }), controlsFor(child), rankOf(opName), isControlOp(opName), names }
 * @example
 * let reg = makeRegistry({
 *     operators: [{ name: 'inc', family: 'f', applies: () => true, children: (s) => [{ spec: { n: s.n + 1 }, params: { by: 1 } }] }],
 *     familyRank: { f: 1 },
 * })
 * let kids = reg.childrenOf({ n: 0 })
 * console.log(kids.length, kids[0].op, kids[0].spec.n, reg.rankOf('inc'), reg.rankOf('none'))
 * // => 1 inc 1 1 9
 */
export let makeRegistry = ({ operators = [], validateSpec = null, familyRank = {} } = {}) => {
    let ok = (spec) => { if (!isFunction(validateSpec)) { return true } try { validateSpec(spec); return true } catch (e) { return false } }
    let byName = keyBy(operators, 'name')
    let childrenOf = (spec, opt = {}) => {
        let only = get(opt, 'ops', null)
        let ph = specHash(spec)
        let out = []
        for (let op of operators) {
            if (only && !only.includes(op.name)) { continue }
            let app
            try { app = op.applies(spec) } catch (e) { app = false }
            if (!app) { continue }
            let kids
            try { kids = op.children(spec) || [] } catch (e) { kids = [] }
            for (let c of kids) {
                if (!c || !c.spec) { continue }
                let h = specHash(c.spec)
                if (h === ph || !ok(c.spec)) { continue }
                out.push({ op: op.name, family: op.family || null, spec: c.spec, specHash: h, params: c.params || null, reason: c.reason || op.name })
            }
        }
        return uniqBy(out, 'specHash')
    }
    //對照臂:產生 child 之算子若宣告 controls, 以那些算子對 child.spec 展開(附 controlOf = child.specHash)
    let controlsFor = (child) => {
        let op = byName[child.op]
        if (!op || !size(op.controls)) { return [] }
        return childrenOf(child.spec, { ops: op.controls }).map((c) => ({ ...c, controlOf: child.specHash, reason: `${c.reason}(${child.op} 之對照)` }))
    }
    let rankOf = (opName) => { let op = byName[opName]; if (!op) { return 9 } return isNumber(op.rank) ? op.rank : (get(familyRank, op.family, 9)) }
    let isControlOp = (opName) => some(operators, (o) => includes(o.controls || [], opName))
    return { operators, childrenOf, controlsFor, rankOf, isControlOp, names: operators.map((o) => o.name) }
}

export default makeRegistry
