import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildRegister, guideLines } from './reference-mapping.mjs'

export const SOURCE_COMMIT = 'a28ee2b2063426e8816e380ccea528b9de95e5da'
export const BINARY_SHA256 = '9cd26b579840f0f5c9148a8059ad651904c08b41b7f2ef0b4ec04b9ba898844e'
const evidenceRoot = new URL('../docs/rewrite/reference/', import.meta.url)
const sha256 = text => createHash('sha256').update(text).digest('hex')
const codegen = 'crates/codegen/'
const pager = `${codegen}xai-grok-pager/`

function files(root, path) {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const name = `${path}/${entry.name}`
    return entry.isDirectory() ? files(root, name) : [name]
  }).sort()
}

function environmentControls(text) {
  const controls = new Map()
  const add = (name, offset) => controls.set(`${offset}:${name}`, { name, offset })
  for (const match of text.matchAll(/"((?:GROK_|XAI_|OTEL_|DO_NOT_TRACK)[A-Z0-9_]*)"/gu)) add(match[1], match.index)
  for (const match of text.matchAll(/(?:\b(?:std::)?env::(?:var|var_os)|\b(?:var|var_os))\s*\(\s*"([A-Z][A-Z0-9_]+)"/gu)) add(match[1], match.index + match[0].indexOf('"'))
  for (const match of text.matchAll(/\bconst\s+(?:ENV_[A-Z0-9_]+|[A-Z0-9_]+_ENV(?:_VAR)?)\s*:\s*&str\s*=\s*"([A-Z][A-Z0-9_]+)"/gu)) add(match[1], match.index + match[0].indexOf('"'))
  for (const match of text.matchAll(/\.env\(\s*"([A-Z][A-Z0-9_]+)"\s*,/gu)) add(match[1], match.index + match[0].indexOf('"'))
  for (const match of text.matchAll(/\benv\.get\(\s*"([A-Z][A-Z0-9_]+)"|\benv_nonempty\(\s*\w+\s*,\s*"([A-Z][A-Z0-9_]+)"/gu)) add(match[1] ?? match[2], match.index + match[0].indexOf('"'))
  for (const loop of text.matchAll(/\bfor\s+(\w+)\s+in\s+\[([^\]]+)\]\s*\{([^}]+)\}/gu)) {
    if (!new RegExp(`\\benv\\s*\\.get\\(\\s*${loop[1]}\\s*\\)`, 'u').test(loop[3])) continue
    const offset = loop.index + loop[0].indexOf('[') + 1
    for (const match of loop[2].matchAll(/"([A-Z][A-Z0-9_]+)"/gu)) add(match[1], offset + match.index)
  }
  return [...controls.values()]
}

export function sourceInputs(root) {
  const paths = new Set([
    `${codegen}xai-grok-config-types/src/registry.rs`,
    `${codegen}xai-grok-shell/src/session/slash_commands.rs`,
    ...files(root, `${pager}src/slash/commands`).filter(path => path.endsWith('.rs')),
    ...files(root, `${pager}src`).filter(path => path.endsWith('.rs') && (/\/(?:cli|args)\.rs$/u.test(path) || /_cmd(?:\/|\.rs$)/u.test(path))),
    ...files(root, `${codegen}xai-grok-tools/src/implementations`).filter(path => path.endsWith('.rs')),
    ...files(root, `${codegen}xai-grok-shell/src`).filter(path => path.endsWith('.rs')),
    ...files(root, `${codegen}xai-grok-tools-api/src`).filter(path => path.endsWith('.rs')),
    ...files(root, `${pager}docs/user-guide`).filter(path => path.endsWith('.md')),
    ...files(root, 'crates').filter(path => path.endsWith('.rs') && environmentControls(readFileSync(join(root, path), 'utf8')).length > 0),
    ...files(root, 'prod').filter(path => path.endsWith('.rs') && environmentControls(readFileSync(join(root, path), 'utf8')).length > 0),
  ])
  return [...paths].filter(path => !/(?:\/tests?\/|_tests\.rs$|\/tests\.rs$)/u.test(path))
    .sort().map(path => ({ path, text: readFileSync(join(root, path), 'utf8') }))
}

export function sourceCommands(sources) {
  const declarations = [], children = new Map()
  for (const { text } of sources) {
    for (const structure of text.matchAll(/\bstruct\s+(\w+)\s*\{([\s\S]*?)^\}/gmu)) {
      const child = structure[2].match(/#\[(?:command|clap)\(subcommand\)\]\s*(?:pub\s+)?\w+:\s*(?:Option<)?(\w+)/u)?.[1]
      if (child) children.set(structure[1], child)
    }
  }
  for (const { path, text } of sources.filter(source => source.path.startsWith(`${pager}src/`))) {
    for (const enumeration of text.matchAll(/#\[derive\([^\]]*\bSubcommand\b[^\]]*\)\]\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)\s*\{([\s\S]*?)^\}/gmu)) {
      const body = enumeration[2], offset = enumeration.index + enumeration[0].indexOf(body)
      let previous = 0
      for (const variant of body.matchAll(/^    ([A-Z]\w*)\s*(?:\([^\n]*\)|\{|,)/gmu)) {
        const attributes = body.slice(previous, variant.index)
        const explicit = [...attributes.matchAll(/#\[(?:command|clap)\([\s\S]*?\)\]/gu)].map(match => match[0]).join('\n')
        const canonical = explicit.match(/\bname\s*=\s*"([^"]+)"/u)?.[1]
          ?? variant[1].replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()
        const names = [canonical, ...[...explicit.matchAll(/\b(?:visible_)?alias\s*=\s*"([^"]+)"/gu)].map(match => match[1])]
        const line = text.slice(0, offset + variant.index).split('\n').length
        const payload = variant[0].match(/\((?:Box<)?(?:[\w]+::)*(\w+)/u)?.[1]
        const inline = variant[0].endsWith('{') ? body.slice(variant.index).split(/^    \},?/mu)[0] : ''
        const child = children.get(payload) ?? inline.match(/#\[(?:command|clap)\(subcommand\)\]\s*\w+:\s*(\w+)/u)?.[1]
        for (const name of names) declarations.push({ enumName: enumeration[1], name, canonical, child, path, line, excerpt: variant[0] })
        previous = variant.index + variant[0].length
      }
    }
  }
  const paths = new Map(), visit = (name, prefix, seen = new Set()) => {
    if (seen.has(name)) throw new Error(`Recursive command enum ${name}`)
    for (const declaration of declarations.filter(item => item.enumName === name)) {
      const command = [...prefix, declaration.name]
      paths.set(command.join(' '), declaration)
      if (declaration.child) visit(declaration.child, command, new Set([...seen, name]))
    }
  }
  visit('Command', [])
  return declarations.map(declaration => ({ ...declaration, commands: [...paths].filter(([, item]) => item === declaration).map(([command]) => command.split(' ')) }))
}

/** Discovery records declarations and documentation, never runtime parity. */
export function extractSurfaces(capture, sources) {
  const items = new Map()
  function add(category, name, excerpt, locator, scope) {
    const key = `${category}:${name}`
    const item = items.get(key) ?? { key, category, name, observations: [] }
    if (!item.observations.some(value => value.locator === locator && value.excerpt === excerpt)) {
      item.observations.push({ locator, scope, excerpt })
    }
    items.set(key, item)
  }
  for (const declaration of sourceCommands(sources)) {
    add('source-command', `${declaration.enumName}:${declaration.name}`, declaration.excerpt,
      `source:${declaration.path}#L${declaration.line}`, 'source-command-provisional')
  }
  for (const [index, request] of (capture.modelRequests ?? []).entries()) {
    for (const tool of request.tools ?? []) {
      add('tool', tool.name, JSON.stringify(tool), `model:requests/${index}/tools/${tool.name}`, 'binary-model-schema')
    }
  }
  for (const [index, terminal] of (capture.tutorialProbes ?? []).entries()) {
    for (const name of ['tutorial', 'tour', 'onboarding']) {
      const action = terminal.events.find(event => event.action === `${name}-open`)
      const eventIndex = terminal.events.findIndex(event => event.output && action && event.ms >= action.ms && event.ms <= action.observedMs)
      if (eventIndex >= 0) add('slash', name, terminal.events[eventIndex].output,
        `capture:tutorialProbes/${index}/events/${eventIndex}`, 'binary-pty-observation')
    }
  }
  for (const [index, terminal] of (capture.uiProbes ?? []).entries()) {
    for (const name of ['help', 'docs', 'howto', 'guides', 'debug']) {
      const action = terminal.events.find(event => event.action === `${name}-open`)
      const eventIndex = terminal.events.findIndex(event => event.output && action && event.ms >= action.ms && event.ms <= action.observedMs)
      if (eventIndex >= 0) add('slash', name, terminal.events[eventIndex].output,
        `capture:uiProbes/${index}/events/${eventIndex}`, 'binary-pty-observation')
    }
  }
  for (const [index, terminal] of (capture.environmentProbes ?? []).entries()) {
    if (terminal.environment?.GROK_FPS === '1') {
      const eventIndex = terminal.events.findIndex(event => /fps/iu.test(event.output ?? ''))
      if (eventIndex >= 0) add('environment', 'GROK_FPS', terminal.events[eventIndex].output,
        `capture:environmentProbes/${index}/events/${eventIndex}`, 'binary-pty-observation')
    }
  }
  for (const [index, command] of capture.commands.entries()) {
    if (command.exit === 2 && command.args.length === 1 && /^--[a-zA-Z]/u.test(command.args[0]) && /a value is required|requires a value/u.test(command.stderr) && !/unexpected argument/u.test(command.stderr)) {
      add('flag', `grok:${command.args[0]}`, command.stderr, `capture:commands/${index}`, 'binary-argument-recognition')
    }
    if (command.exit !== 0 || command.args.at(-1) !== '--help') continue
    const path = command.args.slice(0, -1).join(' ')
    const locator = `capture:commands/${index}`
    if (path) add('cli', path, command.stdout.split('\n')[0], locator, 'binary-help')
    const section = command.stdout.match(/^Commands:\n([\s\S]*?)(?=\n[A-Z][^\n]*:|(?![\s\S]))/mu)?.[1] ?? ''
    for (const line of section.split('\n')) {
      const match = line.match(/^  ([a-z][a-z0-9-]*)\s{2,}(.*)/u)
      if (match) {
        add('cli', `${path} ${match[1]}`.trim(), match[2], locator, 'binary-help')
        for (const alias of (match[2].match(/\[aliases: ([^\]]+)\]/u)?.[1] ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
          add('cli', `${path} ${alias}`.trim(), `Alias of ${match[1]}: ${match[2]}`, locator, 'binary-help')
        }
      }
    }
    for (const line of command.stdout.split('\n')) {
      if (!/^\s+(?:-[a-zA-Z], )?--[a-z]/u.test(line) && !line.includes('[aliases:') && !line.includes('alias:')) continue
      for (const flag of line.matchAll(/(?<![a-zA-Z0-9-])--?[a-zA-Z][a-zA-Z0-9-]*/gu)) {
        add('flag', `${path || 'grok'}:${flag[0]}`, line.trim(), locator, 'binary-help')
      }
    }
  }
  function document(file, text, origin) {
    let section = '', table = '', codeTable = '', lastSetting = ''
    const scanned = guideLines(text), lines = scanned.map(row => row.line), headings = []
    for (const [index, row] of scanned.entries()) {
      const { line, content: markup, code, fence, language, heading } = row
      if (heading) { headings.length = heading[1].length; headings[heading[1].length - 1] = heading[2] }
      const locator = `${origin}:${file}#L${index + 1}`
      for (const match of line.matchAll(/\b(?:GROK_[A-Z0-9_]+|XAI_API_KEY|DO_NOT_TRACK|OTEL_[A-Z0-9_]+)\b/gu)) {
        add('environment', match[0], line, locator, origin)
      }
      const context = lines.slice(Math.max(0, index - 1), index + 2).join('\n')
      const environmentText = line.replace(/`KEY=value`/gu, '')
      if (!code && headings.some(heading => /environment variables/iu.test(heading))) {
        const variable = markup.match(/^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/u)?.[1]
        if (variable) add('environment', variable, line, locator, origin)
      }
      if (/\benv(?:ironment)?(?:[ -](?:variable|override|control))?\b/iu.test(context.replace(/--env\b/gu, ''))) {
        for (const match of environmentText.matchAll(/`([A-Z][A-Z0-9_]+)(?:=[^`]+)?`/gu)) add('environment', match[1], line, locator, origin)
      }
      for (const match of environmentText.matchAll(/\b[Ss]et\s+`([A-Z][A-Z0-9_]+)`(?:\s*\(or\s+`([A-Z][A-Z0-9_]+)`\))?|`([A-Z][A-Z0-9_]+)=[^`]+`/gu)) {
        for (const name of match.slice(1).filter(Boolean)) add('environment', name, line, locator, origin)
      }
      const processControls = /\b(?:reads?|checks?|honor(?:s|ing)?)\s+((?:\n\s*)?`[A-Z][A-Z0-9_]+`(?:\s*(?:\/|,|or|and)\s*`[A-Z][A-Z0-9_]+`)*)/gu
      for (const match of context.matchAll(processControls)) {
        for (const variable of match[1].matchAll(/`([A-Z][A-Z0-9_]+)`/gu)) {
          if (line.includes(variable[0])) add('environment', variable[1], line, locator, origin)
        }
      }
      if (/\b(?:credential|token)\b/iu.test(line)) {
        for (const match of line.matchAll(/\b(?:or|from|via)\s+`([A-Z][A-Z0-9_]+)`/gu)) add('environment', match[1], line, locator, origin)
      }
      if (fence) {
        codeTable = ''
        continue
      }
      if (code) {
        if (language === 'toml') {
          const heading = markup.match(/^\[\[?([^\]]+)\]\]?/u)
          if (heading) codeTable = heading[1]
          const field = markup.match(/^([a-z_][a-z0-9_]*)\s*=/u)
          if (field) {
            lastSetting = `${codeTable ? `${codeTable}.` : ''}${field[1]}`
            add('documented-setting', `${file}:${lastSetting}`, line, locator, origin)
          }
          if (field && section.includes('pager.toml')) {
            add('pager-setting', `${codeTable}.${field[1]}`, line, locator, origin)
          }
        }
        continue
      }
      if (heading && heading[1].length >= 2) {
        section = heading[1].length === 2 ? heading[2] : `${section.split(' > ')[0]} > ${heading[2]}`
        table = ''
        const body = []
        for (let next = index + 1; next < scanned.length && !scanned[next].heading; next++) body.push(scanned[next])
        const content = body.map(row => row.line).join('\n').trim()
        if (content) {
          add('guide-section', `${file}:${heading[2]}`, content, locator, origin)
          let paragraphIndex = 0, paragraph = []
          const flush = () => {
            if (!paragraph.length) return
            paragraphIndex++
            if (!paragraph.some(row => row.code) && !paragraph[0].content.startsWith('|')) {
              add('guide-behavior', `${file}:${heading[2]}:${paragraphIndex}`, paragraph.map(row => row.line).join('\n'), locator, origin)
            }
            paragraph = []
          }
          for (const row of body) {
            if (!row.content.trim()) flush()
            else {
              if (paragraph.length && paragraph.at(-1).code !== row.code) flush()
              paragraph.push(row)
            }
          }
          flush()
        }
      }
      if (markup.startsWith('|')) {
        if (!table && !/^\|[\s:|-]+\|$/u.test(markup)) { table = line; continue }
        if (/^\|[\s:|-]+\|$/u.test(markup)) continue
        const cells = markup.split(/(?<!\\)\|/u).slice(1, -1).map(value => value.trim())
        if (cells.length < 2 || !cells[0]) continue
        let category = 'guide-item'
        if (file.startsWith('26-') && table.includes('| Key |') && /^`[a-z_][^`]*`$/u.test(cells[0])) category = 'setting'
        else if (file.startsWith('03-')) category = 'keybinding'
        else if (/^`[A-Z][A-Z0-9_]*(?:=[^`]+)?`$/u.test(cells[0]) && (headings.some(heading => /environment variables/iu.test(heading)) || /^`GROK_/u.test(cells[0]))) category = 'environment'
        const name = category === 'setting' ? cells[0].replaceAll('`', '') : `${file}:${section}:${cells[0]}`
        add(category, name, `${table}\n${line}`, locator, origin)
      }
      for (const match of line.matchAll(/`((?:GROK_|XAI_|OTEL_|DO_NOT_TRACK|NO_COLOR|TERM|COLORTERM|VISUAL|EDITOR|SSH_|DISPLAY|WAYLAND_DISPLAY)[A-Z0-9_]*)`/gu)) {
        add('environment', match[1], line, locator, origin)
      }
      if (file.startsWith('04-')) {
        for (const match of line.matchAll(/`\/(?![\/])([a-z][a-z0-9-]*)(?=[ `])/gu)) {
          add('slash', match[1], line, locator, origin)
        }
      }
    }
  }
  for (const guide of capture.guides) document(guide.file, guide.text, 'binary-guide')
  for (const { path, text } of sources) {
    if (path.endsWith('.md')) {
      document(path.split('/').at(-1), text, 'source-guide')
      continue
    }
    const production = text.replace(/#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+\w+\s*;/gu, value => value.replace(/[^\n]/gu, ' ')).split(/#\[cfg\(test\)\]\s*mod \w+\s*\{/u)[0]
    const at = offset => `source:${path}#L${production.slice(0, offset).split('\n').length}`
    for (const { name, offset } of environmentControls(production)) {
      add('environment', name, production.split('\n')[production.slice(0, offset).split('\n').length - 1].trim(), at(offset), 'source-environment-provisional')
    }
    if (path.startsWith(`${pager}src/`) && !path.includes('/slash/')) {
      for (const match of production.matchAll(/#\[(?:arg|command|clap)\(([\s\S]*?)\)\]/gu)) {
        if (/arg\(skip\)/u.test(match[0])) continue
        for (const flag of match[1].matchAll(/\b(?:long|(?:visible_)?alias)\s*=\s*"(-*[a-zA-Z][a-zA-Z0-9-]*)"/gu)) {
          const prefix = match[0].startsWith('#[command(') ? '' : '--'
          add('source-cli', `${path}:${prefix}${flag[1]}`, match[0], at(match.index), 'source-declaration')
        }
        for (const short of match[1].matchAll(/\bshort(?:_alias)?\s*=\s*'([a-zA-Z])'/gu)) {
          add('source-cli', `${path}:-${short[1]}`, match[0], at(match.index), 'source-declaration')
        }
        for (const aliases of match[1].matchAll(/(?:visible_)?aliases\s*=\s*&?\[([^\]]*)\]/gu)) {
          for (const alias of aliases[1].matchAll(/"([a-zA-Z][a-zA-Z0-9-]*)"/gu)) add('source-cli', `${path}:--${alias[1]}`, match[0], at(match.index), 'source-declaration')
        }
        if (/(?:^|,)\s*long\s*(?:,|$)/u.test(match[1])) {
          const field = production.slice(match.index + match[0].length).match(/^\s*(?:pub )?([a-z][a-z0-9_]*):/u)
          if (field) add('source-cli', `${path}:--${field[1].replaceAll('_', '-')}`, match[0], at(match.index), 'source-declaration')
        }
      }
    }
    if (path.endsWith('/registry.rs')) {
      for (const match of production.matchAll(/FeatureSpec \{\s*id:[\s\S]*?\n    \}/gu)) {
        const key = match[0].match(/key: "([^"]+)"/u)?.[1]
        if (key) add('feature', key, match[0], at(match.index), 'source-registry')
      }
    }
    if (path.includes('/slash/commands/')) {
      for (const match of production.matchAll(/slash_meta!\s*\{\s*name: "([^"]+)"[\s\S]*?\n    \}/gu)) {
        add('slash', match[1], match[0], at(match.index), 'source-registry')
        const aliases = match[0].match(/aliases:\s*&?\[([^\]]*)\]/u)?.[1] ?? ''
        for (const alias of aliases.matchAll(/"([^"]+)"/gu)) add('slash', alias[1], match[0], at(match.index), 'source-registry')
      }
      for (const match of production.matchAll(/fn name\(&self\) -> &str \{\s*"([^"]+)"/gu)) {
        add('slash', match[1], match[0], at(match.index), 'source-registry')
      }
      for (const match of production.matchAll(/fn aliases\(&self\) -> &\[&str\] \{\s*&\[([^\]]+)\]/gu)) {
        for (const alias of match[1].matchAll(/"([^"]+)"/gu)) {
          add('slash', alias[1], match[0], at(match.index), 'source-registry')
        }
      }
    }
    if (path.endsWith('/slash_commands.rs')) {
      for (const match of production.matchAll(/BuiltinCommand \{\s*name: "([^"]+)"[\s\S]*?aliases: &\[([^\]]*)\]/gu)) {
        for (const name of [match[1], ...[...match[2].matchAll(/"([^"]+)"/gu)].map(value => value[1])]) {
          add('slash', name, match[0], at(match.index), 'source-registry')
        }
      }
    }
    if (path.includes('/xai-grok-tools/') || path.includes('/xai-grok-tools-api/')) {
      for (const match of production.matchAll(/(?:ToolId::new|ToolDescription::new)\(\s*"([a-z][a-z0-9_]*)"/gu)) {
        if (match[1] !== 'unknown') add('tool', match[1], match[0], at(match.index), 'source-registry')
      }
      for (const match of production.matchAll(/const (?:[A-Z_]*TOOL_NAME|TOOL_ID|NAME): &str = "([a-z][a-z0-9_]*)"/gu)) {
        add('tool', match[1], match[0], at(match.index), 'source-registry')
      }
    }
    if (path.includes('/xai-grok-shell/src/')) {
      for (const match of production.matchAll(/"(x\.ai\/[a-zA-Z0-9_/-]+)"/gu)) {
        if (match[1].endsWith('/') || match[1] === 'x.ai/foo') continue
        add('acp-extension', match[1], production.split('\n')[production.slice(0, match.index).split('\n').length - 1].trim(), at(match.index), 'source-declaration')
      }
    }
  }
  return [...items.values()].sort((a, b) => a.key.localeCompare(b.key, 'en'))
}

export function loadEvidence(root = evidenceRoot) {
  const read = name => JSON.parse(readFileSync(root instanceof URL ? new URL(name, root) : join(root, name), 'utf8'))
  return { capture: read('observations.json'), model: read('model-observations.json'),
    provenance: read('provenance.json'), source: read('source-evidence.json') }
}

export function sourceEvidence(discovery, sources) {
  const byPath = new Map(sources.map(source => [source.path, source.text]))
  const fragments = new Map(), lengths = new Map()
  for (const item of discovery.items) for (const observation of item.observations) lengths.set(observation.locator, Math.max(lengths.get(observation.locator) ?? 0, observation.excerpt.split('\n').length))
  for (const item of discovery.items) for (const observation of item.observations) {
    const match = observation.locator.match(/^source:([^#]+)#L(\d+)$/u)
    if (!match || fragments.has(observation.locator)) continue
    const text = byPath.get(match[1])
    if (text === undefined) throw new Error(`Missing source ${match[1]}`)
    const lines = text.split('\n'), start = Number(match[2])
    const length = lengths.get(observation.locator)
    if (start < 1 || start + length - 1 > lines.length) throw new Error(`Invalid source line ${observation.locator}`)
    fragments.set(observation.locator, { path: match[1], startLine: start,
      text: lines.slice(start - 1, start - 1 + length).join('\n') })
  }
  const referenced = new Set([...fragments.values()].map(fragment => fragment.path))
  return { sourceCommit: SOURCE_COMMIT,
    surfaces: extractSurfaces({ commands: [], guides: [] }, sources).filter(item => item.observations.some(observation => observation.locator.startsWith('source:'))),
    commands: sourceCommands(sources),
    files: sources.filter(source => referenced.has(source.path) || source.path.endsWith('.md')).map(({ path, text }) => ({ path, sha256: sha256(text), lineCount: text.split('\n').length })),
    guides: sources.filter(source => source.path.endsWith('.md')).map(({ path, text }) => ({ path, text })),
    fragments: Object.fromEntries(fragments) }
}

export function checkInventory(register, discovery, evidence = loadEvidence()) {
  const errors = [], keys = new Set()
  const { capture, model, provenance, source } = evidence
  if ([discovery.binarySha256, capture.binarySha256, model.binarySha256, provenance.behavior.binarySha256].some(hash => hash !== BINARY_SHA256)) errors.push('binary provenance mismatch')
  if (source.sourceCommit !== SOURCE_COMMIT || provenance.source.commit !== SOURCE_COMMIT) errors.push('source provenance mismatch')
  if ([capture.reference, model.reference].some(version => version !== '1.0.34 (3736acbc8658)') || provenance.behavior.version !== '1.0.34' || provenance.behavior.build !== '3736acbc8658') errors.push('binary version provenance mismatch')
  const inputs = new Map(discovery.inputs.map(input => [input.path, input.sha256]))
  const sourceFiles = new Map(source.files.map(file => [file.path, file]))
  if (sha256(`${JSON.stringify(source, null, 2)}\n`) !== provenance.sourceEvidenceSha256) errors.push('source evidence digest mismatch')
  for (const guide of source.guides) if (sha256(guide.text) !== sourceFiles.get(guide.path)?.sha256) errors.push(`source guide hash mismatch ${guide.path}`)
  for (const file of source.files) if (inputs.get(file.path) !== file.sha256) errors.push(`source hash mismatch ${file.path}`)
  for (const guide of capture.guides) {
    if (sha256(guide.text) !== guide.sha256 || discovery.guides.find(item => item.file === guide.file)?.sha256 !== guide.sha256) errors.push(`guide hash mismatch ${guide.file}`)
  }
  const expected = new Map(extractSurfaces({ ...capture, modelRequests: model.requests }, source.guides).map(item => [item.key, item]))
  const actual = new Map(discovery.items.map(item => [item.key, item]))
  for (const item of source.surfaces ?? []) {
    if (!actual.has(item.key)) errors.push(`missing source surface ${item.key}`)
    for (const observation of item.observations) if (!actual.get(item.key)?.observations.some(value => value.locator === observation.locator && value.excerpt === observation.excerpt && value.scope === observation.scope)) errors.push(`missing source evidence ${item.key}`)
  }
  if (!source.surfaces?.length) errors.push('missing source coverage expectations')
  for (const declaration of source.commands ?? []) for (const command of declaration.commands) {
    if (!capture.commands.some(observation => JSON.stringify(observation.args) === JSON.stringify([...command, '--help']))) errors.push(`missing source command probe ${command.join(' ')}`)
  }
  for (const [key, item] of expected) {
    if (!actual.has(key)) errors.push(`missing observed surface ${key}`)
    for (const observation of item.observations) if (!actual.get(key)?.observations.some(value => value.locator === observation.locator && value.excerpt === observation.excerpt)) errors.push(`missing observed evidence ${key}`)
  }
  for (const item of discovery.items) for (const observation of item.observations) {
    const match = observation.locator.match(/^source:([^#]+)#L(\d+)$/u)
    let resolved
    if (match) {
      const file = sourceFiles.get(match[1]), fragment = source.fragments[observation.locator]
      resolved = file && Number(match[2]) > 0 && Number(match[2]) <= file.lineCount
        && fragment?.path === match[1] && fragment.startLine === Number(match[2])
        && fragment.text.includes(observation.excerpt)
    } else {
      resolved = expected.get(item.key)?.observations.some(value => value.locator === observation.locator && value.excerpt === observation.excerpt && value.scope === observation.scope)
    }
    if (!resolved) errors.push(`unresolved evidence ${item.key}: ${observation.locator}`)
  }
  if (discovery.sourceCommit !== SOURCE_COMMIT || discovery.reference !== '1.0.34 (3736acbc8658)') errors.push('reference provenance mismatch')
  if (new Set(discovery.items.map(item => item.key)).size !== discovery.items.length) errors.push('duplicate discovery identity')
  if (new Set(register.acceptance.map(item => item.id)).size !== register.acceptance.length) errors.push('duplicate acceptance identity')
  if (new Set(register.tickets.map(item => item.number)).size !== register.tickets.length) errors.push('duplicate ticket identity')
  const discovered = new Map(discovery.items.map(item => [item.key, item]))
  const tickets = new Map(register.tickets.map(ticket => [ticket.number, ticket]))
  const tests = new Map(register.acceptance.map(test => [test.id, test]))
  for (const item of register.items) {
    if (keys.has(item.key)) errors.push(`duplicate ${item.key}`)
    keys.add(item.key)
    if (!discovered.has(item.key)) errors.push(`undiscovered ${item.key}`)
    if (!item.stories?.length || item.stories.some(story => !Number.isInteger(story) || story < 1 || story > 76)) errors.push(`story mapping ${item.key}`)
    if (!item.tickets?.length || item.tickets.some(ticket => !tickets.has(ticket))) errors.push(`ticket mapping ${item.key}`)
    if (!item.acceptance?.length || item.acceptance.some(id => !tests.has(id))) errors.push(`test mapping ${item.key}`)
    if (item.tickets?.some(ticket => !item.acceptance?.some(id => tests.get(id)?.ticket === ticket))) errors.push(`ticket lacks acceptance ${item.key}`)
    if (item.acceptance?.some(id => !item.tickets?.includes(tests.get(id)?.ticket))) errors.push(`acceptance ownership ${item.key}`)
    if (item.stories?.some(story => !item.tickets?.some(ticket => tickets.get(ticket)?.stories.includes(story)))) errors.push(`story ownership ${item.key}`)
    if (item.status !== 'pending-parity') errors.push(`invalid status ${item.key}; reference discovery is not candidate verification`)
    if (!item.blocker || !item.evidence?.length) errors.push(`missing evidence/blocker ${item.key}`)
    const observations = discovered.get(item.key)?.observations ?? []
    if (item.evidence?.some(locator => !observations.some(observation => observation.locator === locator))) errors.push(`invalid evidence ${item.key}`)
  }
  for (const key of discovered.keys()) if (!keys.has(key)) errors.push(`missing ${key}`)
  for (const test of register.acceptance) {
    if (!test.given || !test.when || !test.then || !test.failure || test.status !== 'planned') errors.push(`incomplete acceptance ${test.id}`)
    if (!tickets.has(test.ticket)) errors.push(`acceptance ticket ${test.id}`)
  }
  if (register.discoverySha256 !== sha256(JSON.stringify(discovery))) errors.push('discovery digest mismatch')
  try {
    const mapped = buildRegister(discovery, register.tickets, evidence)
    const expectedMappings = new Map(mapped.items.map(item => [item.key, item]))
    for (const item of register.items) {
      const expected = expectedMappings.get(item.key)
      if (expected && ['tickets', 'stories', 'acceptance', 'blocker'].some(field => JSON.stringify(item[field]) !== JSON.stringify(expected[field]))) errors.push(`contextual mapping drift ${item.key}`)
    }
    if (JSON.stringify(register.acceptance) !== JSON.stringify(mapped.acceptance)) errors.push('contextual acceptance drift')
  } catch (error) { errors.push(`contextual mapping error: ${error.message}`) }
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, ...args] = process.argv.slice(2)
  if (action === 'extract') {
    const [capturePath, sourceRoot, output, modelPath, evidencePath] = args
    if (execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== SOURCE_COMMIT) throw new Error('Source commit mismatch')
    if (execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Source checkout is modified')
    const capture = JSON.parse(readFileSync(capturePath, 'utf8'))
    if (modelPath) capture.modelRequests = JSON.parse(readFileSync(modelPath, 'utf8')).requests
    const inputs = sourceInputs(sourceRoot)
    const discovery = { schemaVersion: 1, sourceCommit: SOURCE_COMMIT,
      reference: capture.reference, binarySha256: capture.binarySha256,
      inputs: inputs.map(({ path, text }) => ({ path, sha256: sha256(text) })),
      guides: capture.guides.map(({ file, sha256 }) => ({ file, sha256 })),
      items: extractSurfaces(capture, inputs) }
    writeFileSync(output, `${JSON.stringify(discovery, null, 2)}\n`)
    const evidence = sourceEvidence(discovery, inputs)
    if (evidencePath) writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(`Discovered ${discovery.items.length} itemized surfaces.`)
  } else if (action === 'check') {
    const root = args[0] ?? 'docs/rewrite/reference'
    const register = JSON.parse(readFileSync(join(root, 'inventory.json'), 'utf8'))
    const discovery = JSON.parse(readFileSync(join(root, 'discovery.json'), 'utf8'))
    const errors = checkInventory(register, discovery, loadEvidence(root))
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
    else console.log(`Complete mapping: ${register.items.length} surfaces; parity remains pending.`)
  } else {
    throw new Error('Usage: reference-inventory.mjs extract CAPTURE SOURCE OUTPUT [MODEL_CAPTURE] [SOURCE_EVIDENCE_OUTPUT] | check [DIRECTORY]')
  }
}
