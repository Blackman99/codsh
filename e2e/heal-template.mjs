/**
 * Materialize the dsh installation fallback into the packed e2e profile.
 *
 * `plugin add` only installs the profile package; the first real boot is what
 * normally writes `$DSH_HOME/profiles/node_modules`. Per-test homes copy
 * `cordis.yml` and share that fallback, so it has to exist before any test
 * boots — otherwise Node follows the symlink into the template and cannot
 * see a fallback written under the test home.
 */
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(fileURLToPath(new URL('../package.json', import.meta.url)))
const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
const bootEntry = require.resolve('@deepseek-ai/dsh-app-boot', { paths: [dirname(installAnchor)] })
const { healProfilesModuleFallback, loadProfile } = await import(pathToFileURL(bootEntry).href)
const profile = loadProfile('dsh', 'code', installAnchor)
await healProfilesModuleFallback({ installAnchor, profile })
