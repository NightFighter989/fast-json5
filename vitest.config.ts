import { defineConfig } from 'vitest/config'

// `--mode fuzz` raises fuzz iterations; `--mode update-known` rewrites the conformance known-failures list.
export default defineConfig(({ mode }) => ({
  test: {
    include: ['test/**/*.test.ts'],
    env: { FAST_JSON5_TEST_MODE: mode },
    testTimeout: mode === 'fuzz' ? 0 : 20_000,
  },
}))
