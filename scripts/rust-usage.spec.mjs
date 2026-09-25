// Session usage ledger (ticket 65 / #197): the pure fold of
// packages/cli/bin/rust-usage.mjs and the control plugin's `usage` request.
import { describe, expect, it } from 'vitest'
import { COST_UNKNOWN_REASON, bucketsFromSample, composeLedger, foldSessionEvents, sliceTurns, streamUsage } from '../packages/cli/bin/rust-usage.mjs'
import { createControl } from '../packages/cli/bin/rust-acp-control.mjs'

const RICH = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 40, reasoningTokens: 50, totalTokens: 1540 }

/** A dsh-shaped log builder: seq and time advance with every event. */
function log(start = 1000) {
  const events = []
  let time = start
  const push = (type, data) => events.push({ type, seq: events.length, time: (time += 10), data })
  return {
    events,
    header(provider = 'cli-mock', model = 'cli-mock') { push('request/header', { header: { config: { provider, model } }, reason: 'initial' }) },
    turnStart(turn) { push('turn/start', { turn }) },
    turnEnd(turn, kind = 'completed') { push('turn/end', { turn, reason: { kind } }) },
    stepStart(turn, step) { push('step/start', { turn, step }) },
    stepEnd(turn, step) { push('step/end', { turn, step }) },
    message(turn, step, usage, { provider = 'cli-mock', model = 'cli-mock', inStream = false, interrupted } = {}) {
      const data = { turn, step, message: { role: 'assistant', source: { kind: 'model', provider, model }, content: [] }, stream: [] }
      if (usage && inStream) data.stream.push({ type: 'chunk', time, chunk: { type: 'usage', usage } })
      else if (usage) data.usage = usage
      if (interrupted) data.interrupted = true
      push('assistant/message', data)
    },
    attempt(turn, step, usage) {
      const stream = [{ type: 'chunk', time, chunk: { type: 'block-start', index: 0, blockType: 'text' } }]
      if (usage) stream.push({ type: 'chunk', time, chunk: { type: 'usage', usage } })
      push('assistant/attempt', { turn, step, stream })
    },
    retry(turn, step) { push('llm/retry', { turn, step, retry: 1 }) },
    retryStarted(turn, step) { push('llm/retry-started', { turn, step, retry: 1 }) },
    spawn(childId) { push('subagent/catalog', { version: 0, childId, mode: 'one-shot', label: 'probe' }) },
    turn(turn, usages) {
      this.turnStart(turn)
      usages.forEach((usage, index) => {
        this.stepStart(turn, index + 1)
        this.message(turn, index + 1, usage)
        this.stepEnd(turn, index + 1)
      })
      this.turnEnd(turn)
    },
  }
}

const loader = logs => async id => logs[id]

describe('rust-usage fold (ticket 65)', () => {
  it('counts input (with cache), output (with reasoning), totals, calls, and model time per model', () => {
    const l = log()
    l.header()
    l.turn(1, [RICH, { inputTokens: 5, outputTokens: 2 }])
    const folded = foldSessionEvents(l.events)
    expect(folded.totals).toMatchObject({
      inputTokens: 1345, uncachedInputTokens: 1005, cachedReadTokens: 300, cacheCreationTokens: 40,
      outputTokens: 202, reasoningTokens: 50, totalTokens: 1547, modelCalls: 2, unreportedCalls: 0,
    })
    expect(folded.totals.apiDurationMs).toBe(20)
    expect([...folded.byModel.keys()]).toEqual(['cli-mock/cli-mock'])
  })

  it('reads the usage chunk of the stream and rejects malformed samples as unreported', () => {
    expect(streamUsage([{ type: 'chunk', chunk: { type: 'usage', usage: RICH } }])).toEqual(RICH)
    expect(bucketsFromSample({ inputTokens: -1, outputTokens: 2 })).toBeUndefined()
    const l = log()
    l.turnStart(1)
    l.stepStart(1, 1)
    l.message(1, 1, RICH, { inStream: true })
    l.stepEnd(1, 1)
    l.stepStart(1, 2)
    l.message(1, 2, { inputTokens: 'x', outputTokens: 1 })
    l.stepEnd(1, 2)
    l.turnEnd(1)
    const folded = foldSessionEvents(l.events)
    expect(folded.totals.modelCalls).toBe(2)
    expect(folded.totals.unreportedCalls).toBe(1)
    expect(folded.totals.totalTokens).toBe(1540)
  })

  it('adds a retried attempt, and counts a failed attempt without usage as unreported (never zero)', () => {
    const l = log()
    l.turnStart(1)
    l.stepStart(1, 1)
    l.attempt(1, 1, { inputTokens: 10, outputTokens: 1 })
    l.retry(1, 1)
    l.retryStarted(1, 1)
    l.message(1, 1, { inputTokens: 10, outputTokens: 4 })
    l.stepEnd(1, 1)
    l.turnEnd(1)
    l.turnStart(2)
    l.stepStart(2, 1)
    l.attempt(2, 1, undefined)
    l.stepEnd(2, 1)
    l.turnEnd(2, 'error')
    const folded = foldSessionEvents(l.events)
    expect(folded.totals.modelCalls).toBe(3)
    expect(folded.totals.uncachedInputTokens).toBe(20)
    expect(folded.totals.outputTokens).toBe(5)
    expect(folded.totals.unreportedCalls).toBe(1)
    expect(folded.turns.get(2).endReason).toBe('error')
  })

  it('replaces a second sample for the same attempt instead of double counting', () => {
    const l = log()
    l.turnStart(1)
    l.stepStart(1, 1)
    l.attempt(1, 1, { inputTokens: 10, outputTokens: 1 })
    l.message(1, 1, { inputTokens: 10, outputTokens: 3 })
    l.stepEnd(1, 1)
    l.turnEnd(1)
    const folded = foldSessionEvents(l.events)
    expect(folded.totals.modelCalls).toBe(1)
    expect(folded.totals.outputTokens).toBe(3)
  })

  it('counts a cancelled step whose request never settled as an unreported call', () => {
    const l = log()
    l.turnStart(1)
    l.stepStart(1, 1)
    l.stepEnd(1, 1)
    l.turnEnd(1, 'cancelled')
    const folded = foldSessionEvents(l.events)
    expect(folded.totals).toMatchObject({ modelCalls: 1, unreportedCalls: 1, totalTokens: 0 })
  })

  it('keeps fork-inherited history in the root, skips it in a child, and re-folds after a resume (no double count)', async () => {
    const parent = log()
    parent.header()
    parent.turn(1, [RICH])
    const inherited = parent.events.length
    parent.turn(2, [{ inputTokens: 7, outputTokens: 3 }])
    // Reference: session totals include history inherited by resume or fork.
    const ledger = await composeLedger('fork', loader({ fork: { events: parent.events, inheritedEventCount: inherited } }))
    expect(ledger.session.totalTokens).toBe(1550)
    expect(ledger.turns.map(row => row.turnNumber)).toEqual([1, 2])
    // A child forked from the parent context counts only its own calls.
    const folded = foldSessionEvents(parent.events, inherited)
    expect(folded.totals.totalTokens).toBe(10)
    // A resumed session appends to the same log; folding it twice gives the same totals.
    const resumed = log()
    resumed.turn(1, [RICH])
    resumed.turn(2, [RICH])
    const once = await composeLedger('s', loader({ s: { events: resumed.events } }))
    const again = await composeLedger('s', loader({ s: { events: resumed.events } }))
    expect(once.session.totalTokens).toBe(3080)
    expect(again.session).toEqual(once.session)
  })

  it('folds subagent children (and grandchildren) into the spawning turn, numTurns stays the main loop', async () => {
    const root = log()
    root.turnStart(1)
    root.stepStart(1, 1)
    root.message(1, 1, RICH)
    root.spawn('child')
    root.stepEnd(1, 1)
    root.stepStart(1, 2)
    root.message(1, 2, RICH)
    root.stepEnd(1, 2)
    root.turnEnd(1)
    const child = log()
    child.header('narrow', 'narrow')
    child.turnStart(1)
    child.stepStart(1, 1)
    child.message(1, 1, { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, { provider: 'narrow', model: 'narrow' })
    child.spawn('grandchild')
    child.stepEnd(1, 1)
    child.turnEnd(1)
    const grandchild = log()
    grandchild.turn(1, [{ inputTokens: 1, outputTokens: 1 }])
    const ledger = await composeLedger('root', loader({ root: { events: root.events }, child: { events: child.events }, grandchild: { events: grandchild.events } }))
    expect(ledger.session.modelCalls).toBe(4)
    expect(ledger.session.numTurns).toBe(2)
    expect(ledger.session.subagents).toMatchObject({ sessions: 2, modelCalls: 2, totalTokens: 602 })
    expect(Object.keys(ledger.session.modelUsage)).toEqual(['cli-mock/cli-mock', 'narrow/narrow'])
    expect(ledger.session.modelUsage['narrow/narrow'].totalTokens).toBe(600)
    expect(ledger.turns[0]).toMatchObject({ turnNumber: 1, totalTokens: 3682, modelCalls: 4, numTurns: 2 })
    expect(ledger.session.usageIsIncomplete).toBe(false)
    expect(ledger.session.costUsdTicks).toBeNull()
    expect(ledger.session.costStatus).toBe('unknown')
    expect(ledger.session.costReason).toBe(COST_UNKNOWN_REASON)
  })

  it('marks missing, partial, running, and unreadable children incomplete', async () => {
    const root = log()
    root.turnStart(1)
    root.stepStart(1, 1)
    root.message(1, 1, RICH)
    root.spawn('silent')
    root.spawn('running')
    root.spawn('gone')
    root.spawn('broken')
    root.stepEnd(1, 1)
    root.turnEnd(1)
    const silent = log()
    silent.turn(1, [undefined])
    const running = log()
    running.turnStart(1)
    running.stepStart(1, 1)
    const ledger = await composeLedger('root', async (id) => {
      if (id === 'broken') throw new Error('corrupt')
      return { root: { events: root.events }, silent: { events: silent.events }, running: { events: running.events } }[id]
    })
    expect(ledger.session.usageIsIncomplete).toBe(true)
    expect(ledger.session.unreportedCalls).toBe(1)
    expect(ledger.session.incompleteReasons).toEqual([
      '1 model call reported no token usage',
      'subagent running is still running',
      'subagent gone log was not found',
      'subagent broken log is unreadable: corrupt',
    ])
    expect(ledger.session.totalTokens).toBe(1540)
    expect(ledger.session.costUsdTicks).toBeNull()
  })

  it('slices the turns a headless prompt started', async () => {
    const l = log(0)
    l.turn(1, [RICH])
    const since = l.events.at(-1).time + 1
    l.turn(2, [{ inputTokens: 4, outputTokens: 6 }])
    const ledger = await composeLedger('s', loader({ s: { events: l.events } }), { sinceTime: since })
    expect(ledger.prompt).toMatchObject({ turnNumbers: [2], totalTokens: 10, numTurns: 1, usageIsIncomplete: false })
    expect(sliceTurns(ledger.turns, 0).totalTokens).toBe(1550)
    await expect(composeLedger('none', loader({}))).rejects.toThrow("Session 'none' not found.")
  })
})

describe('rust-acp-control usage request (ticket 65)', () => {
  it('folds the live session and live children, and refuses an unknown session', async () => {
    const root = log()
    root.turnStart(1)
    root.stepStart(1, 1)
    root.message(1, 1, RICH)
    root.spawn('child')
    root.stepEnd(1, 1)
    root.turnEnd(1)
    const child = log()
    child.turn(1, [{ inputTokens: 5, outputTokens: 5 }])
    const sent = []
    const control = createControl({ llm: {} }, message => sent.push(message), {
      persistence: () => ({ open: async () => { throw Object.assign(new Error('not found'), { name: 'SessionPersistenceNotFoundError' }) } }),
    })
    control.onCreated({ session: { id: 'root', snapshotEvents: () => root.events, inheritedEventCount: 0 }, options: {} })
    control.trackSession({ id: 'child', snapshotEvents: () => child.events, inheritedEventCount: 0 })
    control.handle(JSON.stringify({ type: 'usage', id: 'u1', sessionId: 'root', turns: false }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sent.at(-1).type).toBe('usage_result')
    expect(sent.at(-1).ledger.session.totalTokens).toBe(1550)
    expect(sent.at(-1).ledger.turns).toBeUndefined()
    control.handle(JSON.stringify({ type: 'usage', id: 'u2', sessionId: 'nope' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sent.at(-1)).toEqual({ type: 'usage_error', id: 'u2', message: 'no live dsh session for usage' })
  })

  it('reads a child of an earlier process from the session store, and reports an unavailable store', async () => {
    const root = log()
    root.turnStart(1)
    root.stepStart(1, 1)
    root.message(1, 1, RICH)
    root.spawn('old-child')
    root.stepEnd(1, 1)
    root.turnEnd(1)
    const oldChild = log()
    oldChild.turn(1, [{ inputTokens: 2, outputTokens: 2 }])
    const sent = []
    const opened = []
    const control = createControl({ llm: {} }, message => sent.push(message), {
      persistence: () => ({
        open: async (id, mode) => {
          opened.push([id, mode])
          return { read: async () => ({ events: oldChild.events }), inheritedEventCount: 0, close: async () => {} }
        },
      }),
    })
    control.onCreated({ session: { id: 'root', snapshotEvents: () => root.events, inheritedEventCount: 0 }, options: {} })
    control.handle(JSON.stringify({ type: 'usage', id: 'u1', sessionId: 'root' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(opened).toEqual([['old-child', 'read']])
    expect(sent.at(-1).ledger.session.totalTokens).toBe(1544)
    const bare = createControl({ llm: {} }, message => sent.push(message))
    bare.onCreated({ session: { id: 'root', snapshotEvents: () => root.events, inheritedEventCount: 0 }, options: {} })
    bare.handle(JSON.stringify({ type: 'usage', id: 'u2', sessionId: 'root' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sent.at(-1).ledger.session.usageIsIncomplete).toBe(true)
    expect(sent.at(-1).ledger.session.incompleteReasons).toEqual(['subagent old-child log is unreadable: the dsh session store is not available'])
  })
})
