import { readFileSync } from 'node:fs'

export const configAudit = JSON.parse(readFileSync(new URL('../docs/rewrite/reference/config-audit.json', import.meta.url), 'utf8'))
const controls = new Map(configAudit.groups.flatMap(group => group.controls.map(control => [control.identity, group])))
export const auditScenarios = configAudit.groups.flatMap(group => group.scenarios)

export function configIdentity(item) {
  if (item.category === 'environment') return `environment:${item.name.match(/(?:^|:)`?([A-Z][A-Z0-9_]+)(?:=[^`]+)?`?$/u)?.[1] ?? item.name}`
  if (item.category === 'documented-setting') return `setting:${item.name.slice(item.name.indexOf(':') + 1)}`
  if (item.category === 'feature') return `setting:features.${item.name}`
  if (item.category === 'setting') return item.key
  return undefined
}

export function auditedControl(item) { return controls.get(configIdentity(item)) }
export function auditAcceptance(group, ticket) {
  return [...group.scenarios.filter(scenario => scenario.ticket === ticket).map(scenario => scenario.id),
    ...(group.scenarioRefs ?? []).filter(id => Number(id.split('-')[1]) === ticket)]
}

export function checkConfigAudit(discovery, source, audit = configAudit) {
  const errors = [], seen = new Set(), covered = new Set()
  const rows = new Map(discovery.items.map(row => [row.key, row]))
  const locators = new Set(discovery.items.flatMap(row => row.observations.map(observation => observation.locator)))
  const files = new Map(discovery.inputs.map(file => [file.path, file]))
  for (const file of source.files) files.set(file.path, file)
  if (audit.sourceCommit !== source.sourceCommit) errors.push('config audit source mismatch')
  for (const group of audit.groups) {
    if (!group.id || !group.rationale || !group.tickets.length || !['functional', 'configuration', 'build-test', 'source-internal', 'not-control'].includes(group.classification)) errors.push(`incomplete config audit group ${group.id}`)
    const discoveryOnly = ['build-test', 'source-internal', 'not-control'].includes(group.classification)
    if (discoveryOnly && (JSON.stringify(group.tickets) !== '[133]' || group.scenarios.some(scenario => !scenario.id.startsWith('DISCOVERY-133-')))) errors.push(`internal config masquerades as parity ${group.id}`)
    if (group.tickets.some(ticket => !auditAcceptance(group, ticket).length)) errors.push(`audit owner lacks scenario ${group.id}`)
    for (const control of group.controls) {
      if (seen.has(control.identity)) errors.push(`duplicate audit identity ${control.identity}`)
      seen.add(control.identity)
      if (!control.evidence.length || control.evidence.some(locator => !locators.has(locator))) errors.push(`unresolved audit evidence ${control.identity}`)
      for (const key of control.baselineKeys) {
        if (covered.has(key) || configIdentity(rows.get(key) ?? {}) !== control.identity) errors.push(`invalid audit baseline ${key}`)
        covered.add(key)
      }
      for (const context of control.context ?? []) {
        const file = files.get(context.path)
        if (!file || file.sha256 !== context.sourceSha256 || context.startLine < 1 || file.lineCount && context.startLine + context.text.split('\n').length - 1 > file.lineCount) errors.push(`invalid audit context ${control.identity}`)
      }
    }
    for (const context of group.reviewContext ?? []) {
      const file = files.get(context.path)
      if (!file || file.sha256 !== context.sourceSha256 || context.startLine < 1 || file.lineCount && context.startLine + context.text.split('\n').length - 1 > file.lineCount) errors.push(`invalid audit review context ${group.id}`)
    }
  }
  if (new Set(audit.baselineFallbackKeys).size !== audit.baselineFallbackKeys.length || audit.baselineFallbackKeys.some(key => !covered.has(key)) || [...covered].some(key => !audit.baselineFallbackKeys.includes(key))) errors.push('incomplete generic fallback audit')
  return errors
}

export function checkConfigAuditSources(sources, audit = configAudit) {
  const files = new Map(sources.map(file => [file.path, file.text]))
  const errors = []
  for (const group of audit.groups) for (const context of [...(group.reviewContext ?? []), ...group.controls.flatMap(control => control.context ?? [])]) {
    const lines = files.get(context.path)?.split('\n')
    if (!lines || lines.slice(context.startLine - 1, context.startLine - 1 + context.text.split('\n').length).join('\n') !== context.text) errors.push(`audit source quotation mismatch ${group.id}: ${context.path}#L${context.startLine}`)
  }
  return errors
}

export function checkConfigConsistency(register, discovery, contexts) {
  const errors = [], mapped = new Map(register.items.map(item => [item.key, item]))
  const canonical = new Map(), environments = new Map()
  for (const item of discovery.items) {
    if (item.category === 'setting') canonical.set(item.name, mapped.get(item.key))
    if (item.category === 'environment' && item.key === configIdentity(item)) environments.set(item.name, mapped.get(item.key))
  }
  const includes = (row, expected, label) => {
    if (!row || !expected) return
    for (const field of ['tickets', 'acceptance']) {
      if (expected[field].some(value => !row[field]?.includes(value))) errors.push(`${label} ${field} ${row.key}`)
    }
  }
  for (const item of discovery.items) {
    const row = mapped.get(item.key), id = configIdentity(item)
    if (item.category === 'documented-setting') includes(row, canonical.get(id.slice(8)), 'config representation mismatch')
    if (item.category === 'environment') {
      const name = id.slice(12)
      includes(row, environments.get(name), 'environment representation mismatch')
      const fields = [...(contexts.get(`environment:${name}`) ?? []), ...(configAudit.aliases[name] ?? [])]
      for (const field of fields) includes(row, canonical.get(field), 'config alias mismatch')
    }
    if (['setting', 'documented-setting', 'environment'].includes(item.category) && row?.tickets?.length === 1 && row.tickets[0] === 139) {
      const group = auditedControl(item)
      if (!group || !group.tickets.includes(139) || !group.rationale || row.acceptance.includes('PARITY-139')) errors.push(`unreviewed generic config ${item.key}`)
    }
  }
  return errors
}
