# fast-json5: plan

## Goal

A spec-compliant JSON5 `parse` that is much faster than [`json5`](https://www.npmjs.com/package/json5). It scans the source once, rewrites the JSON5-only syntax into JSON, and hands that JSON to the native `JSON.parse`, which builds the objects.

The package exports one `parse` function plus its types, has no dependencies, ships ESM and CJS, and works in Node 18+, Bun, Deno and browsers.

**Selling point:** a benchmark table against `json5`, `strip-json-comments` + `JSON.parse`, and bare `JSON.parse` as the ceiling.

### Prior art (checked on npm, 2026-10-14)

| Package | Approach | Gap |
| --- | --- | --- |
| `strip-json-comments` | Text patch, then `JSON.parse` | JSONC only: comments and trailing commas |
| `json5` 2.2.3 | Full parser in JS | Slow; it builds every value itself |
| `json11`, `@croct/json5-parser`, `jju`, `lezer-json5` | Full or lossless parsers | Same cost as `json5`, or aimed at editing |
| `confbox` | Wraps an existing parser | Same as above |

I found no JSON5→JSON text transformer. The name `fast-json5` is free on npm.

---

## Public API

```ts
export type Reviver = (this: any, key: string, value: any) => any
export interface ParseOptions {
  reviver?: Reviver
  nonFinite?: 'allow' | 'reject'   // default 'allow'
}
export function parse<T = any>(text: string, reviverOrOptions?: Reviver | ParseOptions): T
```

- `parse(text, reviver)` matches `JSON5.parse`, so it's a drop-in replacement.
- The return type is `any`, matching `JSON.parse` and `json5`. Callers can narrow it with the generic.
- Errors are `SyntaxError` instances with `lineNumber` and `columnNumber` properties, the same fields `json5` uses. The message reports the position in the **original** source.
- Possible later addition: `export function toJSON(text): string`, which exposes the transform itself. It costs almost nothing to add and is useful for piping into other JSON tools. We'll decide once the core is stable.

---

## Core design

### 1. One scanner, copy only when something changes

- The scanner tracks a cursor index and a `last` index. The output is an array of chunks: `text.slice(last, i)` followed by the replacement text.
- If nothing needed rewriting, it **returns the original string**. That means no copy, and pure JSON costs one scan plus `JSON.parse`.
- It jumps over long runs with sticky (`/y`) regexes and `indexOf`. Examples: string bodies via `/[^"'\\\x00-\x1f]*/y`, comment bodies via `indexOf('*/')` and `indexOf('\n')`, and runs of plain whitespace and number characters. It only handles characters one at a time at token boundaries.
- We'll benchmark an alternative: try `JSON.parse(text)` first and run the scanner only if that throws. This wins when inputs are mostly pure JSON. When they aren't, it costs an extra failed parse. The default will be whichever wins on the benchmark corpus.

### 2. Rewrites

| JSON5 | JSON output | Keeps length? |
| --- | --- | --- |
| `// …` and `/* … */` | spaces | yes |
| Trailing `,` before `]` or `}` | space | yes |
| Whitespace `\v \f \u00A0 \uFEFF \u2028 \u2029` and other Zs characters | space | yes (one UTF-16 unit each) |
| Unquoted key `foo`, `ünï`, `\u0061b` | `"foo"`; `\uXXXX` escapes pass through, since JSON decodes them | no (+2) |
| `'single'` | `"single"`: escape inner `"`, turn `\'` into `'` | mostly |
| `\x41` | `\u0041` | no |
| `\v`, `\0` (not followed by a digit) | `\u000b`, `\u0000` | no |
| Line continuation: `\` followed by LF, CR, CRLF, U+2028 or U+2029 | removed | no |
| Identity escapes such as `\a` | `a` | no |
| **Raw control characters U+0000–U+001F inside strings** (JSON5 allows them, JSON doesn't) | `\u00XX` | no |
| `0xFF` and `-0x1f` | `255` and `-31`, via `Number()` then `String()` | no |
| `.5`, `5.`, `+1`, `-.5` | `0.5`, `5`, `1`, `-0.5` | no |
| `Infinity`, `-Infinity`, `NaN`, `+NaN` | sentinel string (see §4) | no |

Inputs that are invalid in both JSON5 and JSON, and must stay invalid: leading zeros (`01`), escapes `\1` through `\9`, unterminated strings and comments, raw line terminators in strings, and lone surrogates in `\u` key escapes that don't form an identifier.

### 3. Strictness: validate what we rewrite, delegate the rest to JSON.parse

The scanner must never turn invalid JSON5 into valid JSON. Because `JSON.parse` re-validates everything we output, the scanner doesn't have to be a full grammar checker. **It only has to make sure each rewrite happens in a context where the JSON5 grammar allows it**:

- `{a b: 1}` is safe without extra checks: quoting gives `{"a" "b": 1}`, which `JSON.parse` rejects.
- `{,}` and `[1,,]` are the dangerous cases. Naively dropping the comma would give valid JSON. A trailing comma may only be dropped when the previous significant token ended a value and the next one closes a container.
- A bare word may only be quoted in key position, meaning after `{` or `,` inside an object. In value position the only allowed bare words are `true`, `false`, `null`, `Infinity` and `NaN`.

So the scanner keeps a small state: a container stack (object or array) and an "expecting" state (key, colon, value, or comma-or-close). Pushing and popping that state is cheap, and building values is where the time goes.

**Error path:** when `JSON.parse` throws, we're already on the slow path, so we **re-scan the original source with a strict, full JSON5 validator**. That produces an exact, engine-independent message and line and column. It avoids parsing V8, JSC and SpiderMonkey error strings and keeping an offset map on the hot path. If the strict validator accepts input that `JSON.parse` rejected, that's an internal bug, and the fuzzer should catch it.

The fallback, if this turns out too clever: make the scanner a full validator and keep a sparse offset map (pairs of output position and cumulative delta, recorded only for rewrites that change length).

### 4. Infinity, -Infinity and NaN

- Emit a sentinel string such as `"\u0000fj5:Infinity"`. Set a flag only when the scanner emits one.
- **No sentinel emitted** (the usual case): call `JSON.parse` with no fix-up at all.
- **Sentinel emitted, no user reviver:** walk the result once after parsing and replace the sentinels. That should be faster than a reviver; to be benchmarked.
- **Sentinel emitted and a user reviver:** wrap the reviver so it restores the sentinel before calling the user's function, so the user sees real numbers.
- **Collisions:** the scanner already reads every string, so it can check whether any source string starts with the sentinel prefix. If one does, it switches to a different prefix.
- `nonFinite: 'reject'` throws at the token instead.
- Don't patch by path: with duplicate keys (`{a: Infinity, a: 1}`), patching by path would overwrite the wrong value.

### 5. Identifiers

- Keys may be any ES5.1 IdentifierName. A key starts with a Unicode letter (Lu, Ll, Lt, Lm, Lo or Nl), `$`, `_` or a `\uXXXX` escape. Later characters may also be Mn, Mc, Nd, Pc, U+200C or U+200D.
- Fast path: `/[A-Za-z_$][\w$]*/y`. If that stops at a non-ASCII character or `\`, fall back to `/[\p{ID_Start}$_]…/uy`, and check that each decoded escape is a valid identifier character.
- Known edge: `json5` ships a Unicode table generated for an older Unicode version, so the two may disagree on very new characters. Document this and exclude those characters from differential fuzzing.

### 6. Semantics that must match `json5` and `JSON.parse`

- Duplicate keys: the last one wins.
- `__proto__` becomes an own property, never a prototype change. `JSON.parse` already behaves this way; add a test.
- The top level may be any value, with whitespace and comments around it. Empty input is an error.
- `-0` stays `-0`. Big hex numbers lose precision the same way `Number('0x…')` does.

---

## Testing

1. **Unit tests** (vitest) for each rewrite and each rejection.
2. **Conformance corpus:** vendor [`json5/json5-tests`](https://github.com/json5/json5-tests) (MIT) into `test/fixtures/`. Every `.json5` and `.json` file must parse to the same value as `json5`, and every `.js` and `.txt` file must throw.
3. **Differential fuzzing:** use `fast-check` to generate random JSON5 documents, valid and slightly corrupted. For each one, check that `fast-json5` and `json5` agree on either the value (compared with `Object.is` for `NaN` and `-0`) or the fact that it throws. Run a bounded version in CI and a longer local run before releases.
4. **Error-position tests** that check the line and column for errors after length-changing rewrites.
5. **Type tests** (`expectTypeOf`) for the overloads.

### Test bed as built (phase 1)

| File | What it does |
| --- | --- |
| `test/conformance.test.ts` | Runs every case in `test/fixtures/json5-tests/` (vendored at upstream commit `ceb24d4`) and `test/fixtures/extra/`. Valid cases must produce exactly json5's value; invalid ones must throw a `SyntaxError`. Each case also checks that json5 itself agrees with the fixture's extension. |
| `test/conformance.known-failures.json` | A ratchet. Listed cases run as `it.fails`, so a fixed case fails the suite until it's removed from the list. Regenerate with `npm run test:update-known`. |
| `test/fuzz.test.ts` | Differential fuzzing against json5 on three generators: plain JSON, JSON5 documents, and corrupted documents (1-3 single-character edits). It also checks that the JSON5 generator only emits documents json5 accepts, and that each of 14 JSON5 features shows up in at least 1% of samples. `npm test` runs 300 cases per property; `npm run test:fuzz` runs 200k. |
| `test/support/` | `oracle` (json5 with warnings muted), `equal` (`-0`, `NaN`, key order, own `__proto__`), `differential`, `errors` (`positionAt`, `¦` markers), `fixtures`, `arbitraries`. These have their own tests in `test/support.test.ts`. |

Status against the stub: all 59 must-reject cases pass, because `JSON.parse` rejects them too. 61 valid-JSON5 cases are known failures. The JSON5 and corrupted-document fuzz properties are `it.fails` until phase 2.

Things found while building it:
- **Upstream fixture quirks:** `comments/irregular-block-comment.json` is valid JSON5 but not valid JSON, so `.json` files are checked against json5, not `JSON.parse`. The `new-lines/*-crlf.json5` files contain no CR bytes, so `test/fixtures/extra/new-lines/` adds real CR/CRLF cases. `strings/no-comma-array.errorSpec` is an orphan with a misspelled key. `test/fixtures/**` is marked `-text` in `.gitattributes`, so git never rewrites line endings in fixtures.
- **json5 as an oracle:** it is spec-correct on escapes (`\01` rejected, `\0a` accepted, escaped key characters validated). It `console.warn`s on raw U+2028/U+2029 in strings, which the harness mutes.
- **json5 error positions:** 1-based, only LF counts as a line break (CR and U+2028 don't), and columns count UTF-16 code units. `positionAt` copies these rules, so phase 4 can compare positions with json5 directly. See open questions.

## Benchmarks

The `bench/` harness uses mitata. It already compares against `JSON.parse`, `json5` and `strip-json-comments`.

- **Corpus:** pure JSON (`package.json`-sized and about 1 MB), JSONC (a `tsconfig` or VS Code `settings.json`), comment-heavy, unquoted-key-heavy, single-quoted-heavy, and a few real-world `.json5` configs. Report both ops/s and MB/s.
- **Runtimes:** current Node LTS and Bun, at minimum.
- **Baseline** (Node 22, 318 KiB pure JSON, scaffold day): `JSON.parse` 1.3 ms, `strip-json-comments` + `JSON.parse` 12.1 ms, `json5` 35.5 ms. That's about 27× between `json5` and the native ceiling. On JSONC, `strip-json-comments` takes about 16 ms, so a single-pass scanner that is quicker than it will also win on the JSONC subset.
- **Targets to beat before v0.1.0:** at least 5× `json5` on realistic JSON5, and within about 1.3× of `JSON.parse` on pure JSON.

## Packaging and release

- Built by tsdown into `dist/index.js` (ESM), `dist/index.cjs` (CJS) and `.d.ts`/`.d.cts` files. `sideEffects: false`, no runtime dependencies.
- `publint` and `@arethetypeswrong/cli` run in `prepublishOnly` and in CI.
- GitHub Actions: lint, typecheck, test on Node 18/20/22/24 and Bun, plus a smoke test of the build output in both module formats.
- Publish with `npm publish --provenance` from CI when a tag is pushed. Keep the version in `0.x` until the API settles.
- The README needs the benchmark table, a "differences from json5" section (should be empty apart from error message wording), and a migration snippet.

---

## Milestones

| Phase | Deliverable | Done when |
| --- | --- | --- |
| **0. Scaffold** ✅ | package, build, test, bench harness | `npm run build && npm test` pass |
| **1. Test bed** ✅ | json5-tests vendored, differential harness, error-position helpers | Suite runs (and mostly fails) against the stub |
| **2. Scanner** | comments, trailing commas, whitespace, keys, strings, escapes, numbers | Conformance suite passes, except non-finite values; the two fuzz `it.fails` become `it` |
| **3. Non-finite values** | sentinel, post-walk, reviver wrapping, `nonFinite: 'reject'` | All of json5-tests passes; fuzzer clean for 1M cases |
| **4. Errors** | strict validator on the error path, `lineNumber`/`columnNumber` | Error tests pass; messages are the same on every engine |
| **5. Performance** | sticky-regex skipping, JSON.parse-first experiment, profiling | Targets in "Benchmarks" are met |
| **6. Release 0.1.0** | CI, README with table, provenance publish | `npm i fast-json5` works in ESM, CJS and TS projects |

## Dev notes

- On npm 10.8.x, `npm i -D tsdown` crashes with an arborist bug (`Cannot read properties of null (reading 'edgesOut')`). It was installed with `--legacy-peer-deps`. Plain `npm install` from the lockfile works fine.

## Open questions

- Minimum Node version: 18 is already end-of-life. Should we require 20?
- Should `toJSON(text)` be exported in v0.1, or held back?
- JSON.parse-first vs scan-first as the default: the benchmarks will decide.
- Error line numbers: copy json5 (only LF starts a new line), or follow ECMAScript (CR, CRLF, U+2028 and U+2029 all do)? Copying json5 keeps it a true drop-in and makes differential testing of positions trivial. The ECMAScript rule is more correct for files with CR-only line endings.
- Is it worth adding a `stringify` later? Out of scope for now.
