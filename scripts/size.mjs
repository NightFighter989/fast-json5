// Bundle size report: `npm run size`. Bundles each parser the way an app would import it
// (tree-shaken, minified, browser platform) and prints minified, gzip and brotli sizes.
// `npm run size -- --print` also prints fast-json5's minified code, for size reviews.
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = fileURLToPath(new URL('..', import.meta.url))
const fastJson5 = JSON.stringify(fileURLToPath(new URL('../src/index.ts', import.meta.url)))

/** [name, entry module source]. Each entry exposes just the parse function a user would import. */
const entries = [
  ['fast-json5', `export { parse } from ${fastJson5}`],
  ['json5', `import JSON5 from 'json5'; export const parse = JSON5.parse`],
  ['confbox (parseJSON5)', `export { parseJSON5 } from 'confbox'`],
  ['jsonc-parser', `export { parse } from 'jsonc-parser'`],
  ['confbox (parseJSONC)', `export { parseJSONC } from 'confbox'`],
  ['strip-json-comments', `import strip from 'strip-json-comments'; export const parse = (text) => JSON.parse(strip(text, { trailingCommas: true }))`],
]

async function bundle(code) {
  const build = await rolldown({
    input: 'entry',
    cwd: root,
    platform: 'browser',
    logLevel: 'silent',
    plugins: [{ name: 'entry', resolveId: (id) => (id === 'entry' ? id : null), load: (id) => (id === 'entry' ? code : null) }],
  })
  const { output } = await build.generate({ format: 'esm', minify: true })
  await build.close()
  return Buffer.from(output[0].code)
}

const kib = (n) => `${(n / 1024).toFixed(2)} KiB`
const only = process.argv.includes('--print') ? entries.slice(0, 1) : entries
console.log(`${'parser'.padEnd(22)}${'minified'.padStart(11)}${'min+gzip'.padStart(11)}${'min+brotli'.padStart(12)}`)
for (const [name, code] of only) {
  const min = await bundle(code)
  console.log(`${name.padEnd(22)}${kib(min.length).padStart(11)}${kib(gzipSync(min, { level: 9 }).length).padStart(11)}${kib(brotliCompressSync(min).length).padStart(12)}`)
  if (process.argv.includes('--print')) console.log(`\n${min}`)
}
