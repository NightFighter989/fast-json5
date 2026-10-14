# json5-tests (vendored)

- Upstream: https://github.com/json5/json5-tests
- Commit: ceb24d4080137d70833f86c25659c1331b80a387 (2026-02-20)
- License: MIT, see [LICENSE.md](./LICENSE.md)

Copied byte-for-byte. Don't edit these files. Add new cases under `test/fixtures/extra/` instead.

Extensions: `.json` is valid JSON, `.json5` is valid JSON5, and both `.js` and `.txt` must be rejected.
`.errorSpec` files hold json5's own error positions and messages. They have quirks (`columnNumber: 0`, and an orphan `strings/no-comma-array.errorSpec` with a misspelled `columNumber` key), so treat them as hints only.

Upstream quirk: `new-lines/*-crlf.json5` contain no CR bytes. The real CR/CRLF coverage comes from `test/fuzz.test.ts` and the unit tests.
