/**
 * Harness packages for the Rust client's dsh plugins (ticket 66).
 *
 * dsh loads the `rust-acp-*.mjs` plugins by file URL, so a bare
 * `import '@deepseek-ai/dsh-llm'` resolves from where codsh-cli is installed.
 * codsh-cli carries no dependencies: after `npm install -g @deepseek-ai/dsh
 * codsh-cli` the harness packages sit under dsh's own `node_modules`, and a
 * bare import fails there. These plugins therefore load harness packages from
 * the dsh that is running them (its entry script is `process.argv[1]`), so
 * they share dsh's module instances. Resolution from this file comes second;
 * that is what a development checkout uses when dsh has no copy of its own.
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Where to resolve from, in order: the running dsh, then this file. */
export function dshAnchors(entry = process.argv[1]) {
  const anchors = []
  if (typeof entry === 'string' && entry !== '' && isAbsolute(entry)) {
    try {
      anchors.push(realpathSync(entry))
    } catch {
      // A vanished entry is not an anchor.
    }
  }
  anchors.push(new URL(import.meta.url))
  return anchors
}

function notFound(error) {
  return error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND'
    || error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
}

/**
 * Import a harness package the way the running dsh sees it.
 * @param {string} name - a bare package name such as `@deepseek-ai/dsh-llm`.
 * @param {string} [entry] - the dsh entry script; `process.argv[1]` in dsh.
 */
export async function importFromDsh(name, entry = process.argv[1]) {
  const tried = []
  for (const anchor of dshAnchors(entry)) {
    let resolved
    try {
      resolved = createRequire(anchor).resolve(name)
    } catch (error) {
      if (!notFound(error)) throw error
      tried.push(anchor instanceof URL ? anchor.pathname : anchor)
      continue
    }
    return import(pathToFileURL(resolved).href)
  }
  throw new Error(`codsh: cannot load ${name} from the running dsh (looked from ${tried.join(', ')}). `
    + 'The dsh runtime is incomplete or too old: reinstall it with npm install -g @deepseek-ai/dsh, '
    + 'or point DSH_BIN at a complete dsh.')
}
