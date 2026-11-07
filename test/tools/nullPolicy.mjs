//空策略(測試用):什麼都不提 ⇒ 做夢分數 J = 0
export const meta = { name: 'null', version: '0.0.0', desc: '不提任何臂' }
export default function policy(view, budget, ctx) { return { policy: meta, round: view.round, expand: [], novelty: [], requests: [], stop: [], notes: ['null policy'] } }
