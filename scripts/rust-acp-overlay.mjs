import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function rustAcpMockUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../e2e/fixtures/rust-acp-mock-llm.mjs', import.meta.url)))).href
}

export function rustAcpFileApprovalUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-file-approval.mjs', import.meta.url)))).href
}

export function rustAcpCompactUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../packages/cli/bin/rust-acp-compact.mjs', import.meta.url)))).href
}

export function rustAcpOverlay(mockUrl = rustAcpMockUrl(), approvalUrl = rustAcpFileApprovalUrl(), compactUrl = rustAcpCompactUrl()) {
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
  ]
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
    '    - id: rust-acp-mock-llm',
    `      name: '${mockUrl}'`,
    '    - id: rust-acp-file-approval',
    `      name: '${approvalUrl}'`,
    '    - id: rust-acp-compact',
    `      name: '${compactUrl}'`,
    '',
  )
  return lines.join('\n')
}
