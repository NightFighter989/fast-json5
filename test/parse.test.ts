import { describe, expect, it } from 'vitest'
import { parse } from '../src/index.js'

describe('parse', () => {
  it('parses plain JSON', () => {
    expect(parse('{"a": [1, 2.5, "x", true, null]}')).toEqual({ a: [1, 2.5, 'x', true, null] })
  })

  it('accepts a reviver as the second argument', () => {
    expect(parse('[1, 2]', (_k, v) => (typeof v === 'number' ? v * 10 : v))).toEqual([10, 20])
  })

  it.todo('strips comments')
  it.todo('drops trailing commas')
  it.todo('quotes unquoted (including Unicode) keys')
  it.todo('converts single-quoted strings')
  it.todo('converts JSON5-only escapes')
  it.todo('normalises hex, leading/trailing-dot and signed numbers')
  it.todo('returns Infinity, -Infinity and NaN')
  it.todo('rejects invalid JSON5 such as {a b: 1}')
  it.todo('reports errors at original line and column')
})
