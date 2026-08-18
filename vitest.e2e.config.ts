import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // PTY and profile setup share one home template; keep runs serial.
    fileParallelism: false,
  },
})
