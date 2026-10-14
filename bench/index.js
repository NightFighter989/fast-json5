// Benchmarks the built package (run `npm run build` first) against popular JSON5/JSONC parsers.
import { parseJSON5 as confboxJSON5, parseJSONC as confboxJSONC } from 'confbox'
import { parse as jsoncParser } from 'jsonc-parser'
import JSON5 from 'json5'
import { bench, group, run, summary } from 'mitata'
import stripJsonComments from 'strip-json-comments'
import { parse } from '../dist/index.js'
import { json5, jsonc, minified, pureJson, smallJson, smallJson5 } from './corpus.js'

// [label, text, kind]: 'json' inputs also run JSON.parse; JSON5 syntax limits who can take part.
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
      bench('fast-json5', () => parse(text)).baseline(true)
      if (kind === 'json') bench('JSON.parse (ceiling)', () => JSON.parse(text))
      bench('json5', () => JSON5.parse(text))
      bench('confbox parseJSON5', () => confboxJSON5(text))
      if (kind !== 'json5') {
        // jsonc-parser never throws; it collects errors. allowTrailingComma matches JSONC as used in tsconfig.
        bench('jsonc-parser', () => jsoncParser(text, [], { allowTrailingComma: true }))
        bench('confbox parseJSONC', () => confboxJSONC(text, { allowTrailingComma: true }))
        bench('strip-json-comments + JSON.parse', () => JSON.parse(stripJsonComments(text, { trailingCommas: true })))
      }
    })
  })
}

await run()
