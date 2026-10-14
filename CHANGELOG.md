# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/) (0.x: minor versions may change the API).

## 0.1.1

No changes to the library. This release moves publishing to npm trusted publishing (OIDC), so
no npm token is stored anywhere; the package is still published with provenance from the
tagged GitHub Actions workflow.

## 0.1.0

First release.

- `parse(text, reviver?)`: a drop-in replacement for `JSON5.parse` from json5, covering the full JSON5 spec: comments, trailing commas, unquoted (including Unicode and escaped) keys, single-quoted strings, JSON5 escapes and line continuations, hex, leading/trailing-dot and signed numbers, `Infinity`, `NaN`, and JSON5 whitespace.
- `parse(text, { reviver, nonFinite })`: `nonFinite: 'reject'` throws on `Infinity` and `NaN` literals.
- `JSON5SyntaxError`: a `SyntaxError` with json5-compatible `lineNumber` and `columnNumber`, plus `offset`, a machine-readable `code`, and `reason`. Messages say what was expected.
- Rewrites JSON5 to JSON and lets the native `JSON.parse` build values. On Node 22, pure JSON parses within about 1.3× of `JSON.parse`; it is 5–20× faster than json5 and 3–4× faster than jsonc-parser, depending on input.
- ESM and CommonJS builds with TypeScript declarations. No dependencies, 3.3 KiB minified and gzipped. Supports Node 18+, Bun, Deno and browsers.
