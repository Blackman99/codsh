/**
 * Runner-owned ship answers: encoding, local-decision extraction, and
 * adjacent sidecar persistence. The graph cache is not this store.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  answersPathFor,
  encodeAskUserAnswers,
  extractLocalDecisionAnswer,
  isShipAnswersError,
  mergeShipAnswers,
  parseGraphObjective,
  parseGraphOriginalRequirement,
  parseShipAnswers,
  parseWayfinderDestination,
  readShipAnswers,
  writeShipAnswers,
} from '../src/ship-answers.ts'
import { collectJoinSources, isShipGraphJoinError, joinShipGraph } from '../src/ship-graph.ts'

describe('encodeAskUserAnswers', () => {
  it('encodes selected, multiselect, custom, and skipped questions by actual id', () => {
    const questions = [
      { id: 'storage', question: 'Storage?', header: 'ship · grill', detail: 'pick one' },
      { id: 'layers', question: 'Layers?', header: 'ship · grill' },
      { id: 'name', question: 'Name it', header: 'ship · grill' },
      { id: 'skip', question: 'Skip me?', header: 'ship · grill' },
    ]
    const records = encodeAskUserAnswers(questions, [
      { id: 'storage', selected: ['SQLite'] },
      { id: 'layers', selected: ['API', 'UI'] },
      { id: 'name', selected: [], custom: 'widget-core' },
      { id: 'skip', selected: [] },
    ], 'grill')
    expect(records).toEqual([
      { id: 'storage', phase: 'grill', question: 'Storage?', answer: 'SQLite', detail: 'pick one', source: 'Storage?' },
      { id: 'layers', phase: 'grill', question: 'Layers?', answer: 'API, UI', source: 'Layers?' },
      { id: 'name', phase: 'grill', question: 'Name it', answer: 'widget-core', source: 'Name it' },
      { id: 'skip', phase: 'grill', question: 'Skip me?', answer: '', source: 'Skip me?' },
    ])
  })

  it('maps gate headers onto spec/tickets phases and keeps repeated ids as history', () => {
    const first = encodeAskUserAnswers(
      [{ id: 'q1', question: 'Storage?', header: 'ship · grill' }],
      [{ id: 'q1', selected: ['SQLite'] }],
      'grill',
    )
    const second = encodeAskUserAnswers(
      [{ id: 'q1', question: 'Storage?', header: 'ship · grill' }],
      [{ id: 'q1', selected: ['Postgres'] }],
      'grill',
    )
    expect(mergeShipAnswers(first, second)).toEqual([
      { id: 'q1', phase: 'grill', question: 'Storage?', answer: 'SQLite', source: 'Storage?' },
      { id: 'q1', phase: 'grill', question: 'Storage?', answer: 'Postgres', source: 'Storage?' },
    ])
    expect(encodeAskUserAnswers(
      [{ id: 'g1', question: 'Confirm spec?', header: 'ship · gate 1/2' }],
      [{ id: 'g1', selected: ['Confirm'] }],
      'wayfinder',
    )[0]?.phase).toBe('spec')
    expect(encodeAskUserAnswers(
      [{ id: 'g2', question: 'Confirm tickets?', header: 'ship · gate 2/2' }],
      [{ id: 'g2', selected: ['Confirm'] }],
      'wayfinder',
    )[0]?.phase).toBe('tickets')
  })
})

describe('extractLocalDecisionAnswer', () => {
  it('reads explicit Question and User answer headings, including multiline fences', () => {
    const extracted = extractLocalDecisionAnswer([
      '# Auth store',
      '',
      'Type: grilling',
      'Status: resolved',
      '',
      '## Question',
      '',
      'Where should sessions live?',
      '',
      '```',
      'not a heading',
      '## User answer',
      '```',
      '',
      '## User answer',
      '',
      'Keep them in SQLite.',
      'Reuse the existing table.',
      '',
      '## Resolution',
      '',
      'Research found Redis already in prod.',
    ].join('\n'))
    expect(extracted.question).toBe('Where should sessions live?\n\n```\nnot a heading\n## User answer\n```')
    expect(extracted.userAnswer).toBe('Keep them in SQLite.\nReuse the existing table.')
    expect(extracted.source).toContain('Where should sessions live?')
  })

  it('reads metadata fields and keeps a missing user answer as explicit empty UI state', () => {
    const extracted = extractLocalDecisionAnswer([
      '# Scope',
      '',
      'Question: Keep offline use?',
      'Status: open',
    ].join('\n'))
    expect(extracted.question).toBe('Keep offline use?')
    expect(extracted.userAnswer).toBeUndefined()
    expect(extracted.source).toBe('Keep offline use?')
  })

  it('ignores example fields inside fences instead of inventing user responses', () => {
    expect(extractLocalDecisionAnswer('# Research\n\n```md\nQuestion: Example?\nUser answer: Example answer\n```\n')).toEqual({})
  })

  it('does not treat research Resolution as the user answer', () => {
    expect(extractLocalDecisionAnswer([
      '# Repo facts',
      '',
      'Type: research',
      '',
      '## Resolution',
      '',
      'The package already has a graph join.',
    ].join('\n'))).toEqual({})
  })
})

describe('parseGraphOriginalRequirement / objective', () => {
  it('keeps exact original wording and prefers Main Track Idea over Destination', () => {
    const markdown = [
      '## Original Requirement',
      '',
      'Build a widget',
      'that works offline.',
      '',
      '## Wayfinder',
      '',
      'Destination: Chart the route.',
      '',
      '## Main Track',
      '',
      '**Idea.** One canvas for the person.',
      '**Track-1.** Hybrid compass.',
    ].join('\n')
    expect(parseGraphOriginalRequirement(markdown)).toBe('Build a widget\nthat works offline.')
    expect(parseGraphObjective(markdown)).toBe('One canvas for the person.')
  })

  it('preserves a multiline Main Track Idea without including anchors or boundaries', () => {
    expect(parseGraphObjective('## Main Track\n\n**Idea.** Show the entire history,\nincluding every user decision.\n\n**Track-1.** Persist answers.\n**Out of Scope.** Translation.')).toBe('Show the entire history,\nincluding every user decision.')
    expect(parseGraphObjective('## Main Track\n\n### Idea\n\nShow the original request.\nKeep answers visible.\n\n### Out of Scope\n\nHosted service.')).toBe('Show the original request.\nKeep answers visible.')
  })

  it('allows a legacy explicit Requirement but not Main Track as the original', () => {
    const markdown = [
      '## Requirement',
      '',
      'Keep the typed ask.',
      '',
      '## Main Track',
      '',
      '**Idea.** A later design summary.',
      '**Track-1.** Do not treat this as the original.',
    ].join('\n')
    expect(parseGraphOriginalRequirement(markdown)).toBe('Keep the typed ask.')
    expect(parseGraphObjective(markdown)).toBe('A later design summary.')
    expect(parseGraphOriginalRequirement('## Main Track\n\n**Idea.** Not the original.\n')).toBeUndefined()
  })

  it('falls back to Wayfinder Destination, then original, and never guesses plan tickets', () => {
    const destination = [
      '## Wayfinder',
      '',
      'Destination: Named map first.',
      '',
      '## Plan',
      '',
      '- [ ] Ticket 1: Land the teaser',
    ].join('\n')
    expect(parseWayfinderDestination(destination)).toBe('Named map first.')
    expect(parseGraphObjective(destination)).toBe('Named map first.')
    expect(parseGraphObjective('## Original Requirement\n\nBuild a widget.\n')).toBe('Build a widget.')
    expect(parseGraphObjective('## Plan\n\n- [ ] Ticket 1: Land the teaser\n')).toBeUndefined()
  })
})

describe('answers sidecar', () => {
  it('round-trips a versioned record and treats unknown versions as errors', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-answers-'))
    const spec = join(cwd, 'docs', 'specs', 'widget.md')
    mkdirSync(dirname(spec), { recursive: true })
    writeFileSync(spec, 'Status: grilling\n')
    expect(answersPathFor(spec)).toBe(join(cwd, 'docs', 'specs', 'widget.ship.answers.json'))
    const record = {
      version: 1 as const,
      specPath: 'widget.md',
      answers: [
        { id: 'q1', phase: 'grill' as const, question: 'Storage?', answer: 'SQLite', source: 'Storage?' },
      ],
    }
    writeShipAnswers(record, spec)
    const raw = readFileSync(answersPathFor(spec), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(readShipAnswers(spec)).toEqual(record)
    writeFileSync(answersPathFor(spec), JSON.stringify({ ...record, specPath: 'other.md' }))
    expect(readShipAnswers(spec)).toEqual({ error: expect.stringContaining('another specification') })
    expect(isShipAnswersError(parseShipAnswers('{"version":99,"specPath":"widget.md","answers":[]}')))
      .toBe(true)
  })
})

describe('collectJoinSources local decision fields', () => {
  it('carries Question / User answer on injected DecisionChild without minting extra nodes', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-answers-'))
    const spec = join(cwd, 'docs', 'specs', 'widget.md')
    mkdirSync(dirname(spec), { recursive: true })
    const markdown = [
      'Status: wayfinding',
      'Branch: ship/widget',
      '',
      '## Original Requirement',
      '',
      'Build a widget.',
      '',
      '## Wayfinder',
      '',
      'Destination: Named map.',
    ].join('\n')
    writeFileSync(spec, markdown)
    const dir = join(cwd, '.scratch', 'widget', 'wayfinder')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '01-auth-store.md'), [
      '# Auth store',
      '',
      'Type: grilling',
      'Status: resolved',
      '',
      '## Question',
      '',
      'Where should sessions live?',
      '',
      '## User answer',
      '',
      'Keep them in SQLite.',
      '',
      '## Resolution',
      '',
      'Research found Redis already in prod.',
    ].join('\n'))
    const collected = collectJoinSources(cwd, spec, markdown)
    expect(isShipGraphJoinError(collected)).toBe(false)
    if (isShipGraphJoinError(collected)) return
    expect(collected.mapChildren).toEqual([
      {
        id: 'decision:local:1',
        title: 'Auth store',
        closed: true,
        ticketType: 'grilling',
        question: 'Where should sessions live?',
        userAnswer: 'Keep them in SQLite.',
        questionSource: 'Where should sessions live?',
      },
    ])
    const graph = joinShipGraph(collected)
    expect(isShipGraphJoinError(graph)).toBe(false)
    if (isShipGraphJoinError(graph)) return
    expect(graph.nodes.map(node => node.id)).toEqual(['decision:local:1'])
    expect(graph.originalRequirement).toBe('Build a widget.')
    expect(graph.objective).toBe('Named map.')
    expect(graph.answers).toEqual([
      {
        id: 'decision:local:1',
        phase: 'wayfinder',
        question: 'Where should sessions live?',
        answer: 'Keep them in SQLite.',
        source: 'Where should sessions live?',
        ticketId: 'decision:local:1',
      },
    ])
  })
})
