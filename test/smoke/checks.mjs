// Runtime smoke checks against the built package, with no dependencies, so they run on every
// runtime fast-json5 claims to support (Node 18+, Bun, Deno), including ones the dev toolchain
// can't run on. Used by smoke.mjs (ESM) and smoke.cjs (CommonJS).

const ch = (...codes) => String.fromCharCode(...codes)

export function runChecks({ parse, JSON5SyntaxError }, label) {
  let failures = 0
  const check = (name, fn) => {
    try {
      fn()
    } catch (error) {
      failures++
      console.error(`FAIL ${label}: ${name}\n  ${error && error.stack ? error.stack : error}`)
    }
  }
  const equal = (actual, expected) => {
    const a = JSON.stringify(actual, (_, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))
    const e = JSON.stringify(expected, (_, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))
    if (a !== e) throw new Error(`expected ${e}, got ${a}`)
  }

  check('plain JSON', () => equal(parse('{"a": [1, "x", true, null]}'), { a: [1, 'x', true, null] }))
  check('JSON5 syntax', () =>
    equal(parse(`// c\n{a: 'x', b: 0xFF, c: .5, d: +1, e: [1, 2,], f: 'l\\\nm', 'g': "\\x41"}`), {
      a: 'x', b: 255, c: 0.5, d: 1, e: [1, 2], f: 'lm', g: 'A',
    }))
  check('Infinity and NaN', () => {
    const v = parse('[Infinity, -Infinity, NaN]')
    if (v[0] !== Infinity || v[1] !== -Infinity || !Number.isNaN(v[2])) throw new Error(String(v))
  })
  check('Unicode keys and whitespace', () => equal(parse(`${ch(0xfeff)}{${ch(0xfc)}ml: 1,${ch(0xa0)}${ch(0x3c0)}: 2}`), { [`${ch(0xfc)}ml`]: 1, [ch(0x3c0)]: 2 }))
  check('reviver', () => equal(parse('[1, NaN]', (k, v) => (typeof v === 'number' ? (Number.isNaN(v) ? 'nan' : v * 2) : v)), [2, 'nan']))
  check('nonFinite reject', () => {
    try {
      parse('NaN', { nonFinite: 'reject' })
    } catch (error) {
      if (error.code === 'NON_FINITE_NOT_ALLOWED') return
      throw error
    }
    throw new Error('did not throw')
  })
  check('JSON5SyntaxError', () => {
    try {
      parse('{\n  a: 1\n  b: 2\n}')
    } catch (error) {
      if (!(error instanceof JSON5SyntaxError) || !(error instanceof SyntaxError)) throw new Error('wrong class')
      if (error.name !== 'SyntaxError' || error.lineNumber !== 3 || error.columnNumber !== 3 || error.code !== 'UNEXPECTED_CHARACTER') {
        throw new Error(`wrong fields: ${error.name} ${error.lineNumber}:${error.columnNumber} ${error.code}`)
      }
      return
    }
    throw new Error('did not throw')
  })
  check('deep nesting', () => {
    let v = parse(`${'['.repeat(20000)}${']'.repeat(20000)}`)
    let depth = 0
    while (Array.isArray(v)) {
      depth++
      v = v[0]
    }
    if (depth !== 20000) throw new Error(`depth ${depth}`)
  })

  const runtime = typeof Deno !== 'undefined' ? `Deno ${Deno.version.deno}` : typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`
  if (failures) throw new Error(`${failures} smoke check(s) failed (${label}, ${runtime})`)
  console.log(`ok: ${label} smoke checks pass on ${runtime}`)
}
