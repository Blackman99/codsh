/**
 * Keyless LLM adapter at the dsh provider boundary for Rust ACP turn tests.
 * Modes: echo (default), reasoning, empty, fail-stream, max-tokens, file-edit, file-write,
 * file-missing, file-error, markdown, huge-read, control-output, plain-steps, bash-rm, bash-timeout-rm, bash-nice-rm, bash-brace-rm,
 * bash-ansi-c-rm, bash-quoted-rm, bash-eval-rm, bash-path-rm, bash-sudo-rm,
 * bash-nohup-rm, bash-xargs-rm, bash-sort-prefix,
 * bash-sort-output, bash-git-branch, bash-git-upstream, bash-git-track,
 * bash-time-rm, bash-exec-rm, bash-builtin-rm, bash-shell-option-rm, bash-expand-rm,
 * bash-positional-rm, bash-glob-rm, bash-git-long-track,
 * bash-git-cat,
 * bash-git, shell-echo, shell-fail, shell-long, shell-deny, shell-env, file-secret, sandbox-session. Optional
 * DSH_CODE_CLI_MOCK_DELAY_MS delays the first chunk so session/cancel can win
 * before activity.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
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
    .filter(text => !text.startsWith('<') || text.includes('<human_rules>') || text.includes('<agent-definitions>') || text.includes('Follow the `') || text.includes('Run the custom command') || text.includes('<local-memory>'))
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
  if (MODE === 'shell-env') {
    if (done.length === 0) {
      // The command is fixed. The bash child prints the marker and the set
      // value from its own environment, so a filter that never reached dsh
      // cannot look filtered.
      const command = "printf 'ENV_%s_%s\\n' \"${CODSH_SHELL_MARKER-hidden}\" \"${CODSH_ENV_MARK-unset}\""
      yield* mockToolCall('rust-acp-shell', 'bash', { command, description: 'Run the shell probe' })
      return
    }
    const last = done.at(-1)
    const text = resultText(last)
    if (last?.isError === true) {
      yield* mockText(`RUST_ACP_SHELL_ERROR ${text}`)
      return
    }
    yield* mockText(`RUST_ACP_SHELL_DONE ${text}`)
    return
  }
  if (MODE === 'shell-echo' || MODE === 'shell-fail' || MODE === 'shell-long' || MODE === 'shell-deny') {
    if (done.length === 0) {
      const marker = process.env.CODSH_SHELL_MARKER || 'SHELL_MARKER'
      const workdir = process.env.CODSH_SHELL_WORKDIR || ''
      const command = MODE === 'shell-fail'
        ? `printf 'STDOUT_${marker}\\n'; printf 'STDERR_${marker}\\n' >&2; exit 7`
        : MODE === 'shell-long'
          ? `printf 'STARTED_${marker}\\n' > shell-started.txt; sleep 30; printf 'FINISHED_${marker}\\n' > shell-finished.txt`
          : MODE === 'shell-deny'
            ? `printf 'DENIED_RAN_${marker}\\n' > denied-ran.txt`
            : `printf 'STDOUT_${marker}\\n'; printf 'STDERR_${marker}\\n' >&2; printf '%s\\n' "$PWD"`
      const args = { command, description: 'Run the shell probe' }
      if (workdir) args.workdir = workdir
      if (MODE === 'shell-fail') args.timeoutMs = 15000
      yield* mockToolCall('rust-acp-shell', 'bash', args)
      return
    }
    const last = done.at(-1)
    const text = resultText(last)
    if (last?.isError === true) {
      yield* mockText(`RUST_ACP_SHELL_ERROR ${text}`)
      return
    }
    yield* mockText(`RUST_ACP_SHELL_DONE ${text}`)
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
  if (MODE === 'search-needle' || MODE === 'search-empty' || MODE === 'search-denied' || MODE === 'search-continue' || MODE === 'search-binary' || MODE === 'search-stale' || MODE === 'search-lsp') {
    const last = done.at(-1)
    if (last?.isError === true) {
      yield* mockText(`RUST_ACP_SEARCH_ERROR ${resultText(last)}`)
      return
    }
    if (MODE === 'search-needle' && done.length === 0) {
      yield* mockToolCall('rust-acp-grep', 'grep', { pattern: 'NEEDLE', path: '.' })
      return
    }
    if (MODE === 'search-needle' && done.length === 1) {
      yield* mockToolCall('rust-acp-glob', 'glob', { pattern: '**/*.txt', path: '.' })
      return
    }
    if (MODE === 'search-empty' && done.length === 0) {
      yield* mockToolCall('rust-acp-grep-empty', 'grep', { pattern: 'NO_SUCH_TOKEN_ZZZ', path: '.' })
      return
    }
    if (MODE === 'search-denied' && done.length === 0) {
      yield* mockToolCall('rust-acp-grep-denied', 'grep', { pattern: 'SECRET_LINE', path: '.' })
      return
    }
    if (MODE === 'search-denied' && done.length === 1) {
      yield* mockToolCall('rust-acp-glob-denied', 'glob', { pattern: '**/*', path: '.' })
      return
    }
    if (MODE === 'search-denied' && done.length === 2) {
      yield* mockToolCall('rust-acp-grep-root', 'grep', { pattern: 'SECRET_LINE', path: 'secret' })
      return
    }
    if (MODE === 'search-denied' && done.length === 3) {
      yield* mockToolCall('rust-acp-bash-denied', 'bash', { command: 'rg -n SECRET_LINE secret/key.txt', description: 'search bypass probe' })
      return
    }
    if (MODE === 'search-continue' && done.length === 0) {
      yield* mockToolCall('rust-acp-grep-page', 'grep', { pattern: 'PAGE', path: 'paged.txt' })
      return
    }
    if (MODE === 'search-continue' && done.length === 1) {
      yield* mockToolCall('rust-acp-read-page', 'read', { file_path: 'paged.txt', offset: 1, limit: 2 })
      return
    }
    if (MODE === 'search-continue' && done.length === 2) {
      const text = resultText(done[1])
      const marker = text.match(/offset=(\d+)/)
      const offset = marker ? Number(marker[1]) : 3
      yield* mockToolCall('rust-acp-read-rest', 'read', { file_path: 'paged.txt', offset, limit: 50 })
      return
    }
    if (MODE === 'search-binary' && done.length === 0) {
      yield* mockToolCall('rust-acp-read-bin', 'read', { file_path: 'blob.bin' })
      return
    }
    if (MODE === 'search-stale' && done.length === 0) {
      yield* mockToolCall('rust-acp-read-stale', 'read', { file_path: 'moving.txt' })
      return
    }
    if (MODE === 'search-stale' && done.length === 1) {
      // The read already observed "before". Change the file before edit so
      // dsh reports a stale version instead of applying the patch.
      writeFileSync('moving.txt', 'changed-underfoot\n')
      yield* mockToolCall('rust-acp-edit-stale', 'edit', {
        file_path: 'moving.txt',
        old_string: 'before',
        new_string: 'after',
      })
      return
    }
    if (MODE === 'search-lsp' && done.length === 0) {
      yield* mockToolCall('rust-acp-lsp', 'lsp', {
        operation: 'goToDefinition',
        file_path: 'nav.ts',
        line: 1,
        character: 1,
      })
      return
    }
    if (last) {
      yield* mockText(`RUST_ACP_SEARCH_DONE ${resultText(last)}`)
      return
    }
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

// Filesystem sandbox session (ticket 11 / #143). The parent and a real dsh
// subagent each attempt protected reads, writes, and renames through dsh
// tools. Every tool result dsh returns is appended to a record in the dsh
// working directory so the test can assert what the tools actually reported.
const SANDBOX_CHILD = 'SANDBOX_CHILD_PROBE'
const SANDBOX_RECORD = '.codsh-mock-record.jsonl'

function sandboxBashCommand(prefix) {
  return [
    `out=$(cat secret.txt 2>&1) && echo "${prefix}_CAT=allowed:$out" || echo "${prefix}_CAT=denied:$out"`,
    `out=$( (printf changed > secret.txt) 2>&1) && echo "${prefix}_WRITE=allowed" || echo "${prefix}_WRITE=denied:$out"`,
    `out=$(mv secret.txt stolen-${prefix}.txt 2>&1) && echo "${prefix}_MV=allowed" || echo "${prefix}_MV=denied:$out"`,
    `if [ -e stolen-${prefix}.txt ]; then mv stolen-${prefix}.txt secret.txt; fi`,
    `out=$(python3 -c "open('secret.txt').read()" 2>&1) && echo "${prefix}_PY=allowed" || echo "${prefix}_PY=denied:$(printf '%s' "$out" | tail -n 1)"`,
    `out=$(mv hooks/guard.sh hooks/moved-${prefix}.sh 2>&1) && echo "${prefix}_HOOK_MV=allowed" || echo "${prefix}_HOOK_MV=denied:$out"`,
    `if [ -e hooks/moved-${prefix}.sh ]; then mv hooks/moved-${prefix}.sh hooks/guard.sh; fi`,
    `out=$(mv hooks hooks-moved-${prefix} 2>&1) && echo "${prefix}_DIR_MV=allowed" || echo "${prefix}_DIR_MV=denied:$out"`,
    `if [ -e hooks-moved-${prefix} ]; then mv hooks-moved-${prefix} hooks; fi`,
    `out=$( (printf ok > ${prefix.toLowerCase()}-allowed.txt) 2>&1) && echo "${prefix}_ALLOWED=allowed" || echo "${prefix}_ALLOWED=denied:$out"`,
  ].join('; ')
}

// A child agent cannot answer an approval card, so its command avoids the
// expansions and parentheses that make the permission layer ask (the Python
// read lives in the fixture's read_secret.py). Each step prints its own
// error; the renames are undone unconditionally so the control run stays
// comparable.
function sandboxChildCommand() {
  return [
    'echo CHILD_BEGIN',
    'cat secret.txt',
    'printf changed > secret.txt',
    'mv secret.txt stolen-CHILD.txt',
    'mv stolen-CHILD.txt secret.txt',
    'python3 read_secret.py',
    'mv hooks/guard.sh hooks/moved-CHILD.sh',
    'mv hooks/moved-CHILD.sh hooks/guard.sh',
    'mv hooks hooks-moved-CHILD',
    'mv hooks-moved-CHILD hooks',
    'printf ok > child-allowed.txt',
    'echo CHILD_END',
  ].join('; ')
}

async function recordSandboxResult(agent, step, result) {
  const { appendFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const entry = { agent, step, isError: result?.isError === true, text: resultText(result) }
  await appendFile(join(process.cwd(), SANDBOX_RECORD), `${JSON.stringify(entry)}\n`)
}

function sandboxSteps(child) {
  if (child) {
    return [
      ['child-read-secret', 'read', { file_path: 'secret.txt' }],
      ['child-write-pem', 'write', { file_path: 'certs/child.pem', content: 'CHILD_PEM\n' }],
      ['child-bash', 'bash', { command: sandboxChildCommand(), description: 'sandbox child probe' }],
    ]
  }
  return [
    ['read-secret', 'read', { file_path: 'secret.txt' }],
    ['read-hook', 'read', { file_path: 'hooks/guard.sh' }],
    ['edit-hook', 'edit', { file_path: 'hooks/guard.sh', old_string: 'guard', new_string: 'patched' }],
    ['write-pem', 'write', { file_path: 'certs/new.pem', content: 'NEW_PEM\n' }],
    ['bash', 'bash', { command: sandboxBashCommand('PARENT'), description: 'sandbox probe' }],
    ['read-note', 'read', { file_path: 'note.txt' }],
    ['edit-note', 'edit', { file_path: 'note.txt', old_string: 'alpha', new_string: 'ALPHA' }],
    ['subagent', 'subagent', {
      description: 'sandbox child probe',
      prompt: `${SANDBOX_CHILD}: attempt the protected reads, writes, and renames, then report.`,
      run_in_background: false,
    }],
  ]
}

async function * sandboxSessionTurn(options) {
  const child = userTexts(options).some(text => text.includes(SANDBOX_CHILD))
  const agent = child ? 'child' : 'parent'
  const steps = sandboxSteps(child)
  const done = toolResults(options)
  if (done.length > 0) await recordSandboxResult(agent, steps[done.length - 1]?.[0] ?? `extra-${done.length}`, done.at(-1))
  if (done.length < steps.length) {
    const [id, name, args] = steps[done.length]
    yield* mockToolCall(`rust-acp-sandbox-${id}`, name, args)
    return
  }
  yield* mockText(child ? 'RUST_ACP_SANDBOX_CHILD_DONE' : 'RUST_ACP_SANDBOX_DONE')
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
    const trace = process.env.CODSH_REVIEW_TRACE
    if (trace && options.purpose !== 'compaction') {
      const names = Array.isArray(options.tools) ? options.tools.map(tool => tool.name) : []
      const user = options.messages
        .filter(message => message.role === 'user')
        .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
      const results = options.messages.flatMap(message => message.content.filter(block => block.type === 'tool-result').map(block => ({
        name: block.toolName ?? block.name ?? '',
        error: block.isError === true,
        text: (block.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 500),
      })))
      appendFileSync(trace, `${JSON.stringify({
        purpose: options.purpose ?? 'turn',
        provider: options.provider,
        model: options.model?.id ?? options.model ?? '',
        tools: names,
        user,
        results,
      })}\n`)
    }
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
    if (MODE === 'sandbox-session') {
      yield* sandboxSessionTurn(options)
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
    if (MODE === 'file-edit' || MODE === 'file-write' || MODE === 'file-missing' || MODE === 'file-error' || MODE === 'bash-rm' || MODE === 'bash-timeout-rm' || MODE === 'bash-nice-rm' || MODE === 'bash-brace-rm' || MODE === 'bash-ansi-c-rm' || MODE === 'bash-quoted-rm' || MODE === 'bash-eval-rm' || MODE === 'bash-path-rm' || MODE === 'bash-sudo-rm' || MODE === 'bash-nohup-rm' || MODE === 'bash-xargs-rm' || MODE === 'bash-sort-prefix' || MODE === 'bash-sort-output' || MODE === 'bash-git-branch' || MODE === 'bash-git-upstream' || MODE === 'bash-git-track' || MODE === 'bash-time-rm' || MODE === 'bash-exec-rm' || MODE === 'bash-builtin-rm' || MODE === 'bash-shell-option-rm' || MODE === 'bash-expand-rm' || MODE === 'bash-positional-rm' || MODE === 'bash-glob-rm' || MODE === 'bash-git-long-track' || MODE === 'bash-git-cat' || MODE === 'bash-git' || MODE === 'file-secret' || MODE === 'search-needle' || MODE === 'search-empty' || MODE === 'search-denied' || MODE === 'search-continue' || MODE === 'search-binary' || MODE === 'search-stale' || MODE === 'search-lsp' || MODE === 'shell-echo' || MODE === 'shell-fail' || MODE === 'shell-long' || MODE === 'shell-deny' || MODE === 'shell-env') {
      yield* fileToolTurn(options)
      return
    }
    if (MODE === 'markdown') {
      yield* mockMarkdown()
      return
    }
    if (MODE === 'huge-read' || MODE === 'control-output' || MODE === 'plain-read') {
      const done = toolResults(options)
      const path = MODE === 'huge-read' ? 'huge.txt' : MODE === 'plain-read' ? 'note.txt' : 'ctrl.txt'
      const id = MODE === 'huge-read' ? 'rust-acp-huge' : MODE === 'plain-read' ? 'rust-acp-plain-read' : 'rust-acp-ctrl'
      if (done.length === 0) {
        yield* mockToolCall(id, 'read', { file_path: path })
        return
      }
      const last = done.at(-1)
      if (last?.isError === true) {
        yield* mockText(`RUST_ACP_FILE_ERROR ${resultText(last)}`)
        return
      }
      yield* mockText(MODE === 'control-output' ? 'RUST_ACP_CTRL_DONE' : 'RUST_ACP_HUGE_DONE')
      return
    }
    if (MODE === 'plain-steps') {
      const done = toolResults(options)
      if (done.length < 4) {
        yield* mockToolCall(`rust-acp-step-${done.length + 1}`, 'read', { file_path: 'note.txt' })
        return
      }
      yield* mockText(`RUST_ACP_STEPS_DONE calls=${done.length}`)
      return
    }
    if (MODE === 'hook-bash') {
      const done = toolResults(options)
      if (done.length > 0) {
        const last = done.at(-1)
        const text = resultText(last)
        if (last?.isError === true) {
          yield* mockText(`RUST_ACP_HOOK_DENIED ${text}`)
          return
        }
        yield* mockText(`RUST_ACP_HOOK_DONE ${text}`)
        return
      }
      const prompt = latestUserText(options)
      if (prompt.includes('BLOCK_THIS_PROMPT')) {
        yield* mockText('RUST_ACP_HOOK_PROMPT_RAN')
        return
      }
      yield* mockToolCall('rust-acp-hook-bash', 'bash', { command: 'printf HOOK_SIDE_EFFECT', description: 'hook fixture' })
      return
    }
    if (MODE === 'hook-prompt-block') {
      yield* mockText('RUST_ACP_HOOK_PROMPT_RAN')
      return
    }
    if (MODE === 'hook-stop') {
      const texts = userTexts(options).join('\n')
      if (texts.includes('\u241ehook\u241estop hook')) {
        yield* mockText('RUST_ACP_HOOK_CONTINUED')
        return
      }
      yield* mockText('RUST_ACP_HOOK_STOP_READY')
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
    if (MODE === 'max-tokens') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'RUST_ACP_TRUNCATED' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'RUST_ACP_TRUNCATED' } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
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
