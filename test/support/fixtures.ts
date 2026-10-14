import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSON5 from 'json5'

export interface ErrorSpec {
  at?: number
  lineNumber?: number
  columnNumber?: number
  message?: string
}

export interface FixtureCase {
  /** Path relative to `test/fixtures`, e.g. `json5-tests/arrays/empty-array.json`. */
  id: string
  text: string
  /** `.json` and `.json5` must parse; `.js` and `.txt` must be rejected. */
  valid: boolean
  errorSpec?: ErrorSpec
}

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))
const CASE_EXTENSIONS = new Set(['.json', '.json5', '.js', '.txt'])

/** Load every case under `test/fixtures/<suite>`, sorted by id. Files are read as UTF-8, byte-for-byte. */
export function loadFixtures(suite: string): FixtureCase[] {
  const cases: FixtureCase[] = []
  for (const file of walk(join(FIXTURES, suite))) {
    const ext = extname(file)
    if (!CASE_EXTENSIONS.has(ext)) continue
    const specFile = file.slice(0, -ext.length) + '.errorSpec'
    cases.push({
      id: relative(FIXTURES, file).replaceAll('\\', '/'),
      text: readFileSync(file, 'utf8'),
      valid: ext === '.json' || ext === '.json5',
      errorSpec: readErrorSpec(specFile),
    })
  }
  return cases.sort((a, b) => (a.id < b.id ? -1 : 1))
}

function readErrorSpec(file: string): ErrorSpec | undefined {
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  // Upstream strings/no-comma-array.errorSpec (an orphan with no case file) misspells columnNumber.
  const { columNumber, ...spec } = JSON5.parse(source) as ErrorSpec & { columNumber?: number }
  return { ...spec, columnNumber: spec.columnNumber ?? columNumber }
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}
