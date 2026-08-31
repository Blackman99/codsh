#!/usr/bin/env node
/**
 * Inline the captured terminal frames into the site's pages.
 *
 * The showcase must not need a script to appear: a docs page whose screenshots
 * arrive by fetch is a page that shows nothing when the fetch does not, and the
 * frames are the argument the site is making. So they are rendered here, once,
 * into static HTML between the `frames` markers, and the scene switcher is
 * radio inputs and CSS.
 *
 * Frames come from `site/data/screens.json`, written by the e2e capture
 * (`pnpm run site:screens`) from the real binary. This script never invents a
 * row: it maps the SGR each run carried to a class and escapes the text.
 *
 * Usage: node scripts/site-frames.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataPath = join(root, 'site', 'data', 'screens.json')

/** Short tab labels and captions per language, keyed by scene id. */
const COPY = {
  en: {
    welcome: { tab: 'Welcome' },
    anchor: { tab: 'Ask' },
    turns: { tab: 'Read back' },
    'tool-call': { tab: 'Tool cards' },
    'fold-open': { tab: 'Folds' },
    todos: { tab: 'Todos' },
    markdown: { tab: 'Markdown' },
    view: { tab: 'Full screen' },
  },
  zh: {
    welcome: {
      tab: '欢迎',
      title: '会话是自己的空间',
      note: '备用屏幕、钉在底部从不移动的输入框，以及始终当前的状态行。',
    },
    anchor: {
      tab: '提问',
      title: '刚问出口的问题停在最上面',
      note: '刚提交的问题占住视口顶部，回复从下方填进空出来的位置。往回读历史再回到底部，回来的是同一帧——滚轮和 PgDn 都能落回去。',
    },
    turns: {
      tab: '往回读',
      title: '你正在读的这段，是谁问出来的',
      note: '往回滚过一次轮次边界，问出这几行的那条提问就钉在顶部；右侧一列时间线标出当前在哪一轮，Shift+←/→ 在轮次之间跳。',
    },
    'tool-call': {
      tab: '工具卡片',
      title: '工具调用渲染为卡片，带 diff',
      note: '每次调用都经由它的 presenter 渲染——标题、状态、diff——左侧还有一道标出块边界的竖线。',
    },
    'fold-open': {
      tab: '折叠块',
      title: '一次点击只开一块',
      note: '点一下展开落点那一块，在块内任意处再点一下收起；Ctrl+O 依然一次开合全部，手动开合的选择会跨轮次保留。',
    },
    todos: {
      tab: 'Todo',
      title: 'todo 常驻可见',
      note: '一行常驻读数把 agent 的清单钉在状态行之上，不随那次写入滚走；Ctrl+T 展开为完整清单。',
    },
    markdown: {
      tab: 'Markdown',
      title: 'Markdown 是渲染，不是回显',
      note: '表格排出真正的列，代码带高亮，强调标记被吃掉而不是打印出来。',
    },
    view: {
      tab: '全屏阅读',
      title: '把一条回答摊开成整屏',
      note: '/view 1 打开一条回答，/view 1:1 打开它的第一个代码块，改窗口大小也不会乱；Esc 原样还回会话。/copy 用的是同一套编号。',
    },
  },
}

/** Per-language strings around the frames. */
const CHROME = {
  en: { real: 'real capture', pick: 'Pick a scene' },
  zh: { real: '真实抓取', pick: '选择场景' },
}

/**
 * The class list for one SGR pen.
 *
 * The surface paints with a small, known set of roles, and this is the only
 * place that knows which colour means which: magenta is the person's own
 * message, cyan a tool, red a failure, and the 256-palette gray everything
 * secondary. An unmapped code simply carries no class, which renders as the
 * terminal's default foreground — exactly what it would do.
 * @param pen - the pen recorded for a run, e.g. `38;5;245` or `35;1`.
 * @returns the classes to put on the span, or `''` for the default.
 */
function appearance(pen) {
  if (pen === '') return { classes: '', style: '' }
  const classes = []
  let style = ''
  const parts = pen.split(';')
  for (let index = 0; index < parts.length; index += 1) {
    const code = parts[index]
    if (code === '38' && parts[index + 1] === '5') {
      classes.push('c-dim')
      index += 2
      continue
    }
    if (code === '38' && parts[index + 1] === '2') {
      const red = parts[index + 2] ?? '0'
      const green = parts[index + 3] ?? '0'
      const blue = parts[index + 4] ?? '0'
      style = `color:rgb(${red},${green},${blue})`
      index += 4
      continue
    }
    if (code === '31' || code === '91') classes.push('c-error')
    else if (code === '32' || code === '92') classes.push('c-ok')
    else if (code === '33' || code === '93') classes.push('c-pending')
    else if (code === '34' || code === '94') classes.push('c-path')
    else if (code === '35' || code === '95') classes.push('c-user')
    else if (code === '36' || code === '96') classes.push('c-tool')
    else if (code === '1') classes.push('a-bold')
    else if (code === '2') classes.push('a-dim')
    else if (code === '4') classes.push('a-underline')
    else if (code === '7') classes.push('a-inverse')
  }
  return { classes: [...new Set(classes)].join(' '), style }
}

const escape = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * One captured row as HTML.
 * @param runs - the row's runs of same-pen text.
 * @returns the row element.
 */
function renderRow(runs) {
  if (runs.length === 0) return '<span class="row"> </span>'
  const inner = runs
    .map((run) => {
      const { classes, style } = appearance(run.pen)
      const text = escape(run.text)
      const attrs = [
        classes === '' ? '' : `class="${classes}"`,
        style === '' ? '' : `style="${style}"`,
      ].filter(part => part !== '').join(' ')
      return attrs === '' ? text : `<span ${attrs}>${text}</span>`
    })
    .join('')
  return `<span class="row">${inner}</span>`
}

/**
 * One scene as a tab, a panel, and the frame inside it.
 * @param scene - the captured scene.
 * @param index - 1-based position, which the CSS switcher keys on.
 * @param lang - which language's copy to use.
 * @returns the panel HTML.
 */
function renderFrame(scene, lang) {
  const copy = COPY[lang][scene.id] ?? {}
  const title = copy.title ?? scene.title
  const rows = scene.keep
    .map(([from, to], range) => {
      const block = scene.rows
        .slice(from, to + 1)
        .map((row) => renderRow(row))
        .join('\n')
      return range === 0 ? block : `<span class="gap"></span>\n${block}`
    })
    .join('\n')
  return `          <figure class="frame">
            <div class="frame__bar">
              <i class="shell__dot"></i><i class="shell__dot"></i><i class="shell__dot"></i>
              <b>${escape(title)}</b>
              <span class="frame__real">${CHROME[lang].real}</span>
            </div>
            <div class="screen"><code class="screen__rows">
${rows}
</code></div>
          </figure>`
}

/**
 * One scene as the panel the switcher shows.
 * @param scene - the captured scene.
 * @param index - 1-based position, which the CSS switcher keys on.
 * @param lang - which language's copy to use.
 * @returns the panel HTML.
 */
function renderScene(scene, index, lang) {
  const note = COPY[lang][scene.id]?.note ?? scene.note
  return `        <div data-scene="${index}">
${renderFrame(scene, lang)}
          <p class="caption">${escape(note)}</p>
        </div>`
}

/**
 * The whole switcher: the radios, the tabs, and every panel.
 * @param scenes - every captured scene, in order.
 * @param lang - which language's copy to use.
 * @returns the HTML to place between the markers.
 */
function renderScenes(scenes, lang) {
  const radios = scenes
    .map((_, index) =>
      `        <input type="radio" name="scene" id="s-${index + 1}"${index === 0 ? ' checked' : ''}>`)
    .join('\n')
  const tabs = scenes
    .map((scene, index) => {
      const label = COPY[lang][scene.id]?.tab ?? scene.id
      return `          <label class="scenes__tab" for="s-${index + 1}">${escape(label)}</label>`
    })
    .join('\n')
  const panels = scenes.map((scene, index) => renderScene(scene, index + 1, lang)).join('\n')
  return `${radios}
        <div class="scenes__tabs" role="tablist" aria-label="${CHROME[lang].pick}">
${tabs}
        </div>
        <div class="scenes__panels">
${panels}
        </div>`
}

/**
 * Replace what sits between a marker pair.
 * @param page - the page's HTML.
 * @param name - the marker name, e.g. `frames`.
 * @param html - what to put between them.
 * @returns the page with that region replaced.
 */
function inject(page, name, html) {
  const start = `<!-- ${name}:start -->`
  const end = `<!-- ${name}:end -->`
  const from = page.indexOf(start)
  const to = page.indexOf(end)
  if (from < 0 || to < 0) throw new Error(`${name} markers missing`)
  return `${page.slice(0, from + start.length)}\n${html}\n${page.slice(to)}`
}

const data = JSON.parse(readFileSync(dataPath, 'utf8'))
// Every capture is a switcher scene; the hero holds the hand-authored /ship
// demo, the one screen on the page that is not a capture.
for (const [file, lang] of [['index.html', 'en'], ['zh.html', 'zh']]) {
  const path = join(root, 'site', file)
  let page = readFileSync(path, 'utf8')
  page = inject(page, 'frames', renderScenes(data.scenes, lang))
  writeFileSync(path, page)
  console.log(`✓ ${file}: ${data.scenes.length} scenes inlined (${lang})`)
}
