// ESM smoke test of the built package: `npm run build && node test/smoke/smoke.mjs`.
import * as fastJson5 from '../../dist/index.js'
import { runChecks } from './checks.mjs'

runChecks(fastJson5, 'ESM')
