// Benchmark inputs, generated deterministically so every run measures the same text.

const item = (i) => ({ id: i, name: `item ${i}`, tags: ['a', 'b', 'c'], price: i * 1.5, active: i % 2 === 0 })
const data = { items: Array.from({ length: 2000 }, (_, i) => item(i)) }

/** ~318 KiB of pretty-printed JSON. */
export const pureJson = JSON.stringify(data, null, 2)
/** The same data minified: the densest token stream. */
export const minified = JSON.stringify(data)
/** JSONC: comments and trailing commas only, so strip-json-comments can take part. */
export const jsonc = pureJson.replace(/\n(\s*)"id"/g, '\n$1// entry\n$1"id"').replace(/(\])\n/g, '$1,\n')
/** Full JSON5: unquoted keys and single-quoted strings on top of the JSONC features. */
export const json5 = jsonc.replace(/"(\w+)":/g, '$1:').replace(/"([^"]*)"/g, "'$1'")

/** A small, realistic JSON config (package.json-like, ~1 KiB). */
export const smallJson = JSON.stringify(
  {
    name: 'example',
    version: '1.2.3',
    description: 'A small package used as a benchmark input',
    type: 'module',
    main: './dist/index.cjs',
    exports: { '.': { import: './dist/index.js', require: './dist/index.cjs' } },
    scripts: { build: 'tsdown', test: 'vitest run', lint: 'eslint .' },
    keywords: ['json', 'json5', 'parser', 'config'],
    engines: { node: '>=18' },
    dependencies: {},
    devDependencies: { typescript: '^5.0.0', vitest: '^2.0.0', tsdown: '^0.1.0' },
  },
  null,
  2,
)

/** A small, realistic JSON5 config (tsconfig-like, ~1 KiB) using most JSON5 features. */
export const smallJson5 = `// Project configuration
{
  compilerOptions: {
    target: 'ES2022', // modern output
    module: 'NodeNext',
    strict: true,
    outDir: './dist',
    paths: {
      '@/*': ['./src/*'],
    },
    maxNodeModuleJsDepth: 0x2,
    ratio: .75,
    retries: +3,
    timeout: Infinity,
  },
  /* Files to include */
  include: ['src', 'test',],
  exclude: [
    'node_modules',
    'dist', // build output
  ],
  description: 'A \\
multi-line string',
}
`
