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
- Errors are `JSON5SyntaxError` (exported), a `SyntaxError` subclass whose `name` is still `'SyntaxError'`. It has json5's `lineNumber` and `columnNumber` plus `offset`, a machine-readable `code` and `reason` (the message without the position). Positions always refer to the **original** source. See §7.
- Possible later addition: `export function toJSON(text): string`, which exposes the transform itself. It costs almost nothing to add and is useful for piping into other JSON tools. We'll decide once the core is stable.

---

## Core design

### 1. Two scanners: a fast path that always runs, and a strict one for errors (phase 5)

**Decision (2026-10-14):** the transform always runs. There is no "try `JSON.parse` on the raw input first" path; speed comes from the scanner itself.

`parse()` (in `src/index.ts`) works like this:
1. **Fast path, `scanFast()`.** One sticky regex (`JSON_RUN`) consumes each maximal run of plain-JSON tokens in a single native call. A whole pure-JSON document is one call, at about 0.35 ms for 318 KiB. JS code only wakes up where JSON5 syntax may start, and rewrites that token under a local rule (§3). Structure isn't tracked; `JSON.parse` validates it.
2. `JSON.parse` on the output. If nothing was rewritten, the output is the input string itself, with no copy.
3. **Slow path, only if step 1 bailed or step 2 threw:** `scanStrict()`, the strict token-level state machine from phase 2. For invalid input it throws a `SyntaxError` positioned in the original text. For the rare valid form the fast path declines (e.g. `{true /* c */ : 1}`), it produces correct JSON. A reviver's own exception is told apart from a syntax error (the JSON is re-checked without the reviver), so it propagates unchanged and the reviver never runs twice.

Output is built by string concatenation (`out = out + slice + text`). V8 makes rope strings, and `JSON.parse` flattens them in one native pass. Measured on 20k edits: rope 1.0 ms, parts-and-`join` 1.9 ms, `Uint16Array` plus `TextDecoder` 2.2 ms. Native `String.prototype.replace` with a callback took 4.9 ms just for the replacement, so it lost too.

**Code shape, for size (size pass).** The scanner is module-level functions plus module-level state (`src`, `pos`, `last`, `out` and so on), not a class. Minifiers can rename variables but never properties, and the class version spent about 2.5 KiB of its minified size on names like `this.edit(` and `this.lookahead(`. This is safe because a scan never calls user code, so it can't be re-entered; `parse()` reads `sawNaN` right after the scan.
- The state is declared with **`var`, not `let`**. Module-level `let` needs a temporal-dead-zone check on every access from a function, and the interleaved A/B benchmark (`bench/ab.js`) measured `let` at about 8% slower on JSON5 input. The hottest functions also copy `src` into a local.
- **Duplicates merged:** one number regex instead of two, one string-run regex for both quote styles, inline ASCII identifier loops instead of a regex, one `isWordAt` for both sides of a number, `\p{L}` instead of listing Lu, Ll, Lt, Lm and Lo, and JS `\s` for JSON5 whitespace. `\s` matches exactly the same set across the whole BMP, which was verified before relying on it.
- **NaN path:** the restore walk and the reviver both iterate arrays and objects the same way, through `Object.keys`. JSON arrays have no holes, so that's exact. The walk stays iterative, because `JSON.parse`'s native reviver overflows the stack at about 10k levels.
- **Result of the first pass:** minified size 10.74 KiB → 8.14 KiB, min+gzip 4.09 KiB → 3.53 KiB.

**Second size pass** (from a function-by-function read of the minified bundle): 8.14 → 7.38 KiB minified, 3.53 → 3.31 KiB min+gzip.
- Whitespace and comments: one regex, `/(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*/y`, replaced three hand-written loops and a line-comment regex. `.` stops at exactly JSON5's line terminators. Both scanners replace a whole run of whitespace and comments with one space, and a `/` left at a token position can only be an unterminated or stray comment, so it becomes the error.
- `number()` tests captures for truthiness (each is undefined or a non-empty string), `escape()` uses one string lookup for the JSON-valid escapes, regexes use `\d` and `\w`, the NaN sentinel is one random number with its JSON form from `JSON.stringify`, and error line/column come from `slice` plus `split`.
- Speed is neutral against the previous commit in interleaved A/B runs (within ±4% noise).

**How it compares** (`npm run size`, each library tree-shaken to the parse function an app imports, minified, min+gzip): fast-json5 3.3 KiB, json5 9.6 KiB, confbox `parseJSON5` 8.1 KiB, jsonc-parser 3.1 KiB (JSONC only), strip-json-comments 0.6 KiB (a comment stripper, not a parser).

**Performance found in the same pass.** The fast path's comma rule used to consume a comma only before a plain-JSON value start, so every comma before an unquoted key (`, price:`) went to the JS trailing-comma check. A comma followed by any ASCII token start (a quote, bracket, digit, sign, dot, letter or `\`) can't be trailing, so `JSON_RUN` now consumes those too. The JSON5 corpus got 22% faster (5.1 ms → 4.0 ms); JSON is unchanged.

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

### 3. Strictness: local rules on the fast path, the full grammar on the slow path

Neither path may turn invalid JSON5 into valid JSON, or change a value.

**Fast path (`scanFast`).** Each rewrite replaces one JSON5 token with a JSON token that has the same meaning and grammatical role. `JSON.parse` then rejects any structure that was wrong in the source. The rules below are where that argument needs care. Each one was found or confirmed by the corrupted-document fuzzer.
- **Plain-JSON runs:** `JSON_RUN` refuses tokens that are really the start of JSON5 syntax. A number isn't consumed if `.`, `e`, `x` or a digit continues it, so `5.` and `1.e5` are read whole. A literal is consumed only before `,` `]` `}` or end of input (`trueish`, `null:` and `true /* c */ :` go to JS). A comma is consumed only before a plain-JSON value start.
- **Comments and exotic whitespace** become a space, never the empty string. Otherwise `1/**/2` could become `12`.
- **Trailing commas** are dropped only when the previous significant character ends a value (not `,` `[` `{` `:`) and the next one is a closer. This keeps `[,]`, `[1,,]` and `{"a":,}` invalid. The previous character is worked out only when a comma or comment needs it.
- **Bare words** are quoted only when a `:` follows, so they can only ever end up as keys. Non-keys must be `true`, `false`, `null`, `Infinity` or `NaN`; anything else bails.
- **Numbers** rewritten in JS must not touch an identifier character, digit or `.` on either side (`1Infinity` would become `11e400`), and must not be followed by `:`. The colon check exists because `-NaN` becomes the sentinel *string*, which `JSON.parse` would accept as a key; the fuzzer found this.

**Slow path (`scanStrict`).** This is the phase 2 state machine: five states (value, element-or-`]`, key-or-`}`, `:`, after-value), a boolean container stack (iterative, so depth is unlimited), and full validation with errors positioned in the original source. Trailing commas are decided by looking ahead at the comma, so edits stay in source order.

**Shared token readers** handle strings (sticky-regex runs over `[^"\\\x00-\x1f]*`), numbers (the JSON-number regex, falling back to the JSON5-number regex only when needed), and identifiers (an inline ASCII loop, with `\p{...}` checks per code point for anything else). They validate tokens the same way on both paths.

### 4. Infinity, -Infinity and NaN

As built (phases 2 and 3):
- **Infinity needs no sentinel.** `JSON.parse` turns an overflowing literal into `Infinity` (the spec requires it, so every engine does it). So `Infinity` becomes `1e400` and `-Infinity` becomes `-1e400`, and huge hex literals become the same values.
- **NaN** becomes a sentinel string (in `src/nan.ts`): NUL, then `fast-json5:NaN:`, then a **per-process random suffix**. Input can't produce it by accident, and an attacker can't guess it. The scanner sets a flag only when it writes one, so documents without `NaN` pay nothing.
- **Sentinel written, no reviver:** an iterative walk after `JSON.parse` swaps sentinels back to `NaN`, assigning `__proto__` keys with `defineProperty`. Sentinels are found by value, not by path, so duplicate keys such as `{a: NaN, a: 1}` are handled correctly.
- **Sentinel written and a reviver:** sentinels are restored first, then the reviver runs in JS (ECMA-262 InternalizeJSONProperty), so it only ever sees real `NaN`. Call order matches json5's; there's a fuzz property for it.
- `nonFinite: 'reject'` throws at an `Infinity` or `NaN` *literal*. Overflowing numbers such as `1e400` still parse to `Infinity`, as they do in `JSON.parse`.

### 5. Identifiers

- Keys may be any ES5.1 IdentifierName. A key starts with a Unicode letter (Lu, Ll, Lt, Lm, Lo or Nl), `$`, `_` or a `\uXXXX` escape. Later characters may also be Mn, Mc, Nd, Pc, U+200C or U+200D.
- Fast path: `/[A-Za-z0-9$_]*/y`. If that stops at a non-ASCII character or `\`, each code point is checked against the exact spec categories (`\p{Lu}\p{Ll}...` rather than `\p{ID_Start}`, which also includes Other_ID_Start), and each `\uXXXX` escape is decoded and checked the same way. Code points are used rather than code units, as json5 does, so astral letters are accepted.
- **Known difference:** json5 ships identifier tables from Unicode 10, while fast-json5 uses the engine's current Unicode data. So keys using letters added later (e.g. Lao U+0E90, added in Unicode 12) are accepted here and rejected by json5. That follows the spec, which tracks current Unicode. The differential check recognises exactly this case and skips it.

### 6. Semantics that must match `json5` and `JSON.parse`

- Duplicate keys: the last one wins.
- `__proto__` becomes an own property, never a prototype change. `JSON.parse` already behaves this way; add a test.
- The top level may be any value, with whitespace and comments around it. Empty input is an error.
- `-0` stays `-0`. Big hex numbers lose precision the same way `Number('0x…')` does.

### 7. Errors (phase 4)

Every syntax error comes from the strict scanner (the fast path never reports errors itself; it hands over to the strict one), so there is one implementation of messages and positions.

- **Shape:** `Unexpected character "x"; expected ',' or ']' at line 3, column 5` style. The `reason` says what each grammar state expected: `',' or ']'`, `':' after a key`, `a key or '}'`, `a value`, `end of input`, `'null'` and so on. Invisible characters (controls, spaces, BOM, ZWSP, lone surrogates) are shown as `U+XXXX`.
- **Codes:** `UNEXPECTED_CHARACTER`, `UNEXPECTED_END`, `UNTERMINATED_STRING`, `UNTERMINATED_COMMENT`, `LINE_BREAK_IN_STRING`, `INVALID_ESCAPE`, `INVALID_IDENTIFIER`, `NON_FINITE_NOT_ALLOWED`. Prefer `code` over `instanceof` when ESM and CJS copies of the package might both be loaded (the dual-package hazard).
- **Position rules (decided):** json5's. Lines are 1-based and only LF starts a new one; columns are 1-based UTF-16 code units. CRLF files count correctly; only CR-only files differ from ECMAScript line terminators. This keeps fast-json5 a drop-in and lets positions be tested against json5 directly.
- **Where errors point**, matching json5: the first character of a literal that doesn't fit (`nu¦xl`), the first bad hex digit of an escape, the character after a stray `/`, and where the missing digit of an exponent or hex prefix should be (`1e¦`, `0x¦`).
- **Intentional differences from json5**, all tolerated by the position fuzz property and nothing else:
  1. If the offending character is a line break, json5 reports `(next line, column 0)`. We point at the line break itself (column 0 isn't valid in 1-based positions).
  2. For an astral character (e.g. an emoji), json5's column is one past where it starts; we give its start.
  3. For an unterminated `/*`, json5 points at end of input; we point at the `/*`.
  4. Identifier characters newer than Unicode 10 (see §5).
- **Measured agreement:** on corrupted documents both parsers reject, positions match json5 exactly in 92.6% of cases before counting the differences above, and in 100% once they're excluded. The fuzz property checks 200k documents. One upstream `.errorSpec` (`top-level-inline-comment`) is stale: json5 2.x itself reports `1:66` and so do we. The conformance suite skips it with a note.
- **Reviver errors** propagate unchanged and are never mistaken for syntax errors, and a reviver is never run twice.

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
- **After phase 2** (same machine, no tuning yet): pure JSON 3.7 ms (2.8× `JSON.parse`, 9× faster than json5); JSONC 4.3 ms (8.7× json5, 4× faster than `strip-json-comments`); full JSON5 7.9 ms (4.4× json5). Pure JSON is the gap: it pays for a full scan with nothing to rewrite, so trying `JSON.parse` first is the obvious phase 5 experiment.
- **After phase 5** (Node 22, `npm run bench`; the two small configs are ~0.5 KiB):

  | Input | fast-json5 | vs `JSON.parse` | vs json5 | vs strip-json-comments |
  | --- | --- | --- | --- | --- |
  | Pure JSON, 318 KiB | 1.50 ms | 1.24× slower | 20× faster | 7.4× faster |
  | Minified JSON, 154 KiB | 1.23 ms | 1.22× slower | 17× faster | 3.6× faster |
  | JSONC, 348 KiB | 1.89 ms | — | 17× faster | 7.2× faster |
  | Full JSON5, 328 KiB | 4.53 ms (3.99 ms after the size pass) | — | 6.9× faster (8.2×) | — |
  | Small JSON config | 3.3 µs | 1.16× slower | 17× faster | 4.4× faster |
  | Small JSON5 config | 8.8 µs (7.9 µs after the size pass) | — | 5.2× faster (5.6×) | — |

  Where the JSON5 time goes: on the 328 KiB case, the scan takes 2.8 ms, flattening the output rope 0.5 ms and `JSON.parse` 1.1 ms. The scan cost is mostly building the output (about 20k edits at roughly 50 ns each). Pure JSON is one regex call at about 0.35 ms plus `JSON.parse`.
- **Targets to beat before v0.1.0:** at least 5× `json5` on realistic JSON5, and within about 1.3× of `JSON.parse` on pure JSON.

## Packaging and release

- Built by tsdown into `dist/index.js` (ESM), `dist/index.cjs` (CJS) and `.d.ts`/`.d.cts` files. `sideEffects: false`, no runtime dependencies. The tarball is 7 files, about 13 KiB packed. The published files are not minified, so stack traces stay readable; bundlers minify them to about 8 KiB (3.5 KiB gzipped).
- **CI** (`.github/workflows/ci.yml`), kept to one job on purpose: typecheck, tests, build and `publint` + `attw` on Node 22 (the oldest the dev toolchain supports), then the dependency-free smoke test (`test/smoke/`, ESM and CJS) of the built package on Node 18, Node 20, Bun and Deno. That is what backs `engines: >=18`. Docs-only changes skip CI.
- **Fuzz:** the long run (200k cases per property) is part of `prepublishOnly`, so it runs before every publish, local or CI. There is no scheduled fuzz job. `npm test` runs a short pass on every CI run.
- **Release** (`release.yml`): on a `v*` tag, `release:check` then `npm publish --provenance`. The check needs a real `repository` URL, a non-placeholder version, a CHANGELOG entry, a tag that matches the version, and exact tarball contents. The job runs in a GitHub environment `npm`, so publishing can require approval. The first publish uses an `NPM_TOKEN` secret, then it switches to trusted publishing (OIDC); see RELEASING.md.
- `prepublishOnly` runs typecheck, tests, the long fuzz pass, build, smoke tests and package lint, so nothing broken can be published even by hand.
- Keep the version in `0.x` until the API settles.
- **Checked before release** with a packed tarball installed into a throwaway project: ESM and CJS imports both work and export exactly `parse` and `JSON5SyntaxError`; TypeScript typechecks a consumer under `nodenext` (as `.mts` and `.cts`) and `bundler`; `attw` covers `node10`.

---

## Milestones

| Phase | Deliverable | Done when |
| --- | --- | --- |
| **0. Scaffold** ✅ | package, build, test, bench harness | `npm run build && npm test` pass |
| **1. Test bed** ✅ | json5-tests vendored, differential harness, error-position helpers | Suite runs (and mostly fails) against the stub |
| **2. Scanner** ✅ | comments, trailing commas, whitespace, keys, strings, escapes, numbers, Infinity | Conformance suite passes, except NaN; the two fuzz `it.fails` become `it` |
| **3. NaN** ✅ | sentinel, post-walk, JS reviver on the NaN path, `nonFinite: 'reject'` (Infinity was done in phase 2) | All of json5-tests passes; fuzz NaN filter removed |
| **4. Errors** ✅ | `JSON5SyntaxError` with codes, contextual messages, json5 position rules | Error tests pass; positions match json5 (§7); messages are the same on every engine |
| **5. Performance** ✅ | fast path with `JSON_RUN` and local rules, strict fallback, rope output, regex alternative ordering | Targets in "Benchmarks" are met (see the table) |
| **6. Release 0.1.0** ✅ | CI, README with table, provenance publish | Published 2026-10-14 from the tagged release workflow, with a verified provenance attestation (`npm audit signatures`) |

## Dev notes

- On npm 10.8.x, `npm i -D tsdown` crashes with an arborist bug (`Cannot read properties of null (reading 'edgesOut')`). It was installed with `--legacy-peer-deps`. Plain `npm install` from the lockfile works fine.

## Open questions

- ~~Repository URL~~ Done: https://github.com/NightFighter989/fast-json5.
- ~~Minimum Node version~~ Decided: Node 18. The library only needs ES2020 plus Unicode regexes, and CI smoke-tests 18 and 20 even though both are end-of-life, which widens reach for config loaders on old runtimes. Raising it later would be a breaking change, so keep it while it costs nothing.
- ~~Export `toJSON(text)`~~ Held back for 0.1. It would freeze the rewrite format (the NaN sentinel, rope output) as public API. Can be added later without breaking anything.
- ~~JSON.parse-first vs scan-first~~ Decided: the transform always runs (see §1).
- ~~Error line numbers~~ Decided: json5's rules (§7).
- `stringify`: out of scope; json5's `stringify` or `JSON.stringify` cover it.

