// Benchmarks the built package (run `npm run build` first) against json5 and strip-json-comments.
import { bench, group, run, summary } from 'mitata'
import JSON5 from 'json5'
import stripJsonComments from 'strip-json-comments'
import { parse } from '../dist/index.js'

const item = (i) => ({ id: i, name: `item ${i}`, tags: ['a', 'b', 'c'], price: i * 1.5, active: i % 2 === 0 })
const data = { items: Array.from({ length: 2000 }, (_, i) => item(i)) }

const pureJson = JSON.stringify(data, null, 2)
// JSONC: comments and trailing commas only, so strip-json-comments can take part.
const jsonc = pureJson.replace(/\n(\s*)"id"/g, '\n$1// entry\n$1"id"').replace(/(\])\n/g, '$1,\n')
// Full JSON5: unquoted keys and single-quoted strings on top of the JSONC features.
const json5 = jsonc.replace(/"(\w+)":/g, '$1:').replace(/"([^"]*)"/g, "'$1'")

const cases = { 'pure JSON': pureJson, JSONC: jsonc, JSON5: json5 }

for (const [label, text] of Object.entries(cases)) {
  group(`${label} (${(text.length / 1024).toFixed(0)} KiB)`, () => {
    summary(() => {
      if (label === 'pure JSON') bench('JSON.parse (ceiling)', () => JSON.parse(text))
      if (label !== 'JSON5') {
        bench('strip-json-comments + JSON.parse', () => JSON.parse(stripJsonComments(text, { trailingCommas: true })))
      }
      bench('json5', () => JSON5.parse(text))
      bench('fast-json5', () => parse(text))
    })
  })
}

await run()
