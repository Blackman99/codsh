/**
 * Keyless LLM adapter at the dsh provider boundary for Rust ACP turn tests.
 * Modes: echo (default), reasoning, empty, fail-stream, file-edit, file-write,
 * file-missing, file-error. Optional DSH_CODE_CLI_MOCK_DELAY_MS delays the
 * first chunk so session/cancel can win before activity.
 */
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'

const OFF = ReasoningEffortId('off')
const HIGH = ReasoningEffortId('high')
const MODE = process.env.DSH_CODE_CLI_MOCK_TOOL ?? 'echo'
const DELAY_MS = Number(process.env.DSH_CODE_CLI_MOCK_DELAY_MS ?? '0')

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(ms) || ms <= 0) {
      resolve()
      return
    }
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

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

function toolResults(options) {
  return options.messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
}

function resultText(result) {
  return (result?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function* mockToolCall(id, name, args) {
  const toolId = ToolCallId(id)
  const encoded = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: toolId, name, argumentsDelta: encoded }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: toolId, name, arguments: encoded } }
  yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function* mockText(reply) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: reply }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
  yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* fileToolTurn(options) {
  const done = toolResults(options)
  if (MODE === 'file-missing') {
    if (done.length === 0) {
      yield* mockToolCall('rust-acp-read-missing', 'read', { file_path: 'missing-note.txt' })
      return
    }
    const last = done.at(-1)
    yield* mockText(`RUST_ACP_FILE_ERROR ${resultText(last)}`)
    return
  }
  if (MODE === 'file-write') {
    if (done.length === 0) {
      yield* mockToolCall('rust-acp-write', 'write', {
        file_path: 'created.txt',
        content: 'RUST_ACP_CREATED\n',
      })
      return
    }
    const last = done.at(-1)
    if (last?.isError === true) {
      yield* mockText(`RUST_ACP_FILE_ERROR ${resultText(last)}`)
      return
    }
    yield* mockText(`RUST_ACP_FILE_DONE ${resultText(last)}`)
    return
  }
  if (MODE === 'file-error') {
    if (done.length === 0) {
      yield* mockToolCall('rust-acp-read', 'read', { file_path: 'note.txt' })
      return
    }
    if (done.length === 1 && done[0]?.isError !== true) {
      yield* mockToolCall('rust-acp-edit-miss', 'edit', {
        file_path: 'note.txt',
        old_string: 'NO_SUCH_HUNK',
        new_string: 'patched',
      })
      return
    }
    yield* mockText(`RUST_ACP_FILE_ERROR ${resultText(done.at(-1))}`)
    return
  }
  if (done.length === 0) {
    yield* mockToolCall('rust-acp-read', 'read', { file_path: 'note.txt' })
    return
  }
  if (done.length === 1 && done[0]?.isError === true) {
    yield* mockText(`RUST_ACP_FILE_ERROR ${resultText(done[0])}`)
    return
  }
  if (done.length === 1) {
    yield* mockToolCall('rust-acp-edit', 'edit', {
      file_path: 'note.txt',
      old_string: 'alpha',
      new_string: 'ALPHA',
    })
    return
  }
  const last = done.at(-1)
  if (last?.isError === true) {
    yield* mockText(`RUST_ACP_FILE_ERROR ${resultText(last)}`)
    return
  }
  yield* mockText(`RUST_ACP_FILE_DONE ${resultText(last)}`)
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
    if (DELAY_MS > 0) {
      try {
        await sleep(DELAY_MS, options.signal)
      } catch {
        return
      }
      if (options.signal?.aborted) return
    }
    const turn = String(userTurns(options))
    if (MODE === 'file-edit' || MODE === 'file-write' || MODE === 'file-missing' || MODE === 'file-error') {
      yield* fileToolTurn(options)
      return
    }
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
      const effort = options.reasoningEffort ?? 'none'
      const route = `${options.provider}/${options.model}`
      const reply = `RUST_ACP_ANSWER turn=${turn} route=${route} effort=${effort}`
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: reply }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 6 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const effort = options.reasoningEffort ?? 'none'
    const route = `${options.provider}/${options.model}`
    const reply = `RUST_ACP_ANSWER turn=${turn} route=${route} effort=${effort} ${userTexts(options).join('\n')}`
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
