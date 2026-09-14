/**
 * Keyless `cli-mock` adapter for the terminal-surface end-to-end test: one real
 * `write` call, then a final answer quoting the tool's result.
 *
 * `write` rather than `bash` because the write tool returns a
 * {@link DiffResultView}, which is what makes the run exercise the terminal's
 * diff card instead of its generic one.
 * @module apps/cli/tests/fixtures/code-cli-mock-llm
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

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
  // Inline HTML where a model reaches for it instead of Markdown.
  'Gain: <font color="green">CODE_CLI_GAIN</font> &amp; <b>held</b>',
  '',
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
 * @param text - the whole answer.
 * @returns fragments whose concatenation is `text`.
 */
function splitDeltas(text: string): string[] {
  const deltas: string[] = []
  for (let at = 0; at < text.length; at += 7) deltas.push(text.slice(at, at + 7))
  return deltas
}

/** Lines far wider than any test terminal, for the streaming repaint stress. */
const WIDE_LINES = [
  "const WIDE = source.replace(/<script[\\s\\S]*?<\\/script>/g, '').replace(/<style[\\s\\S]*?<\\/style>/g, '') + SUFFIX_MARKER_ONE",
  "const BASE = 'http://localhost:4173/some/deep/path?query=1&other=2#fragment' + '/' + segment + '/' + tail",
  // Short and alone on its line: a marker inside a wide line is cut in half by
  // the wrap, and a test cannot wait for a string the screen never holds.
  'WIDEDONE',
]

/**
 * A workflow the end-to-end suite can actually run: two rounds through the real
 * engine, with each child answering as text so nothing recurses.
 *
 * The child is told apart by the marker its prompt carries — a child has no
 * tool result in its history either, so without one it would emit this very
 * tool call again.
 */
const WORKFLOW_SCRIPT = [
  "phase('Rounds')",
  'for (let round = 1; round <= 2; round += 1) {',
  "  await agent('WORKFLOW_CHILD round ' + round, { label: 'E2E round ' + round, phase: 'Rounds' })",
  '}',
  "return 'WORKFLOW_RUN_DONE'",
].join('\n')

/** How long the interruptible scenario keeps the turn busy. */
const SLOW_SECONDS = 30

/** Reasoning text streamed before the `reasoning` mode's answer. */
const THINKING = 'CODE_CLI_THINKING about the request\nweighing the options carefully'

/** The `reasoning` mode's visible answer, after the thinking ends. */
const AFTERTHOUGHT = 'CODE_CLI_ANSWER after thinking'

/** The `reason-write` mode's thought before its write call. */
const FIRST_THOUGHT = 'CODE_CLI_FIRST_THOUGHT about the note\nplanning the write step'

/** The `reason-write` mode's thought after the write landed. */
const SECOND_THOUGHT = 'CODE_CLI_SECOND_THOUGHT after the write\nchecking what the write did'

/** The `reason-write` mode's answer, closing the turn. */
const REASONED_ANSWER = 'CODE_CLI_REASONED_ANSWER after the write'

/** The `reasoning-slow` mode's thought: one line a beat, long enough to interrupt. */
const SLOW_THOUGHT = Array.from({ length: 12 }, (_, index) => `CODE_CLI_SLOW_THINK_${index}`)

/** The `reasoning-slow` mode's answer, if the thought is allowed to finish. */
const SLOW_ANSWER = 'CODE_CLI_SLOW_ANSWER after thinking'

/**
 * How many prompts the person has sent, so a reply can say which turn it
 * answers: a test that waits for the same words twice would otherwise match
 * a repaint of the first answer.
 * @param options - the request.
 * @returns the count of real user messages, plugin context excluded.
 */
function userTurns(options: GenerateOptions): number {
  return options.messages.filter(message =>
    message.role === 'user' && message.content.some(block => block.type === 'text' && !block.text.startsWith('<'))).length
}

/** A tall write: enough diff lines that the terminal clips the card body. */
const TALL_CONTENT = `${Array.from({ length: 45 }, (_, index) => `CODE_CLI_TALL_${index}`).join('\n')}\n`

/** A spec whose `## Plan` gives the surface a ticket count to report. */
const SPEC_CONTENT = [
  '# Demo spec',
  '',
  'Status: landing',
  '',
  '## Plan',
  '',
  '- [x] SHIP_TICKET_ONE already landed',
  '- [ ] SHIP_TICKET_TWO in flight',
  '- [ ] SHIP_TICKET_THREE waiting',
  '',
  '## Acceptance criteria',
  '',
  '1. `pnpm test` passes',
  '',
].join('\n')

/** A command that is itself several lines, the shape a heredoc gives. */
const HEREDOC_COMMAND = [
  "python3 - <<'EOF'",
  'import re',
  "p='docs/specs/2026-09-02-impact.md'",
  's=open(p).read()',
  "open(p,'w').write(s)",
  "print('patched')",
  'EOF',
].join('\n')

/** Call arguments per `DSH_CODE_CLI_MOCK_TOOL` mode. */
const ARGUMENTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  questions: { questions: [
    { id: 'storage', header: 'ship · grill', question: 'Storage?', options: [{ label: 'SQLite', description: 'Recommended for local use.' }, { label: 'Postgres' }] },
    { id: 'features', header: 'ship · grill', question: 'Features?', multi_select: true, options: [{ label: 'Tests' }, { label: 'Docs' }] },
    { id: 'path', header: 'ship · grill', question: 'Path?', options: [{ label: 'docs/' }, { label: 'Type a path' }, { label: 'src/' }] },
  ] },
  write: { file_path: join(process.cwd(), TARGET), content: CONTENT },
  bash: {
    command: `printf ${CONTENT.trim()}`,
    description: 'Prove the terminal round trip.',
    sandbox_permissions: 'danger-full-access',
    justification: 'The end-to-end test drives the approval prompt.',
  },
  // A command with newlines in it: every row region cuts to fit, and a cut
  // that keeps a newline breaks the frame it was cut for.
  heredoc: {
    command: HEREDOC_COMMAND,
    description: 'Carry newlines into a one-row region.',
    sandbox_permissions: 'danger-full-access',
    justification: 'The end-to-end test drives the approval prompt.',
  },
  // A command that prints and then fails: the card has a body to withhold
  // and a non-zero exit to name on its one row. What it prints is spelled so
  // it appears nowhere in the command itself, which the row shows.
  fail: {
    command: "sh -c 'printf CODE_CLI_%s_PRINTED FAIL; exit 3'",
    description: 'Fail on purpose.',
    sandbox_permissions: 'danger-full-access',
    justification: 'The end-to-end test drives a failed call.',
  },
  slow: {
    command: `sleep ${SLOW_SECONDS}`,
    description: 'Hold the turn open.',
    timeoutMs: SLOW_SECONDS * 2000,
  },
  // Just long enough for a test to inject a message into the running turn
  // before the tool settles, and short enough that the suite does not stall.
  steer: {
    command: 'sleep 3',
    description: 'Hold the turn open briefly.',
    timeoutMs: 20_000,
  },
  tall: { file_path: join(process.cwd(), TARGET), content: TALL_CONTENT },
  spec: { file_path: join(process.cwd(), 'plan.md'), content: SPEC_CONTENT },
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

/** Collect plain text blocks from one mocked request. */
function textBlocks(options: GenerateOptions): string[] {
  return options.messages.flatMap(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text))
}

/**
 * The original requirement the *prompt* still carries — never the live spec
 * file, so a rewrite on disk cannot fake recovery.
 */
function promptIdea(texts: readonly string[]): string {
  for (const text of texts) {
    const tagged = /<idea>\s*([\s\S]*?)\s*<\/idea>/u.exec(text)
    const idea = tagged?.[1]?.trim() ?? ''
    if (idea !== '') return idea
  }
  for (const text of texts) {
    const section = /^## Original Requirement\n+([\s\S]*?)(?=\n## |\nBound spec:|\nThroughout \/ship|\n$)/mu.exec(text)
    const body = section?.[1]?.trim() ?? ''
    if (body !== '') return body.split('\n')[0]!.trim()
  }
  return ''
}

/** Fresh-context policy token from the current `/ship` contract. */
function hasSubagentPolicy(texts: readonly string[]): boolean {
  return texts.some(text => text.includes('Prefer `subagent`, not `subagent_fork`'))
}

/** Body of a `## Heading` section, or undefined when the heading is absent. */
function sectionBody(markdown: string, heading: string): string | undefined {
  const re = new RegExp(`^## ${heading}\\s*$`, 'miu')
  const lines = markdown.split(/\r\n|[\r\n]/u)
  const body: string[] = []
  let inside = false
  for (const line of lines) {
    if (re.test(line)) {
      inside = true
      continue
    }
    if (inside && /^#{1,6}\s+/u.test(line)) break
    if (inside) body.push(line)
  }
  if (!inside) return undefined
  const text = body.join('\n').trim()
  return text === '' ? undefined : text
}

/** Ledger the wayfinder fixture writes: original wording is stored verbatim. */
function wayfinderLedger(idea: string, pending: boolean): string {
  return [
    '# Wayfinder fixture',
    '',
    `Status: ${pending ? 'wayfinding' : 'grilling'}`,
    '',
    '## Original Requirement',
    '',
    idea,
    '',
    '## Main Track',
    '',
    `**Idea.** ${idea}`,
    '**Track-1.** Keep the original wording.',
    '',
    '## Wayfinder',
    '',
    pending ? 'Pending research remains.' : 'Small route confirmed; no map needed.',
    '',
  ].join('\n')
}

/** Emits one `write` call, then a closing message naming the result. */
class CodeCliMockAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // Keep the advisory catalog text-only even in vision mode. Exact model
    // resolution below is the capability source; this pins the startup/stale
    // catalog case instead of letting cached discovery decide correctness.
    return Promise.resolve([
      { provider, id: 'cli-mock', name: 'CLI Mock', inputModalities: ['text'] },
      { provider, id: 'cli-mock-pro', name: 'CLI Mock Pro', inputModalities: ['text'] },
    ])
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      ...MOCK_MODE === 'context' ? { context: { contextWindow: model === 'cli-mock-pro' ? 64_000 : 128_000 } } : {},
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

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (MOCK_MODE === 'ship-landing') {
      const texts = textBlocks(options)
      const prompt = texts.findLast(text => text.includes('Throughout /ship')) ?? ''
      const active = /^Active Ticket: Ticket (\d+):/mu.exec(prompt)?.[1]
      const result = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
      const ledger = join(process.cwd(), 'docs', 'specs', 'landing-e2e.md')
      if (result === undefined && existsSync(ledger)) {
        const id = ToolCallId('landing-read')
        const args = JSON.stringify({ file_path: ledger })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'read', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (result?.toolCallId === 'landing-read' && result.isError !== true) {
        const current = readFileSync(ledger, 'utf8')
        const verification = prompt.includes('This turn is final verification only')
        const drift = current.includes('DRIFT_AFTER_FIRST') && active === '1'
        const content = active !== undefined
          ? current.replace(`- [ ] Ticket ${active}:`, `- [x] Ticket ${active}:`).replace(drift ? 'Track-1: Keep offline exports.' : 'NEVER_MATCH', 'Track-1: Upload exports.')
          : verification ? `${current.replace('Status: landing', 'Status: shipped')}\n## Verification\n\n- ACC-001: \`pnpm test\` exit 0\n` : current
        const id = ToolCallId(`landing-${active ?? 'verify'}`)
        const args = JSON.stringify({ file_path: ledger, content })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const reply = result?.isError ? 'SHIP_LANDING_ERROR'
        : active === undefined ? 'SHIP_VERIFICATION_DONE' : `SHIP_TICKET_${active}_DONE`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (MOCK_MODE === 'ship-wayfinder') {
      const texts = textBlocks(options)
      const prompt = texts.findLast(text =>
        text.includes('This turn is wayfinder only')
        || text.includes('This turn is grill only')
        || text.includes('This turn is to-spec (gate 1) only')
        || text.includes('This turn is tickets and baseline (gate 2) only')
        || text.includes('This turn is only the phase that Status names')) ?? ''
      const wayfinder = prompt.includes('This turn is wayfinder only')
      const later = !wayfinder && (
        prompt.includes('This turn is grill only')
        || prompt.includes('This turn is to-spec (gate 1) only')
        || prompt.includes('This turn is tickets and baseline (gate 2) only')
        || prompt.includes('Strict Red-First Execution')
        || prompt.includes('dual-layer DoD'))
      const ledger = join(process.cwd(), 'docs', 'specs', 'wayfinder-e2e.md')
      const idea = promptIdea([prompt])
      const pending = idea.includes('PENDING_WAYFINDER') || texts.some(text => text.includes('PENDING_WAYFINDER'))
      const result = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
      const policy = hasSubagentPolicy(texts)
      const recovered = idea !== ''
      let call: { id: string; name: string; args: unknown } | undefined
      let reply = ''
      if (wayfinder && result === undefined && existsSync(ledger)) {
        reply = `WAYFINDER_RESUMED original=${recovered ? idea : 'missing'} policy=${policy ? 'yes' : 'no'}`
      } else if (result === undefined) {
        call = { id: 'ship-wayfinder-question', name: 'ask_user_question', args: { questions: [{
          id: 'route', header: wayfinder ? 'ship · wayfinder' : 'ship · grill',
          question: wayfinder ? 'Is the route clear?' : 'Confirm the grill handoff?',
          options: [{ label: 'Continue', description: 'Recommended.' }, { label: 'Stop' }],
        }] } }
      } else if (result.isError === true) {
        reply = 'SHIP_FIXTURE_ERROR'
      } else if (later) {
        reply = `GRILL_CONTRACT_OK original=${recovered ? idea : 'missing'} policy=${policy ? 'yes' : 'no'}`
      } else if (result.toolCallId === 'ship-wayfinder-question') {
        const answer = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        if (!answer.includes('Continue')) reply = 'WAYFINDER_STOPPED'
        else call = { id: 'ship-wayfinder-ledger', name: 'write', args: {
          file_path: ledger,
          content: wayfinderLedger(idea === '' ? (pending ? 'PENDING_WAYFINDER' : 'SMALL_WAYFINDER') : idea, pending),
        } }
      } else {
        reply = pending
          ? `WAYFINDER_WAITING original=${recovered ? idea : 'missing'} policy=${policy ? 'yes' : 'no'}`
          : `WAYFINDER_READY original=${recovered ? idea : 'missing'} policy=${policy ? 'yes' : 'no'}`
      }
      if (call !== undefined) {
        const id = ToolCallId(call.id)
        const args = JSON.stringify(call.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (MOCK_MODE === 'ship-delegate') {
      // Parent calls the real `subagent` tool; the child is told apart by the
      // brief it actually received — never by pretending the parent proved it.
      const texts = textBlocks(options)
      if (!texts.some(text => text.includes('Throughout /ship') || text.includes('SHIP_DELEGATE_CHILD'))) {
        const reply = 'SHIP_PARENT_READY'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const child = texts.some(text => text.includes('SHIP_DELEGATE_CHILD'))
      const result = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
      if (child) {
        const worked = result
        if (worked === undefined) {
          const brief = texts.find(text => text.includes('SHIP_DELEGATE_CHILD')) ?? ''
          const original = /## Original Requirement\n+([\s\S]*?)(?=\n## |\n$)/mu.exec(brief)?.[1]?.trim() ?? ''
          const track = /## Main Track\n+([\s\S]*?)(?=\n## |\n$)/mu.exec(brief)?.[1]?.trim() ?? ''
          const spec = /Bound spec:\s*(\S+)/u.exec(brief)?.[1] ?? ''
          const evidence = join(process.cwd(), '.scratch', 'wayfinder-e2e', 'child-evidence.md')
          const body = [
            '# SHIP_CHILD_EVIDENCE',
            '',
            `original=${original === '' ? 'missing' : original}`,
            `track=${track === '' ? 'missing' : 'yes'}`,
            `bound=${spec === '' ? 'no' : 'yes'}`,
            `policy=${hasSubagentPolicy(texts) ? 'yes' : 'no'}`,
            `parent_history=${texts.some(text => text.includes('PARENT_CONTEXT_SENTINEL')) ? 'yes' : 'no'}`,
            '',
          ].join('\n')
          const args = JSON.stringify({ file_path: evidence, content: body })
          const id = ToolCallId('ship-delegate-child-write')
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } }
          yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        const evidence = join(process.cwd(), '.scratch', 'wayfinder-e2e', 'child-evidence.md')
        const recorded = existsSync(evidence) ? readFileSync(evidence, 'utf8') : ''
        const reply = [
          'SHIP_CHILD_OK',
          recorded.match(/^original=.+$/mu)?.[0] ?? 'original=missing',
          recorded.match(/^bound=.+$/mu)?.[0] ?? 'bound=no',
          recorded.match(/^parent_history=.+$/mu)?.[0] ?? 'parent_history=unknown',
          'evidence=.scratch/wayfinder-e2e/child-evidence.md',
        ].join(' ')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (result === undefined) {
        const idea = promptIdea(texts)
        const specPath = texts.flatMap(text => {
          const match = /Bound spec:\s*(\S+)/u.exec(text)
          return match?.[1] === undefined ? [] : [match[1]]
        })[0] ?? join(process.cwd(), 'docs', 'specs', 'wayfinder-e2e.md')
        const current = texts.findLast(text => text.includes('Throughout /ship')) ?? ''
        const track = sectionBody(current, 'Main Track') ?? 'missing'
        const brief = [
          'SHIP_DELEGATE_CHILD',
          '',
          'Read-only bounded brief. Do not reconstruct the goal from a conversation you do not have.',
          '',
          '## Original Requirement',
          '',
          idea === '' ? 'missing' : idea,
          '',
          `## Main Track\n\n${track}`,
          '',
          `Bound spec: ${specPath}`,
          '',
          'Prefer `subagent`, not `subagent_fork`; do not approve gates or modify the spec.',
          'Exact question: report whether CONTEXT.md exists; write evidence only under .scratch/wayfinder-e2e/.',
          'Allowed files: CONTEXT.md (read), .scratch/wayfinder-e2e/child-evidence.md (write).',
          'Stop after returning at most 20 lines of evidence.',
        ].join('\n')
        const args = JSON.stringify({
          description: 'Read-only ship brief',
          prompt: brief,
          run_in_background: false,
        })
        const id = ToolCallId('ship-delegate-parent')
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'subagent', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'subagent', arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const returned = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const reply = result.isError === true
        ? 'SHIP_DELEGATE_ERROR'
        : `SHIP_DELEGATE_PARENT child=${returned.includes('SHIP_CHILD_OK') ? 'yes' : 'no'} original=${returned.includes('original=SMALL_WAYFINDER') ? 'yes' : 'no'} isolated=${returned.includes('parent_history=no') ? 'yes' : 'no'}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (MOCK_MODE === 'workflow') {
      const seen = options.messages.flatMap(message =>
        message.content.filter(block => block.type === 'text').map(block => block.text))
      if (seen.some(text => text.includes('WORKFLOW_CHILD'))) {
        // A round's child does one thing before it answers: a write, so the
        // parent's working line has a call to name while the round runs.
        const worked = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
        if (worked === undefined) {
          const args = JSON.stringify(ARGUMENTS.write)
          const id = ToolCallId('code-cli-workflow-child-write')
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: args } }
          yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        // Long enough that the working line ticks while a round is in flight,
        // and that the parent's once-a-second look at the child's log catches
        // the write above: a figure that only exists between rounds is one
        // nobody sees.
        await new Promise(resolve => setTimeout(resolve, 1500))
        const reply = 'WORKFLOW_CHILD_OK'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const settled = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
      if (settled === undefined) {
        const args = JSON.stringify({
          script: WORKFLOW_SCRIPT,
          meta: { name: 'e2e-rounds', description: 'Two rounds through the real engine.' },
        })
        const id = ToolCallId('code-cli-workflow')
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'workflow', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'workflow', arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 4 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const reply = 'WORKFLOW_PARENT_OK'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (MOCK_MODE === 'context') {
      const reply = 'CONTEXT_REPLY_OK'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 32_000, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (MOCK_MODE === 'wide') {
      const reply = WIDE_LINES.join('\n')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const delta of splitDeltas(reply)) {
        await new Promise(resolve => setTimeout(resolve, 12))
        yield { type: 'text-delta', index: 0, text: delta }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 40 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (MOCK_MODE === 'anchor') {
      const rows = Array.from({ length: 12 }, (_, index) => `ANCHOR_REPLY_${index + 1}`)
      const reply = rows.join('\n')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const [index, row] of rows.entries()) {
        if (index > 0) await new Promise(resolve => setTimeout(resolve, 100))
        yield { type: 'text-delta', index: 0, text: `${index === 0 ? '' : '\n'}${row}` }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 12 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
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
    if (MOCK_MODE === 'reason-write') {
      // A thought, a write, a second thought, an answer — one turn, the way
      // a reasoning model works a tool: what the surface shows while a
      // thought stays open and the card between two thoughts stays a row.
      const worked = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
      const thought = worked === undefined ? FIRST_THOUGHT : SECOND_THOUGHT
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      for (const delta of splitDeltas(thought)) {
        yield { type: 'reasoning-delta', index: 0, text: delta }
      }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: thought } }
      if (worked === undefined) {
        const args = JSON.stringify(ARGUMENTS.write)
        const id = ToolCallId('code-cli-reason-write')
        yield { type: 'block-start', index: 1, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 1, id, name: 'write', argumentsDelta: args }
        yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'write', arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 4 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const reply = `${REASONED_ANSWER} (turn ${String(userTurns(options))})`
      yield { type: 'block-start', index: 1, blockType: 'text' }
      for (const delta of splitDeltas(reply)) {
        yield { type: 'text-delta', index: 1, text: delta }
      }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (MOCK_MODE === 'reasoning-slow') {
      // A thought long enough to press Escape into: one finished line a beat,
      // so what streamed so far is on screen when the interrupt lands.
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      for (const line of SLOW_THOUGHT) {
        await Promise.race([
          new Promise(resolve => setTimeout(resolve, 250)),
          new Promise(resolve => options.signal?.addEventListener('abort', resolve, { once: true })),
        ])
        if (options.signal?.aborted === true) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'caller stopped' } } }
          return
        }
        yield { type: 'reasoning-delta', index: 0, text: `${line}\n` }
      }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: SLOW_THOUGHT.join('\n') } }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: SLOW_ANSWER }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: SLOW_ANSWER } }
      yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 12 } }
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
      // The turn is named so a second turn's answer is told apart from a
      // repaint of the first.
      const reply = `${AFTERTHOUGHT} (turn ${String(userTurns(options))})`
      yield { type: 'block-start', index: 1, blockType: 'text' }
      for (const delta of splitDeltas(reply)) {
        yield { type: 'text-delta', index: 1, text: delta }
      }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: reply } }
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
      // /ship dispatched and expanded the typed idea into the current phase.
      // Wayfinder is the first injection; later phases get separate turns.
      const ship = texts.some(text => text.includes('SHIP_E2E_IDEA') && text.includes('ask_user_question') && text.includes('This turn is wayfinder only')) ? 'yes' : 'no'
      const original = texts.some(text => /<idea>\s*add a SHIP_E2E_IDEA command\s*<\/idea>/u.test(text)) ? 'yes' : 'no'
      const policy = texts.some(text => text.includes('Prefer `subagent`, not `subagent_fork`')) ? 'yes' : 'no'
      const mission = texts.some(text => text.includes('SHIP_E2E_IDEA') && (text.includes('Mission Contract') || text.includes('mission.contract.json'))) ? 'yes' : 'no'
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
      const reply = `CODE_CLI_CTX bang=${bang} remembered=${remembered} marker=${marker} ship=${ship} original=${original} policy=${policy} mission=${mission} ${image}`
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
      const tool = mode === 'questions' ? 'ask_user_question' : mode === 'write' || mode === 'tall' || mode === 'spec' ? 'write' : mode === 'todo' ? 'todo_write' : 'bash'
      const args = JSON.stringify(ARGUMENTS[mode] ?? ARGUMENTS.write)
      const id = ToolCallId(`code-cli-${tool}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (MOCK_MODE === 'steer') {
      // A second `$ sleep` card would mean a second turn; `seen=yes` with only
      // one card proves the steer message arrived mid-turn.
      const userMessages = options.messages.filter(message => message.role === 'user')
      const seen = userMessages.some(message => message.content.some(block =>
        block.type === 'text' && block.text.includes('CODE_CLI_STEER_MARK')))
      const users = userMessages.filter(message => message.content.some(block =>
        block.type === 'text' && !block.text.startsWith('<'))).length
      const reply = `CODE_CLI_STEER seen=${seen ? 'yes' : 'no'} users=${users}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 6 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const failed = toolResult.isError === true
    // Naming the serving model is what lets a test prove a /model switch
    // reached the request rather than only the status display.
    const reply = failed ? 'CODE_CLI_CALL_DENIED' : MOCK_MODE === 'questions'
      ? `QUESTION_RESULT\n${toolResult.content.filter(block => block.type === 'text').map(block => block.text).join('\n')}\nQUESTIONS_DONE`
      : `CODE_CLI_CALL_OK via ${options.model}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    // `spec` holds the turn open past the write, so the working line ticks
    // with the plan the write put on disk: a figure that only exists after
    // the turn ends is a figure nobody sees.
    if ((process.env.DSH_CODE_CLI_MOCK_TOOL ?? '') === 'spec') {
      for (let tick = 0; tick < 12; tick += 1) await new Promise(resolve => setTimeout(resolve, 120))
    }
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
export function apply(ctx: Context): void {
  const providers = AUTO_VISION
    ? ['cli-mock', 'deepseek-official']
    : ['cli-mock']
  ctx.llm.registerAdapter(providers, new CodeCliMockAdapter())
}
