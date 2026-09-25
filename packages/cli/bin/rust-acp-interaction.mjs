/**
 * The question card, plan review, plan state, and todos over the private
 * control channel (ticket 179). Used by rust-acp-control.mjs.
 *
 * dsh asks the human through the `user-questions/request` waterfall
 * (`ask_user_question`, and `exit_plan_mode`'s review). In the terminal UI
 * (CODSH_INTERACTION=tui) this answerer sends the questions to the Rust
 * client and waits for the card: an answer, a dismissal, `q` in the plan
 * review, the configured timeout, or the turn being cancelled. Each question
 * resolves once; a late or duplicate answer is refused as stale.
 *
 * Without a terminal (plain prompts, the editor ACP server) no one can
 * answer: `ask_user_question` returns the reference no-operator text and a
 * plan review is approved, as the reference does headless.
 */
import { randomUUID } from 'node:crypto'
import { importFromDsh } from './rust-acp-dsh.mjs'
import { planFilePath } from './rust-acp-plan.mjs'
const { createUserMessage } = await importFromDsh('@deepseek-ai/dsh-llm')

export const NO_OPERATOR_TEXT = 'No user is available to answer questions in this non-interactive session. Continue with your best judgment; do not wait for clarification.'
export const CANCEL_TEXT = 'User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.'
export const QUIT_TEXT = 'The user quit the plan review: the plan was abandoned and plan mode is off. Do not implement it; stop here and wait for their message.'
export const APPROVED_COMMENTS_PREFIX = 'Plan approved with comments. Apply them while you implement:'

/** A UserQuestionError shape dsh restores by name, code, and message. */
export function questionError(code, message) {
  const error = new Error(message)
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

function isReview(question) {
  return question?.intent?.kind === 'plan-review'
}

/** Keep answers for known question ids and offered labels only. */
export function cleanAnswers(questions, answers) {
  const byId = new Map(questions.map(question => [question.id, question]))
  const out = []
  for (const answer of Array.isArray(answers) ? answers : []) {
    const question = byId.get(answer?.id)
    if (question === undefined || out.some(item => item.id === answer.id)) continue
    const labels = new Set((question.options ?? []).map(option => option.label))
    const selected = (Array.isArray(answer.selected) ? answer.selected : [])
      .filter(label => typeof label === 'string' && labels.has(label))
    const multi = question.multiSelect === true
    const item = { id: answer.id, selected: multi ? [...new Set(selected)] : selected.slice(0, 1) }
    if (typeof answer.custom === 'string' && answer.custom.trim() !== '') item.custom = answer.custom.trim()
    out.push(item)
  }
  return out
}

/** Questions as the card needs them. */
function wireQuestions(questions) {
  return questions.map(question => ({
    id: question.id,
    question: question.question ?? '',
    ...(question.header !== undefined ? { header: question.header } : {}),
    options: (question.options ?? []).map(option => ({ label: option.label, description: option.description ?? '' })),
    multiSelect: question.multiSelect === true,
  }))
}

function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.session?.header?.id
}

/**
 * @param {object} ctx - cordis context (`planMode`, `sessionProjections` via ctx.get).
 * @param {(message: object) => void} send - writes one control message.
 * @param {{ interactive: boolean, timeoutSecs: number, agents: Map<string, any>, env?: object }} options
 */
export function createInteraction(ctx, send, options) {
  const { interactive, agents } = options
  const timeoutMs = Math.max(0, Number(options.timeoutSecs) || 0) * 1000
  const env = options.env ?? process.env
  const open = new Map()
  const lastPlan = new Map()
  const lastTodos = new Map()

  const planMode = () => ctx.get('planMode')
  const projections = () => ctx.get('sessionProjections')

  const settle = (id, outcome) => {
    const entry = open.get(id)
    if (entry === undefined) return false
    open.delete(id)
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener?.('abort', entry.onAbort)
    outcome(entry)
    return true
  }

  const planState = (agent) => {
    const sessionId = sessionIdOf(agent)
    let state = { active: false }
    try {
      state = planMode()?.get(agent) ?? state
    } catch {
      // No projection yet: the session has not loaded.
    }
    return { sessionId, active: Boolean(state.active), pending: state.pending, planFile: planFilePath(sessionId, env) }
  }

  const sendPlanState = (agent, force = false) => {
    if (!interactive || agent === undefined) return
    const state = planState(agent)
    const key = JSON.stringify(state)
    if (!force && lastPlan.get(state.sessionId) === key) return
    lastPlan.set(state.sessionId, key)
    send({ type: 'plan_state', sessionId: state.sessionId, active: state.active, ...(state.pending !== undefined ? { pending: state.pending } : {}), planFile: state.planFile })
  }

  const sendTodos = (session, force = false) => {
    if (!interactive || session === undefined) return
    let todos = null
    try {
      todos = projections()?.stateOf(session, 'todos') ?? null
    } catch {
      todos = null
    }
    const sessionId = session.id ?? session.header?.id
    const key = JSON.stringify(todos)
    if (!force && lastTodos.get(sessionId) === key) return
    lastTodos.set(sessionId, key)
    send({ type: 'todos', sessionId, todos })
  }

  /** The `user-questions/request` answerer. */
  const ask = (request, next) => {
    const agent = request.agent
    const sessionId = sessionIdOf(agent)
    if (agent === undefined || agents.get(sessionId) !== agent) return next()
    const questions = Array.isArray(request.questions) ? request.questions : []
    const review = questions.length === 1 && isReview(questions[0]) ? questions[0] : undefined
    if (!interactive) {
      // Reference headless: no one answers questions; a plan review is approved.
      if (review !== undefined) return Promise.resolve({ answers: [{ id: review.id, selected: [review.intent.approve] }] })
      return Promise.reject(questionError('NO_OPERATOR', NO_OPERATOR_TEXT))
    }
    if (request.signal?.aborted) return Promise.reject(questionError('ASK_ABORTED', 'ask_user_question was aborted before the user answered'))
    if (options.connected !== undefined && !options.connected()) {
      return Promise.reject(questionError('NO_OPERATOR', `The question card is unavailable (the client control channel is closed). ${NO_OPERATOR_TEXT}`))
    }
    const id = `q-${randomUUID()}`
    return new Promise((resolve, reject) => {
      const entry = { id, agent, questions, review, resolve, reject, signal: request.signal, timer: undefined, onAbort: undefined }
      entry.onAbort = () => {
        if (settle(id, item => item.reject(questionError('ASK_ABORTED', 'ask_user_question was aborted before the user answered')))) {
          send({ type: 'question_closed', id, reason: 'aborted' })
        }
      }
      request.signal?.addEventListener?.('abort', entry.onAbort, { once: true })
      // A plan review waits for the user; only questions time out.
      if (timeoutMs > 0 && review === undefined) {
        entry.timer = setTimeout(() => {
          if (settle(id, item => item.reject(questionError('ASK_TIMEOUT', CANCEL_TEXT)))) {
            send({ type: 'question_closed', id, reason: 'timeout' })
          }
        }, timeoutMs)
        entry.timer.unref?.()
      }
      open.set(id, entry)
      const message = { type: 'question', id, sessionId, questions: wireQuestions(questions) }
      if (review !== undefined) {
        message.review = { plan: String(review.detail ?? ''), planFile: planFilePath(sessionId, env) }
      }
      send(message)
    })
  }

  const stale = (id) => send({ type: 'question_closed', id, reason: 'stale' })

  const handle = (request) => {
    switch (request.type) {
      case 'question_answer': {
        const done = settle(request.id, (entry) => {
          const answers = cleanAnswers(entry.questions, request.answers)
          entry.resolve({ answers })
          const comments = typeof request.comments === 'string' ? request.comments.trim() : ''
          const approved = entry.review !== undefined
            && answers.some(answer => answer.selected[0] === entry.review.intent.approve && answer.custom === undefined)
          if (approved && comments !== '') {
            // The approval stays an approval; the comments follow as the
            // user's next message in the same turn.
            entry.agent.steer(createMessage(`${APPROVED_COMMENTS_PREFIX}\n${comments}`))
          }
        })
        if (!done) stale(request.id)
        return true
      }
      case 'question_dismiss':
        if (!settle(request.id, entry => entry.reject(questionError('ASK_CANCELLED', CANCEL_TEXT))))
          stale(request.id)
        return true
      case 'plan_quit':
        if (!settle(request.id, (entry) => {
          try {
            planMode()?.set(entry.agent, false)
          } catch (error) {
            ctx.logger?.warn?.(`rust-acp-interaction: plan quit: ${String(error?.message ?? error)}`)
          }
          entry.reject(questionError('PLAN_ABANDONED', QUIT_TEXT))
          sendPlanState(entry.agent)
        })) stale(request.id)
        return true
      case 'plan_set': {
        const agent = agents.get(request.sessionId)
        if (agent === undefined) {
          send({ type: 'plan_result', id: request.id, outcome: 'error', message: 'no live dsh session for plan mode yet; send a prompt first' })
          return true
        }
        if (env.CODSH_NO_PLAN === '1') {
          send({ type: 'plan_result', id: request.id, outcome: 'error', message: 'plan mode is disabled for this session (--no-plan)' })
          return true
        }
        try {
          const outcome = planMode().set(agent, request.active === true)
          send({ type: 'plan_result', id: request.id, outcome, message: '' })
        } catch (error) {
          send({ type: 'plan_result', id: request.id, outcome: 'error', message: String(error?.message ?? error) })
        }
        sendPlanState(agent, true)
        return true
      }
      default:
        return false
    }
  }

  return {
    open,
    ask,
    handle,
    onCreated(agent) {
      sendPlanState(agent, true)
      sendTodos(agent.session, true)
    },
    onSessionEvent(session, event) {
      const agent = agents.get(session?.id ?? session?.header?.id)
      if (agent === undefined || agent.session !== session) return
      if (event?.type === 'todo/write' || event?.type === 'turn/start') sendTodos(session)
      sendPlanState(agent)
    },
    onDisposed(agent) {
      for (const [id, entry] of open) {
        if (entry.agent !== agent) continue
        settle(id, item => item.reject(questionError('ASK_ABORTED', 'the session closed before the user answered')))
        send({ type: 'question_closed', id, reason: 'aborted' })
      }
    },
    close() {
      for (const id of [...open.keys()]) {
        settle(id, item => item.reject(questionError('ASK_ABORTED', 'the client closed before the user answered')))
      }
    },
  }
}

function createMessage(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
