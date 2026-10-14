# fast-json5

> Work in progress. Not yet published.

A JSON5 parser that doesn't build values in JavaScript. It scans JSON5 source, rewrites the JSON5-only syntax into plain JSON, and passes the result to the engine's native `JSON.parse`.

```ts
import { parse } from 'fast-json5'

parse(`{
  // comments
  unquoted: 'single quotes',
  hex: 0xFF,
  trailing: [1, 2, 3,],
}`)
```

It's a drop-in replacement for `JSON5.parse(text, reviver)` from [`json5`](https://www.npmjs.com/package/json5). It has no dependencies, ships ESM and CommonJS builds, and includes TypeScript types.

See [PLAN.md](./PLAN.md) for the design and roadmap.

## License

MIT
