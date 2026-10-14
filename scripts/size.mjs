// Bundle size report: `npm run size`. Builds a minified ESM bundle of the package into a temp
// folder and prints raw, minified, and minified+gzip/brotli sizes, so changes can be compared.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const out = mkdtempSync(join(tmpdir(), 'fast-json5-size-'))
const tsdown = join('node_modules', '.bin', process.platform === 'win32' ? 'tsdown.cmd' : 'tsdown')
const build = (dir, extra) =>
  execFileSync(tsdown, ['src/index.ts', '--format', 'esm', '--no-dts', '--out-dir', join(out, dir), '--platform', 'neutral', ...extra], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  })

try {
  build('plain', [])
  build('min', ['--minify'])
  const plain = readFileSync(join(out, 'plain', 'index.js'))
  const min = readFileSync(join(out, 'min', 'index.js'))
  const kib = (n) => `${(n / 1024).toFixed(2)} KiB`
  console.log(`raw            ${kib(plain.length)}`)
  console.log(`minified       ${kib(min.length)}`)
  console.log(`min + gzip     ${kib(gzipSync(min, { level: 9 }).length)}`)
  console.log(`min + brotli   ${kib(brotliCompressSync(min).length)}`)
  if (process.argv.includes('--print')) console.log(`\n${min}`)
} finally {
  rmSync(out, { recursive: true, force: true })
}
