import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function rustAcpMockUrl() {
  return pathToFileURL(resolve(fileURLToPath(new URL('../e2e/fixtures/rust-acp-mock-llm.mjs', import.meta.url)))).href
}

export function rustAcpOverlay(mockUrl = rustAcpMockUrl()) {
  return [
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
    '- insert:',
    '    - id: rust-acp-mock-llm',
    `      name: '${mockUrl}'`,
    '',
  ].join('\n')
}
