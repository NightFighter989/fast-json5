/**
 * Runs the vendored json5-tests suite plus our own fixtures. Valid cases must produce exactly the
 * value json5 produces; invalid cases must throw a SyntaxError.
 *
 * Cases listed in conformance.known-failures.json run as `it.fails`, so a case that starts passing
 * fails the suite until it is removed from the list. Regenerate with `npm run test:update-known`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { expectSameAsJson5 } from './support/differential.js'
import { loadFixtures, type FixtureCase } from './support/fixtures.js'
import { fastParse, json5Parse } from './support/oracle.js'

const KNOWN_FAILURES = new URL('./conformance.known-failures.json', import.meta.url)
const updating = process.env.FAST_JSON5_TEST_MODE === 'update-known'
const known = new Set<string>(JSON.parse(readFileSync(KNOWN_FAILURES, 'utf8')))
const cases = [...loadFixtures('json5-tests'), ...loadFixtures('extra')]

function check(c: FixtureCase): void {
  // Oracle sanity check: the reference implementation must agree with the fixture's extension.
  expect(json5Parse(c.text).ok, 'json5 itself disagrees with this fixture').toBe(c.valid)
  expect(fastParse(c.text).ok, c.valid ? 'should parse' : 'should be rejected').toBe(c.valid)
  expectSameAsJson5(c.text)
}

describe('conformance', () => {
  const failing: string[] = []

  for (const c of cases) {
    if (updating) {
      it(c.id, () => {
        try {
          check(c)
        } catch {
          failing.push(c.id)
        }
      })
    } else if (known.has(c.id)) {
      it.fails(`${c.id} [known failure]`, () => check(c))
    } else {
      it(c.id, () => check(c))
    }
  }

  it('known-failures list only names existing cases', () => {
    const ids = new Set(cases.map((c) => c.id))
    expect([...known].filter((id) => !ids.has(id))).toEqual([])
  })

  if (updating) {
    afterAll(() => writeFileSync(KNOWN_FAILURES, `${JSON.stringify(failing.sort(), null, 2)}\n`))
  }
})
