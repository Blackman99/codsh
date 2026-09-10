/**
 * Replay clocks for thinking folds: step thinking time and step total time,
 * indexed off the session log rather than remembered from the live turn.
 * @module codsh-bundle/src/replay-timing
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Lookup functions for thinking duration and turn duration on replay. */
export interface ReplayTiming {
  stepThinkingSeconds: (turn: number, step: number, messageTime?: number) => number | undefined
  stepTotalSeconds: (turn: number, step: number) => number | undefined
}

/**
 * Index step and turn boundary timestamps to restore thinking and turn clocks on replay.
 * @param events - the session snapshot events.
 * @returns lookup functions for thinking duration and turn duration.
 */
export function indexReplayTiming(events: readonly SessionEvent[]): ReplayTiming {
  const stepStarts = new Map<string, number>()
  const stepEnds = new Map<string, number>()
  const reasoningEnds = new Map<string, number>()
  const maxStepEventTimes = new Map<string, number>()

  for (const event of events) {
    if (typeof event.time !== 'number' || event.time <= 0) continue

    const turn = (event.data as { turn?: unknown }).turn
    const step = (event.data as { step?: unknown }).step
    if (typeof turn === 'number' && typeof step === 'number') {
      const key = `${turn}:${step}`
      const prevMax = maxStepEventTimes.get(key) ?? 0
      if (event.time > prevMax) maxStepEventTimes.set(key, event.time)
    }

    if (event.type === 'step/start' && typeof turn === 'number' && typeof step === 'number') {
      stepStarts.set(`${turn}:${step}`, event.time)
    } else if (event.type === 'step/end' && typeof turn === 'number' && typeof step === 'number') {
      stepEnds.set(`${turn}:${step}`, event.time)
    } else if (event.type === 'assistant/chunk' && typeof turn === 'number' && typeof step === 'number') {
      const key = `${turn}:${step}`
      const chunk = (event.data as { chunk?: { type?: string; block?: { type?: string } } }).chunk
      if (chunk?.type === 'reasoning-delta') {
        reasoningEnds.set(key, event.time)
      } else if (chunk?.type === 'block-end' && chunk.block?.type === 'reasoning') {
        reasoningEnds.set(key, event.time)
      } else if (chunk?.type === 'text-delta' || chunk?.type === 'tool-call-delta') {
        if (!reasoningEnds.has(key)) reasoningEnds.set(key, event.time)
      }
    }
  }

  const stepThinkingSeconds = (turn: number, step: number, messageTime?: number): number | undefined => {
    const key = `${turn}:${step}`
    const start = stepStarts.get(key)
    const end = reasoningEnds.get(key) ?? messageTime
    if (start !== undefined && end !== undefined && end > start) {
      return (end - start) / 1000
    }
    return undefined
  }

  const stepTotalSeconds = (turn: number, step: number): number | undefined => {
    const key = `${turn}:${step}`
    const start = stepStarts.get(key)
    const end = stepEnds.get(key) ?? maxStepEventTimes.get(key)
    if (start !== undefined && end !== undefined && end > start) {
      return (end - start) / 1000
    }
    return undefined
  }

  return { stepThinkingSeconds, stepTotalSeconds }
}
