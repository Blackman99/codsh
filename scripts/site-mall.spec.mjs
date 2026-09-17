import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GALLERY_LINKS, injectGalleryNav, rewriteRootAbsoluteUrls } from './site-demo.mjs'
import {
  MALL_ORIGINAL_REQUIREMENT,
  MALL_SLUG,
  MALL_SOURCE_COMMIT,
  MALL_UPDATE_COMMAND,
  mallTargetDir,
  mallSnapshotProblems,
  renderMallProvenance,
  installMallSnapshot,
} from './site-mall.mjs'

const sampleHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>International Mall</title>
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

describe('mallTargetDir', () => {
  it('places the snapshot under site/demos/international-mall', () => {
    expect(mallTargetDir('/repo')).toBe(`/repo/site/demos/${MALL_SLUG}`)
  })
})

describe('checked-in snapshot', () => {
  it('is Pages-ready with relative URLs and provenance', () => {
    expect(mallSnapshotProblems(mallTargetDir())).toEqual([])
  })
})

describe('renderMallProvenance', () => {
  it('records the original requirement, commit, localStorage checkout, and update command', () => {
    const readme = renderMallProvenance({ commit: MALL_SOURCE_COMMIT, lucideVersion: '0.468.0' })
    expect(readme).toContain(MALL_ORIGINAL_REQUIREMENT)
    expect(readme).toContain(MALL_SOURCE_COMMIT)
    expect(readme).toContain('localStorage')
    expect(readme).toContain(MALL_UPDATE_COMMAND)
    expect(readme).toContain('0.468.0')
  })
})

describe('mallSnapshotProblems', () => {
  it('reports a missing index.html', () => {
    const dir = tempDir('codsh-mall-empty-')
    try {
      expect(mallSnapshotProblems(dir)).toContain('missing index.html')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts a relative snapshot with license and provenance', () => {
    const dir = tempDir('codsh-mall-ok-')
    try {
      mkdirSync(join(dir, 'assets'))
      writeFileSync(join(dir, 'assets', 'index-hash.js'), 'export {}')
      writeFileSync(join(dir, 'assets', 'index-hash.css'), 'body{}')
      writeFileSync(
        join(dir, 'index.html'),
        injectGalleryNav(rewriteRootAbsoluteUrls(sampleHtml)),
      )
      writeFileSync(join(dir, 'LICENSE'), 'ISC')
      writeFileSync(join(dir, 'README.md'), renderMallProvenance({ commit: MALL_SOURCE_COMMIT }))
      expect(mallSnapshotProblems(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags a root-absolute script URL', () => {
    const dir = tempDir('codsh-mall-abs-')
    try {
      mkdirSync(join(dir, 'assets'))
      writeFileSync(join(dir, 'index.html'), injectGalleryNav(sampleHtml))
      writeFileSync(join(dir, 'LICENSE'), 'ISC')
      writeFileSync(join(dir, 'README.md'), renderMallProvenance({ commit: MALL_SOURCE_COMMIT }))
      expect(mallSnapshotProblems(dir)).toContain('non-relative URL: /assets/index-hash.js')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('installMallSnapshot', () => {
  it('copies the built files, rewrites URLs, and writes license plus provenance', () => {
    const staging = tempDir('codsh-mall-install-')
    try {
      const distDir = join(staging, 'dist')
      const targetDir = join(staging, 'site', 'demos', MALL_SLUG)
      const sourceRoot = join(staging, 'source')
      mkdirSync(join(distDir, 'assets'), { recursive: true })
      mkdirSync(join(sourceRoot, 'node_modules', 'lucide-react'), { recursive: true })
      writeFileSync(join(sourceRoot, 'package.json'), JSON.stringify({ name: 'mall-source', private: true }))
      writeFileSync(join(distDir, 'index.html'), sampleHtml)
      writeFileSync(join(distDir, 'assets', 'index-hash.js'), 'export {}')
      writeFileSync(join(distDir, 'assets', 'index-hash.css'), 'body{}')
      writeFileSync(join(sourceRoot, 'node_modules', 'lucide-react', 'LICENSE'), 'ISC License\n')
      writeFileSync(
        join(sourceRoot, 'node_modules', 'lucide-react', 'package.json'),
        JSON.stringify({ version: '0.468.0' }),
      )

      installMallSnapshot({
        distDir,
        targetDir,
        sourceRoot,
        commit: MALL_SOURCE_COMMIT,
      })

      expect(existsSync(join(targetDir, 'assets', 'index-hash.js'))).toBe(true)
      const html = readFileSync(join(targetDir, 'index.html'), 'utf8')
      expect(html).toContain(GALLERY_LINKS.en)
      expect(html).toContain(GALLERY_LINKS.zh)
      expect(html).toContain('src="./assets/index-hash.js"')
      expect(readFileSync(join(targetDir, 'LICENSE'), 'utf8')).toContain('ISC License')
      const readme = readFileSync(join(targetDir, 'README.md'), 'utf8')
      expect(readme).toContain(MALL_ORIGINAL_REQUIREMENT)
      expect(readme).toContain(MALL_SOURCE_COMMIT)
      expect(mallSnapshotProblems(targetDir)).toEqual([])
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  })
})
