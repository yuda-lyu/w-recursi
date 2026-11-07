import rollupFiles from 'w-package-tools/src/rollupFiles.mjs'


let fdSrc = './src'
let fdTar = './dist'


//external與globals之盤點原則:
//1. 本套件src之node內建模組一律以無前綴引用(fs、path、url、crypto、zlib、child_process、util), 與自有套件同一寫法, 故只需一套剔除規則;
//   rollup之external與globals以import字串逐字比對, 'fs'不涵蓋'node:fs', 若日後引用node:前綴須另行列入
//2. 本套件不直接引用任何第三方套件之主入口: lodash-es一律以單函數路徑(lodash-es/<函數>.js)引用, 列於npm依賴之wsemi帶入(package.json不另宣告),
//   屬純函式之ESM小檔且互相只含相對引用, 不剔除而打包進dist(與自有套件對lodash-es/*之處理一致);
//   wsemi本身於src中未被引用, 故無wsemi之剔除清單(tree-kill、dayjs等)需列入
//3. globals右側為引入後的名稱, 不能包含小數點「.」
//4. runin須為nodejs: 本套件僅能於nodejs執行(child_process、fs、zlib、process.kill與Atomics.wait), 未給時rollupFiles預設browser,
//   會以browser欄位解析被打包之相依並警告依賴node內建模組
//5. dist之限制(行為不改, 僅記錄): src內以import.meta.url相對位置取用之資產(src/eval/worker.mjs, 供spawn模式派發子程序; src/search/policyV0.mjs, 供init()寫入預設策略)
//   不在import圖內, 故不隨dist打包; 需用spawn模式或init()者請以ESM深層路徑取用(w-recursi/src/index.mjs等, 套件不設exports)
//盤點方式: 自src/WRecursi.mjs靜態追蹤import圖(含export … from與字串常值之動態import, 並進入node_modules內之lodash-es單檔),
//   共走訪293檔(本套件29、node_modules 264), 未解析0; 裸import只有上列7個node內建模組與45個lodash-es單函數路徑, node_modules內部無再引用之裸import;
//   圖外之本套件檔3個: src/cli.mjs(命令列入口)、src/eval/worker.mjs(子程序入口)、src/search/policyV0.mjs(預設策略, 由init()複製)


rollupFiles({
    fns: 'WRecursi.mjs',
    fdSrc,
    fdTar,
    nameDistType: 'kebabCase',
    runin: 'nodejs',
    globals: {

        //node內建模組
        'path': 'path',
        'fs': 'fs',
        'url': 'url',
        'child_process': 'child_process',
        'crypto': 'crypto',
        'util': 'util',
        'zlib': 'zlib',

    },
    external: [

        //node內建模組
        'path',
        'fs',
        'url',
        'child_process',
        'crypto',
        'util',
        'zlib',

    ],
})


//node toolg/gDistRollup.mjs
