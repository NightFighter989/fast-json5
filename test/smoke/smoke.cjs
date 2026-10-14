// CommonJS smoke test of the built package: `npm run build && node test/smoke/smoke.cjs`.
const fastJson5 = require('../../dist/index.cjs')

import('./checks.mjs')
  .then(({ runChecks }) => runChecks(fastJson5, 'CJS'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
