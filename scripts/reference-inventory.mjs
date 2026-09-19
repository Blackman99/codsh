import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SOURCE_COMMIT = 'a28ee2b2063426e8816e380ccea528b9de95e5da'
const sha256 = text => createHash('sha256').update(text).digest('hex')
const codegen = 'crates/codegen/'
const pager = `${codegen}xai-grok-pager/`

function files(root, path) {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const name = `${path}/${entry.name}`
    return entry.isDirectory() ? files(root, name) : [name]
  }).sort()
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
  ])
  return [...paths].filter(path => !/(?:\/tests?\/|_tests\.rs$|\/tests\.rs$)/u.test(path))
    .sort().map(path => ({ path, text: readFileSync(join(root, path), 'utf8') }))
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
  for (const [index, request] of (capture.modelRequests ?? []).entries()) {
    for (const tool of request.tools ?? []) {
      add('tool', tool.name, JSON.stringify(tool), `model:requests/${index}/tools/${tool.name}`, 'binary-model-schema')
    }
  }
  for (const [index, command] of capture.commands.entries()) {
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
      if (!/^\s+(?:-[a-zA-Z], )?--[a-z]/u.test(line) && !line.includes('[aliases:')) continue
      for (const flag of line.matchAll(/(?<![a-zA-Z0-9-])--?[a-zA-Z][a-zA-Z0-9-]*/gu)) {
        add('flag', `${path || 'grok'}:${flag[0]}`, line.trim(), locator, 'binary-help')
      }
    }
  }
  function document(file, text, origin) {
    let section = '', code = false, toml = false, table = '', codeTable = '', lastSetting = ''
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      const locator = `${origin}:${file}#L${index + 1}`
      for (const match of line.matchAll(/\b(?:GROK_[A-Z0-9_]+|XAI_API_KEY|DO_NOT_TRACK|OTEL_[A-Z0-9_]+)\b/gu)) {
        add('environment', match[0], line, locator, origin)
      }
      if (line.startsWith('```')) {
        code = !code
        toml = code && line === '```toml'
        codeTable = ''
        continue
      }
      if (code) {
        if (toml) {
          const heading = line.match(/^\[\[?([^\]]+)\]\]?/u)
          if (heading) codeTable = heading[1]
          const field = line.match(/^([a-z_][a-z0-9_]*)\s*=/u)
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
      const heading = line.match(/^(#{2,6}) (.+)/u)
      if (heading) {
        section = heading[1].length === 2 ? heading[2] : `${section.split(' > ')[0]} > ${heading[2]}`
        table = ''
        const body = []
        for (let next = index + 1; next < lines.length && !/^#{1,6} /u.test(lines[next]); next++) {
          body.push(lines[next])
        }
        if (body.join('\n').trim()) {
          add('guide-section', `${file}:${heading[2]}`, body.join('\n').trim(), locator, origin)
          for (const [paragraphIndex, paragraph] of body.join('\n').trim().split(/\n\s*\n/u).entries()) {
            if (!paragraph.startsWith('|') && !paragraph.startsWith('```')) {
              add('guide-behavior', `${file}:${heading[2]}:${paragraphIndex + 1}`, paragraph, locator, origin)
            }
          }
        }
      }
      if (line.startsWith('|')) {
        if (!table && !/^\|[\s:|-]+\|$/u.test(line)) { table = line; continue }
        if (/^\|[\s:|-]+\|$/u.test(line)) continue
        const cells = line.split(/(?<!\\)\|/u).slice(1, -1).map(value => value.trim())
        if (cells.length < 2 || !cells[0]) continue
        let category = 'guide-item'
        if (file.startsWith('26-') && table.includes('| Key |') && /^`[a-z_][^`]*`$/u.test(cells[0])) category = 'setting'
        else if (file.startsWith('03-')) category = 'keybinding'
        else if (cells[0].includes('GROK_')) category = 'environment'
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
    if (path.startsWith(`${pager}src/`) && !path.includes('/slash/')) {
      for (const match of production.matchAll(/#\[(?:arg|command)\(([\s\S]*?)\)\]/gu)) {
        if (/arg\(skip\)/u.test(match[0])) continue
        for (const flag of match[1].matchAll(/(?:long|(?:visible_)?alias)\s*=\s*"([a-z][a-z0-9-]*)"/gu)) {
          add('source-cli', `${path}:--${flag[1]}`, match[0], at(match.index), 'source-declaration')
        }
        if (/(?:^|[\s,])long(?:[\s,]|$)/u.test(match[1])) {
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
        const aliases = match[0].match(/aliases: &\[([^\]]*)\]/u)?.[1] ?? ''
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

export function checkInventory(register, discovery) {
  const errors = [], keys = new Set()
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
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, ...args] = process.argv.slice(2)
  if (action === 'extract') {
    const [capturePath, sourceRoot, output, modelPath] = args
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
    console.log(`Discovered ${discovery.items.length} itemized surfaces.`)
  } else if (action === 'check') {
    const root = args[0] ?? 'docs/rewrite/reference'
    const register = JSON.parse(readFileSync(join(root, 'inventory.json'), 'utf8'))
    const discovery = JSON.parse(readFileSync(join(root, 'discovery.json'), 'utf8'))
    const errors = checkInventory(register, discovery)
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
    else console.log(`Complete mapping: ${register.items.length} surfaces; parity remains pending.`)
  } else {
    throw new Error('Usage: reference-inventory.mjs extract CAPTURE SOURCE OUTPUT [MODEL_CAPTURE] | check [DIRECTORY]')
  }
}
