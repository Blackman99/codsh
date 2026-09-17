import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const site = join(root, 'site')
const pages = ['index.html', 'zh.html', 'gallery.html', 'gallery.zh.html', 'guide.html', 'guide.zh.html']
const read = file => readFileSync(join(site, file), 'utf8')

function htmlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? htmlFiles(path) : entry.name.endsWith('.html') ? [path] : []
  })
}

describe('documentation site', () => {
  it('keeps homepages short and guides separate from project galleries', () => {
    for (const [home, guide, gallery] of [
      ['index.html', 'guide.html', 'gallery.html'],
      ['zh.html', 'guide.zh.html', 'gallery.zh.html'],
    ]) {
      expect(read(home)).not.toContain('frames:start')
      expect(read(home).split('\n').length).toBeLessThan(100)
      expect(read(home)).toContain(`href="${guide}"`)
      expect(read(home)).toContain(`href="${gallery}"`)
      expect(read(home)).toMatch(new RegExp(`<a class="button" href="${guide.replaceAll('.', '\\.')}">`))
      expect(read(home)).not.toMatch(/<a class="button" href="#[^"]*">/)
      expect(read(guide)).toContain('frames:start')
      expect(read(guide)).toContain(`href="${home}"`)
      expect(read(gallery)).toContain('做一个 web 版的荣誉勋章游戏')
      expect(read(gallery)).toContain('href="demos/medal-of-honor/index.html"')
      expect(read(gallery)).toContain('做一个国际商城')
      expect(read(gallery)).toContain('href="demos/international-mall/index.html"')
      expect(read(gallery)).toContain('assets/gallery/international-mall.webp')
      expect(read(gallery)).toContain('做一个 web 音乐播放器，但是要像本地应用一样')
      expect(read(gallery)).toContain('href="demos/web-music-player/index.html"')
      expect(read(gallery)).toContain('assets/gallery/web-music-player.webp')
    }
  })

  it('explains the build conditions for every gallery project in both languages', () => {
    for (const [gallery, conditions] of [
      ['gallery.html', ['Every project', 'one-sentence request', 'one round of interaction', 'recommended answer selected for every question']],
      ['gallery.zh.html', ['所有项目', '一句话需求', '一轮交互', '所有问题均采用推荐答案']],
    ]) {
      const introduction = read(gallery).match(/<div class="page-heading">([\s\S]*?)<\/div>/)?.[1] ?? ''
      for (const condition of conditions) expect(introduction).toContain(condition)
    }
  })

  it('invites README readers to the matching gallery before installation', () => {
    for (const [file, heading, gallery, invitation, conditions] of [
      ['README.md', '## Install', 'gallery.html', 'Visit the gallery', ['one-sentence request', 'one round of interaction', 'recommended answer selected for every question']],
      ['README.zh.md', '## 安装', 'gallery.zh.html', '逛逛展示画廊', ['一句话需求', '一轮交互', '所有问题均采用推荐答案']],
    ]) {
      const introduction = readFileSync(join(root, file), 'utf8').split(heading)[0]
      expect(introduction).toContain(`[${invitation}](https://blackman99.github.io/codsh/${gallery})`)
      for (const condition of conditions) expect(introduction).toContain(condition)
    }
  })

  it('keeps language switches on the equivalent page', () => {
    for (const [en, zh] of [['index.html', 'zh.html'], ['guide.html', 'guide.zh.html'], ['gallery.html', 'gallery.zh.html']]) {
      expect(read(en)).toMatch(new RegExp(`href="${zh.replaceAll('.', '\\.')}" hreflang="zh(?:-Hans)?"`))
      expect(read(zh)).toContain(`href="${en}" hreflang="en"`)
    }
  })

  it('resolves every local link, fragment and asset under a hosting prefix', () => {
    for (const file of htmlFiles(site)) {
      const html = readFileSync(file, 'utf8')
      for (const [, attribute, value] of html.matchAll(/\b(href|src)="([^"\s]+)"/g)) {
        if (/^(?:https?:|data:|mailto:)/.test(value)) continue
        expect(value, `${file}: ${attribute}=${value}`).not.toMatch(/^\//)
        const [path, fragment] = value.split('#')
        const target = path ? resolve(dirname(file), decodeURIComponent(path.split('?')[0])) : file
        expect(existsSync(target), `${file}: missing ${value}`).toBe(true)
        if (fragment && target.endsWith('.html')) {
          expect(readFileSync(target, 'utf8'), `${file}: missing #${fragment}`).toContain(`id="${fragment}"`)
        }
      }
    }
  })

  it('regenerates only guide captures and produces the committed HTML', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'codsh-site-pages-'))
    try {
      cpSync(join(root, 'scripts/site-frames.mjs'), join(temporary, 'scripts/site-frames.mjs'), { recursive: true })
      cpSync(join(site, 'data'), join(temporary, 'site/data'), { recursive: true })
      for (const file of pages) cpSync(join(site, file), join(temporary, 'site', file))
      execFileSync(process.execPath, [join(temporary, 'scripts/site-frames.mjs')])
      for (const file of pages) expect(readFileSync(join(temporary, 'site', file), 'utf8')).toBe(read(file))
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})
