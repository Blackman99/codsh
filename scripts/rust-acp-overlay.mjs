import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { enabled } from '../packages/cli/bin/rust-acp-web.mjs'

export function rustAcpMockUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../e2e/fixtures/rust-acp-mock-llm.mjs', import.meta.url)))).href
}

export function rustAcpFileApprovalUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-file-approval.mjs', import.meta.url)))).href
}

export function rustAcpCompactUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-compact.mjs', import.meta.url)))).href
}

export function rustAcpWebUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-web.mjs', import.meta.url)))).href
}

export function rustAcpPlainUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-plain.mjs', import.meta.url)))).href
}

export function rustAcpHooksUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-hooks.mjs', import.meta.url)))).href
}

export function rustAcpSubagentsUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-subagents.mjs', import.meta.url)))).href
}

export function rustAcpControlUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-control.mjs', import.meta.url)))).href
}

export function rustAcpPlanUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-plan.mjs', import.meta.url)))).href
}

export function rustAcpMcpUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-mcp.mjs', import.meta.url)))).href
}

export function rustAcpBackgroundUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-background.mjs', import.meta.url)))).href
}

export function rustAcpGoalUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-goal.mjs', import.meta.url)))).href
}

export function rustAcpImageUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-image.mjs', import.meta.url)))).href
}

export function rustAcpOverlay(mockUrl = rustAcpMockUrl(), approvalUrl = rustAcpFileApprovalUrl(), compactUrl = rustAcpCompactUrl(), webUrl = rustAcpWebUrl(), plainUrl = rustAcpPlainUrl(), hooksUrl = rustAcpHooksUrl(), subagentsUrl = rustAcpSubagentsUrl(), controlUrl = rustAcpControlUrl(), mcpUrl = rustAcpMcpUrl(), planUrl = rustAcpPlanUrl(), backgroundUrl = rustAcpBackgroundUrl(), goalUrl = rustAcpGoalUrl(), imageUrl = rustAcpImageUrl()) {
  const threshold = process.env.CODSH_TEST_COMPACT_THRESHOLD
  const lines = [
    '- id: acp',
    '  config:',
    '    provider: cli-mock',
    '    model: cli-mock',
    '- id: agent-default-model',
    '  config:',
    '    provider: cli-mock',
    '    model: cli-mock',
    '- id: llm-deepseek',
    '  disabled: true',
    // Shipped DeepSeek search and public HTTP fetch are not the configured
    // substitute. tool-web stays on and fails closed until the substitute is usable.
    '- id: web-search-deepseek',
    '  disabled: true',
    '- id: web-fetch-http',
    '  disabled: true',
    '- id: web',
    '  config:',
    '    searchProvider: codsh-substitute',
    '    fetchProvider: codsh-substitute',
    '- id: tool-web',
    '  config:',
    `    search: ${enabled('CODSH_WEB_SEARCH') ? 'true' : 'false'}`,
    `    fetch: ${enabled('CODSH_WEB_FETCH') ? 'true' : 'false'}`,
    // rust-acp-subagents registers the typed `subagent` tool in its place.
    '- id: tool-subagent',
    '  disabled: true',
    // rust-acp-subagents registers the Rhai `workflow` tool in its place
    // (ticket 181). workflow-worker-thread stays: tool-ralph needs it.
    '- id: tool-workflow',
    '  disabled: true',
  ]
  // dsh owns code navigation. No language server is configured, so a call
  // reports LSP_UNAVAILABLE instead of inventing a location. The profile does
  // not depend on these packages, so the patch inserts the files directly.
  const lsp = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-lsp/lib/index.js', import.meta.url))
  const toolLsp = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-tool-lsp/lib/index.js', import.meta.url))
  const lspInsert = existsSync(lsp) && existsSync(toolLsp)
    ? ['    - id: lsp', `      name: '${pathToFileURL(lsp).href}'`, '    - id: tool-lsp', `      name: '${pathToFileURL(toolLsp).href}'`]
    : []
  // ask_user_question: dsh's model-facing tool for its user-questions seam.
  // The acp profile does not load it; the bundle ships the package.
  const askUser = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js', import.meta.url))
  const askInsert = existsSync(askUser) ? ['    - id: tool-ask-user', `      name: '${pathToFileURL(askUser).href}'`] : []
  if (threshold) {
    const ratio = Number(threshold)
    if (!Number.isFinite(ratio) || ratio <= 0) {
      lines.push('- id: compaction-basic', '  config:', '    auto: false')
    } else {
      const retain = Math.min(0.16, ratio * 0.5)
      lines.push('- id: compaction-basic', '  config:', `    thresholdRatio: ${ratio}`, `    retainRatio: ${retain}`, '    auto: true')
    }
  }
  if (process.env.CODSH_TEST_PRUNE_DISABLED === '1') {
    lines.push('- id: tool-result-pruner', '  disabled: true')
  } else if (process.env.CODSH_TEST_PRUNE_HEAD || process.env.CODSH_TEST_PRUNE_TAIL || process.env.CODSH_TEST_PRUNE_THRESHOLD) {
    lines.push(
      '- id: tool-result-pruner',
      '  config:',
      `    thresholdChars: ${process.env.CODSH_TEST_PRUNE_THRESHOLD || 32}`,
      `    headChars: ${process.env.CODSH_TEST_PRUNE_HEAD || 8}`,
      `    tailChars: ${process.env.CODSH_TEST_PRUNE_TAIL || 8}`,
    )
  }
  lines.push(
    '- insert:',
    ...lspInsert,
    ...askInsert,
    '    - id: rust-acp-mock-llm',
    `      name: '${mockUrl}'`,
    '    - id: rust-acp-plain',
    `      name: '${plainUrl}'`,
    '    - id: rust-acp-hooks',
    `      name: '${hooksUrl}'`,
    '    - id: rust-acp-subagents',
    `      name: '${subagentsUrl}'`,
    '    - id: rust-acp-file-approval',
    `      name: '${approvalUrl}'`,
    '    - id: rust-acp-compact',
    `      name: '${compactUrl}'`,
    '    - id: rust-acp-web',
    `      name: '${webUrl}'`,
    '    - id: rust-acp-plan',
    `      name: '${planUrl}'`,
    '    - id: rust-acp-background',
    `      name: '${backgroundUrl}'`,
    '    - id: rust-acp-goal',
    `      name: '${goalUrl}'`,
    '    - id: rust-acp-control',
    `      name: '${controlUrl}'`,
    '    - id: rust-acp-mcp',
    `      name: '${mcpUrl}'`,
    '    - id: rust-acp-image',
    `      name: '${imageUrl}'`,
    '',
  )
  return lines.join('\n')
}
