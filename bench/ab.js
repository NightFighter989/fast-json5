// Interleaved A/B timing of two builds: `node bench/ab.js <other-dist-dir> [rounds]`.
// Alternates short rounds of each build so machine noise hits both equally, then reports the
// median time ratio per input (< 1.00 means the current dist/ is faster).
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as current } from '../dist/index.js'
import { json5, jsonc, minified, pureJson, smallJson, smallJson5 } from './corpus.js'

const { parse: other } = await import(pathToFileURL(resolve(process.argv[2], 'index.js')).href)
const rounds = Number(process.argv[3] ?? 40)
const cases = { 'pure JSON': pureJson, 'minified JSON': minified, JSONC: jsonc, JSON5: json5, 'small JSON': smallJson, 'small JSON5': smallJson5 }

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
function timeOnce(fn, text, iterations) {
  const t = performance.now()
  for (let i = 0; i < iterations; i++) fn(text)
  return (performance.now() - t) / iterations
}

for (const [label, text] of Object.entries(cases)) {
  // Aim for ~20 ms per round per build.
  const iterations = Math.max(1, Math.round(20 / Math.max(timeOnce(current, text, 20), 0.0005)))
  for (let i = 0; i < 5; i++) timeOnce(current, text, iterations), timeOnce(other, text, iterations) // warm up
  const ratios = []
  const a = []
  const b = []
  for (let r = 0; r < rounds; r++) {
    const [first, second] = r % 2 ? [current, other] : [other, current]
    const t1 = timeOnce(first, text, iterations)
    const t2 = timeOnce(second, text, iterations)
    const [tc, to] = first === current ? [t1, t2] : [t2, t1]
    a.push(tc)
    b.push(to)
    ratios.push(tc / to)
  }
  const unit = (ms) => (ms < 0.1 ? `${(ms * 1000).toFixed(2)} us` : `${ms.toFixed(3)} ms`)
  console.log(`${label.padEnd(14)} current ${unit(median(a)).padStart(10)}   other ${unit(median(b)).padStart(10)}   ratio ${median(ratios).toFixed(3)}`)
}
