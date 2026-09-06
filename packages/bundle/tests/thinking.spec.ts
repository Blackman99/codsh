import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import {
  THINKING_PREFS_FILE,
  modelKey,
  getThinkingPref,
  parseThinkingLevel,
  resolveEffortChoice,
  loadThinkingPrefs,
  saveThinkingPref,
} from '../src/thinking.js'

describe('thinking domain module', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codsh-thinking-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('constants and helpers', () => {
    it('defines the standard prefs file name', () => {
      expect(THINKING_PREFS_FILE).toBe('code-cli-thinking.json')
    })

    it('creates standard modelKey', () => {
      expect(modelKey('deepseek', 'deepseek-chat')).toBe('deepseek/deepseek-chat')
    })

    it('resolves thinking pref by provider/model or fallback to model', () => {
      const prefs = {
        'deepseek/deepseek-reasoner': ReasoningEffortId('high'),
        'gpt-4o': ReasoningEffortId('low'),
      }
      expect(getThinkingPref(prefs, 'deepseek', 'deepseek-reasoner')).toBe(ReasoningEffortId('high'))
      expect(getThinkingPref(prefs, 'openai', 'gpt-4o')).toBe(ReasoningEffortId('low'))
      expect(getThinkingPref(prefs, 'anthropic', 'claude-3-5')).toBeUndefined()
    })

    it('parses raw thinking level input', () => {
      expect(parseThinkingLevel(' high ')).toBe('high')
      expect(parseThinkingLevel('')).toBeUndefined()
      expect(parseThinkingLevel('   ')).toBeUndefined()
    })
  })

  describe('resolveEffortChoice', () => {
    const standardReasoning: LlmModelReasoningInfo = {
      efforts: [
        { id: ReasoningEffortId('off'), name: 'Off', description: 'Thinking disabled' },
        { id: ReasoningEffortId('low'), name: 'Low', description: 'Fast shallow thinking' },
        { id: ReasoningEffortId('high'), name: 'High', description: 'Deep deliberation' },
      ],
      defaultEffort: ReasoningEffortId('low'),
    }

    it('rejects when model does not support reasoning', () => {
      const res1 = resolveEffortChoice('high', undefined)
      expect(res1.ok).toBe(false)
      if (!res1.ok) {
        expect(res1.error).toMatch(/model does not support configurable thinking/i)
      }

      const emptyReasoning: LlmModelReasoningInfo = { efforts: [] }
      const res2 = resolveEffortChoice('high', emptyReasoning)
      expect(res2.ok).toBe(false)
      if (!res2.ok) {
        expect(res2.error).toMatch(/model does not support configurable thinking/i)
      }
    })

    it('rejects empty input', () => {
      const res = resolveEffortChoice('  ', standardReasoning)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error).toMatch(/cannot be empty/i)
      }
    })

    it('resolves explicit supported effort id case-insensitively', () => {
      const resLow = resolveEffortChoice('low', standardReasoning)
      expect(resLow).toEqual({ ok: true, effort: ReasoningEffortId('low') })

      const resHigh = resolveEffortChoice('  HIGH  ', standardReasoning)
      expect(resHigh).toEqual({ ok: true, effort: ReasoningEffortId('high') })
    })

    it('resolves "off" directly', () => {
      const res = resolveEffortChoice('off', standardReasoning)
      expect(res).toEqual({ ok: true, effort: ReasoningEffortId('off') })
    })

    it('resolves "on" to defaultEffort when non-off', () => {
      const res = resolveEffortChoice('on', standardReasoning)
      expect(res).toEqual({ ok: true, effort: ReasoningEffortId('low') })
    })

    it('resolves "on" to "high" if defaultEffort is unset or "off"', () => {
      const reasoningWithoutDefault: LlmModelReasoningInfo = {
        efforts: [
          { id: ReasoningEffortId('off'), name: 'Off' },
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
      }
      expect(resolveEffortChoice('on', reasoningWithoutDefault)).toEqual({
        ok: true,
        effort: ReasoningEffortId('high'),
      })

      const reasoningWithOffDefault: LlmModelReasoningInfo = {
        efforts: [
          { id: ReasoningEffortId('off'), name: 'Off' },
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('off'),
      }
      expect(resolveEffortChoice('on', reasoningWithOffDefault)).toEqual({
        ok: true,
        effort: ReasoningEffortId('high'),
      })
    })

    it('resolves "on" to first non-off effort when "high" is not available', () => {
      const reasoningCustom: LlmModelReasoningInfo = {
        efforts: [
          { id: ReasoningEffortId('off'), name: 'Off' },
          { id: ReasoningEffortId('medium'), name: 'Medium' },
          { id: ReasoningEffortId('max'), name: 'Max' },
        ],
      }
      expect(resolveEffortChoice('on', reasoningCustom)).toEqual({
        ok: true,
        effort: ReasoningEffortId('medium'),
      })
    })

    it('returns error when "on" is chosen but no non-off effort exists', () => {
      const onlyOffReasoning: LlmModelReasoningInfo = {
        efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }],
      }
      const res = resolveEffortChoice('on', onlyOffReasoning)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error).toMatch(/does not have an active thinking level/i)
      }
    })

    it('rejects unknown level and lists available options', () => {
      const res = resolveEffortChoice('ultra', standardReasoning)
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error).toMatch(/unknown thinking level: ultra/i)
        expect(res.error).toMatch(/off, low, high/i)
      }
    })
  })

  describe('persistence', () => {
    it('returns empty object when file does not exist', async () => {
      const nonExistent = join(tempDir, 'missing.json')
      const prefs = await loadThinkingPrefs(nonExistent)
      expect(prefs).toEqual({})
    })

    it('returns empty object when file contains invalid json or array', async () => {
      const invalidPath = join(tempDir, 'invalid.json')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(invalidPath, '[1, 2, 3]', 'utf8')
      expect(await loadThinkingPrefs(invalidPath)).toEqual({})

      await writeFile(invalidPath, '{not valid json', 'utf8')
      expect(await loadThinkingPrefs(invalidPath)).toEqual({})
    })

    it('saves and loads thinking preferences across models', async () => {
      const prefsPath = join(tempDir, THINKING_PREFS_FILE)

      await saveThinkingPref(prefsPath, 'deepseek/deepseek-reasoner', 'high')
      let prefs = await loadThinkingPrefs(prefsPath)
      expect(prefs).toEqual({
        'deepseek/deepseek-reasoner': ReasoningEffortId('high'),
      })

      // Add another model preference without clobbering the first
      await saveThinkingPref(prefsPath, 'openai/o3-mini', 'low')
      prefs = await loadThinkingPrefs(prefsPath)
      expect(prefs).toEqual({
        'deepseek/deepseek-reasoner': ReasoningEffortId('high'),
        'openai/o3-mini': ReasoningEffortId('low'),
      })

      // Overwrite an existing preference
      await saveThinkingPref(prefsPath, 'deepseek/deepseek-reasoner', 'off')
      prefs = await loadThinkingPrefs(prefsPath)
      expect(prefs['deepseek/deepseek-reasoner']).toBe(ReasoningEffortId('off'))
    })
  })
})
