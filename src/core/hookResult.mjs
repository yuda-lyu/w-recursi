//領域鉤子失敗之結果形(單一來源;2026-10-09 —— 原於 loop/auto.mjs 與領域之尾段續跑各手寫一份)
//  hookFailureOf(err) → { failed: true, errors: [訊息], lines: ['## 領域鉤子失敗', '', '- 訊息'] }:鉤子(domain.hooks.afterRound)拋錯時之結果
//    消費者:auto 之 hook 欄(CLI 以 hook.failed 非 0 結束)、輪次報告之該節(驗收以「## 領域鉤子失敗」偵測鉤子錯誤段)、領域之 DONE.json 之 hookFailed
//  hookErrText(err) → 訊息(Error 取 message, 否則字串化;兩處原式 String((e && e.message) || e))
//  無相依(協定入口 protocol.mjs 轉出;領域之輕量模組經協定入口取)
/**
 * 領域鉤子失敗之報告節標題(驗收以此字樣偵測鉤子錯誤段)
 *
 * @type {String}
 */
export const HOOK_FAIL_HEAD = '## 領域鉤子失敗'
/**
 * 鉤子拋出物轉訊息:Error 取 message,否則字串化
 *
 * @param {*} e 輸入拋出物
 * @returns {String} 回傳訊息
 * @example
 * console.log(hookErrText(new Error('x')), hookErrText('y'))
 * // => x y
 */
export let hookErrText = (e) => String((e && e.message) || e)
/**
 * 領域鉤子(domain.hooks.afterRound)拋錯時之結果形:{ failed: true, errors, lines };auto 之 hook 欄、輪次報告之該節與領域之尾段續跑共用
 *
 * @param {*} e 輸入拋出物
 * @returns {Object} 回傳 { failed:true, errors:Array, lines:Array }
 * @example
 * console.log(JSON.stringify(hookFailureOf(new Error('boom'))))
 * // => {"failed":true,"errors":["boom"],"lines":["## 領域鉤子失敗","","- boom"]}
 */
export let hookFailureOf = (e) => { let msg = hookErrText(e); return { failed: true, errors: [msg], lines: [HOOK_FAIL_HEAD, '', `- ${msg}`] } }

export default { HOOK_FAIL_HEAD, hookErrText, hookFailureOf }
