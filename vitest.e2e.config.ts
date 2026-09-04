import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // One packed profile, shared: the parent warms it, workers lock if they
    // race. The tests themselves mostly wait on a PTY, so overlapping files
    // is how a 6+ minute serial run becomes the length of the slowest file.
    globalSetup: './e2e/global-setup.ts',
    fileParallelism: true,
  },
})
