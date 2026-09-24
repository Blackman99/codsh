/**
 * Keyless LLM adapter at the dsh provider boundary for Rust ACP turn tests.
 * Modes: echo (default), reasoning, empty, fail-stream, file-edit, file-write,
 * file-missing, file-error, markdown, huge-read, control-output, bash-rm, bash-timeout-rm, bash-nice-rm, bash-brace-rm,
 * bash-ansi-c-rm, bash-quoted-rm, bash-eval-rm, bash-path-rm, bash-sudo-rm,
 * bash-nohup-rm, bash-xargs-rm, bash-sort-prefix,
 * bash-sort-output, bash-git-branch, bash-git-upstream, bash-git-track,
 * bash-time-rm, bash-exec-rm, bash-builtin-rm, bash-shell-option-rm, bash-expand-rm,
 * bash-positional-rm, bash-glob-rm, bash-git-long-track,
 * bash-git-cat,
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
const IMAGE_INPUT = process.env.DSH_CODE_CLI_MOCK_IMAGE === '1'
const TEXT_MODALITIES = ['text']
const VISION_MODALITIES = ['text', 'image']

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
    .filter(text => !/Current runtime context|This snapshot supersedes/i.test(text))
    .filter(text => !text.startsWith('<') || text.includes('<human_rules>') || text.includes('<agent-definitions>') || text.includes('Follow the `') || text.includes('Run the custom command'))
}

function latestUserText(options) {
  return userTexts(options).at(-1) ?? ''
}

function imageEcho(options) {
  const images = options.messages
    .filter(message => message.role === 'user')
    .flatMap(message => message.content.filter(block => block.type === 'image'))
  if (images.length === 0) return ''
  const parts = images.map(block => {
    const ref = block.attachment ?? {}
    const mime = ref.mediaType ?? block.mimeType ?? 'unknown'
    const bytes = Number(ref.bytes ?? 0)
    const width = Number(ref.width ?? 0)
    const height = Number(ref.height ?? 0)
    const id = String(ref.attachmentId ?? '').slice(0, 12)
    return `mime=${mime} bytes=${bytes} size=${width}x${height} id=${id}`
  })
  return ` images=${images.length} ${parts.join(' ')}`
}

function echoUserText(text) {
  return text.replaceAll('\n', '⏎')
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

const MARKDOWN = [
  '# RUST_MD_HEADING',
  '',
  'Prose with **bold**, *em*, `inline_code`, and a [link](https://example.com).',
  'Unicode: 你好 👩‍💻 café',
  'Use Vec<T> when a < b && c > d.',
  'Gain: <font color="green">RUST_MD_GAIN</font> &amp; <b>held</b>',
  '',
  '| 维度 | 内容 |',
  '|---|---|',
  '| 一句话 | 一个很长的中文单元格 |',
  '| 命令 | `codsh` |',
  '',
  '> a quoted line',
  '',
  '```ts',
  'const answer = "text" // a comment',
  '```',
  '',
  '```mermaid',
  'graph TD',
  'A[Start] --> B{Decision}',
  'B -->|yes| C[Done]',
  '```',
  '',
  '```rust',
  'fn f<T>(v: Vec<T>) -> bool { a < b && c > d }',
  '```',
  '',
  '```ts',
  'const unclosed = true',
  '',
  'RUST_MD_STREAM_DONE',
].join('\n')

function* mockMarkdown() {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  for (let at = 0; at < MARKDOWN.length; at += 11) {
    yield { type: 'text-delta', index: 0, text: MARKDOWN.slice(at, at + 11) }
  }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: MARKDOWN } }
  yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 9 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
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
  if (MODE === 'bash-rm' || MODE === 'bash-timeout-rm' || MODE === 'bash-nice-rm' || MODE === 'bash-brace-rm' || MODE === 'bash-ansi-c-rm' || MODE === 'bash-quoted-rm' || MODE === 'bash-eval-rm' || MODE === 'bash-path-rm' || MODE === 'bash-sudo-rm' || MODE === 'bash-nohup-rm' || MODE === 'bash-xargs-rm' || MODE === 'bash-sort-prefix' || MODE === 'bash-sort-output' || MODE === 'bash-git-branch' || MODE === 'bash-git-upstream' || MODE === 'bash-git-track' || MODE === 'bash-time-rm' || MODE === 'bash-exec-rm' || MODE === 'bash-builtin-rm' || MODE === 'bash-shell-option-rm' || MODE === 'bash-expand-rm' || MODE === 'bash-positional-rm' || MODE === 'bash-glob-rm' || MODE === 'bash-git-long-track' || MODE === 'bash-git-cat') {
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
                    : MODE === 'bash-sudo-rm'
                      ? 'sudo rm -rf denied-target'
                      : MODE === 'bash-nohup-rm'
                        ? 'nohup rm -rf denied-target'
                        : MODE === 'bash-xargs-rm'
                          ? 'xargs rm -rf denied-target'
                          : MODE === 'bash-sort-prefix'
                            ? 'sort --compress-pro=gzip note.txt'
                      : MODE === 'bash-sort-output'
                        ? 'sort -oFILE note.txt'
                        : MODE === 'bash-git-branch'
                          ? 'git branch newtopic'
                          : MODE === 'bash-git-upstream'
                            ? 'git branch -uorigin/main'
                            : MODE === 'bash-git-track'
                              ? 'git branch -u'
                              : MODE === 'bash-time-rm'
                                ? 'time /bin/rm -rf denied-target'
                                : MODE === 'bash-exec-rm'
                                  ? 'exec /bin/rm -rf denied-target'
                                  : MODE === 'bash-builtin-rm'
                                    ? 'builtin rm -rf denied-target'
                                    : MODE === 'bash-shell-option-rm'
                                      ? 'bash -o errexit -c "/bin/rm -rf denied-target"'
                                      : MODE === 'bash-glob-rm'
                                        ? './r* -rf denied-target'
                                        : MODE === 'bash-git-long-track'
                                          ? 'git branch --track'
                                      : MODE === 'bash-expand-rm'
                                        ? 'x=/bin/rm; $x -rf denied-target'
                                        : MODE === 'bash-positional-rm'
                                          ? 'set -- /bin/rm; "$1" -rf denied-target'
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
    if (provider === 'text-only') {
      return Promise.resolve([
        { provider, id: 'text-only', name: 'Text Only', inputModalities: TEXT_MODALITIES, contextWindow: CONTEXT_WINDOW },
      ])
    }
    const modalities = IMAGE_INPUT ? VISION_MODALITIES : TEXT_MODALITIES
    return Promise.resolve([
      { provider, id: 'cli-mock', name: 'CLI Mock', inputModalities: modalities, contextWindow: CONTEXT_WINDOW },
      // Same provider, text-only id. A live /model switch can select it
      // without a second provider or a hidden vision route.
      { provider, id: 'cli-mock-fork', name: 'CLI Mock Fork', inputModalities: TEXT_MODALITIES, contextWindow: CONTEXT_WINDOW },
      { provider, id: 'text-only', name: 'Text Only', inputModalities: TEXT_MODALITIES, contextWindow: CONTEXT_WINDOW },
    ])
  }

  resolveModel(provider, model) {
    const window = model === 'narrow' || provider === 'narrow' ? 64000 : CONTEXT_WINDOW
    const modalities = IMAGE_INPUT && model !== 'cli-mock-fork' && model !== 'text-only' && model !== 'narrow' ? VISION_MODALITIES : TEXT_MODALITIES
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: modalities,
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
    if (MODE === 'file-edit' || MODE === 'file-write' || MODE === 'file-missing' || MODE === 'file-error' || MODE === 'bash-rm' || MODE === 'bash-timeout-rm' || MODE === 'bash-nice-rm' || MODE === 'bash-brace-rm' || MODE === 'bash-ansi-c-rm' || MODE === 'bash-quoted-rm' || MODE === 'bash-eval-rm' || MODE === 'bash-path-rm' || MODE === 'bash-sudo-rm' || MODE === 'bash-nohup-rm' || MODE === 'bash-xargs-rm' || MODE === 'bash-sort-prefix' || MODE === 'bash-sort-output' || MODE === 'bash-git-branch' || MODE === 'bash-git-upstream' || MODE === 'bash-git-track' || MODE === 'bash-time-rm' || MODE === 'bash-exec-rm' || MODE === 'bash-builtin-rm' || MODE === 'bash-shell-option-rm' || MODE === 'bash-expand-rm' || MODE === 'bash-positional-rm' || MODE === 'bash-glob-rm' || MODE === 'bash-git-long-track' || MODE === 'bash-git-cat' || MODE === 'bash-git' || MODE === 'file-secret') {
      yield* fileToolTurn(options)
      return
    }
    if (MODE === 'markdown') {
      yield* mockMarkdown()
      return
    }
    if (MODE === 'huge-read' || MODE === 'control-output') {
      const done = toolResults(options)
      const path = MODE === 'huge-read' ? 'huge.txt' : 'ctrl.txt'
      const id = MODE === 'huge-read' ? 'rust-acp-huge' : 'rust-acp-ctrl'
      if (done.length === 0) {
        yield* mockToolCall(id, 'read', { file_path: path })
        return
      }
      const last = done.at(-1)
      if (last?.isError === true) {
        yield* mockText(`RUST_ACP_FILE_ERROR ${resultText(last)}`)
        return
      }
      yield* mockText(MODE === 'huge-read' ? 'RUST_ACP_HUGE_DONE' : 'RUST_ACP_CTRL_DONE')
      return
    }
    if (MODE === 'web-search' || MODE === 'web-search-hang' || MODE === 'web-fetch' || MODE === 'web-missing') {
      const done = toolResults(options)
      if (done.length === 0) {
        if (MODE === 'web-fetch') {
          const url = process.env.CODSH_WEB_FIXTURE_URL || 'http://127.0.0.1/page'
          yield* mockToolCall('rust-acp-web-fetch', 'web_fetch', { url })
        } else if (MODE === 'web-missing') {
          yield* mockToolCall('rust-acp-web-missing', 'web_search', { query: 'should not run' })
        } else {
          yield* mockToolCall('rust-acp-web-search', 'web_search', {
            queries: [MODE === 'web-search-hang' ? 'hang' : 'rust web policy'],
            allowed_domains: ['evil.example'],
          })
        }
        return
      }
      const last = done.at(-1)
      const text = resultText(last)
      if (last?.isError === true) {
        yield* mockText(`RUST_ACP_WEB_ERROR ${text}`)
        return
      }
      yield* mockText(`RUST_ACP_WEB_DONE ${text}`)
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
    const history = echoUserText(userTexts(options).join('\n'))
    const latest = echoUserText(latestUserText(options))
    const corpus = userTexts(options).join('\n')
    const markers = ['HOME_RULE', 'ROOT_RULE', 'DEEP_RULE', 'DIR_RULE_A', 'EXTRA_RULE', 'NESTED_RULE', 'IGNORED_LOCAL', 'UNTRUSTED_PROJECT', 'COMMIT_BODY', 'SHIP_NOTE_BODY', 'REVIEWER_BODY', 'SKILL_ADDED', 'SKILL_REMOVED']
      .filter(marker => corpus.includes(marker))
    const markerText = markers.length ? ` markers=${markers.join(',')}` : ''
    const reply = `RUST_ACP_ANSWER turn=${turn} route=${route} effort=${effort} model=${model} latest=${latest}${imageEcho(options)}${markerText} ${history}`
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
