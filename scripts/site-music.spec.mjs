import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GALLERY_LINKS, injectGalleryNav, rewriteRootAbsoluteUrls } from './site-demo.mjs'
import {
  MUSIC_ORIGINAL_REQUIREMENT,
  MUSIC_SLUG,
  MUSIC_SOURCE_COMMIT,
  MUSIC_UPDATE_COMMAND,
  musicTargetDir,
  musicSnapshotProblems,
  renderMusicProvenance,
  installMusicSnapshot,
} from './site-music.mjs'

const sampleHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Web Music Player</title>
    <script type="module" crossorigin src="/assets/index-hash.js"></script>
    <link rel="stylesheet" href="/assets/index-hash.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('musicTargetDir', () => {
  it('places the snapshot under site/demos/web-music-player', () => {
    expect(musicTargetDir('/repo')).toBe(`/repo/site/demos/${MUSIC_SLUG}`)
  })
})

describe('checked-in snapshot', () => {
  it('is Pages-ready with relative URLs and provenance', () => {
    expect(musicSnapshotProblems(musicTargetDir())).toEqual([])
  })
})

describe('renderMusicProvenance', () => {
  it('records the original requirement, commit, IndexedDB, and update command', () => {
    const readme = renderMusicProvenance({ commit: MUSIC_SOURCE_COMMIT, lucideVersion: '0.475.0' })
    expect(readme).toContain(MUSIC_ORIGINAL_REQUIREMENT)
    expect(readme).toContain(MUSIC_SOURCE_COMMIT)
    expect(readme).toContain('IndexedDB')
    expect(readme).toContain(MUSIC_UPDATE_COMMAND)
    expect(readme).toContain('0.475.0')
  })
})

describe('musicSnapshotProblems', () => {
  it('reports a missing index.html', () => {
    const dir = tempDir('codsh-music-empty-')
    try {
      expect(musicSnapshotProblems(dir)).toContain('missing index.html')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts a relative snapshot with license and provenance', () => {
    const dir = tempDir('codsh-music-ok-')
    try {
      mkdirSync(join(dir, 'assets'))
      writeFileSync(join(dir, 'assets', 'index-hash.js'), 'export {}')
      writeFileSync(join(dir, 'assets', 'index-hash.css'), 'body{}')
      writeFileSync(
        join(dir, 'index.html'),
        injectGalleryNav(rewriteRootAbsoluteUrls(sampleHtml)),
      )
      writeFileSync(join(dir, 'LICENSE'), 'ISC')
      writeFileSync(join(dir, 'README.md'), renderMusicProvenance({ commit: MUSIC_SOURCE_COMMIT }))
      expect(musicSnapshotProblems(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags a root-absolute script URL', () => {
    const dir = tempDir('codsh-music-abs-')
    try {
      mkdirSync(join(dir, 'assets'))
      writeFileSync(join(dir, 'index.html'), injectGalleryNav(sampleHtml))
      writeFileSync(join(dir, 'LICENSE'), 'ISC')
      writeFileSync(join(dir, 'README.md'), renderMusicProvenance({ commit: MUSIC_SOURCE_COMMIT }))
      expect(musicSnapshotProblems(dir)).toContain('non-relative URL: /assets/index-hash.js')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('installMusicSnapshot', () => {
  it('copies the built files, rewrites URLs, sanitizes manifest, and writes license plus provenance', () => {
    const staging = tempDir('codsh-music-install-')
    try {
      const distDir = join(staging, 'dist')
      const targetDir = join(staging, 'site', 'demos', MUSIC_SLUG)
      const sourceRoot = join(staging, 'source')
      mkdirSync(join(distDir, 'assets'), { recursive: true })
      mkdirSync(join(sourceRoot, 'node_modules', 'lucide-react'), { recursive: true })
      writeFileSync(join(sourceRoot, 'package.json'), JSON.stringify({ name: 'music-source', private: true }))
      writeFileSync(join(distDir, 'index.html'), sampleHtml)
      writeFileSync(join(distDir, 'assets', 'index-hash.js'), 'export {}')
      writeFileSync(join(distDir, 'assets', 'index-hash.css'), 'body{}')
      writeFileSync(
        join(distDir, 'manifest.json'),
        JSON.stringify({
          start_url: '/',
          scope: '/',
          icons: [{ src: '/icon.svg' }],
        }),
      )
      writeFileSync(join(sourceRoot, 'node_modules', 'lucide-react', 'LICENSE'), 'ISC License\n')
      writeFileSync(
        join(sourceRoot, 'node_modules', 'lucide-react', 'package.json'),
        JSON.stringify({ version: '0.475.0' }),
      )

      installMusicSnapshot({
        distDir,
        targetDir,
        sourceRoot,
        commit: MUSIC_SOURCE_COMMIT,
      })

      expect(existsSync(join(targetDir, 'index.html'))).toBe(true)
      expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toContain('src="./assets/index-hash.js"')
      expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toContain(GALLERY_LINKS.en)
      expect(readFileSync(join(targetDir, 'LICENSE'), 'utf8')).toContain('ISC License')
      expect(readFileSync(join(targetDir, 'README.md'), 'utf8')).toContain(MUSIC_ORIGINAL_REQUIREMENT)

      const manifest = JSON.parse(readFileSync(join(targetDir, 'manifest.json'), 'utf8'))
      expect(manifest.start_url).toBe('./')
      expect(manifest.scope).toBe('./')
      expect(manifest.icons[0].src).toBe('./icon.svg')
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  })
})
