/**
 * Keyless `cli-mock` adapter for the end-to-end suites: one real `write` call,
 * then a final answer quoting the tool's result. Plain JavaScript because the
 * installed dsh runs under plain Node, which cannot import TypeScript.
 *
 * `write` rather than `bash` because the write tool returns a diff result
 * view, which is what makes the run exercise the terminal's diff card instead
 * of its generic one.
 * @module codsh/e2e/fixtures/mock-llm
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const OFF = ReasoningEffortId('off')
const HIGH = ReasoningEffortId('high')
const MOCK_MODE = process.env.DSH_CODE_CLI_MOCK_TOOL ?? ''
const AUTO_VISION = MOCK_MODE.startsWith('auto-vision')

/** File the mocked call creates, relative to the launched process cwd. */
const TARGET = 'note.txt'

/** Content the mocked call writes. */
const CONTENT = 'CODE_CLI_ROUND_TRIP\n'

/** A Markdown answer exercising every construct the surface renders. */
const MARKDOWN = [
  '# CODE_CLI_HEADING',
  '',
  'Prose with **bold**, *em*, `inline_code`, and a [link](https://x.dev).',
  'An identifier like some_helper_name must survive intact.',
  '',
  // The shapes real models produce constantly: emphasis wrapping code, and a
  // table whose Chinese cells are far wider than any terminal.
  '- **`screen.ts`**: the viewport module',
  '- second bullet',
  '- third bullet keeps the answer long',
  '- fourth bullet keeps the answer long',
  '- fifth bullet keeps the answer long',
  '- sixth bullet keeps the answer long',
  '- seventh bullet keeps the answer long',
  '- eighth bullet: past the fold threshold at any test width',
  '',
  '| 维度 | 内容 |',
  '|---|---|',
  `| 一句话 | ${'一个很长的中文单元格内容,用来强制表格在任何终端宽度下都必须在单元格内部换行。'.repeat(3)} |`,
  '| 命令 | `codsh` | | |',
  '',
  '> a quoted line',
  '',
  '```ts',
  'const answer = "text" // a comment',
  '```',
  '',
  'CODE_CLI_CALL_STREAM_DONE',
].join('\n')

/**
 * Cut text into small fragments that do not respect line ends.
 * @param {string} text - the whole answer.
 * @returns {string[]} fragments whose concatenation is `text`.
 */
function splitDeltas(text) {
  const deltas = []
  for (let at = 0; at < text.length; at += 7) deltas.push(text.slice(at, at + 7))
  return deltas
}

/** How long the interruptible scenario keeps the turn busy. */
const SLOW_SECONDS = 30

/** Reasoning text streamed before the `reasoning` mode's answer. */
const THINKING = 'CODE_CLI_THINKING about the request\nweighing the options carefully'

/** The `reasoning` mode's visible answer, after the thinking ends. */
const AFTERTHOUGHT = 'CODE_CLI_ANSWER after thinking'

/** A tall write: enough diff lines that the terminal clips the card body. */
const TALL_CONTENT = `${Array.from({ length: 45 }, (_, index) => `CODE_CLI_TALL_${index}`).join('\n')}\n`

/** Call arguments per `DSH_CODE_CLI_MOCK_TOOL` mode. */
const ARGUMENTS = {
  write: { file_path: join(process.cwd(), TARGET), content: CONTENT },
  bash: {
    command: `printf ${CONTENT.trim()}`,
    description: 'Prove the terminal round trip.',
    sandbox_permissions: 'danger-full-access',
    justification: 'The end-to-end test drives the approval prompt.',
  },
  slow: {
    command: `sleep ${SLOW_SECONDS}`,
    description: 'Hold the turn open.',
    timeoutMs: SLOW_SECONDS * 2000,
  },
  tall: { file_path: join(process.cwd(), TARGET), content: TALL_CONTENT },
  // One item per lifecycle state, so the readout has a count to report, an
  // item in flight to name, and a finished one to dim.
  todo: {
    todos: [
      { content: 'read the code', status: 'completed' },
      { content: 'write the fix', status: 'in_progress' },
      { content: 'run the tests', status: 'pending' },
    ],
  },
}

/** Emits one `write` call, then a closing message naming the result. */
class CodeCliMockAdapter extends LlmAdapter {
  listModels(provider) {
    // Keep the advisory catalog text-only even in vision mode. Exact model
    // resolution below is the capability source; this pins the startup/stale
    // catalog case instead of letting cached discovery decide correctness.
    return Promise.resolve([
      { provider, id: 'cli-mock', name: 'CLI Mock', inputModalities: ['text'] },
      { provider, id: 'cli-mock-pro', name: 'CLI Mock Pro', inputModalities: ['text'] },
    ])
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: MOCK_MODE === 'vision'
        || (AUTO_VISION && model === 'deepseek-v4-flash-vision-exp')
        ? ['text', 'image']
        : ['text'],
      reasoning: {
        efforts: [{ id: OFF, name: 'Off' }, { id: HIGH, name: 'High' }],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options) {
    if (MOCK_MODE === 'sticky') {
      const texts = options.messages.flatMap(message =>
        message.content.filter(block => block.type === 'text').map(block => block.text))
      const turn = texts.some(text => text.includes('second sticky prompt')) ? 'SECOND' : 'FIRST'
      const rows = Array.from({ length: 45 }, (_, index) => `STICKY_${turn}_${index}`)
      if (turn === 'SECOND') rows.push('STICKY_SECOND_DONE')
      const reply = rows.join('\n')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const delta of splitDeltas(reply)) {
        yield { type: 'text-delta', index: 0, text: delta }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: turn === 'SECOND' ? 46 : 45 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (AUTO_VISION) {
      if (options.model === 'deepseek-v4-flash-vision-exp') {
        if (MOCK_MODE === 'auto-vision-fail') {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'VISION_FAILED', message: 'fixture refused image' } } }
          return
        }
        if (MOCK_MODE === 'auto-vision-slow') {
          await Promise.race([
            new Promise(resolve => setTimeout(resolve, 2_000)),
            new Promise(resolve => options.signal?.addEventListener('abort', resolve, { once: true })),
          ])
          if (options.signal?.aborted === true) {
            yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'caller stopped' } } }
            return
          }
        }
        const images = options.messages.flatMap(message =>
          message.content.filter(block => block.type === 'image').map(block => block.attachment))
        const names = images.map(image => image.name ?? 'unnamed').join(',')
        const reply = `E2E_AUTO_DESCRIPTION img=${images.length} name=${names}: a single red pixel`
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const texts = options.messages.flatMap(message =>
        message.content.filter(block => block.type === 'text').map(block => block.text))
      const pasted = texts.filter(text => text.startsWith('<pasted-image '))
      const savedAt = pasted[0] === undefined ? undefined : /path="([^"]*)"/.exec(pasted[0])?.[1]
      const described = pasted.length > 0 && pasted.every(text => text.includes('<description>')) ? 'yes' : 'no'
      const bridge = pasted.some(text => text.includes('E2E_AUTO_DESCRIPTION'))
        ? 'auto'
        : pasted.some(text => text.includes('E2E_SIDECAR_DESCRIPTION')) ? 'sidecar' : 'none'
      const file = savedAt !== undefined && existsSync(savedAt) ? 'yes' : 'no'
      const order = pasted.map(text => /name=Pasted image #(\d+)/.exec(text)?.[1] ?? '?').join(',')
      const reply = `CODE_CLI_AUTO_VISION model=${options.model} described=${described} bridge=${bridge} file=${file} order=${order}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (process.env.DSH_CODE_CLI_MOCK_TOOL === 'vision') {
      // Reports the image blocks the request actually carried: id, size, type.
      // This is the proof the first-class path works — bytes were admitted to
      // the durable store and rode the message as blocks, not as text.
      const images = options.messages.flatMap(message =>
        message.content.filter(block => block.type === 'image').map(block => block.attachment))
      const shapes = images.map(image => `${image.width}x${image.height}:${image.mediaType}`).join(' ')
      const reply = `CODE_CLI_VISION img=${images.length}${shapes === '' ? '' : ` ${shapes}`}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (process.env.DSH_CODE_CLI_MOCK_TOOL === 'reasoning') {
      // Reasoning first, text second — the order the real provider emits.
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      for (const delta of splitDeltas(THINKING)) {
        yield { type: 'reasoning-delta', index: 0, text: delta }
      }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: THINKING } }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      for (const delta of splitDeltas(AFTERTHOUGHT)) {
        yield { type: 'text-delta', index: 1, text: delta }
      }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: AFTERTHOUGHT } }
      yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (process.env.DSH_CODE_CLI_MOCK_TOOL === 'echo') {
      // Reports what the request actually carried, which is how a test proves
      // an injected `!` outcome arrived and a `/clear` really isolated context.
      const texts = options.messages.flatMap(message =>
        message.content.filter(block => block.type === 'text').map(block => block.text))
      const bang = texts.some(text => text.includes('<bash-input>')) ? 'yes' : 'no'
      const remembered = texts.some(text => text.includes('DELTA_ONE')) ? 'yes' : 'no'
      // Presence, not position: injected plugin context (instructions, time)
      // can follow the person's message in the request, so "the last text" is
      // not theirs to claim.
      const marker = texts.some(text => text.includes('CODE_CLI_CUSTOM_MARKER')) ? 'yes' : 'no'
      // /ship dispatched, expanded the typed idea into the template, and the
      // template still names the workflow's tools.
      const ship = texts.some(text => text.includes('SHIP_E2E_IDEA') && text.includes('ask_user_question') && text.includes('ralph')) ? 'yes' : 'no'
      // A pasted image on a text-only route arrives as a <pasted-image> text
      // block: report the saved path and whether a description came along, so
      // the fallback and sidecar tests can read the proof off the transcript.
      const pasted = texts.find(text => text.startsWith('<pasted-image '))
      const savedAt = pasted === undefined ? undefined : /path="([^"]*)"/.exec(pasted)?.[1]
      // Existence is checked HERE, while the per-test home still exists: the
      // harness removes it before a test's own assertions could look.
      const image = pasted === undefined
        ? 'image=no'
        : `image=${savedAt ?? '?'} file=${savedAt !== undefined && existsSync(savedAt) ? 'yes' : 'no'} described=${pasted.includes('<description>') ? 'yes' : 'no'}`
      const reply = `CODE_CLI_CTX bang=${bang} remembered=${remembered} marker=${marker} ship=${ship} ${image}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (process.env.DSH_CODE_CLI_MOCK_TOOL === 'markdown') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      // Split mid-line as a real provider does, so the surface has to accumulate
      // deltas rather than receiving whole lines.
      for (const delta of splitDeltas(MARKDOWN)) {
        yield { type: 'text-delta', index: 0, text: delta }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: MARKDOWN } }
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 9 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const toolResult = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (toolResult === undefined) {
      // `write` inside the workspace runs under the default workspace-write
      // preset with nothing to decide. Approval is raised by a sandbox
      // ESCALATION, so `bash` asks for a wider mode: that widening request is
      // what reaches `ctx.approval` and therefore the keyboard. `slow` occupies
      // the turn long enough for a person to interrupt it.
      const mode = process.env.DSH_CODE_CLI_MOCK_TOOL ?? 'write'
      const tool = mode === 'write' || mode === 'tall' ? 'write' : mode === 'todo' ? 'todo_write' : 'bash'
      const args = JSON.stringify(ARGUMENTS[mode] ?? ARGUMENTS.write)
      const id = CallId(`code-cli-${tool}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const failed = toolResult.isError === true
    // Naming the serving model is what lets a test prove a /model switch
    // reached the request rather than only the status display.
    const reply = failed ? 'CODE_CLI_CALL_DENIED' : `CODE_CLI_CALL_OK via ${options.model}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Stable Cordis plugin name. */
export const name = 'code-cli-mock-llm'

/** Service required before the adapter can register. */
export const inject = ['llm']

/**
 * Register the keyless `cli-mock` adapter.
 * @param ctx - plugin context carrying the LLM registry.
 */
export function apply(ctx) {
  const providers = AUTO_VISION
    ? ['cli-mock', 'deepseek-official']
    : ['cli-mock']
  ctx.llm.registerAdapter(providers, new CodeCliMockAdapter())
}
