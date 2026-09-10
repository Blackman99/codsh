/**
 * The tool-call category vocabulary and the merged group-header label, tested
 * directly as pure functions — no `Transcript` in this file.
 */

import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { TOOL_CATEGORY_WORDS, toolCategory, toolGroupLabel, type ToolCategory, type ToolGroupMember } from '../src/tool-group.ts'

const terminalCall: ToolCallView = { card: 'terminal', title: 'ls' }
const result = (view: ToolResultView): ToolResultView => view

describe('toolCategory', () => {
  it('maps a terminal call view to the command category', () => {
    expect(toolCategory('bash', terminalCall)).toBe('command' satisfies ToolCategory)
  })

  it('maps a diff view to the edit category', () => {
    const diffs = [{ path: 'a.ts', oldText: null, newText: 'x' }]
    expect(toolCategory('edit', { card: 'diff', title: 'Edit a.ts', diffs })).toBe('edit')
    expect(toolCategory('edit', result({ card: 'diff', diffs }))).toBe('edit')
  })

  it('maps a search result view to the search category', () => {
    expect(toolCategory('grep', result({ card: 'search', shape: 'paths', paths: [], truncated: false, total: 0 }))).toBe('search')
  })

  it('maps a read result view to the read category', () => {
    expect(toolCategory('read', result({ card: 'read', path: 'a.ts', offset: 1, lines: [], totalLines: 0 }))).toBe('read')
  })

  it('maps web search and web fetch result views to their own categories', () => {
    expect(toolCategory('web_search', result({ card: 'web', kind: 'search', sources: [], truncated: false }))).toBe('web-search')
    expect(toolCategory('web_fetch', result({ card: 'web', kind: 'fetch', url: 'https://x', statusCode: 200, truncated: false }))).toBe('web-fetch')
  })

  it('maps the subagent tool names to the subagent category', () => {
    expect(toolCategory('subagent', undefined)).toBe('subagent')
    expect(toolCategory('subagent_fork', { card: 'generic', title: 'Delegate' })).toBe('subagent')
  })

  it('falls back to the other category for a generic or absent view', () => {
    expect(toolCategory('todo', { card: 'generic', title: 'Todos' })).toBe('other')
    expect(toolCategory('mystery', undefined)).toBe('other')
  })

  it('falls back to other when a presenter throws', () => {
    const throwing = { get card(): never { throw new Error('presenter blew up') } } as unknown as ToolCallView
    expect(() => toolCategory('boom', throwing)).not.toThrow()
    expect(toolCategory('boom', throwing)).toBe('other')
  })
})

describe('toolGroupLabel', () => {
  const categories = Object.keys(TOOL_CATEGORY_WORDS) as ToolCategory[]

  it('produces no label for an empty run rather than a bare zero', () => {
    expect(toolGroupLabel([])).toBe('')
  })

  it('pluralizes every category at one and at many', () => {
    for (const category of categories) {
      const words = TOOL_CATEGORY_WORDS[category]
      const one = toolGroupLabel([{ category }])
      const many = toolGroupLabel([{ category }, { category }, { category }])
      expect(one).toBe(`${words.past} 1 ${words.singular}`)
      expect(many).toBe(`${words.past} 3 ${words.plural}`)
    }
  })

  it('lists categories in first-appearance order, not vocabulary order', () => {
    const run: ToolGroupMember[] = [
      { category: 'read' },
      { category: 'read' },
      { category: 'command' },
      { category: 'edit' },
      { category: 'edit' },
      { category: 'edit' },
    ]
    expect(toolGroupLabel(run)).toBe('Read 2 files, Ran 1 command, Edited 3 files')
  })

  it('reads in the present tense while any member is still running', () => {
    const run: ToolGroupMember[] = [{ category: 'command', running: true }, { category: 'read' }]
    expect(toolGroupLabel(run)).toBe('Running 1 command, Reading 1 file')
  })

  it('reads in the past tense once every member has settled', () => {
    const run: ToolGroupMember[] = [{ category: 'command' }, { category: 'read', running: false }]
    expect(toolGroupLabel(run)).toBe('Ran 1 command, Read 1 file')
  })

  it('appends the failure segment with its count and omits it at zero', () => {
    const clean: ToolGroupMember[] = [{ category: 'read' }, { category: 'read' }]
    expect(toolGroupLabel(clean)).not.toContain('failed')
    expect(toolGroupLabel([...clean, { category: 'read', failed: true }])).toBe('Read 3 files · 1 failed')
    expect(toolGroupLabel([{ category: 'command' }, { category: 'command', failed: true }, { category: 'command', failed: true }]))
      .toBe('Ran 3 commands · 2 failed')
  })
})
