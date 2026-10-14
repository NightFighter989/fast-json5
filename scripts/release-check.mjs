// Pre-publish sanity checks: `npm run release:check`. Run by the release workflow before
// `npm publish`; also useful locally. Exits non-zero with a list of problems.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const problems = []

// npm provenance links the package to its source repository, so this must be the real one.
const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
if (!repo || /OWNER|example/i.test(repo)) problems.push('package.json "repository" is missing or still a placeholder')
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version) || pkg.version === '0.0.0') problems.push(`version ${pkg.version} is not releasable`)
if (!changelog.includes(`## ${pkg.version}`)) problems.push(`CHANGELOG.md has no "## ${pkg.version}" section`)

// In CI the tag being released must match the version being published.
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined
if (tag && tag !== `v${pkg.version}`) problems.push(`tag ${tag} does not match version v${pkg.version}`)

// The tarball should hold exactly the build, the docs and the license.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packResult = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', shell: process.platform === 'win32' }))
// npm 10 and 11 print an array of packages; npm 12 prints an object keyed by package name.
const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0]
const files = packed.files.map((f) => f.path).sort()
const expected = ['LICENSE', 'README.md', 'dist/index.cjs', 'dist/index.d.cts', 'dist/index.d.ts', 'dist/index.js', 'package.json']
if (JSON.stringify(files) !== JSON.stringify(expected)) problems.push(`unexpected tarball contents: ${files.join(', ')} (run npm run build first?)`)

if (problems.length > 0) {
  console.error(`Not ready to release ${pkg.name}@${pkg.version}:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`${pkg.name}@${pkg.version} is ready: ${files.length} files, ${(packed.size / 1024).toFixed(1)} KiB packed`)
