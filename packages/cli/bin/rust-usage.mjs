/**
 * Session usage ledger for the isolated Rust client (ticket 65 / #197).
 *
 * One pure fold over durable dsh session events, used by the live control
 * plugin (`/usage`, `/cost`, the status line, `/session-info`, headless
 * results) and by the offline `codsh --rust usage <session-id>` reader, so
 * every surface shows the same explainable statistic.
 *
 * Counting follows the dsh attempt lifecycle (dsh-token-meter): `step/start`
 * and `llm/retry-started` open a billed attempt; `assistant/attempt`,
 * `assistant/message`, `llm/retry`, or `step/end` close it. Each closed attempt
 * is one model call. Its usage is the message's `usage`, else the last `usage`
 * chunk of its stream. A call with no usage sample is counted as unreported
 * and marks the ledger incomplete: it is never a zero. A second sample for the
 * same turn/step with no retry in between replaces the first, as in
 * dsh-token-meter. Model time mirrors dsh-session-stats `llmMs`: the attempt's
 * open event to its settlement.
 *
 * Session totals cover the whole conversation, including history a fork
 * inherited (the reference `usage` rule). A subagent child counts only its
 * own events: a context-forked child's inherited prefix is the parent's
 * calls, already counted in the parent. The whole durable log is re-folded
 * every time, so a resumed session is never double-counted.
 *
 * Subagent children (reference rule: every spawn folds into the parent) are
 * found through the parent's `subagent/catalog` events, folded recursively,
 * and attributed to the parent turn that spawned them. A child that is still
 * running or whose log cannot be read marks the ledger incomplete.
 *
 * Auxiliary side calls (the title model, compaction summaries, `/btw`,
 * memory extraction) are not session events and are not counted, the same
 * exception the reference makes for its side calls.
 *
 * Cost: dsh's TokenUsage carries no cost, and dsh-llm-pi-ai never reads the
 * catalog price metadata, so no surface ever sees a provider-reported bill.
 * The ledger reports cost as unknown. No price table is consulted, and an
 * estimate is never produced.
 */

export const COST_UNKNOWN_REASON = 'not reported by the provider'
export const MAX_SUBAGENT_DEPTH = 16

const BUCKET_KEYS = [
  'inputTokens',
  'uncachedInputTokens',
  'cachedReadTokens',
  'cacheCreationTokens',
  'outputTokens',
  'reasoningTokens',
  'totalTokens',
  'modelCalls',
  'unreportedCalls',
  'apiDurationMs',
]

export function emptyBuckets() {
  return Object.fromEntries(BUCKET_KEYS.map(key => [key, 0]))
}

function addBuckets(target, source, sign = 1) {
  for (const key of BUCKET_KEYS) target[key] += sign * (source[key] ?? 0)
  return target
}

const isCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * A provider usage sample as buckets, or undefined when it is malformed
 * (a malformed sample is an unreported call, never a zero).
 */
export function bucketsFromSample(sample) {
  if (sample === null || typeof sample !== 'object') return undefined
  const { inputTokens, outputTokens } = sample
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
  const cacheRead = sample.cacheReadTokens ?? 0
  const cacheWrite = sample.cacheWriteTokens ?? 0
  const reasoning = sample.reasoningTokens ?? 0
  if (!isCount(cacheRead) || !isCount(cacheWrite) || !isCount(reasoning)) return undefined
  const buckets = emptyBuckets()
  buckets.uncachedInputTokens = inputTokens
  buckets.cachedReadTokens = cacheRead
  buckets.cacheCreationTokens = cacheWrite
  buckets.inputTokens = inputTokens + cacheRead + cacheWrite
  buckets.outputTokens = outputTokens
  buckets.reasoningTokens = Math.min(reasoning, outputTokens)
  buckets.totalTokens = buckets.inputTokens + outputTokens
  return buckets
}

/** The last `usage` chunk of a durable assistant stream (dsh stream records). */
export function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    const chunk = record?.type === 'chunk' ? record.chunk : record
    if (chunk?.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') return chunk.usage
  }
  return undefined
}

function streamHasContent(stream) {
  return Array.isArray(stream) && stream.length > 0
}

function routeKey(route) {
  if (!route || !route.provider || !route.model) return 'unknown'
  return `${route.provider}/${route.model}`
}

/**
 * Fold one session log. Returns the session's own calls grouped per turn, the
 * children it spawned, and whether anything is still in flight.
 * @param {readonly object[]} events - full log, including an inherited prefix.
 * @param {number} inheritedEventCount - events before this seq belong to the fork parent.
 */
export function foldSessionEvents(events, inheritedEventCount = 0) {
  const turns = new Map()
  const children = []
  const totals = emptyBuckets()
  const byModel = new Map()
  let route
  let open = null
  let lastClosed = null
  let currentTurn = null
  let lastTurn = null
  let updatedAt = 0
  const own = (event, index) => (typeof event.seq === 'number' ? event.seq : index) >= inheritedEventCount

  const turnRow = (turn, time) => {
    let row = turns.get(turn)
    if (row === undefined) {
      row = { turnNumber: turn, startedAt: time ?? null, endedAt: null, endReason: null, open: false, own: emptyBuckets(), byModel: new Map(), children: [] }
      turns.set(turn, row)
    }
    return row
  }
  const apply = (call, buckets, sign) => {
    if (!call.own) return
    const row = turnRow(call.turn, call.startTime)
    addBuckets(totals, buckets, sign)
    addBuckets(row.own, buckets, sign)
    for (const map of [byModel, row.byModel]) {
      const key = call.model
      if (!map.has(key)) map.set(key, emptyBuckets())
      addBuckets(map.get(key), buckets, sign)
    }
  }
  const settle = (call, sample, time) => {
    const buckets = sample === undefined ? undefined : bucketsFromSample(sample)
    const contribution = buckets ?? emptyBuckets()
    contribution.modelCalls = 1
    if (buckets === undefined) contribution.unreportedCalls = 1
    contribution.apiDurationMs = Math.max(0, (time ?? call.startTime ?? 0) - (call.startTime ?? time ?? 0))
    call.contribution = contribution
    apply(call, contribution, 1)
    lastClosed = call
  }
  const reopenLast = (turn, step) => lastClosed !== null && lastClosed.turn === turn && lastClosed.step === step && open === null

  events.forEach((event, index) => {
    if (!event || typeof event !== 'object') return
    const data = event.data ?? {}
    const time = typeof event.time === 'number' ? event.time : undefined
    if (time !== undefined && own(event, index)) updatedAt = Math.max(updatedAt, time)
    switch (event.type) {
      case 'request/header': {
        const config = data.header?.config
        if (config?.provider && config?.model) route = { provider: String(config.provider), model: String(config.model) }
        break
      }
      case 'request/context':
        if (data.provider && data.model) route = { provider: String(data.provider), model: String(data.model) }
        break
      case 'turn/start':
        currentTurn = data.turn
        lastTurn = data.turn
        if (own(event, index)) {
          const row = turnRow(data.turn, time)
          row.startedAt = time ?? row.startedAt
          row.open = true
        }
        break
      case 'turn/end':
        if (turns.has(data.turn)) {
          const row = turns.get(data.turn)
          row.endedAt = time ?? null
          row.endReason = data.reason?.kind ?? null
          row.open = false
        }
        if (currentTurn === data.turn) currentTurn = null
        break
      case 'subagent/catalog':
        if (own(event, index) && typeof data.childId === 'string' && data.childId !== '') {
          children.push({ id: data.childId, turn: currentTurn ?? lastTurn, label: data.label ?? '' })
        }
        break
      case 'step/start':
        if (open !== null) settle(open, open.sample, time)
        open = { turn: data.turn, step: data.step, startTime: time, sample: undefined, model: routeKey(route), own: own(event, index) }
        lastClosed = null
        break
      case 'llm/retry-started':
        if (open !== null) settle(open, open.sample, time)
        open = { turn: data.turn, step: data.step, startTime: time, sample: undefined, model: routeKey(route), own: own(event, index) }
        lastClosed = null
        break
      case 'llm/retry':
        if (open !== null && open.turn === data.turn && open.step === data.step) {
          settle(open, open.sample, time)
          open = null
        }
        lastClosed = null
        break
      case 'assistant/attempt':
      case 'assistant/message': {
        const message = event.type === 'assistant/message'
        const sample = (message ? data.usage : undefined) ?? streamUsage(data.stream)
        const source = message ? data.message?.source : undefined
        const model = source?.provider && source?.model ? routeKey(source) : undefined
        if (open !== null && open.turn === data.turn && open.step === data.step) {
          if (model) open.model = model
          const call = open
          open = null
          settle(call, sample ?? call.sample, time)
        } else if (reopenLast(data.turn, data.step)) {
          // A second settlement for the same attempt replaces the first sample.
          if (sample !== undefined) {
            const call = lastClosed
            apply(call, call.contribution, -1)
            if (model) call.model = model
            settle(call, sample, time === undefined ? undefined : time)
          }
        } else if (message || sample !== undefined || streamHasContent(data.stream)) {
          // A settlement with no recorded opening still billed one request.
          const call = { turn: data.turn, step: data.step, startTime: time, sample: undefined, model: model ?? routeKey(route), own: own(event, index) }
          settle(call, sample, time)
        }
        break
      }
      case 'step/end':
        if (open !== null && open.turn === data.turn && open.step === data.step) {
          settle(open, open.sample, time)
          open = null
        }
        break
      default:
        break
    }
  })
  const openTurns = [...turns.values()].filter(row => row.open).map(row => row.turnNumber)
  return { totals, byModel, turns, children, inFlight: open !== null && open.own, openTurns, updatedAt }
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function mergeModels(target, source) {
  for (const [key, buckets] of source) {
    if (!target.has(key)) target.set(key, emptyBuckets())
    addBuckets(target.get(key), buckets)
  }
}

function modelRows(map) {
  const rows = {}
  for (const [key, buckets] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    rows[key] = { ...buckets, costUsdTicks: null, costReason: COST_UNKNOWN_REASON }
  }
  return rows
}

function summary(buckets, models, extra) {
  const incomplete = extra.reasons.length > 0 || buckets.unreportedCalls > 0
  const reasons = [...extra.reasons]
  if (buckets.unreportedCalls > 0) {
    reasons.unshift(`${buckets.unreportedCalls} model call${buckets.unreportedCalls === 1 ? '' : 's'} reported no token usage`)
  }
  return {
    ...buckets,
    numTurns: extra.numTurns,
    costUsdTicks: null,
    costIsPartial: false,
    costStatus: 'unknown',
    costReason: COST_UNKNOWN_REASON,
    usageIsIncomplete: incomplete,
    incompleteReasons: [...new Set(reasons)],
    modelUsage: modelRows(models),
    subagents: { sessions: extra.subagentSessions, ...extra.subagent },
  }
}

/**
 * Compose the ledger of a root session and every subagent child below it.
 * @param {string} sessionId
 * @param {(id: string) => Promise<{ events: readonly object[], inheritedEventCount?: number } | undefined>} load
 *   returns a session log, undefined when missing; it may throw when unreadable.
 * @param {{ sinceTime?: number }} options - `sinceTime` also reports the
 *   `prompt` slice: turns that started at or after this time.
 */
export async function composeLedger(sessionId, load, options = {}) {
  const root = await load(sessionId)
  if (root === undefined) throw new Error(`Session '${sessionId}' not found.`)
  // The root keeps its fork-inherited history (reference: session totals
  // include history inherited by resume or fork).
  const folded = foldSessionEvents(root.events ?? [], 0)
  const reasons = []
  const turnReasons = new Map()
  const subagent = emptyBuckets()
  const models = new Map(folded.byModel)
  const totals = addBuckets(emptyBuckets(), folded.totals)
  const turnRows = new Map([...folded.turns.entries()].map(([turn, row]) => [turn, {
    row,
    buckets: addBuckets(emptyBuckets(), row.own),
    subagent: emptyBuckets(),
    models: new Map(row.byModel),
    sessions: 0,
  }]))
  if (folded.inFlight) reasons.push('a model call is still in progress')
  let updatedAt = folded.updatedAt
  let subagentSessions = 0
  const seen = new Set([sessionId])
  const queue = folded.children.map(child => ({ ...child, rootTurn: child.turn, depth: 1 }))
  while (queue.length > 0) {
    const child = queue.shift()
    if (seen.has(child.id)) continue
    seen.add(child.id)
    const noteTurn = (reason) => {
      reasons.push(reason)
      if (child.rootTurn !== null && child.rootTurn !== undefined) {
        if (!turnReasons.has(child.rootTurn)) turnReasons.set(child.rootTurn, [])
        turnReasons.get(child.rootTurn).push(reason)
      }
    }
    if (child.depth > MAX_SUBAGENT_DEPTH) {
      noteTurn(`subagent ${child.id} is nested too deeply to count`)
      continue
    }
    let log
    try {
      log = await load(child.id)
    } catch (error) {
      noteTurn(`subagent ${child.id} log is unreadable: ${String(error?.message ?? error)}`)
      continue
    }
    if (log === undefined) {
      noteTurn(`subagent ${child.id} log was not found`)
      continue
    }
    subagentSessions += 1
    const inner = foldSessionEvents(log.events ?? [], log.inheritedEventCount ?? 0)
    if (inner.inFlight || inner.openTurns.length > 0) noteTurn(`subagent ${child.id} is still running`)
    updatedAt = Math.max(updatedAt, inner.updatedAt)
    addBuckets(totals, inner.totals)
    addBuckets(subagent, inner.totals)
    mergeModels(models, inner.byModel)
    const target = turnRows.get(child.rootTurn)
    if (target !== undefined) {
      addBuckets(target.buckets, inner.totals)
      addBuckets(target.subagent, inner.totals)
      mergeModels(target.models, inner.byModel)
      target.sessions += 1
    }
    for (const grandchild of inner.children) queue.push({ ...grandchild, rootTurn: child.rootTurn, depth: child.depth + 1 })
  }
  const session = summary(totals, models, {
    reasons,
    numTurns: folded.totals.modelCalls,
    subagentSessions,
    subagent,
  })
  const turns = [...turnRows.values()]
    .sort((a, b) => a.row.turnNumber - b.row.turnNumber)
    .map(({ row, buckets, subagent: childBuckets, models: turnModels, sessions }) => {
      const extraReasons = [...(turnReasons.get(row.turnNumber) ?? [])]
      if (row.open) extraReasons.push('this turn is still running')
      return {
        turnNumber: row.turnNumber,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        endReason: row.endReason,
        ...summary(buckets, turnModels, {
          reasons: extraReasons,
          numTurns: row.own.modelCalls,
          subagentSessions: sessions,
          subagent: childBuckets,
        }),
      }
    })
  const ledger = {
    sessionId,
    updatedAt: updatedAt > 0 ? new Date(updatedAt).toISOString() : null,
    session,
    turns,
  }
  if (typeof options.sinceTime === 'number' && Number.isFinite(options.sinceTime)) {
    ledger.prompt = sliceTurns(turns, options.sinceTime)
  }
  return ledger
}

/** Sum turn rows that started at or after `sinceTime` into one summary. */
export function sliceTurns(turns, sinceTime) {
  const picked = turns.filter(row => typeof row.startedAt === 'number' && row.startedAt >= sinceTime)
  const buckets = emptyBuckets()
  const subagent = emptyBuckets()
  const models = new Map()
  const reasons = []
  let numTurns = 0
  let sessions = 0
  for (const row of picked) {
    addBuckets(buckets, row)
    addBuckets(subagent, row.subagents)
    sessions += row.subagents.sessions
    numTurns += row.numTurns
    for (const reason of row.incompleteReasons) if (!/reported no token usage$/.test(reason)) reasons.push(reason)
    for (const [key, value] of Object.entries(row.modelUsage)) {
      if (!models.has(key)) models.set(key, emptyBuckets())
      addBuckets(models.get(key), value)
    }
  }
  return {
    turnNumbers: picked.map(row => row.turnNumber),
    ...summary(buckets, models, { reasons, numTurns, subagentSessions: sessions, subagent }),
  }
}
