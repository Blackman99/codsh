import { defineConfig } from 'tsdown'

/** Runtime bundles for the three published entries; types come from tsc. */
export default defineConfig({
  entry: ['src/index.ts', 'src/startup.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: 'esm',
  dts: false,
  clean: false,
})
