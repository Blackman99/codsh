/**
 * Plan mode, the question tool, and the todo gate for the Rust client
 * (ticket 179). dsh owns the state: `ctx.planMode` (dsh-plan-mode) keeps the
 * logged plan projection, `exit_plan_mode` asks for the review through
 * `ctx.userQuestions`, and `todo_write` appends `todo/write`. This plugin adds
 * what the reference has on top of that:
 *
 * - `enter_plan_mode`: the model asks to enter plan mode. The user approves
 *   through the normal approval prompt (`approval/request`); a decline leaves
 *   plan mode off.
 * - The plan file `$GROK_HOME/sessions/<encoded cwd>/<session-id>/plan.md`.
 *   `exit_plan_mode` saves the plan there; a call without a `#` plan reads it
 *   back from disk, and with no plan at all the review still opens with the
 *   empty state (approve / request changes / quit).
 * - The plan gate: while plan mode is on for a session, edits to any file but
 *   the plan file are refused before they run, in every permission mode.
 *   Bash is not inspected and subagents are not covered (reference contract).
 * - `CODSH_NO_PLAN=1` (--no-plan) removes enter/exit_plan_mode;
 *   `CODSH_NO_ASK_USER=1` (--no-ask-user, features.ask_user_question=false)
 *   removes ask_user_question.
 * - `CODSH_TODO_GATE=1` (--todo-gate): when the model ends a turn with todos
 *   still pending or in progress, it is sent back to work at most twice per
 *   prompt.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { importFromDsh } from './rust-acp-dsh.mjs'
import { accessFromTool } from './rust-acp-file-approval.mjs'
const { createUserMessage } = await importFromDsh('@deepseek-ai/dsh-llm')
const { defineTool } = await importFromDsh('@deepseek-ai/dsh-tools')

export const name = 'rust-acp-plan'
export const inject = ['tools', 'systemPrompt', 'planMode', 'sessionProjections']

export const ENTER_PLAN_MODE = 'enter_plan_mode'
export const EXIT_PLAN_MODE = 'exit_plan_mode'
export const ASK_USER_QUESTION = 'ask_user_question'
export const DECLINED_TEXT = 'User declined to enter plan mode.'
export const TODO_GATE_MAX_FIRES = 2
const ENTER_DESCRIPTION = 'Ask the user to switch this session into plan mode before you implement a task with genuine ambiguity about the right approach (several reasonable designs, unclear requirements, or high-impact restructuring). Skip it for clear, small, or conventional changes. The user must approve; in plan mode only the plan file may be edited, and you present the plan with exit_plan_mode.'
const APPROVED_TEXT = 'Plan approved — plan mode exited; carry out the plan starting with your next step.'

/** Same bytes as the Rust client's `interaction::encode_cwd_dirname`. */
export function encodeCwdDirname(cwd) {
  let out = ''
  for (const byte of Buffer.from(String(cwd), 'utf8')) {
    const ch = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  if (out.length <= 255) return out
  let slug = ''
  let dash = false
  for (const ch of basename(String(cwd)) || 'workspace') {
    if (/[A-Za-z0-9]/.test(ch)) {
      slug += ch.toLowerCase()
      dash = false
    } else if (!dash && slug !== '') {
      slug += '-'
      dash = true
    }
    if (slug.length >= 40) break
  }
  slug = slug.replace(/-+$/, '') || 'workspace'
  return `${slug}-${createHash('sha256').update(String(cwd)).digest('hex').slice(0, 16)}`
}

/** `plan.md` for a session. CODSH_PLAN_ROOT comes from the Rust client. */
export function planFilePath(sessionId, env = process.env, cwd = process.cwd()) {
  const root = env.CODSH_PLAN_ROOT
    || join(env.GROK_HOME || join(homedir(), '.grok'), 'sessions', encodeCwdDirname(cwd))
  return join(root, String(sessionId), 'plan.md')
}

export function hasHeading(plan) {
  return /^#\s+\S/.test(String(plan ?? '').trim())
}

export function readPlan(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export function writePlan(path, plan) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, plan.endsWith('\n') ? plan : `${plan}\n`, { mode: 0o600 })
}

/** Plan mode is on, or selected to be on, for this agent's session. */
export function planActive(planMode, agent) {
  if (planMode === undefined || agent === undefined) return false
  try {
    const state = planMode.get(agent)
    return state.pending ?? state.active
  } catch {
    return false
  }
}

function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.session?.header?.id
}

/** Same path, ignoring a trailing slash and `./` segments. */
function samePath(a, b) {
  const norm = (p) => String(p ?? '').replace(/\/+$/, '').replace(/\/\.\//g, '/')
  return norm(a) !== '' && norm(a) === norm(b)
}

/**
 * The plan gate decision for one tool call, or undefined when it does not apply.
 * @returns {{kind: 'deny', reason: string} | {kind: 'plan-file'} | undefined}
 */
export function planGate(active, toolName, args, planFile) {
  if (!active) return undefined
  const access = accessFromTool(toolName, args ?? {})
  if (access.kind !== 'edit') return undefined
  if (samePath(access.path, planFile)) return { kind: 'plan-file' }
  return {
    kind: 'deny',
    reason: `Plan mode is read-only: only the plan file ${planFile} can be edited until the plan is approved with exit_plan_mode.`,
  }
}

/** Todos still owed at turn end, or null when the gate stays quiet. */
export function todoGateReminder(todos) {
  if (!Array.isArray(todos)) return null
  const pending = todos.filter(todo => todo?.status === 'pending').map(todo => todo.content)
  const active = todos.filter(todo => todo?.status === 'in_progress').map(todo => todo.content)
  if (pending.length === 0 && active.length === 0) return null
  let text = 'You have outstanding todos but ended your turn without a tool call.\n\n'
  if (active.length > 0) text += `In-progress:\n${active.map(item => `- ${item}`).join('\n')}\n\n`
  if (pending.length > 0) text += `Pending:\n${pending.map(item => `- ${item}`).join('\n')}\n\n`
  text += 'Advance the next pending todo with the appropriate tool call NOW. If you have a genuine external blocker (missing credential, denied permission, network unreachable), state it explicitly and update the list with todo_write in the same turn.'
  return text
}

export function apply(ctx) {
  const noPlan = process.env.CODSH_NO_PLAN === '1'
  const noAsk = process.env.CODSH_NO_ASK_USER === '1'
  const todoGate = process.env.CODSH_TODO_GATE === '1'
  const planMode = ctx.planMode

  if (!noPlan) {
    ctx.tools.register(defineTool({
      name: ENTER_PLAN_MODE,
      description: ENTER_DESCRIPTION,
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { planFile: { type: 'string', required: true } },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Plan mode is on. Explore read-only, write the plan (you may edit only ${value.planFile}), then present the complete plan with exit_plan_mode.`,
        }],
      },
      execute: async (_args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error(`${ENTER_PLAN_MODE} requires a calling agent`)
        if (planActive(planMode, agent)) throw new Error('Plan mode is already on.')
        const answer = await ctx.waterfall('approval/request', {
          agent,
          toolName: ENTER_PLAN_MODE,
          callId: exec.callId,
          reason: 'Enter plan mode? y=approve  n=stay in normal mode',
        }, () => 'unavailable')
        if (answer !== 'allowed-once' && answer !== 'allowed-always' && answer !== 'allowed-session') {
          throw new Error(DECLINED_TEXT)
        }
        planMode.set(agent, true)
        return { planFile: planFilePath(sessionIdOf(agent)) }
      },
      presentCall: () => ({ card: 'generic', title: 'Enter plan mode', kind: 'other' }),
    }))
  }

  // Deny before the permission listener runs, so an out-of-plan edit never
  // prompts; the monotonic guard below is the backstop no listener can undo.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (noPlan && (exec.name === ENTER_PLAN_MODE || exec.name === EXIT_PLAN_MODE)) {
      return { kind: 'deny', reason: `--no-plan removed ${exec.name}` }
    }
    if (noAsk && exec.name === ASK_USER_QUESTION) {
      return { kind: 'deny', reason: `ask_user_question is disabled for this session` }
    }
    const gate = planGate(planActive(planMode, exec.agent), exec.name, exec.arguments, planFilePath(sessionIdOf(exec.agent)))
    if (gate?.kind === 'deny') return { kind: 'deny', reason: gate.reason }
    return next()
  }, true)
  ctx.tools.guard((exec) => {
    const gate = planGate(planActive(planMode, exec.agent), exec.name, exec.arguments, planFilePath(sessionIdOf(exec.agent)))
    return gate?.kind === 'deny' ? gate.reason : undefined
  })

  // exit_plan_mode: save the plan; read it back from disk when the call has
  // none; review an empty plan instead of refusing it.
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== EXIT_PLAN_MODE || noPlan) return next()
    const agent = exec.agent
    if (agent === undefined) return next()
    let logged = false
    try {
      logged = planMode.get(agent).active
    } catch {
      return next()
    }
    if (!logged) return next()
    const file = planFilePath(sessionIdOf(agent))
    const given = typeof exec.arguments?.plan === 'string' ? exec.arguments.plan : ''
    if (hasHeading(given)) {
      try {
        writePlan(file, given.trim())
      } catch (error) {
        ctx.logger?.warn?.(`rust-acp-plan: could not save ${file}: ${String(error?.message ?? error)}`)
      }
      return next()
    }
    const disk = readPlan(file)
    if (hasHeading(disk)) {
      exec.arguments = { ...exec.arguments, plan: disk.trim() }
      return next()
    }
    // No plan anywhere. The review still opens with the empty state.
    const review = ctx.get('userQuestions')
    if (review === undefined) return next()
    try {
      const answer = await review.ask({
        questions: [{
          id: 'plan-review',
          header: 'Plan review',
          question: 'No plan written yet. Approve and start implementing?',
          detail: given.trim(),
          options: [
            { label: 'Approve', description: 'Leave plan mode and start implementing.' },
            { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
          ],
          intent: { kind: 'plan-review', approve: 'Approve' },
        }],
        agent,
        signal: exec.signal,
      })
      const item = answer.answers.find(entry => entry.id === 'plan-review')
      if (item?.selected?.length === 1 && item.selected[0] === 'Approve' && item.custom === undefined) {
        planMode.set(agent, false)
        return { isError: false, value: { approved: true } }
      }
      const feedback = item?.custom ?? ''
      return failure(feedback === ''
        ? 'The user chose to keep planning; write the plan and present it again.'
        : `The user chose to keep planning; their feedback: ${feedback}`)
    } catch (error) {
      if (error?.code === 'ASK_CANCELLED') {
        return failure('The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.')
      }
      return failure(String(error?.message ?? error))
    }
  })

  ctx.systemPrompt.section({
    name: 'codsh:plan-file',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined || !planActive(planMode, agent)) return ''
      return `Plan file for this session: ${planFilePath(sessionIdOf(agent))}. It is the only file you may edit in plan mode; edits to any other file are refused. exit_plan_mode saves the plan you present there.`
    },
  })

  const fires = new WeakMap()
  ctx.on('agent/created', ({ agent }) => {
    const deny = []
    const has = (tool) => {
      try {
        return Boolean(agent.ctx.tools.get(tool))
      } catch {
        return false
      }
    }
    if (noPlan) deny.push(...[ENTER_PLAN_MODE, EXIT_PLAN_MODE].filter(has))
    if (noAsk && has(ASK_USER_QUESTION)) deny.push(ASK_USER_QUESTION)
    if (deny.length > 0) {
      try {
        agent.ctx.tools.restrict({ deny })
      } catch (error) {
        ctx.logger?.warn?.(`rust-acp-plan: restrict failed: ${String(error?.message ?? error)}`)
      }
    }
  })
  if (todoGate) {
    ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      if (agent === undefined || isChild(agent) || planActive(planMode, agent)) return
      let todos
      try {
        todos = ctx.sessionProjections.stateOf(agent.session, 'todos')
      } catch {
        return
      }
      const reminder = todoGateReminder(todos)
      if (reminder === null) return
      const seen = fires.get(agent)
      const count = seen?.turn === turn ? seen.count : 0
      if (count >= TODO_GATE_MAX_FIRES) return
      fires.set(agent, { turn, count: count + 1 })
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: reminder }],
        source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'todo gate: outstanding todos' },
      }))
    })
  }
}

function isChild(agent) {
  const runtime = agent?.options?.subagentDepth
  const header = agent?.session?.header?.delegationDepth
  return (Number.isSafeInteger(runtime) && runtime > 0) || (Number.isSafeInteger(header) && header > 0)
}

function failure(message) {
  return {
    isError: true,
    error: { message },
    content: [{ type: 'text', text: `Error: ${message}` }],
  }
}

export { APPROVED_TEXT }
