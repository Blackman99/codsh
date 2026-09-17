#!/usr/bin/env node
/**
 * Import a playable static production build of a local demo into
 * `site/demos/<slug>/` so GitHub Pages can serve it under `/codsh/`.
 *
 * The source project's own installed Vite is invoked with `--base ./` into a
 * temporary outDir. Only that snapshot is copied; the source tree is not
 * edited. Asset URLs stay relative so a Pages project site does not resolve
 * `/assets/...` at the domain root.
 *
 * Usage: node scripts/site-demo.mjs <path-to-the-Medal-of-Honor-source>
 *
 * The current `../test-codsh` tree is International Mall. Refresh that
 * snapshot with `node scripts/site-mall.mjs ../test-codsh` instead.
 */

import { execFileSync } from 'node:child_process'
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

export const RELATIVE_BASE = './'
export const DEMO_SLUG = 'medal-of-honor'
export const SOURCE_COMMIT = '4bbf68e77dfea4f3d8497f120067604aa671cf47'
export const ORIGINAL_REQUIREMENT = '做一个 web 版的荣誉勋章游戏'
export const UPDATE_COMMAND = 'node scripts/site-demo.mjs ../test-codsh'
export const GALLERY_LINKS = Object.freeze({
  en: '../../gallery.html',
  zh: '../../gallery.zh.html',
})

const thisFile = fileURLToPath(import.meta.url)
const defaultRoot = join(dirname(thisFile), '..')

/** Vite `--base` that keeps hashed assets relative to the demo HTML. */
export function relativeAssetBase() {
  return RELATIVE_BASE
}

/**
 * Checked-in snapshot directory for a demo slug.
 * @param {string} [root]
 * @param {string} [slug]
 */
export function demoTargetDir(root = defaultRoot, slug = DEMO_SLUG) {
  return join(root, 'site', 'demos', slug)
}

/**
 * Root-absolute `/assets/...` breaks GitHub Pages under `/codsh/`.
 * Hash fragments, data URLs, and `./` / `../` paths are already relative.
 * @param {string} url
 */
export function isRelativeUrl(url) {
  if (url.startsWith('#') || url.startsWith('data:') || url.startsWith('mailto:')) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false
  if (url.startsWith('//')) return false
  if (url.startsWith('/')) return false
  return true
}

/**
 * Rewrite `/foo` to `./foo` in src/href. Protocol-relative `//` is left alone.
 * @param {string} html
 */
export function rewriteRootAbsoluteUrls(html) {
  return html.replace(
    /\b(src|href)=(["'])\/(?!\/)(.*?)\2/g,
    (_match, attr, quote, path) => `${attr}=${quote}./${path}${quote}`,
  )
}

/** @param {string} html */
export function collectDocumentRefs(html) {
  const refs = []
  const pattern = /\b(?:src|href)=(["'])(.*?)\1/gi
  for (const match of html.matchAll(pattern)) refs.push(match[2])
  return refs
}

export function galleryNavStyle() {
  return `<style>
      .codsh-demo-gallery {
        position: fixed;
        top: 10px;
        right: 12px;
        z-index: 101;
        font: 12px/1.4 system-ui, sans-serif;
        color: #c8c4b8;
        background: rgba(10, 12, 10, 0.55);
        border: 1px solid rgba(200, 196, 180, 0.28);
        border-radius: 3px;
        padding: 4px 10px;
        pointer-events: auto;
      }
      .codsh-demo-gallery a { color: #e8e4d4; text-decoration: none; }
      .codsh-demo-gallery a:hover { text-decoration: underline; }
      .codsh-demo-gallery a:focus-visible { outline: 2px solid #6fd6d0; outline-offset: 3px; }
    </style>`
}

export function galleryNavHtml() {
  return `<nav class="codsh-demo-gallery" aria-label="Back to gallery">
      <a href="${GALLERY_LINKS.en}" lang="en">Gallery</a>
      <span aria-hidden="true"> · </span>
      <a href="${GALLERY_LINKS.zh}" lang="zh-Hans">展示画廊</a>
    </nav>`
}

/**
 * Static gallery chrome outside `#app`, so the game canvas and HUD stay
 * untouched. Idempotent when the nav is already present.
 * @param {string} html
 */
export function injectGalleryNav(html) {
  if (html.includes('codsh-demo-gallery')) return html
  let out = html
  if (out.includes('</head>')) {
    out = out.replace('</head>', `    ${galleryNavStyle()}\n  </head>`)
  }
  out = out.replace(/<body([^>]*)>/i, `<body$1>\n    ${galleryNavHtml()}`)
  return out
}

/**
 * @param {{
 *   commit: string,
 *   requirement?: string,
 *   updateCommand?: string,
 *   sourceLabel?: string,
 *   threeVersion?: string,
 * }} info
 */
export function renderProvenance(info) {
  const requirement = info.requirement ?? ORIGINAL_REQUIREMENT
  const updateCommand = info.updateCommand ?? UPDATE_COMMAND
  const sourceLabel = info.sourceLabel ?? 'local `../test-codsh` (no git remote)'
  const threeVersion = info.threeVersion ? ` ${info.threeVersion}` : ''
  return `# Medal of Honor Web (unofficial tribute)

This directory is a static production build of a local demo project, checked
in so GitHub Pages can serve a playable snapshot with relative asset URLs.

## Original requirement

> ${requirement}

The source project is a desktop-browser first-person shooter. It requires a
**keyboard and mouse** (pointer-lock look, WASD movement, click to fire). It
is not built for touch controls.

## Provenance

- Source snapshot commit: \`${info.commit}\`
- Source tree: ${sourceLabel}
- Bundler: the source project's installed Vite, invoked with \`--base ./\` into a temporary outDir
- This folder contains only that built snapshot, plus the Three.js license and this note

## Affiliation

This is an **unofficial fan tribute**. It is not associated with, endorsed by,
or affiliated with Electronic Arts, Danger Close, or the Medal of Honor
franchise.

## Three.js

The production bundle includes three.js${threeVersion} (MIT). The license text
is preserved in \`LICENSE\` next to this build.

## Update

From the codsh repository root (the importer does not edit the source project):

\`\`\`
${updateCommand}
\`\`\`
`
}

/** @param {string} sourceRoot */
export function findViteBin(sourceRoot) {
  const bin = join(sourceRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(bin)) {
    throw new Error(`installed Vite not found at ${bin}`)
  }
  return bin
}

/** @param {string} sourceRoot */
export function findThreeLicense(sourceRoot) {
  const license = join(sourceRoot, 'node_modules', 'three', 'LICENSE')
  if (!existsSync(license)) {
    throw new Error(`Three.js LICENSE not found at ${license}`)
  }
  return license
}

/** @param {string} sourceRoot */
export function readThreeVersion(sourceRoot) {
  const manifest = join(sourceRoot, 'node_modules', 'three', 'package.json')
  if (!existsSync(manifest)) return undefined
  return JSON.parse(readFileSync(manifest, 'utf8')).version
}

/** @param {string} sourceRoot */
export function readGitCommit(sourceRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
  }).trim()
}

/**
 * Problems that would make the checked-in snapshot unplayable on Pages.
 * @param {string} dir
 * @returns {string[]}
 */
export function snapshotProblems(dir) {
  const problems = []
  const index = join(dir, 'index.html')
  if (!existsSync(index)) {
    problems.push('missing index.html')
    return problems
  }
  const html = readFileSync(index, 'utf8')
  if (!html.includes('id="app"') && !html.includes("id='app'")) {
    problems.push('index.html does not contain #app')
  }
  for (const ref of collectDocumentRefs(html)) {
    if (!isRelativeUrl(ref)) problems.push(`non-relative URL: ${ref}`)
    if (ref.startsWith('./assets/') && !existsSync(resolve(dir, ref.split(/[?#]/)[0]))) {
      problems.push(`missing asset: ${ref}`)
    }
  }
  if (!html.includes(GALLERY_LINKS.en)) problems.push('missing English gallery link')
  if (!html.includes(GALLERY_LINKS.zh)) problems.push('missing Chinese gallery link')
  if (!existsSync(join(dir, 'LICENSE'))) problems.push('missing Three.js LICENSE')
  const readmePath = join(dir, 'README.md')
  if (!existsSync(readmePath)) {
    problems.push('missing README.md')
  } else {
    const readme = readFileSync(readmePath, 'utf8')
    if (!readme.includes(ORIGINAL_REQUIREMENT)) {
      problems.push('README missing original requirement')
    }
    if (!/Source snapshot commit: `[a-f0-9]{40}`/.test(readme)) {
      problems.push('README missing source commit')
    }
    if (!readme.includes('keyboard and mouse')) {
      problems.push('README missing keyboard+mouse requirement')
    }
    if (!readme.includes('unofficial')) {
      problems.push('README missing unofficial tribute notice')
    }
    if (!readme.includes('not associated with')) {
      problems.push('README missing no-affiliation notice')
    }
    if (!readme.includes(UPDATE_COMMAND)) {
      problems.push('README missing update command')
    }
  }
  const assets = join(dir, 'assets')
  if (!existsSync(assets)) problems.push('missing assets/')
  return problems
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
export function installSnapshot({ distDir, targetDir, sourceRoot, commit }) {
  const htmlPath = join(distDir, 'index.html')
  if (!existsSync(htmlPath)) {
    throw new Error(`Vite outDir is missing index.html: ${distDir}`)
  }

  let html = readFileSync(htmlPath, 'utf8')
  html = rewriteRootAbsoluteUrls(html)
  html = injectGalleryNav(html)
  writeFileSync(htmlPath, html)

  cpSync(findThreeLicense(sourceRoot), join(distDir, 'LICENSE'))
  writeFileSync(
    join(distDir, 'README.md'),
    renderProvenance({
      commit,
      threeVersion: readThreeVersion(sourceRoot),
    }),
  )

  const problems = snapshotProblems(distDir)
  if (problems.length) {
    throw new Error(`demo snapshot failed checks:\n- ${problems.join('\n- ')}`)
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
    throw new Error('Usage: node scripts/site-demo.mjs <source-dir>')
  }

  const root = options.root ?? defaultRoot
  const sourceRoot = resolve(argv[0])
  if (!existsSync(join(sourceRoot, 'package.json'))) {
    throw new Error(`source project not found: ${sourceRoot}`)
  }

  const viteBin = findViteBin(sourceRoot)
  const commit = readGitCommit(sourceRoot)
  const staging = mkdtempSync(join(tmpdir(), 'codsh-site-demo-'))
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

    const targetDir = demoTargetDir(root)
    installSnapshot({ distDir: outDir, targetDir, sourceRoot, commit })
    console.log(`imported ${DEMO_SLUG} from ${sourceRoot}@${commit}`)
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
