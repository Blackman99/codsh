/**
 * Keyless LLM adapter at the dsh provider boundary for Rust ACP turn tests.
 * Modes: echo (default), reasoning, empty, fail-stream.
 */
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const OFF = ReasoningEffortId('off')
const HIGH = ReasoningEffortId('high')
const MODE = process.env.DSH_CODE_CLI_MOCK_TOOL ?? 'echo'

function userTurns(options) {
  return options.messages.filter(message =>
    message.role === 'user'
    && message.content.some(block => block.type === 'text' && !block.text.startsWith('<'))).length
}

function userTexts(options) {
  return options.messages
    .filter(message => message.role === 'user')
    .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
}

class RustAcpMockAdapter extends LlmAdapter {
  listModels(provider) {
    return Promise.resolve([
      { provider, id: 'cli-mock', name: 'CLI Mock', inputModalities: ['text'] },
    ])
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      reasoning: {
        efforts: [{ id: OFF, name: 'Off' }, { id: HIGH, name: 'High' }],
        defaultEffort: HIGH,
      },
    })
  }

  async * stream(options) {
    const turn = String(userTurns(options))
    if (MODE === 'empty') {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (MODE === 'fail-stream') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'RUST_ACP_PARTIAL' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'RUST_ACP_PARTIAL' } }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MOCK_STREAM_FAIL', message: 'provider failed mid-stream' } } }
      return
    }
    if (MODE === 'reasoning') {
      const thought = 'RUST_ACP_THOUGHT weighing the request'
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: thought }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: thought } }
      const reply = `RUST_ACP_ANSWER turn=${turn}`
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: reply }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 6 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const reply = `RUST_ACP_ANSWER turn=${turn} ${userTexts(options).join('\n')}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'rust-acp-mock-llm'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['cli-mock'], new RustAcpMockAdapter())
}
