import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEMO_SLUG,
  GALLERY_LINKS,
  ORIGINAL_REQUIREMENT,
  SOURCE_COMMIT,
  UPDATE_COMMAND,
  collectDocumentRefs,
  demoTargetDir,
  injectGalleryNav,
  installSnapshot,
  isRelativeUrl,
  relativeAssetBase,
  renderProvenance,
  rewriteRootAbsoluteUrls,
  snapshotProblems,
} from './site-demo.mjs'

const sampleHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Medal of Honor Web</title>
    <script type="module" crossorigin src="/assets/index-hash.js"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
`

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('relativeAssetBase', () => {
  it('is the Vite --base that keeps hashed assets next to index.html', () => {
    expect(relativeAssetBase()).toBe('./')
  })
})

describe('demoTargetDir', () => {
  it('places the snapshot under site/demos/<slug>', () => {
    expect(demoTargetDir('/repo')).toBe(`/repo/site/demos/${DEMO_SLUG}`)
    expect(demoTargetDir('/repo', 'other')).toBe('/repo/site/demos/other')
  })
})

describe('isRelativeUrl', () => {
  it('accepts relative, hash, and data URLs', () => {
    expect(isRelativeUrl('./assets/index.js')).toBe(true)
    expect(isRelativeUrl('assets/index.js')).toBe(true)
    expect(isRelativeUrl('../gallery.html')).toBe(true)
    expect(isRelativeUrl('#app')).toBe(true)
    expect(isRelativeUrl('data:image/svg+xml,x')).toBe(true)
  })

  it('rejects root-absolute, protocol-relative, and remote URLs', () => {
    expect(isRelativeUrl('/assets/index.js')).toBe(false)
    expect(isRelativeUrl('/codsh/assets/index.js')).toBe(false)
    expect(isRelativeUrl('//cdn.example/x.js')).toBe(false)
    expect(isRelativeUrl('https://example.com/x.js')).toBe(false)
  })
})

describe('rewriteRootAbsoluteUrls', () => {
  it('turns /assets/... into ./assets/... so Pages under /codsh/ still loads', () => {
    const rewritten = rewriteRootAbsoluteUrls(sampleHtml)
    expect(rewritten).toContain('src="./assets/index-hash.js"')
    expect(rewritten).not.toContain('src="/assets/index-hash.js"')
  })

  it('does not rewrite protocol-relative URLs', () => {
    expect(rewriteRootAbsoluteUrls('<script src="//cdn.example/x.js"></script>')).toContain(
      'src="//cdn.example/x.js"',
    )
  })
})

describe('injectGalleryNav', () => {
  it('adds bilingual gallery links outside #app', () => {
    const html = injectGalleryNav(sampleHtml)
    expect(html).toContain(`href="${GALLERY_LINKS.en}"`)
    expect(html).toContain(`href="${GALLERY_LINKS.zh}"`)
    expect(html.indexOf('codsh-demo-gallery')).toBeLessThan(html.indexOf('id="app"'))
    expect(html).toMatch(/<div id="app"><\/div>/)
    expect(html).toContain('z-index: 101')
  })

  it('is idempotent', () => {
    const once = injectGalleryNav(sampleHtml)
    expect(injectGalleryNav(once)).toBe(once)
  })
})

describe('renderProvenance', () => {
  it('records the original requirement, commit, controls, affiliation, and update command', () => {
    const readme = renderProvenance({ commit: SOURCE_COMMIT, threeVersion: '0.170.0' })
    expect(readme).toContain(ORIGINAL_REQUIREMENT)
    expect(readme).toContain(SOURCE_COMMIT)
    expect(readme).toContain('keyboard and mouse')
    expect(readme).toContain('unofficial')
    expect(readme).toContain('not associated with')
    expect(readme).toContain(UPDATE_COMMAND)
    expect(readme).toContain('0.170.0')
  })
})

describe('snapshotProblems', () => {
  it('reports a missing index.html', () => {
    const dir = tempDir('codsh-demo-empty-')
    try {
      expect(snapshotProblems(dir)).toContain('missing index.html')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts a relative snapshot with license and provenance', () => {
    const dir = tempDir('codsh-demo-ok-')
    try {
      mkdirSync(join(dir, 'assets'))
      writeFileSync(join(dir, 'assets', 'index-hash.js'), 'export {}')
      writeFileSync(
        join(dir, 'index.html'),
        injectGalleryNav(rewriteRootAbsoluteUrls(sampleHtml)),
      )
      writeFileSync(join(dir, 'LICENSE'), 'MIT')
      writeFileSync(join(dir, 'README.md'), renderProvenance({ commit: SOURCE_COMMIT }))
      expect(snapshotProblems(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags a root-absolute script URL', () => {
    const dir = tempDir('codsh-demo-abs-')
    try {
      mkdirSync(join(dir, 'assets'))
      writeFileSync(join(dir, 'index.html'), injectGalleryNav(sampleHtml))
      writeFileSync(join(dir, 'LICENSE'), 'MIT')
      writeFileSync(join(dir, 'README.md'), renderProvenance({ commit: SOURCE_COMMIT }))
      expect(snapshotProblems(dir)).toContain('non-relative URL: /assets/index-hash.js')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('installSnapshot', () => {
  it('copies the built files, rewrites URLs, and writes license plus provenance', () => {
    const staging = tempDir('codsh-demo-install-')
    try {
      const distDir = join(staging, 'dist')
      const targetDir = join(staging, 'site', 'demos', DEMO_SLUG)
      const sourceRoot = join(staging, 'source')
      mkdirSync(join(distDir, 'assets'), { recursive: true })
      mkdirSync(join(sourceRoot, 'node_modules', 'three'), { recursive: true })
      writeFileSync(join(distDir, 'index.html'), sampleHtml)
      writeFileSync(join(distDir, 'assets', 'index-hash.js'), 'export {}')
      writeFileSync(join(sourceRoot, 'node_modules', 'three', 'LICENSE'), 'The MIT License\n')
      writeFileSync(
        join(sourceRoot, 'node_modules', 'three', 'package.json'),
        JSON.stringify({ version: '0.170.0' }),
      )

      installSnapshot({
        distDir,
        targetDir,
        sourceRoot,
        commit: SOURCE_COMMIT,
      })

      expect(existsSync(join(targetDir, 'assets', 'index-hash.js'))).toBe(true)
      const html = readFileSync(join(targetDir, 'index.html'), 'utf8')
      expect(collectDocumentRefs(html).every(isRelativeUrl)).toBe(true)
      expect(html).toContain(GALLERY_LINKS.en)
      expect(html).toContain(GALLERY_LINKS.zh)
      expect(readFileSync(join(targetDir, 'LICENSE'), 'utf8')).toContain('MIT License')
      const readme = readFileSync(join(targetDir, 'README.md'), 'utf8')
      expect(readme).toContain(ORIGINAL_REQUIREMENT)
      expect(readme).toContain(SOURCE_COMMIT)
      expect(snapshotProblems(targetDir)).toEqual([])
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  })
})
