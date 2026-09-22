/**
 * Keyless LLM adapter at the dsh provider boundary for Rust ACP turn tests.
 * Modes: echo (default), reasoning, empty, fail-stream, file-edit, file-write,
 * file-missing, file-error, bash-rm, bash-timeout-rm, bash-nice-rm, bash-brace-rm,
 * bash-ansi-c-rm, bash-quoted-rm, bash-eval-rm, bash-path-rm, bash-sort-prefix,
 * bash-sort-output, bash-git-branch, bash-git-cat,
 * bash-git, file-secret. Optional
 * DSH_CODE_CLI_MOCK_DELAY_MS delays the first chunk so session/cancel can win
 * before activity.
 */
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'

const OFF = ReasoningEffortId('off')
const HIGH = ReasoningEffortId('high')
const MODE = process.env.DSH_CODE_CLI_MOCK_TOOL ?? 'echo'
const DELAY_MS = Number(process.env.DSH_CODE_CLI_MOCK_DELAY_MS ?? '0')
const CONTEXT_WINDOW = Number(process.env.DSH_CODE_CLI_MOCK_CONTEXT_WINDOW ?? '128000')

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
    .filter(text => !text.startsWith('<') && !/Current runtime context|This snapshot supersedes/i.test(text))
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
  if (MODE === 'bash-rm' || MODE === 'bash-timeout-rm' || MODE === 'bash-nice-rm' || MODE === 'bash-brace-rm' || MODE === 'bash-ansi-c-rm' || MODE === 'bash-quoted-rm' || MODE === 'bash-eval-rm' || MODE === 'bash-path-rm' || MODE === 'bash-sort-prefix' || MODE === 'bash-sort-output' || MODE === 'bash-git-branch' || MODE === 'bash-git-cat') {
    if (done.length === 0) {
      const command = MODE === 'bash-timeout-rm'
        ? 'timeout 30 rm -rf denied-target'
        : MODE === 'bash-nice-rm'
          ? 'nice rm -rf denied-target'
          : MODE === 'bash-brace-rm'
            ? '{ rm -rf denied-target; }'
            : MODE === 'bash-ansi-c-rm'
              ? "bash -c $'rm -rf denied-target'"
              : MODE === 'bash-quoted-rm'
                ? "'rm' -rf denied-target"
                : MODE === 'bash-eval-rm'
                  ? 'eval "rm -rf denied-target"'
                  : MODE === 'bash-path-rm'
                    ? '/Bin/RM.EXE -rf denied-target'
                    : MODE === 'bash-sort-prefix'
                      ? 'sort --compress-pro=gzip note.txt'
                      : MODE === 'bash-sort-output'
                        ? 'sort -oFILE note.txt'
                        : MODE === 'bash-git-branch'
                          ? 'git branch newtopic'
                          : MODE === 'bash-git-cat'
                            ? 'git cat-file -t HEAD'
                            : 'rm -rf denied-target'
      yield* mockToolCall('rust-acp-bash-rm', 'bash', { command, description: 'permission probe' })
      return
    }
    const last = done.at(-1)
    if (last?.isError === true) {
      yield* mockText(`RUST_ACP_BASH_DENIED ${resultText(last)}`)
      return
    }
    yield* mockText(`RUST_ACP_BASH_DONE ${resultText(last)}`)
    return
  }
  if (MODE === 'bash-git') {
    if (done.length === 0) {
      yield* mockToolCall('rust-acp-bash-git', 'bash', { command: 'git status', description: 'permission probe' })
      return
    }
    const last = done.at(-1)
    if (last?.isError === true) {
      yield* mockText(`RUST_ACP_BASH_DENIED ${resultText(last)}`)
      return
    }
    yield* mockText(`RUST_ACP_BASH_DONE ${resultText(last)}`)
    return
  }
  if (MODE === 'file-secret') {
    if (done.length === 0) {
      yield* mockToolCall('rust-acp-read-secret', 'read', { file_path: 'secret/key.txt' })
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
    if (provider === 'narrow') {
      return Promise.resolve([
        { provider, id: 'narrow', name: 'Narrow Mock', inputModalities: ['text'], contextWindow: 64000 },
      ])
    }
    return Promise.resolve([
      { provider, id: 'cli-mock', name: 'CLI Mock', inputModalities: ['text'], contextWindow: CONTEXT_WINDOW },
      { provider, id: 'cli-mock-fork', name: 'CLI Mock Fork', inputModalities: ['text'], contextWindow: CONTEXT_WINDOW },
    ])
  }

  resolveModel(provider, model) {
    const window = model === 'narrow' || provider === 'narrow' ? 64000 : CONTEXT_WINDOW
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: Number.isFinite(window) && window > 0
        ? { contextWindow: window }
        : undefined,
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
    if (options.purpose === 'compaction') {
      if (MODE === 'compact-fail') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MOCK_COMPACT_FAIL', message: 'summarizer failed' } } }
        return
      }
      const instruction = userTexts(options).filter(text => text.includes('Additional compaction instruction')).join('\n')
      const history = userTexts(options).join('\n')
      const reply = [
        '## Primary Request and Intent',
        '- MOCK_COMPACTION_SUMMARY',
        instruction ? `- instruction:${instruction}` : '- (none)',
        '## Pending Tasks',
        history.includes('TODO_KEEP') ? '- TODO_KEEP' : '- (none)',
      ].join('\n')
      yield* mockText(reply)
      return
    }
    const turn = String(userTurns(options))
    const wantsTodo = MODE === 'todo' || userTexts(options).some(text => text.includes('WRITE_TODO'))
    if (wantsTodo) {
      const done = toolResults(options)
      if (!done.some(result => /TODO_KEEP|Updated todo list/.test(resultText(result)))) {
        yield* mockToolCall('rust-acp-todo', 'todo_write', {
          todos: [{ content: 'TODO_KEEP', status: 'in_progress' }],
        })
        return
      }
      yield* mockText(`RUST_ACP_TODO_DONE TODO_KEEP turn=${turn} ${userTexts(options).join('\n')}`)
      return
    }
    if (MODE === 'file-edit' || MODE === 'file-write' || MODE === 'file-missing' || MODE === 'file-error' || MODE === 'bash-rm' || MODE === 'bash-timeout-rm' || MODE === 'bash-nice-rm' || MODE === 'bash-brace-rm' || MODE === 'bash-ansi-c-rm' || MODE === 'bash-quoted-rm' || MODE === 'bash-eval-rm' || MODE === 'bash-path-rm' || MODE === 'bash-sort-prefix' || MODE === 'bash-sort-output' || MODE === 'bash-git-branch' || MODE === 'bash-git-cat' || MODE === 'bash-git' || MODE === 'file-secret') {
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
    const model = options.model?.id ?? options.model ?? 'unknown'
    const reply = `RUST_ACP_ANSWER turn=${turn} route=${route} effort=${effort} model=${model} ${userTexts(options).join('\n')}`
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
  ctx.llm.registerAdapter(['cli-mock', 'narrow'], new RustAcpMockAdapter())
}
