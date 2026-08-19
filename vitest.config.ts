import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/bundle/tests/**/*.spec.ts'],
  },
})
