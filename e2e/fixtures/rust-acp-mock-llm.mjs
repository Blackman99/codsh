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
 * bash-git, shell-echo, shell-count (ticket 190), shell-fail, shell-long, shell-deny, shell-env, file-secret, sandbox-session, subagents, mcp,
 * steer-probe (three read steps, then reports the latest user text it saw),
 * interaction (ticket 179: ASK_ONE, ASK_MULTI, PLAN_ENTER, PLAN_EXIT, PLAN_EMPTY,
 * PLAN_EDIT_OTHER, PLAN_EDIT_FILE, TODOS, STATUS keywords in the prompt),
 * background (ticket 175 background commands; see backgroundTurn), scheduler
 * (ticket 177 scheduled prompts; see schedulerTurn), monitor (ticket 176
 * monitors; see monitorTurn). A side question
 * (/btw, system prompt from rust-acp-control) answers RUST_BTW_ANSWER; CODSH_MOCK_BTW=fail fails it
 * and CODSH_MOCK_BTW_DELAY_MS holds it. Optional
 * DSH_CODE_CLI_MOCK_DELAY_MS delays the first chunk so session/cancel can win
 * before activity.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  if (MODE === 'shell-count') {
    // Ticket 190: one appended line per real execution, so a reconnect that
    // ran the command again would leave two lines.
    if (done.length === 0) {
      const seconds = Number(process.env.CODSH_SHELL_SLEEP ?? '4')
      const command = `printf 'RAN\\n' >> shell-count.txt; sleep ${seconds}; printf 'DONE\\n' >> shell-done.txt`
      yield* mockToolCall('rust-acp-shell', 'bash', { command, description: 'Run the counted command' })
      return
    }
    yield* mockText(`RUST_ACP_COUNT_DONE ${resultText(done.at(-1))}`)
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
    // A denied search root errors before the shell bypass. Keep going so
    // `rg` of the denied file is actually issued, then stop on that result.
    const continueDeniedShell = MODE === 'search-denied' && done.length < 4
    if (last?.isError === true && !continueDeniedShell) {
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

// Typed subagents (ticket 172). The parent prompt lists spawn steps:
// `SPAWN:<type>:<CHILD>[:bg]`, run one after another. Each child prompt
// carries `CHILD_<CHILD>`; the child reports the tool names dsh offered it,
// so a test sees the real restricted schema. CHILD kinds:
//   WRITE  calls write child-<n>.txt, then reports whether it was allowed.
//   ECHO   answers at once.
//   SLOW   waits until dsh aborts it (cancel), up to 60s.
//   NEST   calls the subagent tool itself (refused when depth-capped).
//   PWD    runs bash `pwd` and reports the directory (ticket 174).
//   EDIT   writes shared.txt (a tracked file in the worktree tests).
//   SECRET writes secret.txt (denied by a checkout rule in the tests).
// A `:wt` suffix sets isolation: "worktree" (ticket 174).
// COLLECT in the parent prompt then reads each background job with job_output.
function rawUserTexts(options) {
  return options.messages
    .filter(message => message.role === 'user')
    .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
}

function turnToolResults(options, marker) {
  let start = -1
  options.messages.forEach((message, index) => {
    if (message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.includes(marker))) start = index
  })
  return options.messages.slice(start + 1).flatMap(message => message.content.filter(block => block.type === 'tool-result'))
}

// Background commands (ticket 175). The typed prompt picks the scenario;
// each command sleeps for a distinct time so a test can find its process.
//   BG_FAST     foreground command with stdout, stderr, and exit 3.
//   BG_AUTO     foreground command that outlives the auto-background budget.
//   BG_CTRLB    foreground command the test moves with Ctrl+B.
//   BG_SENDNOW  foreground command a send-now moves.
//   BG_WAIT     explicit run_in_background, then a blocking job_output wait.
//   BG_KEEP     explicit run_in_background of a long command, then answers.
// A dsh completion notice (a user message `background job <id> ...`) is
// answered by reading the job with job_output and reporting the output.
const BG_COMMANDS = {
  BG_FAST: { command: "printf 'FAST_OUT\\n'; printf 'FAST_ERR\\n' >&2; exit 3", description: 'fast probe' },
  BG_AUTO: { command: "printf 'AUTO_START\\n'; sleep 3.175; printf 'AUTO_END\\n' > bg-auto-done.txt; printf 'AUTO_OUT\\n'", description: 'auto probe' },
  BG_CTRLB: { command: "printf 'CTRLB_START\\n'; : > bg-ctrlb-started.txt; sleep 4.175; printf 'CTRLB_OUT\\n'", description: 'ctrl-b probe' },
  BG_SENDNOW: { command: "printf 'SENDNOW_START\\n'; : > bg-sendnow-started.txt; sleep 4.275; printf 'SENDNOW_OUT\\n'", description: 'send-now probe' },
  BG_WAIT: { command: "printf 'WAIT_START\\n'; sleep 41.175; printf 'WAIT_OUT\\n'", description: 'wait probe', run_in_background: true },
  BG_KEEP: { command: "printf 'KEEP_START\\n'; sleep 42.175; printf 'KEEP_OUT\\n'", description: 'keep probe', run_in_background: true },
}

function oneLine(text) {
  return String(text ?? '').replaceAll('\n', '⏎').slice(0, 400)
}

/** Tool results since the newest user message that carries text. */
function resultsSinceUser(options) {
  let start = -1
  options.messages.forEach((message, index) => {
    if (message.role === 'user' && message.content.some(block => block.type === 'text')) start = index
  })
  return options.messages.slice(start + 1).flatMap(message => message.content.filter(block => block.type === 'tool-result'))
}

// A short answer line: how the command left the foreground and its last
// output line. The tool card shows the full result.
function resultSummary(text) {
  const how = !text.includes('[Command moved to background]')
    ? 'no'
    : /automatically moved to background/.test(text)
      ? 'auto'
      : /^User moved command/m.test(text)
        ? 'user'
        : /because the user sent a new message/.test(text) ? 'message' : 'yes'
  const tail = String(text ?? '').trim().split('\n').at(-1) ?? ''
  return `moved=${how} tail=${oneLine(tail).slice(0, 80)}`
}

function jobIdOf(text) {
  return /Job id: (\S+?)\./.exec(text)?.[1] ?? /started background job (\S+)/.exec(text)?.[1] ?? ''
}

function * backgroundTurn(options) {
  const latest = latestUserText(options)
  const since = resultsSinceUser(options)
  const notice = /^background job (\S+) /.exec(latest)
  if (notice) {
    const id = notice[1]
    if (latest.includes('was stopped by the user')) {
      yield* mockText(`RUST_BG_STOPPED job=${id}`)
      return
    }
    if (since.length === 0) {
      yield* mockToolCall(`rust-bg-read-${id}-${Date.now().toString(36)}`, 'job_output', { job_id: id })
      return
    }
    yield* mockText(`RUST_BG_WOKE job=${id} out=${oneLine(resultText(since.at(-1)))}`)
    return
  }
  const scenario = Object.keys(BG_COMMANDS).find(key => latest.includes(key))
  if (scenario === undefined) {
    yield* mockText(`RUST_BG_REPLY ${oneLine(latest)}`)
    return
  }
  const spec = BG_COMMANDS[scenario]
  if (since.length === 0) {
    yield* mockToolCall(`rust-bg-${scenario.toLowerCase()}-${Date.now().toString(36)}`, 'bash', spec)
    return
  }
  const first = resultText(since[0])
  if (scenario === 'BG_WAIT' && since.length === 1) {
    yield* mockToolCall(`rust-bg-wait-${Date.now().toString(36)}`, 'job_output', { job_id: jobIdOf(first), wait: true, timeout_ms: 120000 })
    return
  }
  if (scenario === 'BG_FAST') {
    yield* mockText(`RUST_BG_FAST result=${oneLine(resultText(since.at(-1)))}`)
    return
  }
  const label = spec.run_in_background ? 'RUST_BG_STARTED' : 'RUST_BG_MOVED'
  yield* mockText(`${label} job=${jobIdOf(first)} ${resultSummary(resultText(since.at(-1)))}`)
}

// Monitors (ticket 176). Every provider call in this mode is appended to
// CODSH_MOCK_MONITOR_TRACE (one JSON line with the latest user text), so a
// test counts the model requests monitor events caused.
//   MON_CALL <json>   calls monitor with that input, then reports the result.
//   MON_BUSY <json>   calls monitor, runs a 1.6 s foreground command, then
//                     reports how many monitor events reached this turn.
//   MON_KILL <id>     job_kill; MON_OUTPUT <id> job_output; MON_LIST job_list
//                     (the reply ends told=N: user-kill notices seen so far).
// A monitor event (`<monitor-event …>` or a grouped `N monitor events …`)
// is answered RUST_MON_EVENT, a dsh completion notice RUST_MON_ENDED.
function monitorTexts(options) {
  return rawUserTexts(options)
    .filter(text => !/Current runtime context|This snapshot supersedes/i.test(text))
    .filter(text => !text.startsWith('<system-reminder>'))
}

function monitorSince(options, text) {
  let start = -1
  options.messages.forEach((message, index) => {
    if (message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === text)) start = index
  })
  return options.messages.slice(start + 1)
}

function * monitorTurn(options) {
  const texts = monitorTexts(options)
  const latest = texts.at(-1) ?? ''
  if (process.env.CODSH_MOCK_MONITOR_TRACE) {
    try {
      appendFileSync(process.env.CODSH_MOCK_MONITOR_TRACE, `${JSON.stringify({ latest: oneLine(latest).slice(0, 300) })}\n`)
    } catch {}
  }
  const typed = [...texts].reverse().find(text => /^MON_[A-Z]+/.test(text)) ?? ''
  const since = monitorSince(options, typed)
  const results = since.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
  const isEvent = text => text.startsWith('<monitor-event') || /^\d+ monitor events from /.test(text)
  if (typed.startsWith('MON_BUSY ') && results.length >= 2) {
    const seen = since
      .filter(message => message.role === 'user')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
    const events = seen.filter(isEvent)
    const notices = seen.filter(text => /^background job (\S+) /.test(text))
    yield* mockText(`RUST_MON_BUSY saw=${events.length} notices=${notices.length} ${oneLine(events.join(' | ')).slice(0, 300)}`)
    return
  }
  if (isEvent(latest) && latest !== typed) {
    yield* mockText(`RUST_MON_EVENT ${oneLine(latest).slice(0, 300)}`)
    return
  }
  if (/^background job (\S+) /.test(latest)) {
    yield* mockText(`RUST_MON_ENDED ${oneLine(latest).slice(0, 300)}`)
    return
  }
  if (latest.startsWith('Monitor "') && latest.includes('was stopped by the user')) {
    yield* mockText(`RUST_MON_STOPPED ${oneLine(latest).slice(0, 200)}`)
    return
  }
  const [word, ...rest] = typed.split(' ')
  const arg = rest.join(' ')
  if (latest !== typed || word === '') {
    yield* mockText(`RUST_MON_REPLY ${oneLine(latest).slice(0, 200)}`)
    return
  }
  const stamp = Date.now().toString(36)
  if (word === 'MON_CALL' || word === 'MON_BUSY') {
    if (results.length === 0) {
      let input
      try {
        input = JSON.parse(arg)
      } catch {
        input = { command: arg, description: 'probe' }
      }
      yield* mockToolCall(`rust-mon-call-${stamp}`, 'monitor', input)
      return
    }
    if (word === 'MON_BUSY' && results.length === 1 && !results[0].isError) {
      yield* mockToolCall(`rust-mon-busy-${stamp}`, 'bash', { command: 'sleep 1.6; echo BUSY_DONE', description: 'busy probe' })
      return
    }
    const first = results[0]
    yield* mockText(`${first.isError ? 'RUST_MON_ERROR' : 'RUST_MON_STARTED'} ${oneLine(resultText(first)).slice(0, 300)}`)
    return
  }
  const control = { MON_KILL: 'job_kill', MON_OUTPUT: 'job_output', MON_LIST: 'job_list' }[word]
  if (control !== undefined) {
    if (results.length === 0) {
      yield* mockToolCall(`rust-mon-${control}-${stamp}`, control, control === 'job_list' ? {} : { job_id: arg })
      return
    }
    // told=N: user-kill notices (reference wording) the model has seen.
    const told = rawUserTexts(options).filter(text => text.includes('This task was killed by the user')).length
    yield* mockText(`RUST_MON_${word.slice(4)} ${oneLine(resultText(results[0])).slice(0, 300)} told=${told}`)
    return
  }
  yield* mockText(`RUST_MON_REPLY ${oneLine(latest).slice(0, 200)}`)
}

// Goal rounds (ticket 180). The objective's markers pick the behavior.
//   Round turns (`<goal_round>` prompts from dsh's round driver):
//     CLAIM_FROM_<k>  from round k on, read the goal and claim completion
//                     with update_goal (default: round 1).
//     NEVER_CLAIM     never claims; every round only reports progress.
//     PACE            a round that does not claim waits 300 ms (abortable), so
//                     the round cap is far away while a test acts.
//     WRITE_ROUND_<k> in round k, write goal-done.txt before any claim.
//     BURN            every response reports 5000 tokens and never claims.
//     SLOWROUND       each round waits 60 s (abortable) before answering.
//     BGJOB           round 1 starts a 30 s background command before the claim.
//   Verifier turns (`<goal_verification>` briefs from rust-acp-goal):
//     VERIFY_PASS / VERIFY_FAIL / VERIFY_SILENT (no verdict line) /
//     VERIFY_SPLIT (skeptic 1 passes, the others refuse) /
//     VERIFY_FILE (passes only when goal-done.txt exists) / VERIFY_SLOW.
//   A human turn answers GOAL_HUMAN with its text; SLOWHUMAN holds it 1.5 s.
const GOAL_BURN_USAGE = { inputTokens: 4000, outputTokens: 1000 }

function * goalText(reply, usage = { inputTokens: 2, outputTokens: 2 }) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: reply }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function * goalVerifierTurn(options, brief) {
  const objective = /Objective: ("(?:[^"\\]|\\.)*")/.exec(brief)?.[1] ?? '""'
  const skeptic = Number(/You are skeptic (\d+) of (\d+)/.exec(brief)?.[1] ?? '1')
  const has = marker => objective.includes(marker)
  if (has('VERIFY_SLOW')) {
    try {
      await sleep(60000, options.signal)
    } catch {
      return
    }
  }
  if (has('VERIFY_SILENT')) {
    yield* goalText(`VERIFIER_${skeptic} looked around and has no opinion.`)
    return
  }
  let achieved = has('VERIFY_PASS')
  let gap = `skeptic ${skeptic}: the objective is not met`
  if (has('VERIFY_SPLIT')) achieved = skeptic === 1
  if (has('VERIFY_FILE')) {
    achieved = existsSync(join(process.cwd(), 'goal-done.txt'))
    gap = `skeptic ${skeptic}: goal-done.txt is missing`
  }
  yield* goalText(achieved
    ? `VERIFIER_${skeptic} checked the workspace.\nGAPS:\n- none\nVERDICT: ACHIEVED`
    : `VERIFIER_${skeptic} checked the workspace.\nGAPS:\n- ${gap}\nVERDICT: NOT_ACHIEVED`)
}

async function * goalTurn(options) {
  const texts = rawUserTexts(options).filter(text => !/Current runtime context|This snapshot supersedes/i.test(text))
  const brief = texts.find(text => text.includes('<goal_verification>'))
  if (brief !== undefined) {
    yield* goalVerifierTurn(options, brief)
    return
  }
  const latest = texts.at(-1) ?? ''
  if (latest.includes('<goal_complete>') || latest.includes('<goal_blocked>')) {
    yield* goalText(`GOAL_CLOSING ${latest.includes('<goal_complete>') ? 'complete' : 'blocked'}`)
    return
  }
  const roundText = [...texts].reverse().find(text => text.includes('<goal_round>'))
  const lastHuman = [...texts].reverse().find(text => !text.startsWith('<'))
  const roundAt = roundText === undefined ? -1 : texts.lastIndexOf(roundText)
  const humanAt = lastHuman === undefined ? -1 : texts.lastIndexOf(lastHuman)
  if (roundText === undefined || humanAt > roundAt) {
    if ((lastHuman ?? '').includes('SLOWHUMAN')) {
      try {
        await sleep(1500, options.signal)
      } catch {
        return
      }
    }
    const offered = (Array.isArray(options.tools) ? options.tools.map(tool => tool.name) : [])
      .filter(name => name.endsWith('_goal')).sort().join(',')
    yield* goalText(`GOAL_HUMAN tools=${offered || '(none)'} ${echoUserText(lastHuman ?? '')}`)
    return
  }
  const objective = /Objective: ("(?:[^"\\]|\\.)*")/.exec(roundText)?.[1] ?? '""'
  const round = Number(/Round: (\d+)\//.exec(roundText)?.[1] ?? '0')
  const has = marker => objective.includes(marker)
  const done = turnToolResults(options, '<goal_round>')
  const byId = prefix => done.filter(result => String(result.toolCallId ?? '').startsWith(prefix))
  if (has('BURN')) {
    yield* goalText(`GOAL_BURN round=${round}`, GOAL_BURN_USAGE)
    return
  }
  if (has('SLOWROUND')) {
    try {
      await sleep(60000, options.signal)
    } catch {
      return
    }
    yield* goalText(`GOAL_SLOW_DONE round=${round}`)
    return
  }
  if (has('BGJOB') && round === 1 && byId('goal-bg-').length === 0) {
    yield* mockToolCall(`goal-bg-${round}`, 'bash', { command: "printf 'GOAL_BG_START\\n'; sleep 30.180", description: 'goal probe', run_in_background: true })
    return
  }
  const writeRound = Number(/WRITE_ROUND_(\d+)/.exec(objective)?.[1] ?? '0')
  if (writeRound === round && byId('goal-write-').length === 0) {
    yield* mockToolCall(`goal-write-${round}`, 'write', { file_path: 'goal-done.txt', content: `done in round ${round}\n` })
    return
  }
  const claimFrom = Number(/CLAIM_FROM_(\d+)/.exec(objective)?.[1] ?? '1')
  if (has('NEVER_CLAIM') || round < claimFrom) {
    if (has('PACE')) {
      try {
        await sleep(300, options.signal)
      } catch {
        return
      }
    }
    yield* goalText(`GOAL_WORKING round=${round}`)
    return
  }
  const got = byId('goal-get-')
  if (got.length === 0) {
    yield* mockToolCall(`goal-get-${round}`, 'get_goal', {})
    return
  }
  const claimed = byId('goal-claim-')
  if (claimed.length === 0) {
    let goal = {}
    try {
      goal = JSON.parse(resultText(got.at(-1))).goal ?? {}
    } catch {}
    yield* mockToolCall(`goal-claim-${round}`, 'update_goal', { goal_id: goal.id ?? '', revision: goal.revision ?? 0, action: 'complete' })
    return
  }
  const last = claimed.at(-1)
  const verdict = last.isError === true ? 'refused' : 'accepted'
  yield* goalText(`GOAL_ROUND_END round=${round} claim=${verdict}: ${oneLine(resultText(last))}`)
}

const HOLD = { live: 0, peak: 0 }
const ONCE = new Set()

// Scheduled prompts (ticket 177).
//   The /loop instruction (`# /loop -- schedule a recurring prompt`) is turned
//   into scheduler_create: the first input token is the interval, the rest
//   the prompt, fire_immediately: true. Then LOOP_SCHEDULED <result>.
//   SCHED_CALL <json> calls scheduler_create with that input once.
//   SCHED_LIST calls scheduler_list; SCHED_DELETE <id|first> deletes one.
//   A fire's child (a `Scheduled task <id>` reminder) answers
//   LOOP_STATUS n=<k> prior=<previous status or none> sched=<yes|no>
//   interrupted=<fire whose outcome is unknown, or no> (ticket 178); a
//   LOOP_SLOW prompt waits 60s first (abortable) unless it follows an
//   interrupted fire. A completion notice is read
//   with job_output and answered LOOP_WOKE job=<id> out=<one line>.
let loopChildRuns = 0

async function * schedulerTurn(options) {
  const texts = rawUserTexts(options)
  const fireText = texts.find(text => /^<system-reminder>\nScheduled task \S+ \(/.test(text))
  if (fireText) {
    const tools = Array.isArray(options.tools) ? options.tools.map(tool => tool.name) : []
    const prior = /Your previous iteration ended with:\n([^\n]*)/.exec(fireText)?.[1]
    const interrupted = /The previous iteration \(fire (\d+)\) was interrupted/.exec(fireText)?.[1]
    const body = fireText.slice(fireText.indexOf('</system-reminder>\n\n') + '</system-reminder>\n\n'.length)
    // A fire after an interrupted one answers at once, so a restart test
    // sees its status (the interrupted fire itself was the slow one).
    if (body.includes('LOOP_SLOW') && !interrupted) {
      try {
        await sleep(60000, options.signal)
      } catch {
        return
      }
    }
    loopChildRuns += 1
    yield* mockText(`LOOP_STATUS n=${loopChildRuns} prompt=${oneLine(body).slice(0, 40)} prior=${prior ? prior.slice(0, 80) : 'none'} sched=${tools.some(name => name.startsWith('scheduler_')) ? 'yes' : 'no'} interrupted=${interrupted ?? 'no'}`)
    return
  }
  const latest = latestUserText(options)
  const since = resultsSinceUser(options)
  const notice = /^background job (\S+) /.exec(latest)
  if (notice) {
    if (since.length === 0) {
      yield* mockToolCall(`rust-loop-read-${notice[1]}-${Date.now().toString(36)}`, 'job_output', { job_id: notice[1] })
      return
    }
    yield* mockText(`LOOP_WOKE job=${notice[1]} out=${oneLine(resultText(since.at(-1)))}`)
    return
  }
  const loopText = [...texts].reverse().find(text => text.includes('# /loop -- schedule a recurring prompt'))
  const step = [...texts].reverse().find(text => /SCHED_(CALL|LIST|DELETE)/.test(text) || text.includes('# /loop -- schedule a recurring prompt'))
  if (loopText && step === loopText) {
    if (since.length === 0) {
      const input = loopText.slice(loopText.lastIndexOf('## Input\n') + '## Input\n'.length).trim()
      const [interval, ...rest] = input.split(/\s+/)
      yield* mockToolCall(`rust-loop-create-${Date.now().toString(36)}`, 'scheduler_create', { interval, prompt: rest.join(' '), fire_immediately: true })
      return
    }
    yield* mockText(`LOOP_SCHEDULED ${since.at(-1).isError ? 'error' : 'ok'} ${oneLine(resultText(since.at(-1)))}`)
    return
  }
  if (step?.includes('SCHED_CALL ')) {
    if (since.length === 0) {
      const input = JSON.parse(step.slice(step.indexOf('SCHED_CALL ') + 'SCHED_CALL '.length))
      yield* mockToolCall(`rust-sched-call-${Date.now().toString(36)}`, 'scheduler_create', input)
      return
    }
    yield* mockText(`SCHED_RESULT ${since.at(-1).isError ? 'error' : 'ok'} ${oneLine(resultText(since.at(-1)))}`)
    return
  }
  if (step?.includes('SCHED_LIST')) {
    if (since.length === 0) {
      yield* mockToolCall(`rust-sched-list-${Date.now().toString(36)}`, 'scheduler_list', {})
      return
    }
    yield* mockText(`SCHED_LISTED ${oneLine(resultText(since.at(-1)))}`)
    return
  }
  if (step?.includes('SCHED_DELETE')) {
    const wanted = /SCHED_DELETE (\S+)/.exec(step)?.[1] ?? 'first'
    if (wanted === 'first' && since.length === 0) {
      yield* mockToolCall(`rust-sched-list-${Date.now().toString(36)}`, 'scheduler_list', {})
      return
    }
    const listed = wanted === 'first' ? 1 : 0
    if (since.length === listed) {
      const id = wanted === 'first' ? (JSON.parse(resultText(since[0])).tasks[0]?.id ?? 'none') : wanted
      yield* mockToolCall(`rust-sched-delete-${Date.now().toString(36)}`, 'scheduler_delete', { id })
      return
    }
    yield* mockText(`SCHED_DELETED ${oneLine(resultText(since.at(-1)))}`)
    return
  }
  yield* mockText(`SCHED_REPLY ${oneLine(latest)}`)
}

async function * subagentChildTurn(options, kind, signal) {
  const tools = Array.isArray(options.tools) ? options.tools.map(tool => tool.name).sort().join(',') : ''
  const done = toolResults(options)
  if (kind === 'WRITE') {
    if (done.length === 0) {
      const name = `child-${Date.now().toString(36)}.txt`
      yield* mockToolCall(`rust-acp-child-write-${name}`, 'write', { file_path: name, content: 'CHILD_WROTE\n' })
      return
    }
    const last = done.at(-1)
    yield* mockText(`CHILD_DONE tools=${tools} write=${last?.isError ? 'denied' : 'allowed'}:${resultText(last).replaceAll('\n', ' ').slice(0, 160)}`)
    return
  }
  if (kind === 'PWD' || kind === 'EDIT' || kind === 'SECRET') {
    // EDIT reads shared.txt first: dsh refuses to modify an unread file.
    if (kind === 'EDIT' && done.length === 0) {
      yield* mockToolCall('rust-acp-child-edit-read', 'read', { file_path: 'shared.txt' })
      return
    }
    if (done.length === (kind === 'EDIT' ? 1 : 0)) {
      if (kind === 'PWD') yield* mockToolCall('rust-acp-child-pwd', 'bash', { command: 'pwd', description: 'print the directory' })
      else yield* mockToolCall(`rust-acp-child-${kind.toLowerCase()}`, 'write', { file_path: kind === 'EDIT' ? 'shared.txt' : 'secret.txt', content: `CHILD_${kind}_CONTENT\n` })
      return
    }
    const last = done.at(-1)
    yield* mockText(`CHILD_${kind}_DONE ${last?.isError ? 'error' : 'ok'}:${resultText(last).replaceAll('\n', ' ').slice(0, 200)}`)
    return
  }
  if (kind === 'NEST') {
    if (done.length === 0) {
      yield* mockToolCall('rust-acp-child-nest', 'subagent', { description: 'nested', prompt: 'CHILD_ECHO nested', subagent_type: 'general-purpose' })
      return
    }
    yield* mockText(`CHILD_NEST tools=${tools} result=${done.at(-1)?.isError ? 'error' : 'ok'}:${resultText(done.at(-1)).replaceAll('\n', ' ').slice(0, 160)}`)
    return
  }
  // Workflow children (ticket 181). SAY echoes the rest of its prompt line,
  // MODEL reports the route and effort dsh used for this child, FAIL ends
  // with a provider error, WORKFLOW tries to start a workflow itself.
  if (kind === 'SAY') {
    const text = rawUserTexts(options).map(line => /CHILD_SAY ([^\n]*)/.exec(line)?.[1]).find(Boolean) ?? ''
    yield* mockText(`CHILD_SAID ${text}`)
    return
  }
  if (kind === 'MODEL') {
    const model = options.model?.id ?? options.model ?? ''
    yield* mockText(`CHILD_MODEL route=${options.provider}/${model} effort=${options.reasoningEffort ?? 'default'} tools=${tools}`)
    return
  }
  if (kind === 'FAIL') {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MOCK_CHILD_FAIL', message: 'child provider failed' } } }
    return
  }
  if (kind === 'WORKFLOW') {
    if (done.length === 0) {
      yield* mockToolCall('rust-acp-child-workflow', 'workflow', { source: { type: 'script', script: 'let meta = #{ name: "nested", description: "d" };\n1' } })
      return
    }
    yield* mockText(`CHILD_WORKFLOW tools=${tools} result=${done.at(-1)?.isError ? 'error' : 'ok'}:${resultText(done.at(-1)).replaceAll('\n', ' ').slice(0, 300)}`)
    return
  }
  if (kind === 'SLOW') {
    try {
      await sleep(60000, signal)
    } catch {
      return
    }
    yield* mockText('CHILD_SLOW_DONE')
    return
  }
  // Ticket 182. JSON answers `FIRST<<text>>` from its prompt, and
  // `RETRY<<text>>` once it is told its answer missed the output contract
  // (the correction turn of the same child). HOLD waits the given ms while
  // counting the HOLD turns that are live at once in this dsh process, then
  // reports the peak it saw.
  if (kind === 'JSON') {
    const texts = rawUserTexts(options)
    const prompt = texts.find(text => text.includes('CHILD_JSON')) ?? ''
    const retry = texts.some(text => text.includes('did not satisfy the output contract'))
    const pick = (/RETRY<<([\s\S]*?)>>/.exec(prompt) && retry ? /RETRY<<([\s\S]*?)>>/ : /FIRST<<([\s\S]*?)>>/).exec(prompt)
    yield* mockText(pick?.[1] ?? 'no answer')
    return
  }
  if (kind === 'HOLD') {
    const ms = Number(/CHILD_HOLD (\d+)/.exec(rawUserTexts(options).join('\n'))?.[1] ?? '300')
    HOLD.live += 1
    HOLD.peak = Math.max(HOLD.peak, HOLD.live)
    try {
      await sleep(ms, signal)
    } catch {
      return
    } finally {
      HOLD.live -= 1
    }
    yield* mockText(`CHILD_HELD peak=${HOLD.peak}`)
    return
  }
  // Ticket 183. ONCE holds its first turn for a tag (until cancelled, at
  // most 60 s) and answers every later turn with that tag at once, so a
  // resumed workflow can tell a re-run child from a replayed one.
  if (kind === 'ONCE') {
    const tag = /CHILD_ONCE (\S+)/.exec(rawUserTexts(options).join('\n'))?.[1] ?? ''
    if (!ONCE.has(tag)) {
      ONCE.add(tag)
      try {
        await sleep(60000, signal)
      } catch {
        return
      }
    }
    yield* mockText(`CHILD_ONCE_DONE ${tag}`)
    return
  }
  yield* mockText(`CHILD_ECHO tools=${tools}`)
}

async function * subagentsTurn(options) {
  const texts = rawUserTexts(options)
  // Ticket 183: a workflow completion message (the reminder plus the wake
  // prompt) is answered by echoing the reminder.
  // Ticket 184: a slash-launch reminder can follow the notice in the same
  // turn, so every user message since the last assistant reply counts.
  const lastReply = options.messages.findLastIndex(message => message.role === 'assistant')
  const noticeTexts = options.messages.slice(lastReply + 1).filter(message => message.role === 'user').flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
  const reminder = noticeTexts.find(text => text.includes('background workflow run'))
  if (reminder !== undefined) {
    yield* mockText(`PARENT_WORKFLOW_NOTICE\n${reminder.replace(/^<system-reminder>\n/, '').replace(/<\/system-reminder>$/, '').trimEnd()}`)
    return
  }
  // Ticket 184: `WORKFLOW_CONTEXT` echoes the saved-workflow listings and
  // slash-launch reminders the plugin put into this session, oldest first.
  if (latestUserText(options).includes('WORKFLOW_CONTEXT')) {
    const context = texts.filter(text => text.startsWith('<system-reminder>') && (text.includes('The following workflows are available:') || text.includes('No saved workflows are available') || text.includes('The user launched background workflow')))
    yield* mockText(`PARENT_WORKFLOW_CONTEXT\n${context.length === 0 ? 'NONE' : context.join('\n---\n')}`)
    return
  }
  // Workflows (ticket 181): `WORKFLOW_CALL <json>` calls the workflow tool
  // with that input once, then reports the result.
  const lastStep = [...texts].reverse().find(text => text.includes('WORKFLOW_CALL ') || text.includes('SPAWN:'))
  const workflowText = lastStep?.includes('WORKFLOW_CALL ') ? lastStep : undefined
  if (workflowText) {
    const done = turnToolResults(options, 'WORKFLOW_CALL ')
    if (done.length === 0) {
      const input = JSON.parse(workflowText.slice(workflowText.indexOf('WORKFLOW_CALL ') + 'WORKFLOW_CALL '.length))
      yield* mockToolCall(`rust-acp-workflow-${Date.now().toString(36)}`, 'workflow', input)
      return
    }
    const last = done.at(-1)
    yield* mockText(`PARENT_WORKFLOW ${last.isError ? 'error' : 'ok'}: ${resultText(last)}`)
    return
  }
  const childText = texts.find(text => /CHILD_[A-Z]+/.test(text))
  if (childText) {
    yield* subagentChildTurn(options, /CHILD_([A-Z]+)/.exec(childText)[1], options.signal)
    return
  }
  const prompt = [...texts].reverse().find(text => text.includes('SPAWN:')) ?? ''
  const steps = [...prompt.matchAll(/SPAWN:([a-z0-9_-]+):([A-Z]+)((?::bg|:wt)*)/g)]
  const done = turnToolResults(options, 'SPAWN:')
  if (done.length < steps.length) {
    const [, type, kind, flags] = steps[done.length]
    const bg = flags.includes(':bg')
    yield* mockToolCall(`rust-acp-spawn-${done.length}-${Date.now().toString(36)}`, 'subagent', {
      description: `${type} ${kind.toLowerCase()} probe`,
      prompt: `CHILD_${kind}: run the ${kind.toLowerCase()} probe and report.`,
      subagent_type: type,
      ...bg ? { run_in_background: true } : {},
      ...flags.includes(':wt') ? { isolation: 'worktree' } : {},
    })
    return
  }
  // COLLECT reads every started background job once with job_output wait=true.
  const jobs = done.slice(0, steps.length).map(result => /started background subagent job (\S+)/.exec(resultText(result))?.[1]).filter(Boolean)
  if (prompt.includes('COLLECT') && done.length < steps.length + jobs.length) {
    const job = jobs[done.length - steps.length]
    yield* mockToolCall(`rust-acp-collect-${done.length}-${Date.now().toString(36)}`, 'job_output', { job_id: job, wait: true })
    return
  }
  const report = done.map((result, index) => `[${index}:${result.isError ? 'error' : 'ok'}] ${resultText(result).replaceAll('\n', ' ').slice(0, 1200)}`).join(' ')
  yield* mockText(`PARENT_DONE ${report}`)
}


/** Ticket 179 scenarios. Every reply names plan=on|off from the system prompt. */
const INTERACTION_KEYS = ['ASK_ONE', 'ASK_MULTI', 'PLAN_ENTER', 'PLAN_EXIT', 'PLAN_EMPTY', 'PLAN_EDIT_OTHER', 'PLAN_EDIT_FILE', 'TODOS', 'STATUS']

function* interactionTurn(options) {
  // dsh sends the system prompt as system-role messages.
  const system = [
    String(options.system ?? ''),
    ...options.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)),
  ].join('\n')
  const plan = system.includes('You are in plan mode') ? 'on' : 'off'
  const planFile = /Plan file for this session: (\S+?)\. /.exec(system)?.[1] ?? ''
  const texts = rawUserTexts(options)
  const gateFires = texts.filter(text => text.startsWith('You have outstanding todos')).length
  let start = -1
  let prompt = ''
  options.messages.forEach((message, index) => {
    if (message.role !== 'user') return
    const text = message.content.find(block => block.type === 'text' && INTERACTION_KEYS.some(key => block.text.includes(key)))
    if (text) {
      start = index
      prompt = text.text
    }
  })
  const done = options.messages.slice(start + 1).flatMap(message => message.content.filter(block => block.type === 'tool-result'))
  const key = INTERACTION_KEYS.find(name => prompt.includes(name)) ?? 'STATUS'
  const offered = (Array.isArray(options.tools) ? options.tools.map(tool => tool.name) : [])
  const tools = ['ask_user_question', 'enter_plan_mode', 'exit_plan_mode'].map(name => `${name}=${offered.includes(name) ? 'yes' : 'no'}`).join(' ')
  const report = done.map((result, index) => `[${index}:${result.isError ? 'error' : 'ok'}] ${resultText(result).replaceAll('\n', ' ').slice(0, 300)}`).join(' ')
  const id = (suffix) => `rust-acp-${key.toLowerCase()}-${suffix}-${start}`
  const call = {
    ASK_ONE: ['ask_user_question', { questions: [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] }],
    ASK_MULTI: ['ask_user_question', { questions: [
      { id: 'langs', question: 'Which languages?', options: [{ label: 'Rust' }, { label: 'Go' }, { label: 'TS' }], multi_select: true },
      { id: 'name', question: 'Project name?' },
    ] }],
    PLAN_ENTER: ['enter_plan_mode', {}],
    PLAN_EXIT: ['exit_plan_mode', { plan: '# Mock plan\n\n1. first step\n2. second step\n3. verify' }],
    PLAN_EMPTY: ['exit_plan_mode', { plan: '' }],
    PLAN_EDIT_OTHER: ['write', { file_path: 'other.txt', content: 'SHOULD_NOT_EXIST\n' }],
    PLAN_EDIT_FILE: ['write', { file_path: planFile || 'missing-plan-path.md', content: '# Disk plan\n\n1. from disk\n' }],
    TODOS: ['todo_write', { todos: [{ content: 'TODO_A', status: 'in_progress' }, { content: 'TODO_B', status: 'pending' }] }],
  }[key]
  if (call !== undefined && done.length === 0) {
    yield* mockToolCall(id('1'), call[0], call[1])
    return
  }
  yield* mockText(`RUST_INTERACTION ${key} plan=${plan} gate=${gateFires} ${tools} planFile=${planFile || '-'} ${report}`.trim())
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
      const side = String(options.system ?? '').startsWith('codsh side question')
      const assistant = options.messages
        .filter(message => message.role === 'assistant')
        .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
      appendFileSync(trace, `${JSON.stringify({
        purpose: side ? 'btw' : options.purpose ?? 'turn',
        provider: options.provider,
        model: options.model?.id ?? options.model ?? '',
        tools: names,
        user,
        assistant,
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
    if (String(options.system ?? '').startsWith('codsh side question')) {
      const btwDelay = Number(process.env.CODSH_MOCK_BTW_DELAY_MS ?? '0')
      if (btwDelay > 0) {
        try {
          await sleep(btwDelay, options.signal)
        } catch {
          return
        }
      }
      if (process.env.CODSH_MOCK_BTW === 'fail') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MOCK_BTW_FAIL', message: 'side model failed' } } }
        return
      }
      const texts = userTexts(options)
      const question = echoUserText(texts.at(-1) ?? '')
      const main = texts.slice(0, -1).map(echoUserText).join('|')
      yield* mockText(`RUST_BTW_ANSWER q=${question} context=${main}`)
      return
    }
    if (MODE === 'sandbox-session') {
      yield* sandboxSessionTurn(options)
      return
    }
    if (MODE === 'subagents') {
      yield* subagentsTurn(options)
      return
    }
    if (MODE === 'interaction') {
      yield* interactionTurn(options)
      return
    }
    if (MODE === 'background') {
      yield* backgroundTurn(options)
      return
    }
    if (MODE === 'scheduler') {
      yield* schedulerTurn(options)
      return
    }
    if (MODE === 'monitor') {
      yield* monitorTurn(options)
      return
    }
    if (MODE === 'goal') {
      yield* goalTurn(options)
      return
    }
    if (MODE === 'steer-probe') {
      const done = toolResults(options)
      if (done.length < 3) {
        yield* mockToolCall(`rust-acp-steer-${done.length + 1}-${userTurns(options)}`, 'read', { file_path: 'note.txt' })
        return
      }
      yield* mockText(`RUST_ACP_STEER_DONE calls=${done.length} latest=${echoUserText(latestUserText(options))}`)
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
    if (MODE === 'file-edit' || MODE === 'file-write' || MODE === 'file-missing' || MODE === 'file-error' || MODE === 'bash-rm' || MODE === 'bash-timeout-rm' || MODE === 'bash-nice-rm' || MODE === 'bash-brace-rm' || MODE === 'bash-ansi-c-rm' || MODE === 'bash-quoted-rm' || MODE === 'bash-eval-rm' || MODE === 'bash-path-rm' || MODE === 'bash-sudo-rm' || MODE === 'bash-nohup-rm' || MODE === 'bash-xargs-rm' || MODE === 'bash-sort-prefix' || MODE === 'bash-sort-output' || MODE === 'bash-git-branch' || MODE === 'bash-git-upstream' || MODE === 'bash-git-track' || MODE === 'bash-time-rm' || MODE === 'bash-exec-rm' || MODE === 'bash-builtin-rm' || MODE === 'bash-shell-option-rm' || MODE === 'bash-expand-rm' || MODE === 'bash-positional-rm' || MODE === 'bash-glob-rm' || MODE === 'bash-git-long-track' || MODE === 'bash-git-cat' || MODE === 'bash-git' || MODE === 'file-secret' || MODE === 'search-needle' || MODE === 'search-empty' || MODE === 'search-denied' || MODE === 'search-continue' || MODE === 'search-binary' || MODE === 'search-stale' || MODE === 'search-lsp' || MODE === 'shell-echo' || MODE === 'shell-fail' || MODE === 'shell-long' || MODE === 'shell-deny' || MODE === 'shell-env' || MODE === 'shell-count') {
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
      // Only this prompt's results count, so each turn of one session makes
      // its own bash call. Hook notes are user text marked with ␞hook␞.
      const isPrompt = message => message.role === 'user' && message.content.some(block => block.type === 'text'
        && !block.text.startsWith('\u241ehook\u241e') && !/Current runtime context|This snapshot supersedes/i.test(block.text))
      const done = toolResults({ messages: options.messages.slice(options.messages.findLastIndex(isPrompt) + 1) })
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
      yield* mockToolCall(`rust-acp-hook-bash-${toolResults(options).length + 1}`, 'bash', { command: 'printf HOOK_SIDE_EFFECT', description: 'hook fixture' })
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
    if (MODE === 'mcp') {
      // The prompt names the call: `MCP_CALL <tool> <json args>`, repeated
      // with ` THEN ` for a sequence. `MCP_TOOLS` lists the MCP-related tool
      // names dsh offered on this request. Hook notes arrive as later user
      // text, so the prompt is the latest user message naming MCP_.
      const isPrompt = message => message.role === 'user'
        && message.content.some(block => block.type === 'text' && /MCP_(CALL|TOOLS)/.test(block.text))
      const lastPrompt = options.messages.findLastIndex(isPrompt)
      const prompt = lastPrompt < 0 ? '' : options.messages[lastPrompt].content
        .filter(block => block.type === 'text').map(block => block.text).join('\n')
      const offered = (Array.isArray(options.tools) ? options.tools.map(tool => tool.name) : [])
        .filter(name => name.startsWith('mcp__') || name === 'search_tool' || name === 'use_tool')
      if (prompt.includes('MCP_TOOLS')) {
        yield* mockText(`RUST_ACP_MCP_TOOLS ${offered.sort().join(',') || '(none)'}`)
        return
      }
      const steps = [...prompt.matchAll(/MCP_CALL (\S+) (\{.*?\})(?= THEN |$)/g)].map(match => [match[1], JSON.parse(match[2])])
      // Only this prompt's results count; earlier turns in the session had their own.
      const done = toolResults({ messages: options.messages.slice(lastPrompt + 1) })
      const turnDone = done
      if (steps.length > 0 && done.length < steps.length) {
        const [name, args] = steps[done.length]
        yield* mockToolCall(`rust-acp-mcp-${done.length + 1}`, name, args)
        return
      }
      const summary = turnDone.map(result => `${result.isError === true ? 'ERR' : 'OK'}:${resultText(result).slice(0, 400)}`).join(' | ')
      yield* mockText(`RUST_ACP_MCP_DONE ${summary || '(no calls)'}`)
      return
    }
    if (MODE === 'ship-wayfinder') {
      // The legacy ship-wayfinder scenario (e2e/fixtures/mock-llm.src.ts)
      // driven by the Ship extension's /ship contract (ticket 195). The model
      // follows the injected text: a typed idea asks the route question and
      // writes the ledger; a bare /ship reads the unfinished spec and asks
      // before resuming, as the BOOT contract says.
      const isShip = message => message.role === 'user'
        && message.content.some(block => block.type === 'text' && block.text.includes('Throughout /ship'))
      const at = options.messages.findLastIndex(isShip)
      const prompt = at < 0 ? '' : options.messages[at].content
        .filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (!prompt.includes('This turn is wayfinder only')) {
        yield* mockText(`SHIP_NOT_WAYFINDER ${echoUserText(latestUserText(options)).slice(0, 200)}`)
        return
      }
      const idea = (/Arguments:([\s\S]*?)\n\nThroughout \/ship/.exec(prompt)?.[1] ?? '').trim()
      const done = toolResults({ messages: options.messages.slice(at + 1) })
      const ledger = join(process.cwd(), 'docs', 'specs', 'wayfinder-e2e.md')
      const last = done.at(-1)
      const answer = last === undefined ? '' : resultText(last)
      if (idea === '') {
        if (done.length === 0) {
          if (!existsSync(ledger)) {
            yield* mockText('WAYFINDER_NEEDS_IDEA')
            return
          }
          yield* mockToolCall(`ship-resume-read-${Date.now().toString(36)}`, 'read', { file_path: ledger })
          return
        }
        const read = resultText(done[0])
        const lines = read.split('\n').map(line => line.replace(/^\s*\d+[\t→|:]\s?/, ''))
        const heading = lines.findIndex(line => line.trim() === '## Original Requirement')
        const recovered = heading < 0 ? 'missing' : (lines.slice(heading + 1).find(line => line.trim() !== '') ?? 'missing').trim()
        if (done.length === 1) {
          yield* mockToolCall(`ship-resume-ask-${Date.now().toString(36)}`, 'ask_user_question', { questions: [{
            id: 'resume', header: 'ship · wayfinder', question: 'Resume the pending research?',
            options: [{ label: 'Continue', description: 'Recommended.' }, { label: 'Stop' }],
          }] })
          return
        }
        if (last?.isError === true) {
          yield* mockText(`WAYFINDER_PAUSED original=${recovered}`)
          return
        }
        yield* mockText(`${answer.includes('Continue') ? 'WAYFINDER_RESUMED' : 'WAYFINDER_STOPPED'} original=${recovered}`)
        return
      }
      const pending = idea.includes('PENDING_WAYFINDER')
      if (done.length === 0) {
        yield* mockToolCall(`ship-wayfinder-question-${Date.now().toString(36)}`, 'ask_user_question', { questions: [{
          id: 'route', header: 'ship · wayfinder', question: 'Is the route clear?',
          options: [{ label: 'Continue', description: 'Recommended.' }, { label: 'Stop' }],
        }] })
        return
      }
      if (done.length === 1) {
        if (last?.isError === true) {
          yield* mockText(`SHIP_FIXTURE_ERROR ${answer.slice(0, 200)}`)
          return
        }
        if (!answer.includes('Continue')) {
          yield* mockText('WAYFINDER_STOPPED')
          return
        }
        const content = [
          '# Wayfinder fixture', '', `Status: ${pending ? 'wayfinding' : 'grilling'}`, '',
          '## Original Requirement', '', idea, '',
          '## Main Track', '', `**Idea.** ${idea}`, '**Track-1.** Keep the original wording.', '',
          '## Wayfinder', '', pending ? 'Pending research remains.' : 'Small route confirmed; no map needed.', '',
        ].join('\n')
        yield* mockToolCall(`ship-wayfinder-ledger-${Date.now().toString(36)}`, 'write', { file_path: ledger, content })
        return
      }
      if (last?.isError === true) {
        yield* mockText(`SHIP_LEDGER_REFUSED ${answer.replaceAll('\n', ' ').slice(0, 400)}`)
        return
      }
      yield* mockText(`${pending ? 'WAYFINDER_WAITING' : 'WAYFINDER_READY'} original=${idea}`)
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
    const markers = ['HOME_RULE', 'ROOT_RULE', 'DEEP_RULE', 'DIR_RULE_A', 'EXTRA_RULE', 'NESTED_RULE', 'IGNORED_LOCAL', 'UNTRUSTED_PROJECT', 'COMMIT_BODY', 'SHIP_NOTE_BODY', 'REVIEWER_BODY', 'SKILL_ADDED', 'SKILL_REMOVED', 'PLUGIN_RULE_BODY', 'PLUGIN_SKILL_BODY', 'PLUGIN_COMMAND_BODY', 'PLUGIN_AGENT_BODY', 'PLUGIN_V2_BODY']
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
