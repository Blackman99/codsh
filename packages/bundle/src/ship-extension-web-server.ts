/**
 * Entry of the Ship extension's browser graph server (`hooks/ship-web.mjs`,
 * bundled by `scripts/build-ship-extension.mjs`). The hook spawns it
 * detached with `--record <path> --nonce <hex>`; the packaged page assets
 * are in the extension's `web/` directory.
 * @module codsh-bundle/src/ship-extension-web-server
 */

import { fileURLToPath } from 'node:url'
import { runShipWebServer } from './ship-extension-web.ts'

function arg(name: string): string {
  const at = process.argv.indexOf(name)
  return at < 0 ? '' : (process.argv[at + 1] ?? '')
}

const recordPath = arg('--record')
const nonce = arg('--nonce')
const dataDir = process.env.GROK_PLUGIN_DATA ?? ''
if (recordPath === '' || nonce === '' || dataDir === '') {
  process.stderr.write('ship web: --record, --nonce, and GROK_PLUGIN_DATA are required\n')
  process.exitCode = 2
} else {
  await runShipWebServer({ recordPath, nonce, dataDir, assetsDir: fileURLToPath(new URL('../web/', import.meta.url)) })
}
