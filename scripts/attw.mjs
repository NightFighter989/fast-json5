// Runs @arethetypeswrong/cli on a freshly packed tarball (`npm run lint:pkg`).
// `npm publish --dry-run` sets npm_config_dry_run for lifecycle scripts, which would turn attw's
// internal `npm pack` into a dry run too, leaving no tarball to check; so clear it here.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const env = { ...process.env }
delete env.npm_config_dry_run
const win = process.platform === 'win32'
execFileSync(join('node_modules', '.bin', win ? 'attw.cmd' : 'attw'), ['--pack', '.'], { stdio: 'inherit', env, shell: win })
