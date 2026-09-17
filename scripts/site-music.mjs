#!/usr/bin/env node
/**
 * Import a playable static production build of the local Web Music Player
 * project into `site/demos/web-music-player/` so GitHub Pages can serve
 * a desktop-grade local audio player demo with relative asset URLs.
 *
 * Usage: node scripts/site-music.mjs <path-to-the-web-music-player-source>
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

export const MUSIC_SLUG = 'web-music-player'
export const MUSIC_ORIGINAL_REQUIREMENT = '做一个 web 音乐播放器，但是要像本地应用一样'
export const MUSIC_UPDATE_COMMAND = 'node scripts/site-music.mjs ../test-codsh'
export const MUSIC_SOURCE_COMMIT = 'f494f2b45f7baec049ac6742e06054aa28d7ff78'

const thisFile = fileURLToPath(import.meta.url)
const defaultRoot = join(dirname(thisFile), '..')

export function musicTargetDir(root = defaultRoot) {
  return demoTargetDir(root, MUSIC_SLUG)
}

export function findViteBin(sourceRoot) {
  const direct = join(sourceRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  if (existsSync(direct)) return direct
  const requireFromSource = createRequire(join(sourceRoot, 'package.json'))
  try {
    return requireFromSource.resolve('vite/bin/vite.js')
  } catch {
    throw new Error(`installed Vite not found for ${sourceRoot}`)
  }
}

export function findLucideLicense(sourceRoot) {
  const direct = join(sourceRoot, 'node_modules', 'lucide-react', 'LICENSE')
  if (existsSync(direct)) return direct
  const requireFromSource = createRequire(join(sourceRoot, 'package.json'))
  return requireFromSource.resolve('lucide-react/LICENSE')
}

export function readLucideVersion(sourceRoot) {
  try {
    const license = findLucideLicense(sourceRoot)
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
export function renderMusicProvenance(info) {
  const requirement = info.requirement ?? MUSIC_ORIGINAL_REQUIREMENT
  const updateCommand = info.updateCommand ?? MUSIC_UPDATE_COMMAND
  const sourceLabel = info.sourceLabel ?? 'local `../test-codsh` (no git remote)'
  const lucideVersion = info.lucideVersion ? ` ${info.lucideVersion}` : ''
  return `# Web Music Player (Local-Style Web Application)

This directory is a static production snapshot of a local demo project,
checked in so GitHub Pages can serve an interactive desktop-grade audio
player with relative asset URLs.

## Original requirement

> ${requirement}

The source project is a client-side desktop-grade Progressive Web Application
(PWA) that replicates native local audio players (such as macOS Music or foobar2000).
It features direct local file system access, cross-session IndexedDB persistence,
a 10-band graphic equalizer, a real-time frequency spectrum visualizer, synchronized
LRC lyrics, OS MediaSession controls, and bundled sample tracks for immediate
first-run auditioning.

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
 * Problems that would make the checked-in snapshot broken on Pages.
 * @param {string} dir
 * @returns {string[]}
 */
export function musicSnapshotProblems(dir) {
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
    if (!readme.includes(MUSIC_ORIGINAL_REQUIREMENT)) {
      problems.push('README missing original requirement')
    }
    if (!/Source snapshot commit: `[a-f0-9]{40}`/.test(readme)) {
      problems.push('README missing source commit')
    }
    if (!readme.includes(MUSIC_UPDATE_COMMAND)) {
      problems.push('README missing update command')
    }
    if (!readme.includes('IndexedDB')) {
      problems.push('README missing IndexedDB note')
    }
  }
  const assets = join(dir, 'assets')
  if (!existsSync(assets)) problems.push('missing assets/')
  return problems
}

/**
 * Rewrite manifest.json so its start_url, scope, and icon paths are relative.
 * @param {string} distDir
 */
export function sanitizeManifest(distDir) {
  const manifestPath = join(distDir, 'manifest.json')
  if (!existsSync(manifestPath)) return
  try {
    const content = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (content.start_url === '/') content.start_url = './'
    if (content.scope === '/') content.scope = './'
    if (Array.isArray(content.icons)) {
      content.icons = content.icons.map((icon) => ({
        ...icon,
        src: icon.src?.startsWith('/') ? `.${icon.src}` : icon.src,
      }))
    }
    writeFileSync(manifestPath, JSON.stringify(content, null, 2) + '\n')
  } catch {
    // Ignore if not parseable JSON
  }
}

/**
 * Finish a Vite dist: relative URLs, gallery chrome, license, provenance.
 * @param {{
 *   distDir: string,
 *   targetDir: string,
 *   sourceRoot: string,
 *   commit: string,
 * }} options
 */
export function installMusicSnapshot({ distDir, targetDir, sourceRoot, commit }) {
  const htmlPath = join(distDir, 'index.html')
  if (!existsSync(htmlPath)) {
    throw new Error(`Vite outDir is missing index.html: ${distDir}`)
  }

  let html = readFileSync(htmlPath, 'utf8')
  html = rewriteRootAbsoluteUrls(html)
  html = injectGalleryNav(html)
  writeFileSync(htmlPath, html)

  sanitizeManifest(distDir)

  cpSync(findLucideLicense(sourceRoot), join(distDir, 'LICENSE'))
  writeFileSync(
    join(distDir, 'README.md'),
    renderMusicProvenance({
      commit,
      lucideVersion: readLucideVersion(sourceRoot),
    }),
  )

  const problems = musicSnapshotProblems(distDir)
  if (problems.length) {
    throw new Error(`music snapshot failed checks:\n- ${problems.join('\n- ')}`)
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
    throw new Error('Usage: node scripts/site-music.mjs <source-dir>')
  }

  const root = options.root ?? defaultRoot
  const sourceRoot = resolve(argv[0])
  if (!existsSync(join(sourceRoot, 'package.json'))) {
    throw new Error(`source project not found: ${sourceRoot}`)
  }

  const viteBin = findViteBin(sourceRoot)
  const commit = readGitCommit(sourceRoot)
  const staging = mkdtempSync(join(tmpdir(), 'codsh-site-music-'))
  const outDir = join(staging, 'dist')
  mkdirSync(outDir)

  try {
    execFileSync(
      process.execPath,
      [
        viteBin,
        'build',
        '--base',
        relativeAssetBase(),
        '--outDir',
        outDir,
        '--emptyOutDir',
      ],
      { cwd: sourceRoot, stdio: 'inherit' },
    )

    const targetDir = musicTargetDir(root)
    installMusicSnapshot({ distDir: outDir, targetDir, sourceRoot, commit })
    console.log(`imported ${MUSIC_SLUG} from ${sourceRoot}@${commit}`)
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
    console.error(`site-music: ${error.message}`)
    process.exit(1)
  }
}
