/**
 * Differential fuzzing against json5. `npm test` runs a quick pass; `npm run test:fuzz` runs a
 * long one. On failure fast-check prints the seed and a shrunk counterexample.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { json5Document, jsonDocument, mutatedDocument } from './support/arbitraries.js'
import { expectSameAsJson5 } from './support/differential.js'
import { json5Parse } from './support/oracle.js'

const numRuns = process.env.FAST_JSON5_TEST_MODE === 'fuzz' ? 200_000 : 300

describe('generators', () => {
  it('json5Document only produces documents json5 accepts', () => {
    fc.assert(
      fc.property(json5Document, (text) => {
        const outcome = json5Parse(text)
        if (!outcome.ok) throw outcome.error
      }),
      { numRuns },
    )
  })

  it('json5Document exercises every JSON5 feature', () => {
    const features: Record<string, RegExp> = {
      'line comment': /\/\//,
      'block comment': /\/\*/,
      'exotic whitespace': /[\v\f\u00A0\uFEFF\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/,
      'CR line break': /\r(?!\n)/,
      'unquoted key': /[{,][^"'{}[\],:]*?[A-Za-z_$\u00C0-\uFFFF][^"'{}[\],:]*:/,
      'escaped key': /[{,]\s*\\u[0-9a-fA-F]{4}/,
      'single-quoted string': /'/,
      'hex escape': /\\x[0-9a-fA-F]{2}/,
      'line continuation': /\\[\n\r\u2028\u2029]/,
      'hex number': /0[xX][0-9a-fA-F]/,
      'leading-dot number': /(^|[^0-9])\.[0-9]/,
      'explicit plus sign': /\+(?:[0-9.]|Infinity|NaN)/,
      'Infinity or NaN': /Infinity|NaN/,
      'trailing comma': /,\s*[\]}]/,
    }
    const sample = fc.sample(json5Document, { numRuns: 2000, seed: 42 })
    const missing = Object.entries(features)
      .filter(([, pattern]) => sample.filter((text) => pattern.test(text)).length < sample.length * 0.01)
      .map(([name]) => name)
    expect(missing).toEqual([])
  })

  it('jsonDocument only produces documents JSON.parse accepts', () => {
    fc.assert(fc.property(jsonDocument, (text) => void JSON.parse(text)), { numRuns })
  })
})

describe('differential vs json5', () => {
  it('agrees on plain JSON', () => {
    fc.assert(fc.property(jsonDocument, expectSameAsJson5), { numRuns })
  })

  // TODO(phase 2): switch these to `it` once the scanner lands; they fail against the stub.
  it.fails('agrees on JSON5 documents', () => {
    fc.assert(fc.property(json5Document, expectSameAsJson5), { numRuns })
  })

  it.fails('agrees on corrupted documents (accepts and rejects the same inputs)', () => {
    fc.assert(fc.property(mutatedDocument, expectSameAsJson5), { numRuns })
  })
})
