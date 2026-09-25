/**
 * Entry of the Ship extension's hook script (`hooks/ship-hook.mjs`, bundled
 * by `scripts/build-ship-extension.mjs`). rust-acp-hooks runs it with the
 * hook payload on stdin and `GROK_PLUGIN_DATA` set; `--print-command`
 * prints the `/ship` command markdown the build writes beside it. The
 * browser graph server is the sibling `hooks/ship-web.mjs`.
 * @module codsh-bundle/src/ship-extension-hook
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { shipExtensionCommand } from './ship-extension.ts'
import { handleShipHookWithWeb } from './ship-extension-web.ts'

async function main(): Promise<number> {
  if (process.argv.includes('--print-command')) {
    process.stdout.write(shipExtensionCommand())
    return 0
  }
  const dataDir = process.env.GROK_PLUGIN_DATA ?? ''
  if (dataDir === '') {
    process.stderr.write('ship extension: GROK_PLUGIN_DATA is not set\n')
    return 1
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(readFileSync(0, 'utf8')) as Record<string, unknown>
  } catch (error) {
    process.stderr.write(`ship extension: unreadable hook payload (${String((error as Error).message)})\n`)
    return 1
  }
  const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd()
  const owner = Number(process.env.CODSH_HOOK_HOST_PID ?? '')
  const out = await handleShipHookWithWeb(
    { event: process.env.GROK_HOOK_EVENT ?? '', payload, dataDir, cwd },
    {
      serverScript: fileURLToPath(new URL('./ship-web.mjs', import.meta.url)),
      ownerPid: Number.isInteger(owner) && owner > 0 ? owner : 0,
      node: process.execPath,
    },
  )
  if (out.stdout !== '') process.stdout.write(out.stdout)
  return out.exitCode
}

process.exitCode = await main()
