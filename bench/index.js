// Benchmarks the built package (run `npm run build` first) against json5 and strip-json-comments.
import { bench, group, run, summary } from 'mitata'
import JSON5 from 'json5'
import stripJsonComments from 'strip-json-comments'
import { parse } from '../dist/index.js'
import { json5, jsonc, minified, pureJson, smallJson, smallJson5 } from './corpus.js'

// [label, text, kind]: 'json' inputs also run JSON.parse; 'jsonc' and 'json' also run strip-json-comments.
const cases = [
  ['pure JSON', pureJson, 'json'],
  ['minified JSON', minified, 'json'],
  ['JSONC', jsonc, 'jsonc'],
  ['JSON5', json5, 'json5'],
  ['small JSON config', smallJson, 'json'],
  ['small JSON5 config', smallJson5, 'json5'],
]

for (const [label, text, kind] of cases) {
  const size = text.length < 4096 ? `${text.length} B` : `${(text.length / 1024).toFixed(0)} KiB`
  group(`${label} (${size})`, () => {
    summary(() => {
      if (kind === 'json') bench('JSON.parse (ceiling)', () => JSON.parse(text))
      if (kind !== 'json5') {
        bench('strip-json-comments + JSON.parse', () => JSON.parse(stripJsonComments(text, { trailingCommas: true })))
      }
      bench('json5', () => JSON5.parse(text))
      bench('fast-json5', () => parse(text)).baseline(true)
    })
  })
}

await run()
