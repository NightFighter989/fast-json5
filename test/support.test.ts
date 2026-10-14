// Tests for the test helpers themselves, so later phases can rely on them.
import { describe, expect, it } from 'vitest'
import { diffValues } from './support/equal.js'
import { json5ErrorPosition, markedPosition, positionAt } from './support/errors.js'
import { loadFixtures } from './support/fixtures.js'

describe('positionAt', () => {
  it('matches the positions json5 reports', () => {
    const inputs = ['x', '  x', '\n\n x', '\r\n\r\n x', '\r\r x', '{\n  a: 1,\n  b c\n}', '"😀" x']
    for (const text of inputs) {
      const offset = text.lastIndexOf(text.includes('c') ? 'c' : 'x')
      expect(positionAt(text, offset), JSON.stringify(text)).toEqual(json5ErrorPosition(text))
    }
  })
})

describe('markedPosition', () => {
  it('strips the marker and locates it', () => {
    expect(markedPosition('{\n  a ¦b: 1}')).toEqual({ text: '{\n  a b: 1}', position: { line: 2, column: 5 } })
  })

  it('requires exactly one marker', () => {
    expect(() => markedPosition('{}')).toThrow()
    expect(() => markedPosition('¦{}¦')).toThrow()
  })
})

describe('diffValues', () => {
  it('accepts identical values', () => {
    expect(diffValues({ a: [1, 'x', null, NaN] }, { a: [1, 'x', null, NaN] })).toBeNull()
  })

  it('distinguishes -0 from 0', () => {
    expect(diffValues([-0], [0])).toBe('$["0"]: got -0, expected 0')
  })

  it('checks key order and own __proto__ keys', () => {
    expect(diffValues({ a: 1, b: 2 }, { b: 2, a: 1 })).toMatch(/keys/)
    expect(diffValues(JSON.parse('{"__proto__": 1}'), {})).toMatch(/keys/)
  })

  it('distinguishes arrays from objects', () => {
    expect(diffValues([], {})).toMatch(/array/)
  })
})

describe('fixtures', () => {
  it('loads the vendored suite with error specs', () => {
    const cases = loadFixtures('json5-tests')
    expect(cases.length).toBe(114)
    const spec = cases.find((c) => c.id === 'json5-tests/arrays/no-comma-array.txt')?.errorSpec
    expect(spec).toMatchObject({ lineNumber: 3, columnNumber: 5 })
  })

  it('preserves CR bytes', () => {
    const crlf = loadFixtures('extra').find((c) => c.id === 'extra/new-lines/comment-crlf.json5')
    expect(crlf?.text).toContain('\r\n')
  })
})
