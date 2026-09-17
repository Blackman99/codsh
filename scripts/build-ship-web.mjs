import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['packages/bundle/src/ship-web-app.tsx'],
  outfile: 'packages/bundle/lib/web/ship-web.js',
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'inline',
})
