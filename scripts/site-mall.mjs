#!/usr/bin/env node
/**
 * Import a static production snapshot of the local International Mall
 * project into `site/demos/international-mall/` so GitHub Pages can serve
 * a shoppable demo with relative asset URLs.
 *
 * The source Next.js tree is not edited. Client components, dictionaries,
 * and catalog seed are copied into a temporary Vite app; checkout and
 * order lookup persist in the browser instead of `data/store.json`.
 *
 * Usage: node scripts/site-mall.mjs ../test-codsh
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GALLERY_LINKS,
  collectDocumentRefs,
  demoTargetDir,
  injectGalleryNav,
  isRelativeUrl,
  readGitCommit,
  relativeAssetBase,
  rewriteRootAbsoluteUrls,
} from './site-demo.mjs'

export const MALL_SLUG = 'international-mall'
export const MALL_ORIGINAL_REQUIREMENT = '做一个国际商城'
export const MALL_UPDATE_COMMAND = 'node scripts/site-mall.mjs ../test-codsh'
export const MALL_SOURCE_COMMIT = '0392b46d5fbaf4925b2b060a019c5ff7e2d12eb3'

const thisFile = fileURLToPath(import.meta.url)
const defaultRoot = join(dirname(thisFile), '..')
const SNAPSHOT_TEMPLATE = join(dirname(thisFile), 'mall-snapshot')

const COPY_PATHS = Object.freeze([
  'src/app/globals.css',
  'src/app/providers.tsx',
  'src/app/categories/page.tsx',
  'src/components',
  'src/lib/cart',
  'src/lib/currency',
  'src/lib/i18n',
  'src/lib/payment',
  'src/lib/shipping',
  'src/lib/store/seed.ts',
  'src/lib/store/types.ts',
])

export function mallTargetDir(root = defaultRoot) {
  return demoTargetDir(root, MALL_SLUG)
}

export function mallSnapshotTemplate() {
  return SNAPSHOT_TEMPLATE
}

export function findViteBin(sourceRoot) {
  const requireFromSource = createRequire(join(sourceRoot, 'package.json'))
  try {
    return requireFromSource.resolve('vite/bin/vite.js')
  } catch {
    const nested = join(
      sourceRoot,
      'node_modules',
      '.pnpm',
    )
    if (existsSync(nested)) {
      for (const entry of readdirSync(nested)) {
        if (!entry.startsWith('vite@')) continue
        const bin = join(nested, entry, 'node_modules', 'vite', 'bin', 'vite.js')
        if (existsSync(bin)) return bin
      }
    }
    throw new Error(`installed Vite not found for ${sourceRoot}`)
  }
}

export function findLucideLicense(sourceRoot) {
  const requireFromSource = createRequire(join(sourceRoot, 'package.json'))
  return requireFromSource.resolve('lucide-react/LICENSE')
}

export function readLucideVersion(sourceRoot) {
  const requireFromSource = createRequire(join(sourceRoot, 'package.json'))
  try {
    const license = requireFromSource.resolve('lucide-react/LICENSE')
    const manifest = join(dirname(license), 'package.json')
    if (!existsSync(manifest)) return undefined
    return JSON.parse(readFileSync(manifest, 'utf8')).version
  } catch {
    return undefined
  }
}

/**
 * @param {{
 *   commit: string,
 *   requirement?: string,
 *   updateCommand?: string,
 *   sourceLabel?: string,
 *   lucideVersion?: string,
 * }} info
 */
export function renderMallProvenance(info) {
  const requirement = info.requirement ?? MALL_ORIGINAL_REQUIREMENT
  const updateCommand = info.updateCommand ?? MALL_UPDATE_COMMAND
  const sourceLabel = info.sourceLabel ?? 'local `../test-codsh` (no git remote)'
  const lucideVersion = info.lucideVersion ? ` ${info.lucideVersion}` : ''
  return `# International Mall

This directory is a static production snapshot of a local Next.js demo,
checked in so GitHub Pages can serve a shoppable storefront with relative
asset URLs. Checkout and order lookup persist in this browser (localStorage)
instead of the source project's \`data/store.json\`.

## Original requirement

> ${requirement}

The source project is a bilingual, multi-currency B2C shop. Product photos
load from Unsplash; simulated card / PayPal / Apple Pay checkout does not
charge a real account.

## Provenance

- Source snapshot commit: \`${info.commit}\`
- Source tree: ${sourceLabel}
- Bundler: the source project's installed Vite, invoked with \`--base ./\` into a temporary outDir
- This folder contains only that built snapshot, plus the Lucide license and this note

## Lucide

The production bundle includes lucide-react${lucideVersion} (ISC). The license
text is preserved in \`LICENSE\` next to this build.

## Update

From the codsh repository root (the importer does not edit the source project):

\`\`\`
${updateCommand}
\`\`\`
`
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
export function mallSnapshotProblems(dir) {
  const problems = []
  const index = join(dir, 'index.html')
  if (!existsSync(index)) {
    problems.push('missing index.html')
    return problems
  }
  const html = readFileSync(index, 'utf8')
  if (!html.includes('id="root"') && !html.includes("id='root'")) {
    problems.push('index.html does not contain #root')
  }
  for (const ref of collectDocumentRefs(html)) {
    if (!isRelativeUrl(ref)) problems.push(`non-relative URL: ${ref}`)
    if (ref.startsWith('./assets/') && !existsSync(resolve(dir, ref.split(/[?#]/)[0]))) {
      problems.push(`missing asset: ${ref}`)
    }
  }
  if (!html.includes(GALLERY_LINKS.en)) problems.push('missing English gallery link')
  if (!html.includes(GALLERY_LINKS.zh)) problems.push('missing Chinese gallery link')
  if (!existsSync(join(dir, 'LICENSE'))) problems.push('missing Lucide LICENSE')
  const readmePath = join(dir, 'README.md')
  if (!existsSync(readmePath)) {
    problems.push('missing README.md')
  } else {
    const readme = readFileSync(readmePath, 'utf8')
    if (!readme.includes(MALL_ORIGINAL_REQUIREMENT)) {
      problems.push('README missing original requirement')
    }
    if (!/Source snapshot commit: `[a-f0-9]{40}`/.test(readme)) {
      problems.push('README missing source commit')
    }
    if (!readme.includes('localStorage')) {
      problems.push('README missing localStorage checkout note')
    }
    if (!readme.includes(MALL_UPDATE_COMMAND)) {
      problems.push('README missing update command')
    }
  }
  const assets = join(dir, 'assets')
  if (!existsSync(assets)) problems.push('missing assets/')
  return problems
}

export function copyMallSources({ sourceRoot, stagingRoot }) {
  mkdirSync(join(stagingRoot, 'src'), { recursive: true })
  cpSync(SNAPSHOT_TEMPLATE, stagingRoot, { recursive: true })
  for (const relative of COPY_PATHS) {
    const from = join(sourceRoot, relative)
    if (!existsSync(from)) {
      throw new Error(`source file missing: ${from}`)
    }
    const to = join(stagingRoot, relative)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true })
  }
}

/**
 * @param {{
 *   distDir: string,
 *   targetDir: string,
 *   sourceRoot: string,
 *   commit: string,
 * }} options
 */
export function installMallSnapshot({ distDir, targetDir, sourceRoot, commit }) {
  const htmlPath = join(distDir, 'index.html')
  if (!existsSync(htmlPath)) {
    throw new Error(`Vite outDir is missing index.html: ${distDir}`)
  }

  let html = readFileSync(htmlPath, 'utf8')
  html = rewriteRootAbsoluteUrls(html)
  html = injectGalleryNav(html)
  writeFileSync(htmlPath, html)

  cpSync(findLucideLicense(sourceRoot), join(distDir, 'LICENSE'))
  writeFileSync(
    join(distDir, 'README.md'),
    renderMallProvenance({
      commit,
      lucideVersion: readLucideVersion(sourceRoot),
    }),
  )

  const problems = mallSnapshotProblems(distDir)
  if (problems.length) {
    throw new Error(`mall snapshot failed checks:\n- ${problems.join('\n- ')}`)
  }
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(dirname(targetDir), { recursive: true })
  cpSync(distDir, targetDir, { recursive: true })
}

/**
 * @param {string[]} argv
 * @param {{ root?: string }} [options]
 */
export function main(argv, options = {}) {
  if (argv.length !== 1) {
    throw new Error('Usage: node scripts/site-mall.mjs <source-dir>')
  }

  const root = options.root ?? defaultRoot
  const sourceRoot = resolve(argv[0])
  if (!existsSync(join(sourceRoot, 'package.json'))) {
    throw new Error(`source project not found: ${sourceRoot}`)
  }
  if (!existsSync(join(sourceRoot, 'src', 'components', 'HomeClient.tsx'))) {
    throw new Error(`international mall sources not found in ${sourceRoot}`)
  }

  const viteBin = findViteBin(sourceRoot)
  const commit = readGitCommit(sourceRoot)
  const staging = mkdtempSync(join(tmpdir(), 'codsh-site-mall-'))
  const appDir = join(staging, 'app')
  const outDir = join(staging, 'dist')
  mkdirSync(appDir, { recursive: true })
  mkdirSync(outDir)

  try {
    copyMallSources({ sourceRoot, stagingRoot: appDir })
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'codsh-mall-snapshot', private: true, type: 'module' }, null, 2),
    )
    symlinkSync(join(sourceRoot, 'node_modules'), join(appDir, 'node_modules'), 'dir')

    execFileSync(
      process.execPath,
      [
        viteBin,
        'build',
        '--config',
        join(appDir, 'vite.config.mjs'),
        '--base',
        relativeAssetBase(),
        '--outDir',
        outDir,
        '--emptyOutDir',
      ],
      {
        cwd: appDir,
        stdio: 'inherit',
        env: { ...process.env, MALL_SOURCE_ROOT: sourceRoot },
      },
    )

    const targetDir = mallTargetDir(root)
    installMallSnapshot({ distDir: outDir, targetDir, sourceRoot, commit })
    console.log(`imported ${MALL_SLUG} from ${sourceRoot}@${commit}`)
    console.log(`wrote ${targetDir}`)
    return targetDir
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function isDirectRun(argv1) {
  if (!argv1) return false
  return thisFile === resolve(argv1)
}

if (isDirectRun(process.argv[1])) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
