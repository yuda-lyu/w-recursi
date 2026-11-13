import fs from 'fs'
import path from 'path'


//輪夾之名(單一來源;2026-10-09 —— 輪序原以字典序排, r1000 起取錯末輪 / 摘要序亂;領域端以 `^r\d{3}$` 辨識 ⇒ r1000 起靜默漏輪)
//  名 = r + 輪號(至少 3 位, 左補 0):r001 … r999、r1000 …(roundNameOf;paths.fdRound、explore 之 job tag 同式)
//  isRoundDir(名):是否為某輪(≥ 1)之正規名 —— 與 roundNameOf 互逆(雙射):r052 / r999 / r1000 是;r52 / r0052 / r0999 / r000 / R052 / r05a 否(同一輪只一個名)
//    = `^r\d{3,}$` 之子集(只去掉非正規形:3 位之 r000 與 4 位以上之前導 0);輪號上限 15 位(Number 之安全整數內)
//  roundNumOf(名) → 輪號 | null(非輪夾名);listRoundDirs(夾) → 該夾下之輪夾名, 依輪號升冪(字典序於 r1000 起錯:r1000 < r998);夾不存在 ⇒ []
//  ROUND_NAME_SRC:同一規則之正則源字串(無錨點;供組合他形, 如領域之請求項 id `r{nnn}#N`、日誌名 `r{nnn}_{pid}.log`)
//  領域經協定入口 protocol.mjs 取用(協定件:引擎建之輪夾與領域讀之輪夾必須同一命名)
/**
 * 輪夾名之正則源字串(無錨點;供領域組合他形,如請求項 id 或日誌名):r + 輪號(至少 3 位,r000 與 4 位以上之前導 0 皆非正規名)
 *
 * @type {String}
 */
export const ROUND_NAME_SRC = 'r(?:(?!000)\\d{3}|[1-9]\\d{3,14})'
const RE_ROUND = new RegExp(`^${ROUND_NAME_SRC}$`)
/**
 * 輪號轉輪夾名(至少 3 位,左補 0;與 isRoundDir 互逆)
 *
 * @param {Number} n 輸入輪號(正整數)
 * @returns {String} 回傳輪夾名
 * @example
 * console.log(roundNameOf(52), roundNameOf(1000))
 * // => r052 r1000
 */
export let roundNameOf = (n) => `r${String(n).padStart(3, '0')}`
/**
 * 是否為某輪(≥ 1)之正規輪夾名;同一輪只有一個名(r52、r0052、r000、R052 皆否)
 *
 * @param {*} s 輸入名稱
 * @returns {Boolean} 回傳是否為正規輪夾名
 * @example
 * console.log(isRoundDir('r052'), isRoundDir('r1000'), isRoundDir('r52'), isRoundDir('r000'))
 * // => true true false false
 */
export let isRoundDir = (s) => typeof s === 'string' && RE_ROUND.test(s)
/**
 * 輪夾名轉輪號;非正規輪夾名回 null
 *
 * @param {*} s 輸入輪夾名
 * @returns {Number|null} 回傳輪號或 null
 * @example
 * console.log(roundNumOf('r052'), roundNumOf('x'))
 * // => 52 null
 */
export let roundNumOf = (s) => (isRoundDir(s) ? Number(s.slice(1)) : null)
/**
 * 列出夾下之輪夾名,依輪號升冪(字典序於 r1000 起會錯:r1000 < r998);夾不存在回 []
 *
 * @param {String} fd 輸入夾路徑
 * @returns {Array} 回傳輪夾名陣列
 * @example
 * import fs from 'fs'
 * import os from 'os'
 * import path from 'path'
 *
 * let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-recursi-'))
 * for (let n of ['r999', 'r1000', 'r002', 'r0999', 'tmp']) { fs.mkdirSync(path.join(dir, n)) }
 * console.log(listRoundDirs(dir).join(' '))
 * // => r002 r999 r1000
 * fs.rmSync(dir, { recursive: true, force: true })
 */
export let listRoundDirs = (fd) => (fs.existsSync(fd) ? fs.readdirSync(fd).filter(isRoundDir).sort((a, b) => roundNumOf(a) - roundNumOf(b)) : [])

//狀態根目錄之落點(單一來源):root/tree, root/rounds, root/policies, root/tmp
/**
 * 狀態根目錄之落點(單一來源):root/tree、root/rounds、root/policies、root/tmp;並附 ensure()(建夾)與 fdRound(輪號)
 *
 * @param {String} root 輸入狀態根目錄
 * @param {Object} [opt={}] 輸入選項 { tmp:String(評估 job 暫存夾,未給 ⇒ <root>/tmp) }
 * @returns {Object} 回傳 { root, tree, nodes, index, frontier, lore, slots, rounds, policies, candidates, scores, changelog, current, devRequest, genRequest, governance, govProposals, govProposalsMd, govExtensions, tmp, ensure(), fdRound(r) }(governance 夾只在治理首次寫入時才建,ensure 不建)
 * @throws {Error} 缺 root 時拋出
 * @example
 * let p = makePaths('./demo-root')
 * console.log(path.basename(p.index), path.basename(p.slots), p.fdRound(7).endsWith('r007'))
 * // => index.jsonl .slots true
 */
export let makePaths = (root, { tmp = null } = {}) => {
    if (!root) { throw new Error('makePaths: 缺 root') }
    let R = path.resolve(root)
    let P = {
        root: R,
        tree: path.join(R, 'tree'),
        nodes: path.join(R, 'tree', 'nodes'),
        index: path.join(R, 'tree', 'index.jsonl'),
        frontier: path.join(R, 'tree', 'frontier.jsonl'),
        lore: path.join(R, 'tree', 'lore.jsonl'),
        slots: path.join(R, 'tree', '.slots'),
        rounds: path.join(R, 'rounds'),
        policies: path.join(R, 'policies'),
        candidates: path.join(R, 'policies', 'candidates'),
        scores: path.join(R, 'policies', 'scores.jsonl'),
        changelog: path.join(R, 'policies', 'changelog.md'),
        current: path.join(R, 'policies', 'current.mjs'),
        devRequest: path.join(R, 'policies', '.dev_request.json'),
        genRequest: path.join(R, 'policies', '.gen_request.json'),
        //治理(2026-11-14;search/governance.mjs):提案帳、其渲染、臂目錄之擴充;夾於首次寫入時才建(ensure 不建 ⇒ 未用治理之狀態根佈局與改前相同)
        governance: path.join(R, 'governance'),
        govProposals: path.join(R, 'governance', 'proposals.json'),
        govProposalsMd: path.join(R, 'governance', 'PROPOSALS.md'),
        govExtensions: path.join(R, 'governance', 'extensions.json'),
        tmp:tmp ? path.resolve(tmp) : path.join(R, 'tmp'), //評估 job 暫存(可另指, 如領域自訂之暫存夾)
    }
    P.ensure = () => { for (let d of [P.tree, P.nodes, P.rounds, P.policies, P.candidates, P.tmp]) { fs.mkdirSync(d, { recursive: true }) } }
    P.fdRound = (r) => path.join(P.rounds, roundNameOf(r))
    return P
}

export default makePaths
