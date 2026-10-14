// Public API types. These assertions are checked by `npm run typecheck` (tsc), not at runtime.
import { describe, expectTypeOf, it } from 'vitest'
import { JSON5SyntaxError, parse, type JSON5ErrorCode, type ParseOptions, type Reviver } from '../src/index.js'

describe('types', () => {
  it('parse returns any by default, like JSON.parse, and accepts a generic', () => {
    expectTypeOf(parse('1')).toBeAny()
    expectTypeOf(parse<{ a: number }>('{a: 1}')).toEqualTypeOf<{ a: number }>()
  })

  it('parse takes a reviver or an options object', () => {
    expectTypeOf(parse).parameter(1).toEqualTypeOf<Reviver | ParseOptions | undefined>()
    expectTypeOf<ParseOptions['nonFinite']>().toEqualTypeOf<'allow' | 'reject' | undefined>()
    // @ts-expect-error -- only 'allow' and 'reject'
    parse('1', { nonFinite: 'maybe' })
  })

  it('JSON5SyntaxError is a SyntaxError with typed position fields and code', () => {
    expectTypeOf<JSON5SyntaxError>().toMatchTypeOf<SyntaxError>()
    expectTypeOf<JSON5SyntaxError['lineNumber']>().toEqualTypeOf<number>()
    expectTypeOf<JSON5SyntaxError['columnNumber']>().toEqualTypeOf<number>()
    expectTypeOf<JSON5SyntaxError['offset']>().toEqualTypeOf<number>()
    expectTypeOf<JSON5SyntaxError['code']>().toEqualTypeOf<JSON5ErrorCode>()
  })
})
