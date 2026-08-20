/**
 * `codsh` — the interactive terminal surface. The bundle
 * patch rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * composes one Agent from the roster's preset, renders its session log to the
 * terminal, answers approvals and questions from the keyboard, and drives the
 * conversation until the person leaves.
 *
 * The surface shares the process with the Agent, so it reads `ctx.agents`
 * directly. The API gateway exists to carry out-of-process clients and would
 * add a serialization hop with no reader on the other side.
 *
 * @module codsh
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-session-projection'
// Declares the `todos` projection key this surface reads for its readout.
import type {} from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { TerminalApproval, answerForKey } from './approval.ts'
import { bannerLines } from './banner.ts'
import { createCompleter, fuzzyScore } from './completion.ts'
import { expandTemplate, loadCustomCommands } from './custom-commands.ts'
import type { CompletableCommand } from './completion.ts'
import { TerminalConsole } from './console.ts'
import { Prompt } from './prompt.ts'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { installPackagedPreset } from './preset-install.ts'
import { TerminalQuestions } from './questions.ts'
import { SHIP_PROMPT } from './ship.ts'
import { Spinner } from './spinner.ts'
import { TextStream } from './streaming.ts'
import { formatTokens, gitBranch, statusLine, statusReport, totalTokens } from './status.ts'
import { todoReport } from './todos.ts'
import type { TodoList } from './todos.ts'
import type { StatusFacts } from './status.ts'
import { backgroundIsLight, createTheme } from './theme.ts'
import { Transcript, answerSummary, thinkingFold } from './transcript.ts'
import type { Theme } from './theme.ts'

/** Stable Cordis plugin name. */
export const name = 'coding-cli-runner'

/** Core services required before the surface can compose an agent. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'tools']

/** Plugin config: the invocation resolved from this app's injected provider service. */
export interface Config {
  /** Opening task, or the empty string to start at the prompt. */
  task: string
  /** Session to reopen: an id, `'latest'`, or the empty string for a new session. */
  resume: string
  /** Preset id overriding the roster default, or the empty string to accept it. */
  preset: string
  /** Render the answer to `task` and exit rather than entering the prompt. */
  print: boolean
  /** Ring the terminal bell when a decision waits or a long turn ends. */
  bell: boolean
  /** How long a `!` passthrough command may run before it is killed. */
  bangTimeoutMs: number
  /** Output lines a `!` passthrough keeps before summarizing the rest. */
  bangOutputLines: number
}

export const Config: z<Config> = z.object({
  task: z.string().default(''),
  resume: z.string().default(''),
  preset: z.string().default(''),
  print: z.boolean().default(false),
  bell: z.boolean().default(true),
  bangTimeoutMs: z.number().default(120_000),
  bangOutputLines: z.number().default(200),
})

/** Process-facing effects of one session: the terminal plus the launcher's bounded exit request. */
interface CliIo {
  console: TerminalConsole
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process streams the surface binds to; tests substitute captures. */
export const internals: { input: NodeJS.ReadableStream; output: NodeJS.WriteStream } = {
  input: process.stdin,
  output: process.stdout,
}

/** How long a second interrupt keeps ending the process rather than the turn. */
const INTERRUPT_EXIT_WINDOW_MS = 2000

/**
 * Resolve the session `--continue` reopens: the newest one recorded in this
 * working directory.
 * @param ctx - plugin context carrying the optional session query engine.
 * @param cwd - the workspace to match.
 * @returns the session id, or undefined when nothing was recorded here.
 */
async function latestSessionIn(ctx: Context, cwd: string): Promise<SessionId | undefined> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return undefined
  const records = await query.listSessions()
  // `listSessions` is newest-first, so the first workspace match is the latest.
  return records.find(record => record.header.cwd === cwd)?.header.id
}

/**
 * Build the presenter lookups for one live agent.
 *
 * Presenters live with the tool definitions, and definitions live in the scope
 * chain a preset registers into. The live agent IS that scope key.
 * @param ctx - plugin context carrying the tool registry.
 * @param agent - the live agent whose catalog to resolve against.
 * @returns the call and result presenter lookups.
 */
function presentersFor(ctx: Context, agent: Agent) {
  return {
    call: (toolName: string, args: unknown) => ctx.tools.get(toolName, agent)?.presentCall?.(args),
    result: (toolName: string, args: unknown, result: ToolResult) =>
      ctx.tools.get(toolName, agent)?.presentResult?.(args, result),
  }
}

/**
 * Whether plan mode is holding, from the log's last `plan/mode` record.
 *
 * Folded here rather than through the plugin's own helper because importing a
 * runtime value from a bundled dependency inlines that package into this one;
 * the flag is one last-wins boolean, and the surface already reads the log.
 * @param events - the session log, oldest first.
 * @returns whether plan mode is on.
 */
function planModeFrom(events: readonly SessionEvent[]): boolean {
  let active = false
  for (const event of events) {
    if (event.type === 'plan/mode') active = event.data.active
  }
  return active
}

/**
 * Gather what the status line reports for the session as it stands now.
 *
 * Read fresh on every call: usage, occupancy, permission, and plan state are
 * all folds over the log, so a stale copy would report the turn before last.
 * @param ctx - plugin context carrying the projection and permission services.
 * @param agent - the live agent.
 * @param cwd - the session workspace.
 * @param model - the model route answering this session.
 * @param presetId - the composed preset, when a roster resolved one.
 * @param branch - the checked-out branch, read once per prompt.
 * @returns the facts to render.
 */
function statusFacts(
  ctx: Context,
  agent: Agent,
  cwd: string,
  selection: ModelSelectionRef,
  presetId: string | undefined,
  branch: string | undefined,
): StatusFacts {
  const projections = ctx.get('sessionProjections')?.snapshot(agent.session).values
  return {
    // Read live: a /model switch must show at the next status render.
    model: selection.current?.model ?? '',
    preset: presetId,
    permission: ctx.get('permissionPresets')?.current(agent.session.events),
    planMode: planModeFrom(agent.session.events),
    cwd,
    branch,
    usage: projections?.tokenUsage,
    context: projections?.contextPressure,
  }
}

/**
 * The agent's todo list as the chrome's readout wants it.
 *
 * Read from the projection rather than remembered from the write event, so a
 * resumed session shows the list it left off with and a `/clear` shows none.
 * @param ctx - plugin context carrying the projection service.
 * @param agent - the live agent.
 * @returns the current list, empty before any write.
 */
function todoList(ctx: Context, agent: Agent): TodoList {
  return ctx.get('sessionProjections')?.snapshot(agent.session).values.todos ?? []
}

/**
 * Render every event a resumed session already holds, so the person sees the
 * conversation they are continuing.
 * @param session - the reconstructed session.
 * @param transcript - the renderer, which also learns the pending call table.
 * @param io - the terminal to write to.
 */
function replay(session: Session, transcript: Transcript, io: CliIo, theme: Theme): void {
  for (const event of session.events) {
    // Thinking is in the log but not in the renderer's visible text: replay it
    // the way the turn showed it, one dim line with the deliberation behind
    // Ctrl+O, so a resumed session is that session rather than a redacted copy.
    if (event.type === 'assistant/message') {
      const thought = event.data.message.content
        .filter(block => block.type === 'reasoning')
        .map(block => block.text)
        .join('')
      if (thought !== '') {
        const lines = thought.split('\n').map(line => theme.dim(`  ${line}`))
        const { summary, full } = thinkingFold(lines, theme)
        io.console.appendFold(summary, full)
      }
    }
    const lines = transcript.render(event)
    // The renderer collapsed a long body: history keeps both forms, exactly as
    // the live turn did — the summary promises Ctrl+O, and without the fold the
    // key would answer nothing and the output would be unreachable for good.
    const full = transcript.takeFold()
    const rule = transcript.takeRule()
    if (full !== undefined) {
      io.console.appendFold(lines, full, rule)
      continue
    }
    for (const line of lines) io.console.write(line, rule)
    if (event.type !== 'assistant/message') continue
    // A long answer folds after the fact here too: it was written in the open,
    // and only then does it grow the summary the conversation moved on from.
    const body = lines.at(-1) === '' ? lines.slice(0, -1) : lines
    const summary = answerSummary(body, theme)
    if (summary !== undefined) io.console.foldRecent(lines.length, summary)
  }
}

/** Where a submitted turn came from: typed by the person, or a canned prompt. */
type TurnSource = { kind: 'user' } | { kind: 'plugin'; plugin: string }

/**
 * Run one conversation turn and wait for the agent to go idle.
 * @param agent - the live agent.
 * @param text - the person's message.
 * @param working - the indicator to run while the turn does.
 * @param source - the message source; a canned prompt is plugin-sourced so the
 *   transcript echoes the command that ran it, not its whole body.
 */
async function turn(agent: Agent, text: string, working?: Spinner, source: TurnSource = { kind: 'user' }): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source }))
  working?.start()
  try {
    await agent.whenIdle()
  } finally {
    working?.stop()
  }
}

/**
 * Execute one slash command through the command registry.
 * @param ctx - plugin context carrying the optional command registry.
 * @param agent - the live agent the command applies to.
 * @param line - the typed line, including its leading slash.
 * @param io - the terminal to write to.
 * @param theme - styling for the command's report.
 * @param signal - cancels the command when the person interrupts.
 */
async function runCommand(ctx: Context, agent: Agent, line: string, io: CliIo, theme: Theme, signal: AbortSignal): Promise<void> {
  const commands = ctx.get('commands')
  if (commands === undefined) {
    io.console.write(theme.error('  commands are unavailable in this composition'))
    return
  }
  if (line === '/help' || line === '/') {
    const width = Math.max(...commands.list(agent).map(command => command.name.length), 'exit'.length)
    for (const command of commands.list(agent)) {
      io.console.write(`  ${theme.tool(`/${command.name}`.padEnd(width + 1))}  ${theme.dim(command.description)}`)
    }
    io.console.write(`  ${theme.tool('/exit'.padEnd(width + 1))}  ${theme.dim('leave the session')}`)
    io.console.write('')
    return
  }
  // The whole line, slash included: `parseCommand` anchors on it, so a stripped
  // name resolves as nothing and every registry command answers "unknown".
  const execution = await commands.execute(agent, line, signal)
  if (execution === undefined) {
    io.console.write(theme.error(`  unknown command: ${line}`))
    return
  }
  // A command answers in text; dropping it left `/compact` and friends looking
  // like they had done nothing.
  const { result } = execution
  const report = result.kind === 'error' ? theme.error(result.text) : result.text
  if (report !== undefined && report !== '') {
    for (const reported of report.split('\n')) io.console.write(`  ${reported}`)
  }
  io.console.write('')
}

/** How long the second Escape has to arrive to recall the previous message. */
const RECALL_WINDOW_MS = 1500

/** Turns longer than this ring the bell on completion, when the bell is on. */
const BELL_TURN_MS = 10_000

/**
 * A subprocess's captured outcome: merged output and how it ended.
 */
interface Captured {
  /** stdout and stderr merged in arrival order. */
  output: string
  /** Exit code, or null when a signal ended it. */
  code: number | null
  /** The killing signal, or null when it exited. */
  signal: NodeJS.Signals | null
}

/**
 * Run one subprocess and capture everything it printed.
 * @param file - the executable, or a shell when `shell` is given.
 * @param args - its arguments.
 * @param options - working directory, abort wiring, and an optional kill timer.
 * @returns the merged output and exit status; spawn failures come back as a
 *   nonzero code with the error message as output.
 */
function capture(
  file: string,
  args: readonly string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const take = (chunk: Buffer | string): void => { output += chunk.toString() }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => { child.kill('SIGTERM') }, options.timeoutMs)
    const onAbort = (): void => { child.kill('SIGTERM') }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      resolve({ output: error.message, code: 127, signal: null })
    })
    child.on('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ output, code, signal })
    })
  })
}

/**
 * Style one unified-diff line for the transcript.
 * @param line - the raw diff line.
 * @param theme - styling for additions, removals, and headers.
 * @returns the styled line.
 */
function diffLine(line: string, theme: Theme): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return theme.dim(line)
  if (line.startsWith('@@')) return theme.tool(line)
  if (line.startsWith('+')) return theme.success(line)
  if (line.startsWith('-')) return theme.error(line)
  return theme.dim(line)
}

/**
 * A moment's age as a person reads it.
 * @param epochMs - when it happened.
 * @returns e.g. `just now`, `5m ago`, `3h ago`, `2d ago`.
 */
function age(epochMs: number): string {
  const minutes = Math.floor((Date.now() - epochMs) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** The `/init` prompt: a canned task submitted through the ordinary turn path. */
const INIT_PROMPT = `Analyze this repository and write an AGENTS.md file at its root for future coding agents.
Cover: what the project is, the repository layout, how to build/test/lint (exact commands), code conventions worth enforcing, and any non-obvious constraints you find in configs or docs.
If AGENTS.md (or CLAUDE.md) already exists, read it first and improve it rather than starting over. Keep it concise and factual.`

/** One composed terminal session: the live agent and what it was composed from. */
interface ComposedSession {
  handle: AgentHandle
  /** The model this session routes to. */
  model: string
  /** The composed preset, absent when the deployment composes no roster. */
  presetId?: string
  /**
   * The live selection this session's requests read. Assigning `current` is how
   * a model switch takes effect — the same mechanism the web surface uses.
   */
  selection: ModelSelectionRef
  /** Compose a fresh sibling session the same way — `/clear`'s replacement. */
  createAnother(): Promise<AgentHandle>
  /** Reopen a persisted session the same way — `/resume`'s switch. */
  resumeAnother(id: SessionId): Promise<AgentHandle>
}

/**
 * Compose the agent this invocation asked for: a fresh session, or the
 * persisted one `--resume`/`--continue` names.
 * @param ctx - plugin context carrying the agent, preset, and query services.
 * @param config - the resolved invocation.
 * @param cwd - the session workspace.
 * @returns the live agent and the preset it composed, or undefined when the
 *   requested session could not be resolved.
 */
async function compose(ctx: Context, config: Config, cwd: string): Promise<ComposedSession | undefined> {
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  if (agents === undefined || defaultModel === undefined) return undefined
  const selection = defaultModel.currentSelection()
  const selected: ModelSelectionRef = { current: selection, assembled: undefined }
  const presets = ctx.get('agentPresets')
  const preset = presets === undefined ? undefined : await presets.resolve(config.preset === '' ? undefined : config.preset)
  const setup = async (agentCtx: Context): Promise<void> => {
    installModelSelection(agentCtx, selected)
    if (presets !== undefined && preset !== undefined) await presets.mount(agentCtx, preset.id)
  }
  const agentOptions = { provider: selection.provider, model: selection.model }
  const createAnother = (): Promise<AgentHandle> => agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd, ...preset === undefined ? {} : { agentPreset: preset.id } },
    agentOptions,
    setup,
  })
  const resumeAnother = (id: SessionId): Promise<AgentHandle> => agents.resume({ resumeSessionId: id, agentOptions, setup })
  const composed = {
    model: selection.model,
    selection: selected,
    createAnother,
    resumeAnother,
    ...preset === undefined ? {} : { presetId: preset.id },
  }
  if (config.resume === '') return { handle: await createAnother(), ...composed }
  const resumeSessionId = config.resume === 'latest'
    ? await latestSessionIn(ctx, cwd)
    : SessionId(config.resume)
  if (resumeSessionId === undefined) return undefined
  return { handle: await resumeAnother(resumeSessionId), ...composed }
}

/**
 * Drive one terminal session from composition to exit.
 * @param ctx - plugin context carrying the core services and launcher IO.
 * @param config - the resolved invocation.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, config: Config, io: CliIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return
  const cwd = process.cwd()
  const theme = createTheme(io.console.isTty, process.env)
  // The viewport asks OSC 11 on entry; a light answer swaps in the readable
  // secondary-text shade for everything rendered from then on.
  io.console.onBackground((payload) => {
    const light = backgroundIsLight(payload)
    if (light !== undefined) theme.setLight(light)
  })

  // Before the roster resolves anything: discovery re-reads its roots on every
  // call, so a preset placed here is visible to the resolve below.
  const preset = await installPackagedPreset()
  if (preset.installed) io.console.write(theme.dim(`installed preset into ${preset.path}`))

  const composed = await compose(ctx, config, cwd)
  if (composed === undefined) {
    io.console.write(theme.error(`dsh: no session to resume${config.resume === 'latest' ? ` in ${cwd}` : ''}`))
    io.exit(1)
    return
  }
  const { model, presetId, selection } = composed
  // `/clear` and `/resume` swap the session under a running surface, so the
  // agent, its handle, and its presenter-bound transcript live in one mutable
  // ref that every closure reads through.
  const live = {
    handle: composed.handle,
    agent: composed.handle.agent,
    transcript: new Transcript({ theme, columns: io.console.columns, cwd }, presentersFor(ctx, composed.handle.agent)),
  }
  const facts = (branch: string | undefined): StatusFacts =>
    statusFacts(ctx, live.agent, cwd, selection, presetId, branch)
  io.console.setTitle(`dsh code — ${basename(cwd)}`)

  // Refreshed once per prompt. A command handler is synchronous, so it reports
  // the branch this session last observed rather than stalling to re-read it.
  let branch = await gitBranch(cwd)
  if (config.resume !== '') replay(live.agent.session, live.transcript, io, theme)
  for (const line of bannerLines({
    model,
    preset: presetId,
    cwd,
    branch,
    session: live.agent.session.id,
    readsKeys: io.console.readsKeys,
    resumed: config.resume !== '',
  }, theme, io.console.columns)) io.console.write(line)

  const disposers: (() => void)[] = []
  const commands = ctx.get('commands')

  /** The advertised model catalog, fetched once and refreshed per /model call. */
  let modelCatalog: { provider: string; id: string; name: string }[] = []
  const refreshModelCatalog = async (): Promise<void> => {
    // Read through the store, not the property proxy: `llm` is not one of this
    // plugin's declared injections.
    const llm = ctx.get('llm')
    if (llm === undefined) return
    const providers = llm.listProviders()
    const listed = await Promise.all(providers.map(async (provider) => {
      try {
        return await llm.listModels(provider.id)
      } catch {
        // A provider that cannot list still routes; the catalog is advisory.
        return []
      }
    }))
    modelCatalog = listed.flat().map(entry => ({ provider: entry.provider, id: entry.id, name: entry.name }))
  }
  // Fetched in the background: the catalog feeds completion and listing, and
  // neither is worth delaying the first prompt for.
  void refreshModelCatalog()

  /**
   * Resolve a /model argument to a selection.
   * @param typed - a bare model id, or an explicit `provider/model`.
   * @returns the selection, or an error message naming what is available.
   */
  const resolveModelArgument = (typed: string): { provider: string; model: string } | string => {
    const slash = typed.indexOf('/')
    if (slash > 0) {
      // Explicit routes bypass the catalog: it is advisory, and an adapter may
      // accept ids it does not advertise.
      return { provider: typed.slice(0, slash), model: typed.slice(slash + 1) }
    }
    const hits = modelCatalog.filter(entry => entry.id === typed)
    if (hits.length === 1 && hits[0] !== undefined) return { provider: hits[0].provider, model: hits[0].id }
    if (hits.length > 1) {
      return `"${typed}" is served by several providers; pick one: ${hits.map(hit => `${hit.provider}/${hit.id}`).join(', ')}`
    }
    const known = modelCatalog.map(entry => entry.id).join(', ')
    return known === ''
      ? `no catalog to match "${typed}" against; use the explicit provider/model form`
      : `unknown model "${typed}" (available: ${known}); provider/model also works`
  }
  // Canned prompts this surface runs through the ordinary submission path:
  // `/init` and `/ship` built in, plus whatever command files the person defined.
  const custom = await loadCustomCommands(
    [dshHomePath('commands'), join(cwd, '.dsh', 'commands')],
    new Set([...(commands?.list(live.agent) ?? []).map(entry => entry.name), 'exit', 'quit', 'help', 'init', 'ship', 'status', 'model', 'clear', 'resume', 'diff']),
  )
  for (const warning of custom.warnings) io.console.write(theme.dim(`  skipped ${warning}`))
  const customByName = new Map(custom.commands.map(command => [command.name, command]))
  // Read on each keystroke, not captured: the registry is scoped and changes
  // with the session's mode, and `/exit` is this surface's own.
  const completable = (): readonly CompletableCommand[] => [
    ...commands?.list(live.agent) ?? [],
    { name: 'init', description: 'analyze the repo and draft AGENTS.md' },
    { name: 'ship', description: 'take a one-sentence idea to shipped code' },
    ...custom.commands.map(command => ({ name: command.name, description: command.description })),
    { name: 'exit', description: 'leave the session' },
  ]
  const completePath = createCompleter(completable, cwd)
  /**
   * The first-argument candidates per command, read live: plan's argument
   * depends on its state, permission's on the preset table, model's on the
   * advisory catalog.
   */
  const argumentsFor = (command: string, typed: string): { value: string; detail: string }[] => {
    const offer = (values: { value: string; detail: string }[]): { value: string; detail: string }[] =>
      values.filter(entry => entry.value.startsWith(typed))
    if (command === 'plan') {
      return planModeFrom(live.agent.session.events)
        ? offer([{ value: 'off', detail: 'leave plan mode' }])
        : []
    }
    if (command === 'permission') {
      const presets = ctx.get('permissionPresets')
      if (presets === undefined) return []
      const current = presets.current(live.agent.session.events)
      return offer(presets.names.map(name => ({ value: name, detail: name === current ? 'current' : '' })))
    }
    if (command === 'model') {
      const current = selection.current
      const exact = offer(modelCatalog.map(entry => ({
        value: entry.id,
        detail: entry.provider === current?.provider && entry.id === current.model ? 'current' : entry.name,
      })))
      if (exact.length > 0 || typed === '') return exact
      // A fragment falls back to fuzzy, the way the @ mention does.
      return modelCatalog
        .map(entry => ({ entry, score: fuzzyScore(typed, entry.id) }))
        .filter((hit): hit is { entry: typeof hit.entry; score: number } => hit.score !== undefined)
        .sort((a, b) => b.score - a.score)
        .map(hit => ({ value: hit.entry.id, detail: hit.entry.name }))
    }
    return []
  }
  // Assigned below: the prompt reports keys to work that has to be able to draw
  // through the prompt, so one side of the pair is wired after both exist.
  let onEscapeKey: () => void = () => {}
  let onInterruptKey: () => void = () => {}
  const prompt = new Prompt(io.console, theme, {
    commands: completable,
    paths: completePath,
    commandArguments: argumentsFor,
  }, {
    interrupt: () => { onInterruptKey() },
    escape: () => { onEscapeKey() },
    // The outstanding read is already answered with nothing; ending input is
    // what makes the next one answer the same way.
    eof: () => { io.console.close() },
    // Shift-Tab TOGGLES plan mode. The registry's bare /plan only ever enters,
    // so the current fold decides which line to send — without it a second
    // Shift-Tab would do nothing, which reads as a broken key.
    shiftTab: () => {
      const line = planModeFrom(live.agent.session.events) ? '/plan off' : '/plan'
      void commands?.execute(live.agent, line, new AbortController().signal)
    },
    // Ctrl-O toggles every collapsed block — tool output and thinking alike —
    // between its summary and its full form, in place.
    expandOutput: () => {
      if (!io.console.toggleFolds()) prompt.write(theme.dim('  nothing to expand'))
    },
  }, 'Ask anything · / for commands · @ for files · ⇧Tab plan mode')
  // The baseline the indicator's token figure counts from, reset per turn.
  let turnBaseTokens = 0
  const spinner = new Spinner({
    setLive: (text) => { prompt.setHint(text) },
    isTty: io.console.readsKeys,
  }, theme, {
    verb: 'working',
    interrupt: io.console.readsKeys ? 'ESC' : 'Ctrl-C',
    detail: () => {
      const spent = (totalTokens(facts(branch).usage) ?? 0) - turnBaseTokens
      return spent > 0 ? `${formatTokens(spent)} tokens` : undefined
    },
  })
  // Prompt history survives sessions, which is what makes Up-arrow at a fresh
  // prompt recall yesterday's work. A failure to read or write it costs the
  // history, never the session.
  const historyPath = dshHomePath('code-cli-history.json')
  try {
    const seeded: unknown = JSON.parse(await readFile(historyPath, 'utf8'))
    if (Array.isArray(seeded)) prompt.seedHistory(seeded.filter((entry): entry is string => typeof entry === 'string'))
  } catch {
    // Absent or unreadable history starts empty.
  }

  // Bound after the approval widget exists; commands only run once the loop does.
  let adopt: (next: AgentHandle, replayLog: boolean) => void = () => {}
  /**
   * Swap the surface onto another session: new handle in, old one disposed.
   * @param next - the replacement, already composed.
   * @param replayLog - whether to render the session's existing events.
   */
  const switchTo = async (next: AgentHandle, replayLog: boolean): Promise<void> => {
    await sessions.flush(live.agent.session)
    const old = live.handle
    adopt(next, replayLog)
    await old.dispose()
  }
  if (commands !== undefined) {
    // `register` returns its own effect disposer, which is this registration's
    // lifetime: this runner owns the process, and `ctx.effect` would tie it to an
    // effect scope the detached driver has already left.
    disposers.push(commands.register({
      name: 'status',
      description: 'show the model, composition, permissions, and token usage',
      handler: () => ({ kind: 'success', text: statusReport(facts(branch), live.agent.session.id) }),
    }))
    disposers.push(commands.register({
      name: 'todos',
      description: 'print the agent\'s todo list as it now stands',
      handler: () => {
        // The readout answers this at a glance on a terminal; this is the same
        // list for the pipe shape, which has no chrome and no keys to open it.
        const lines = todoReport(todoList(ctx, live.agent), theme, io.console.columns)
        return lines.length === 0
          ? { kind: 'success', text: 'no todos yet' }
          : { kind: 'success', text: lines.join('\n') }
      },
    }))
    disposers.push(commands.register({
      name: 'clear',
      description: 'start a fresh session in place',
      handler: async () => {
        // Compose the replacement before touching the old session, so a failed
        // create costs nothing.
        const next = await composed.createAnother()
        await switchTo(next, false)
        // A fresh session opens the way the first one did: welcome at the top.
        for (const line of bannerLines({
          model,
          preset: presetId,
          cwd,
          branch,
          session: live.agent.session.id,
          readsKeys: io.console.readsKeys,
          resumed: false,
        }, theme, io.console.columns)) prompt.write(line)
        return { kind: 'success', text: `new session ${live.agent.session.id}` }
      },
    }))
    disposers.push(commands.register({
      name: 'resume',
      description: 'switch to an earlier session',
      input: { hint: '[session-id]' },
      handler: async ({ rawInput, signal }) => {
        const typed = rawInput.trim()
        const resume = async (id: SessionId): Promise<{ kind: 'success'; text: string }> => {
          if (id === live.agent.session.id) return { kind: 'success', text: 'already on that session' }
          const next = await composed.resumeAnother(id)
          await switchTo(next, true)
          return { kind: 'success', text: `resumed ${id}` }
        }
        if (typed !== '') return resume(SessionId(typed))
        const query = ctx.get('sessionQuery')
        if (query === undefined) return { kind: 'error', text: 'session listing is unavailable in this composition' }
        const records = (await query.listSessions()).filter(record => record.header.id !== live.agent.session.id)
        // Newest-first already; this workspace's sessions lead, and the rest
        // follow for the times work moved between checkouts.
        const here = records.filter(record => record.header.cwd === cwd)
        const elsewhere = records.filter(record => record.header.cwd !== cwd)
        const listed = [...here, ...elsewhere].slice(0, 20)
        if (listed.length === 0) return { kind: 'success', text: 'no other sessions recorded' }
        const titles = await Promise.all(listed.map(async (record) => {
          try {
            return (await query.readTitle(record.header.id, signal))?.title
          } catch {
            // A session whose log cannot be read still lists by id.
            return undefined
          }
        }))
        const rows = listed.map((record, index) => ({
          id: record.header.id,
          label: titles[index] ?? String(record.header.id),
          detail: `${age(record.header.createdAt)}${record.header.cwd === cwd ? '' : ` · ${record.header.cwd ?? ''}`}`,
        }))
        if (!io.console.readsKeys) {
          return { kind: 'success', text: rows.map(row => `${row.id}  ${row.label}  ${row.detail}`).join('\n') }
        }
        const outcome = await prompt.select({
          title: 'Resume session',
          options: rows.map(row => ({ label: row.label, detail: row.detail })),
        }, signal)
        if (outcome.kind !== 'chosen') return { kind: 'success', text: 'nothing resumed' }
        const picked = rows[outcome.indices[0] ?? -1]
        if (picked === undefined) return { kind: 'success', text: 'nothing resumed' }
        return resume(picked.id)
      },
    }))
    disposers.push(commands.register({
      name: 'diff',
      description: 'show uncommitted workspace changes',
      handler: async ({ signal }) => {
        // HEAD covers staged and unstaged both; a repo with no commits yet
        // falls back to the plain working-tree diff.
        const against = await capture('git', ['diff', 'HEAD'], { cwd, signal })
        const diff = against.code === 0 ? against : await capture('git', ['diff'], { cwd, signal })
        if (diff.code !== 0) return { kind: 'error', text: diff.output.trim() === '' ? 'not a git repository' : diff.output.trim() }
        if (diff.output.trim() === '') return { kind: 'success', text: 'no uncommitted changes' }
        for (const line of diff.output.trimEnd().split('\n')) prompt.write(diffLine(line, theme))
        return { kind: 'success' }
      },
    }))
    /**
     * Make one route the session's model.
     *
     * Assigning the live ref is the switch; the next request reads it. The
     * default is saved too, like the web surface — a failure there costs the
     * default, never the session.
     */
    const applyModel = async (provider: string, model: string): Promise<void> => {
      selection.current = { provider, model }
      try {
        await ctx.get('agentDefaultModel')?.saveSelection(selection.current)
      } catch {
        // Recorded for this session regardless.
      }
      refreshStatus()
    }
    disposers.push(commands.register({
      name: 'model',
      description: 'switch the model answering this session',
      input: { hint: '[model|provider/model]' },
      handler: async ({ rawInput }) => {
        const typed = rawInput.trim()
        if (typed === '') {
          await refreshModelCatalog()
          const current = selection.current
          const header = `current ${current?.provider ?? '?'}/${current?.model ?? '?'}`
          if (modelCatalog.length === 0) return { kind: 'success', text: header }
          if (!io.console.readsKeys) {
            // The pipe cannot deliver selection keys; it gets the list.
            const rows = modelCatalog.map((entry) => {
              const active = entry.provider === current?.provider && entry.id === current.model
              return `${active ? '❯' : ' '} ${entry.provider}/${entry.id}  ${entry.name}`
            })
            return { kind: 'success', text: `${header}\n${rows.join('\n')}` }
          }
          // A bare /model IS the request to pick one: arrows, digits, Enter —
          // printing a list a person then has to retype defeats the command.
          const outcome = await prompt.select({
            title: 'Switch model',
            options: modelCatalog.map((entry) => {
              const active = entry.provider === current?.provider && entry.id === current.model
              return { label: `${entry.provider}/${entry.id}`, detail: active ? `${entry.name} · current` : entry.name }
            }),
          })
          if (outcome.kind !== 'chosen') return { kind: 'success', text: 'model unchanged' }
          const picked = modelCatalog[outcome.indices[0] ?? -1]
          if (picked === undefined) return { kind: 'success', text: 'model unchanged' }
          await applyModel(picked.provider, picked.id)
          return { kind: 'success', text: `model ${picked.provider}/${picked.id}` }
        }
        // The catalog resolves bare ids; fetch it if the background load has
        // not landed yet rather than answering "no catalog".
        if (modelCatalog.length === 0) await refreshModelCatalog()
        const resolved = resolveModelArgument(typed)
        if (typeof resolved === 'string') return { kind: 'error', text: resolved }
        await applyModel(resolved.provider, resolved.model)
        return { kind: 'success', text: `model ${resolved.provider}/${resolved.model}` }
      },
    }))
  }

  const stream = new TextStream(theme, () => io.console.contentColumns)
  // A finished answer is foldable too, the way Claude keeps every long block
  // collapsible: it streams in the open, and when the block ends anything
  // longer than a screenful is registered as an expanded fold — read now,
  // collapsed to its head lines once the conversation moves on.
  let answerLines: string[] = []
  const finishAnswer = (): void => {
    if (!stream.streamed) return
    const tail = stream.flush()
    emit([...tail, ''])
    answerLines.push(...tail)
    const summary = answerSummary(answerLines, theme)
    if (summary !== undefined) io.console.foldRecent(answerLines.length + 1, summary)
    answerLines = []
  }
  // Reasoning gets its own stream: pushed into `stream`, its deltas would mark
  // the answer as already-shown and the visible text would be swallowed.
  const thinking = new TextStream(theme, () => io.console.contentColumns, true)
  // Thinking is collapsed by default, the way Claude shows it: while it
  // streams only the current line is live on screen, and when it ends the
  // transcript keeps a one-line summary with the full text one click (or
  // Ctrl+O) away —
  // pages of deliberation would otherwise bury the conversation.
  let thinkingLines: string[] = []
  let thinkingStartedAt = 0
  const flushThinking = (): void => {
    thinkingLines.push(...thinking.flush())
    if (thinkingLines.length === 0) return
    prompt.setStreaming(undefined)
    const { summary, full } = thinkingFold(thinkingLines, theme, (performance.now() - thinkingStartedAt) / 1000)
    io.console.appendFold(summary, full)
    thinkingLines = []
    thinkingStartedAt = 0
  }
  /**
   * Append the lines an event produced, and show the line still being typed.
   * @param lines - finished lines for the transcript.
   * @param live - the in-progress line, or undefined to release the region.
   */
  const emit = (lines: readonly string[], live?: string, rule = ''): void => {
    // Released before writing: the region is redrawn under every written line,
    // so leaving the superseded partial in place would reprint it each time.
    if (lines.length > 0) prompt.setStreaming(undefined)
    for (const line of lines) prompt.write(line, rule)
    prompt.setStreaming(live)
  }

  /** Push the always-current status row; the pipe shape prints it instead. */
  const refreshStatus = (): void => {
    if (!io.console.readsKeys) return
    prompt.setStatus(statusLine(facts(branch), theme, io.console.columns - 1))
    // Same cadence as the status row, for the same reason: the list is a fold
    // over the log, so anything cached here would report the turn before last.
    prompt.setTodos(todoList(ctx, live.agent))
  }
  if (planModeFrom(live.agent.session.events)) prompt.setAccent(text => theme.pending(text))
  refreshStatus()

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    // `/clear` and `/resume` retire sessions; only the current one renders.
    if (session !== live.agent.session) return
    if (event.type === 'plan/mode') {
      // The box frame is where the mode lives: a person mid-thought sees what
      // the next submission will do without reading the transcript.
      prompt.setAccent(event.data.active ? text => theme.pending(text) : undefined)
    }
    refreshStatus()
    // Straight from the event, after the projection read above: the write
    // carries the whole replacement list, so the readout never has to wait for
    // a fold that may land after this handler runs.
    if (event.type === 'todo/write') prompt.setTodos(event.data.todos)
    // In print mode the task text came from the caller's own command line;
    // echoing it back would only make stdout harder to consume in scripts.
    if (config.print && event.type === 'user/message') return
    if (event.type === 'assistant/chunk') {
      // Text arrives before the message that assembles it; showing it now is the
      // whole point, and the indicator stands down because the text itself is
      // better evidence of progress.
      const { chunk } = event.data
      // The indicator keeps ticking while text streams: it is the turn's one
      // continuous clock, and hiding it here made the chrome shrink and grow
      // with every step — a visible flicker.
      if (chunk.type === 'reasoning-delta') {
        if (chunk.text === '') return
        if (thinkingStartedAt === 0) thinkingStartedAt = performance.now()
        const step = thinking.push(chunk.text)
        // Collected, not printed: only the line being thought shows, live.
        thinkingLines.push(...step.lines)
        prompt.setStreaming(step.live ?? thinkingLines.at(-1) ?? theme.dim('✻ thinking'))
        return
      }
      if (chunk.type !== 'text-delta') return
      // The answer starting is what collapses the thinking into its summary.
      flushThinking()
      const step = stream.push(chunk.text)
      emit(step.lines, step.live)
      answerLines.push(...step.lines)
      return
    }
    if (event.type === 'assistant/message') {
      // A reasoning-only step (thinking straight into a tool call) still has
      // to land its summary before the call card prints.
      flushThinking()
      if (stream.streamed) {
        // Already shown delta by delta; re-rendering the assembled text would
        // print the answer twice.
        finishAnswer()
        return
      }
    }
    const lines = live.transcript.render(event)
    const full = live.transcript.takeFold()
    // The rule marks which block these lines belong to, down their left edge.
    const rule = live.transcript.takeRule()
    if (full === undefined) {
      emit(lines, undefined, rule)
      return
    }
    // A collapsed block: the screen keeps both forms; a click on it swaps
    // that one, Ctrl+O swaps them all.
    prompt.setStreaming(undefined)
    io.console.appendFold(lines, full, rule)
  })

  /** Pause the indicator around a decision, and resume it if work continues. */
  const whileDeciding = async <T>(decide: () => Promise<T>): Promise<T> => {
    // Paused, not stopped: the decision is part of the turn, and its clock.
    spinner.pause()
    // A decision is the moment a person has to come back to the terminal.
    if (config.bell) io.console.bell()
    try {
      return await decide()
    } finally {
      if (live.agent.status === 'running') spinner.start()
    }
  }

  const approval = new TerminalApproval(
    {
      ask: (toolName, reason, signal) => whileDeciding(async () => {
        if (!io.console.readsKeys) {
          const detail = reason === undefined ? '' : ` ${theme.dim(reason)}`
          prompt.write(`${theme.pending('?')} allow ${theme.tool(toolName)}${detail}`)
          const line = await prompt.read(signal)
          return line === undefined ? undefined : answerForKey(line) ?? 'reject'
        }
        if (reason !== undefined) prompt.write(theme.dim(`  ${reason}`))
        const outcome = await prompt.select({
          title: `Allow ${toolName}?`,
          options: [
            { label: 'Yes, this time', shortcut: 'y' },
            { label: `Yes, every ${toolName} call this session`, shortcut: 'a' },
            { label: 'No', shortcut: 'n' },
          ],
        }, signal)
        if (outcome.kind !== 'chosen') return undefined
        const [chosen] = outcome.indices
        return chosen === 0 ? 'once' : chosen === 1 ? 'always' : 'reject'
      }),
    },
    theme,
    (line) => { prompt.write(line) },
  )
  ctx.on('approval/request', (req, next) => req.agent === live.agent ? approval.decide(req) : next())

  adopt = (next: AgentHandle, replayLog: boolean): void => {
    live.handle = next
    live.agent = next.agent
    live.transcript = new Transcript({ theme, columns: io.console.columns, cwd }, presentersFor(ctx, next.agent))
    // The viewport buffer is the RETIRED session's transcript; left in place,
    // /clear would clear nothing visible and /resume would replay under it.
    io.console.clearScreen()
    // Session-scoped state does not follow the person to another session.
    approval.clear()
    turnBaseTokens = 0
    prompt.setAccent(planModeFrom(next.agent.session.events) ? text => theme.pending(text) : undefined)
    if (replayLog) replay(next.agent.session, live.transcript, io, theme)
    refreshStatus()
  }

  const questions = ctx.get('userQuestions')
  if (questions !== undefined) {
    const terminalQuestions = new TerminalQuestions(
      prompt,
      theme,
      (line) => { prompt.write(line) },
      io.console.readsKeys ? async (spec, signal) => prompt.select(spec, signal) : undefined,
    )
    questions.registerProvider({ ask: async request => whileDeciding(() => terminalQuestions.ask(request)) })
  }

  // The controller in flight belongs to the slash command being executed, so
  // one interrupt reaches whichever kind of work is running.
  let running: AbortController | undefined
  /**
   * Stop whatever the agent is doing. Cancelling an idle agent is a no-op, so
   * the report is withheld unless there was work to stop — an Escape pressed at
   * an empty prompt should look like nothing happened.
   * @returns whether anything was running.
   */
  const interrupt = (): boolean => {
    const busy = live.agent.status === 'running' || running !== undefined
    // The work is being cancelled, so the working indicator goes first: it owns
    // the live region, and anything written under it would be followed by the
    // indicator redrawing itself as though the turn were still going.
    spinner.stop()
    running?.abort()
    live.agent.cancel({ kind: 'user' })
    // Text cut off mid-line was already shown; leaving it in the live region
    // would erase it on the next write.
    flushThinking()
    finishAnswer()
    if (busy) prompt.write(theme.dim('  interrupted'))
    return busy
  }

  /**
   * Hand the terminal back and leave.
   *
   * The session's own screen disappears with it, so the few facts a person
   * still needs — which session this was, what it cost, how to reopen it — are
   * written to the buffer that survives instead.
   * @param code - the exit status to request.
   */
  const leave = (code: number): void => {
    prompt.clear()
    io.console.close()
    const usage = totalTokens(facts(branch).usage)
    const spent = usage === undefined || usage === 0 ? '' : ` · ${formatTokens(usage)} tokens`
    io.console.writeAfterScreen(theme.dim(`codsh session ${live.agent.session.id}${spent}`))
    io.console.writeAfterScreen(theme.dim(`  reopen with: codsh --resume ${live.agent.session.id}`))
    io.exit(code)
  }

  let lastInterrupt = 0
  // Escape at a quiet, empty prompt arms recall: the second press inside the
  // window puts the previous message back for editing.
  let recallArmed: NodeJS.Timeout | undefined
  onEscapeKey = () => {
    if (interrupt()) return
    if (!prompt.empty) return
    // Commands and passthroughs are not messages worth re-editing.
    const last = prompt.history.findLast(entry => !entry.startsWith('/') && !entry.startsWith('!'))
    if (last === undefined) return
    if (recallArmed !== undefined) {
      clearTimeout(recallArmed)
      recallArmed = undefined
      prompt.setHint(undefined)
      prompt.prefill(last)
      return
    }
    prompt.setHint(theme.dim('  ESC again to edit your previous message'))
    recallArmed = setTimeout(() => {
      recallArmed = undefined
      prompt.setHint(undefined)
    }, RECALL_WINDOW_MS)
    recallArmed.unref()
  }
  // Ctrl-C leaves. It still interrupts first when there is work to stop, so the
  // reflex does not end a session mid-turn, and it is the only interrupt off a
  // terminal — where Escape cannot arrive before its line.
  onInterruptKey = () => {
    const now = performance.now()
    const repeated = now - lastInterrupt < INTERRUPT_EXIT_WINDOW_MS
    lastInterrupt = now
    if (!repeated && interrupt()) {
      prompt.write(theme.dim('  Ctrl-C again to exit'))
      return
    }
    leave(130)
  }


  /**
   * Run one turn and report what it cost.
   *
   * The summary is the answer to "was that expensive?" at the moment a person
   * decides whether to keep going, which is why it lands with the turn rather
   * than only in the status line.
   * @param text - the person's message.
   */
  const answer = async (text: string, source?: TurnSource): Promise<void> => {
    const before = totalTokens(facts(branch).usage) ?? 0
    turnBaseTokens = before
    const started = performance.now()
    io.console.setTitle(`⚡ dsh code — ${basename(cwd)}`)
    try {
      await turn(live.agent, text, spinner, source)
    } finally {
      io.console.setTitle(`dsh code — ${basename(cwd)}`)
    }
    const spent = (totalTokens(facts(branch).usage) ?? 0) - before
    const elapsed = (performance.now() - started) / 1000
    // A long turn ending is the other moment worth calling the person back.
    if (config.bell && elapsed * 1000 > BELL_TURN_MS) io.console.bell()
    const cost = spent > 0 ? ` · ${formatTokens(spent)} tokens` : ''
    prompt.write(theme.dim(`  ${elapsed.toFixed(1)}s${cost}`))
    prompt.write('')
  }

  if (config.print) {
    // No viewport in print mode: the caller wants the answer on stdout.
    await turn(live.agent, config.task, spinner)
    flushThinking()
    finishAnswer()
    await sessions.flush(live.agent.session)
    prompt.clear()
    io.console.close()
    io.exit(0)
    return
  }

  /**
   * Run a `!` line locally and hand the outcome to the model as context.
   *
   * The command runs in the person's shell in the workspace; its output prints
   * like a terminal card and is injected as a plugin-sourced message, so the
   * next request sees what just happened without a turn being spent on it.
   * @param command - the line after the `!`.
   */
  const passthrough = async (command: string): Promise<void> => {
    prompt.write(`${theme.user('›')} ${theme.tool(`!${command}`)}`)
    running = new AbortController()
    try {
      const shell = process.env['SHELL'] ?? '/bin/sh'
      const result = await capture(shell, ['-c', command], {
        cwd,
        signal: running.signal,
        timeoutMs: config.bangTimeoutMs,
      })
      const lines = result.output.trimEnd() === '' ? [] : result.output.trimEnd().split('\n')
      const kept = lines.slice(0, config.bangOutputLines)
      const dropped = lines.length - kept.length
      for (const line of kept) prompt.write(theme.dim(`  ${line}`))
      if (dropped > 0) prompt.write(theme.dim(`  … ${dropped} more lines`))
      const status = result.signal !== null
        ? theme.error(`  ✗ killed by ${result.signal}`)
        : result.code !== 0 ? theme.error(`  ✗ exit ${result.code ?? '?'}`) : undefined
      if (status !== undefined) prompt.write(status)
      prompt.write('')
      const report = [...kept, ...dropped > 0 ? [`… ${dropped} more lines`] : []].join('\n')
      const exit = result.signal !== null ? `killed by ${result.signal}` : String(result.code ?? 0)
      live.agent.inject(createUserMessage({
        content: [{
          type: 'text',
          text: `<bash-input>${command}</bash-input>\n<bash-output>\n${report}\n</bash-output>\n<bash-exit>${exit}</bash-exit>`,
        }],
        source: { kind: 'plugin', plugin: 'coding-cli' },
      }))
    } finally {
      running = undefined
    }
  }

  // From here the session is interactive. The viewport opens first: the banner
  // lines written above are already in its scrollback, so the first frame shows
  // them with the box pinned below rather than flashing an unowned screen.
  io.console.enterScreen()
  // The box stays on screen through turns, so type-ahead is visible where it
  // will be edited.
  prompt.setEngaged(true)
  if (config.task !== '') await answer(config.task)
  // Reprinting an unchanged status line before every prompt is noise; a person
  // reads it to notice a CHANGE — context falling, a permission switch, plan
  // mode engaging — so it appears when it has something new to say.
  let shownStatus: string | undefined
  for (;;) {
    // Re-read once per prompt rather than per render: a branch changes between
    // turns, not between the lines of one.
    branch = await gitBranch(cwd)
    if (io.console.readsKeys) {
      // On a terminal the status lives in the region, always current.
      refreshStatus()
    } else {
      const status = statusLine(facts(branch), theme, io.console.columns)
      if (status !== shownStatus) {
        prompt.write(status)
        shownStatus = status
      }
    }
    const line = await prompt.read()
    if (line === undefined) break
    // Moving on reads as dismissal: whatever was expanded folds back, the way
    // clicking elsewhere collapses an expanded block in Claude.
    io.console.collapseFolds()
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed === '/exit' || trimmed === '/quit') break
    if (trimmed.startsWith('!')) {
      const command = trimmed.slice(1).trim()
      if (command !== '') await passthrough(command)
      continue
    }
    if (trimmed.startsWith('/')) {
      // A command produces no session event, so nothing else would show what
      // was run above its result.
      prompt.write(`${theme.user('›')} ${trimmed}`)
      // Canned prompts run as ordinary turns; the echo above is their whole
      // transcript presence, not their page-long body.
      const [, name = '', rest = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed) ?? []
      if (name === 'init') {
        await answer(INIT_PROMPT, { kind: 'plugin', plugin: 'coding-cli' })
        continue
      }
      if (name === 'ship') {
        await answer(expandTemplate(SHIP_PROMPT, rest.trim()), { kind: 'plugin', plugin: 'coding-cli' })
        continue
      }
      const canned = customByName.get(name)
      if (canned !== undefined) {
        await answer(expandTemplate(canned.template, rest.trim()), { kind: 'plugin', plugin: 'coding-cli' })
        continue
      }
      running = new AbortController()
      try {
        await runCommand(ctx, live.agent, trimmed, io, theme, running.signal)
      } finally {
        running = undefined
      }
      continue
    }
    await answer(trimmed)
  }
  await sessions.flush(live.agent.session)
  try {
    // Leave commands are how every session ends; recalling one is never the
    // reason a person pressed Up.
    const worthRecalling = prompt.history.filter(entry => entry !== '/exit' && entry !== '/quit')
    await writeFile(historyPath, `${JSON.stringify(worthRecalling)}\n`)
  } catch {
    // Losing the history file loses recall, never the session.
  }
  for (const dispose of disposers.splice(0)) dispose()
  prompt.setEngaged(false)
  leave(0)
}

/**
 * Report an unexpected surface failure and request a failing exit.
 * @param io - process-facing effects.
 * @param error - the failure.
 */
function fail(io: CliIo, error: unknown): void {
  // Close first: a message painted into a viewport that is about to be handed
  // back would vanish with it.
  io.console.close()
  io.console.writeAfterScreen(`codsh: ${error instanceof Error ? error.message : String(error)}`)
  io.exit(1)
}

/**
 * Mount the interactive terminal surface.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated invocation config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('coding-cli-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: CliIo = { console: new TerminalConsole(internals.input, internals.output), exit }
  // Last-resort restoration. Signals and crashes bypass every ordinary exit,
  // and a terminal left on the alternate screen with the mouse reporting is
  // unusable — a person would have to `reset` it.
  const restore = (): void => { io.console.leaveScreen() }
  process.once('exit', restore)
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      restore()
      process.exit(signal === 'SIGTERM' ? 143 : 129)
    })
  }
  void run(ctx, config, io).catch((error: unknown) => { fail(io, error) })
}
