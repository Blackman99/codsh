// Issue #186 follow-up: a session whose first turn carried local memory was
// titled `<local-memory> Local memory notes the`, and resuming it showed an
// empty first prompt. Titles, picker prompts, rewind points, and resumed
// turns come from the words the user typed, never from injected context.
import { describe, expect, it } from 'vitest'
import {
  catalogTitle,
  projectTurns,
  promptLines,
  rewindPoints,
  typedPrompt,
} from '../packages/cli/bin/rust-acp-session-read.mjs'

const MEMORY = '<local-memory>\nLocal memory notes the user saved. Read-only context. Do not upload them.\n[global MEMORY.md]\n- likes tea\n[session sessions/2026-09-26-user_requested-aaaa1111.md]\n## Decisions\n- The widget service listens on port 7431.\n</local-memory>\n'
const RULES = '<human_rules>\nProject and user rules. Deeper files take precedence over broader ones.\n\nInstructions from: AGENTS.md (project, 9 bytes)\nuse tabs\n</human_rules>\n'
const SESSION_RULES = '<human_rules>\nbe brief\n</human_rules>\n'
const AGENTS = '<agent-definitions>\nAgent reviewer (project) from /p/.grok/agents/reviewer.md: Reviews diffs\nREVIEW\n</agent-definitions>\n'
const SKILL = 'Follow the `local:commit` skill from /p/.grok/skills/commit/SKILL.md. Arguments: fix it\n\nRun /commit only when asked.\n/commit\n\nThe skill body was truncated at 25000 tokens. Read sibling files for the rest.\n/commit fix it'
const COMMAND = 'Run the custom command `ship-note` from /p/.grok/commands/ship-note.md. Arguments: 42\n\nWrite a note.\n/ship-note 42'

function user(seq, text, source = { kind: 'user' }) {
  return { type: 'user/message', seq, data: { message: { role: 'user', content: [{ type: 'text', text }], source } } }
}

function assistant(seq, text) {
  return { type: 'assistant/message', seq, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

function session(firstPrompt) {
  return [
    { type: 'turn/start', seq: 1, data: {} },
    user(2, 'Current runtime context\nThis snapshot supersedes earlier ones.', { kind: 'plugin', plugin: 'dsh-system-prompt', form: 'snapshot' }),
    user(3, '<system-reminder>\nWorkflows: none\n</system-reminder>', { kind: 'plugin', plugin: 'rust-acp-workflow' }),
    user(4, firstPrompt),
    assistant(5, 'Port 7431.'),
    { type: 'turn/end', seq: 6, data: {} },
    { type: 'turn/start', seq: 7, data: {} },
    user(8, `${RULES}second question`),
    assistant(9, 'ok'),
    { type: 'turn/end', seq: 10, data: {} },
    { type: 'session/title', seq: 11, data: { title: '<local-memory> Local memory notes the', source: { kind: 'fallback' } } },
  ]
}

describe('typed prompt (issue #186 follow-up)', () => {
  it('drops memory, rules, agent definitions, and expanded skill bodies', () => {
    expect(typedPrompt(`${MEMORY}Which port does the widget use?`)).toBe('Which port does the widget use?')
    expect(typedPrompt(`${MEMORY}${RULES}${SESSION_RULES}${AGENTS}hello`)).toBe('hello')
    expect(typedPrompt(`${MEMORY}${RULES}${SKILL}`)).toBe('/commit fix it')
    expect(typedPrompt(`${RULES}${COMMAND}`)).toBe('/ship-note 42')
    // --verbatim: the context is its own block joined ahead of the prompt.
    expect(typedPrompt(`${MEMORY}${RULES}\nverbatim ask`)).toBe('verbatim ask')
  })

  it('leaves typed text alone', () => {
    expect(typedPrompt('  plain ask ')).toBe('plain ask')
    expect(typedPrompt('why is <local-memory> shown?')).toBe('why is <local-memory> shown?')
    expect(typedPrompt('<local-memory>\nnever closed')).toBe('<local-memory>\nnever closed')
    expect(typedPrompt('Follow the `x` skill with no slash line')).toBe('Follow the `x` skill with no slash line')
  })
})

describe('session projections use the typed prompt', () => {
  const events = session(`${MEMORY}${RULES}Which port does the widget use?`)

  it('lists only typed prompts for the picker', () => {
    expect(promptLines(events)).toEqual(['Which port does the widget use?', 'second question'])
  })

  it('never keeps dsh fallback titles but keeps provider and user titles', () => {
    expect(catalogTitle({ title: '<local-memory> Local memory notes the', source: 'fallback', manual: false }))
      .toMatchObject({ title: '', source: '' })
    expect(catalogTitle({ title: 'Widget port', source: 'provider', manual: false })).toMatchObject({ title: 'Widget port' })
    expect(catalogTitle({ title: 'Mine', source: 'user', manual: true })).toMatchObject({ title: 'Mine', manual: true })
    expect(catalogTitle(null)).toBe(null)
  })

  it('shows the first turn on resume and in rewind points', () => {
    const turns = projectTurns(events)
    const users = turns.map(turn => turn.user)
    expect(users[0]).toBe('Which port does the widget use?')
    expect(users).toContain('second question')
    expect(users.join('\n')).not.toMatch(/local-memory|human_rules|system-reminder/)
    expect(rewindPoints(events).map(point => point.summary)).toEqual(['Which port does the widget use?', 'second question'])
  })

  it('shows a skill turn as the typed slash line', () => {
    const skill = session(`${MEMORY}${SKILL}`)
    expect(promptLines(skill)[0]).toBe('/commit fix it')
    const turns = projectTurns(skill)
    expect(turns[0].user).toBe('/commit fix it')
  })
})
