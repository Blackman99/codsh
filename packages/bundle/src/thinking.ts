/**
 * Thinking level configuration and persistence: `/thinking` and `/effort`.
 *
 * Reasoning models expose distinct deliberation depths (e.g. `off`, `low`,
 * `high`, `max`). This module manages parsing user inputs, resolving default
 * and shortcut levels, and persisting per-model thinking preferences.
 * @module codsh-bundle/src/thinking
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import type { SelectOption } from './selector.js'

/** Map of model keys (`${provider}/${model}` or `${model}`) to reasoning effort IDs. */
export type ThinkingPrefMap = Record<string, ReasoningEffortId>

/** Standard preferences filename under DSH home directory. */
export const THINKING_PREFS_FILE = 'code-cli-thinking.json'

/**
 * Build a canonical key for per-model persistence.
 * @param provider - LLM provider identifier.
 * @param model - Model identifier.
 */
export function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * Retrieve saved thinking preference for a model, checking canonical key first
 * then model name fallback.
 */
export function getThinkingPref(
  prefs: ThinkingPrefMap,
  provider: string,
  model: string,
): ReasoningEffortId | undefined {
  return prefs[modelKey(provider, model)] ?? prefs[model]
}

/**
 * Parse raw thinking level string, returning non-empty trimmed string or undefined.
 */
export function parseThinkingLevel(raw: string): string | undefined {
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Check whether reasoning capabilities are advertised for a model route.
 */
export function isReasoningSupported(reasoning: LlmModelReasoningInfo | undefined): boolean {
  return reasoning !== undefined && reasoning.efforts.length > 0
}

/** Discriminated union result of resolving a user effort choice. */
export type ResolveEffortResult =
  | { ok: true; effort: ReasoningEffortId }
  | { ok: false; error: string }

/**
 * Resolve user input (`on`, `off`, or explicit level ID/name) against the active
 * model's supported reasoning metadata.
 *
 * - `off`: resolves to `ReasoningEffortId('off')`.
 * - `on`: resolves to advertised non-off `defaultEffort`, or `high`, or first available non-off effort.
 * - `<level>`: matches case-insensitively against supported effort IDs or names.
 */
export function resolveEffortChoice(
  input: string,
  reasoning: LlmModelReasoningInfo | undefined,
): ResolveEffortResult {
  const trimmed = input.trim()
  if (trimmed === '') {
    return { ok: false, error: 'Thinking level cannot be empty' }
  }

  if (!isReasoningSupported(reasoning) || reasoning === undefined) {
    return { ok: false, error: 'Model does not support configurable thinking' }
  }

  const lower = trimmed.toLowerCase()

  if (lower === 'off') {
    return { ok: true, effort: ReasoningEffortId('off') }
  }

  if (lower === 'on') {
    // 1. Advertised non-off default effort
    if (reasoning.defaultEffort !== undefined && reasoning.defaultEffort.toLowerCase() !== 'off') {
      const matched = reasoning.efforts.find(e => e.id.toLowerCase() === reasoning.defaultEffort?.toLowerCase())
      if (matched !== undefined) {
        return { ok: true, effort: matched.id }
      }
    }

    // 2. Fallback to 'high' if available
    const highEffort = reasoning.efforts.find(e => e.id.toLowerCase() === 'high')
    if (highEffort !== undefined) {
      return { ok: true, effort: highEffort.id }
    }

    // 3. First non-off effort
    const firstNonOff = reasoning.efforts.find(e => e.id.toLowerCase() !== 'off')
    if (firstNonOff !== undefined) {
      return { ok: true, effort: firstNonOff.id }
    }

    return { ok: false, error: 'Model does not have an active thinking level' }
  }

  // Exact or case-insensitive match against supported IDs or names
  const matched = reasoning.efforts.find(
    e => e.id.toLowerCase() === lower || e.name.toLowerCase() === lower,
  )
  if (matched !== undefined) {
    return { ok: true, effort: matched.id }
  }

  const available = reasoning.efforts.map(e => e.id).join(', ')
  return {
    ok: false,
    error: `Unknown thinking level: ${trimmed}. Available levels: ${available}`,
  }
}

/**
 * Load persisted thinking preferences from disk.
 * @param filePath - Path to `code-cli-thinking.json`.
 * @returns Map of model keys to preferred reasoning effort IDs.
 */
export async function loadThinkingPrefs(filePath: string): Promise<ThinkingPrefMap> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(content)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const result: ThinkingPrefMap = {}
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'string' && val.trim() !== '') {
        result[key] = ReasoningEffortId(val.trim())
      }
    }
    return result
  } catch {
    return {}
  }
}

/**
 * Write thinking preferences map to disk.
 */
export async function saveThinkingPrefs(
  filePath: string,
  prefs: ThinkingPrefMap,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8')
}

/**
 * Save one model's thinking preference to disk, merging with existing entries.
 */
export async function saveThinkingPref(
  filePath: string,
  key: string,
  effort: string | ReasoningEffortId,
): Promise<void> {
  const current = await loadThinkingPrefs(filePath)
  current[key] = ReasoningEffortId(effort)
  await saveThinkingPrefs(filePath, current)
}

/**
 * Build interactive selector options from model reasoning metadata.
 * @param reasoning - Active model's reasoning info.
 * @param activeEffort - Currently selected reasoning effort, if any.
 */
export function buildThinkingOptions(
  reasoning: LlmModelReasoningInfo,
  activeEffort?: string,
): SelectOption[] {
  return reasoning.efforts.map((entry) => {
    const active = entry.id.toLowerCase() === activeEffort?.toLowerCase()
    return {
      label: entry.id,
      detail: active ? `${entry.name} · current` : (entry.description ?? entry.name),
    }
  })
}

/**
 * Format reasoning effort levels for non-TTY environments.
 * @param reasoning - Active model's reasoning info.
 * @param activeEffort - Currently selected reasoning effort, if any.
 */
export function formatThinkingList(
  reasoning: LlmModelReasoningInfo,
  activeEffort?: string,
): string {
  const currentEffort = activeEffort ?? (reasoning.defaultEffort !== undefined ? `default (${reasoning.defaultEffort})` : 'default')
  const header = `current thinking: ${currentEffort}`
  const rows = reasoning.efforts.map((entry) => {
    const active = entry.id.toLowerCase() === activeEffort?.toLowerCase()
    return `${active ? '❯' : ' '} ${entry.id}  ${entry.name}`
  })
  return `${header}\n${rows.join('\n')}`
}

/**
 * Generate autocompletion candidates for `/thinking` and `/effort` commands.
 * @param reasoning - Active model's reasoning info, or undefined when unsupported.
 * @param activeEffort - Currently selected reasoning effort, if any.
 */
export function thinkingArgumentCandidates(
  reasoning: LlmModelReasoningInfo | undefined,
  activeEffort?: string,
): { value: string; detail: string }[] {
  if (!isReasoningSupported(reasoning) || reasoning === undefined) {
    return []
  }
  const candidates: { value: string; detail: string }[] = []
  candidates.push({ value: 'on', detail: 'enable reasoning' })
  const hasOff = reasoning.efforts.some(e => e.id.toLowerCase() === 'off')
  if (!hasOff) {
    const isOffCurrent = activeEffort?.toLowerCase() === 'off'
    candidates.push({ value: 'off', detail: isOffCurrent ? 'off · current' : 'disable reasoning' })
  }
  for (const entry of reasoning.efforts) {
    const active = entry.id.toLowerCase() === activeEffort?.toLowerCase()
    candidates.push({
      value: entry.id,
      detail: active ? `${entry.name} · current` : (entry.description ?? entry.name),
    })
  }
  return candidates
}

