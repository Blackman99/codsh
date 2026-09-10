/** GateModal layout, focus, and key mapping for /ship approval gates. */

import { describe, expect, it } from 'vitest'
import { GateModal, gateChip, gateTitle } from '../src/gate-modal.ts'
import { createTheme, displayWidth } from '../src/theme.ts'

const theme = createTheme(false, {})
const painted = createTheme(true, {})

describe('gateChip / gateTitle', () => {
  it('maps kind to MetaBar chip numbers and default titles', () => {
    expect(gateChip('spec')).toBe(1)
    expect(gateChip('tickets')).toBe(2)
    expect(gateTitle('spec')).toContain('gate 1/2')
    expect(gateTitle('tickets')).toContain('gate 2/2')
  })
})

describe('GateModal', () => {
  const spec = {
    kind: 'spec' as const,
    title: 'ship · gate 1/2 — confirm spec',
    bodyLines: [
      'Spec · pager opens on long output',
      '',
      'Acceptance (6)',
      '✔ each criterion names its proving command',
      '· opens full-screen pager when output > N lines',
      '· q returns to transcript',
    ],
    recommended: 'confirm' as const,
  }

  it('frames title, body, actions, and recommended hint', () => {
    const modal = new GateModal(spec)
    const frame = modal.frame(theme, 72, 16)
    expect(frame.rows).toHaveLength(16)
    expect(frame.rows[0]).toContain('gate 1/2')
    expect(frame.body.join('\n')).toContain('Acceptance')
    expect(frame.rows.join('\n')).toContain('[y] confirm · [e] edit · [n] abort')
    expect(frame.rows.join('\n')).toContain('recommended: confirm')
    expect(frame.focus).toBe('confirm')
  })

  it('wraps a long body line instead of cutting it at the frame', () => {
    // A gate's body is the spec summary or the ticket list — long lines, each
    // of which used to show as one clipped row.
    const long = 'Ticket 3: Queue panel — Delivers the Ctrl+Q list with edit, delete, reorder, and steer (Blocked by: Ticket 1, Ticket 2)'
    const modal = new GateModal({ ...spec, bodyLines: [long, 'short'] })
    const frame = modal.frame(theme, 40, 16)
    const text = frame.body.filter(row => row.trim() !== '')
    // Rows break at the width, not at words: joined back without spaces, the
    // body is exactly the two lines it was given.
    expect(text.length).toBeGreaterThan(2)
    expect(text.join('').replaceAll(/\s+/gu, '')).toBe(`${long}short`.replaceAll(/\s+/gu, ''))
    for (const row of frame.rows) expect(displayWidth(row)).toBeLessThanOrEqual(40)
  })

  it('hangs a wrapped bullet under its text', () => {
    const modal = new GateModal({ ...spec, bodyLines: ['· a criterion whose wording runs well past the width of the frame it sits in'] })
    const body = modal.frame(theme, 40, 12).body.filter(row => row.trim() !== '')
    expect(body[0]?.startsWith('· a criterion')).toBe(true)
    expect(body[1]?.startsWith('  ')).toBe(true)
    expect(body[1]?.trimStart().startsWith('·')).toBe(false)
  })

  it('scrolls the body with move and handleKey arrows', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    const modal = new GateModal({ ...spec, bodyLines: lines })
    expect(modal.frame(theme, 40, 10).body[0]).toContain('line 1')
    modal.move({ kind: 'line', lines: 1 }, theme, 40, 10)
    expect(modal.frame(theme, 40, 10).body[0]).toContain('line 2')
    modal.handleKey({ kind: 'page', direction: 1 }, theme, 40, 10)
    expect(modal.frame(theme, 40, 10).offset).toBeGreaterThan(1)
    modal.handleKey({ kind: 'home' }, theme, 40, 10)
    expect(modal.frame(theme, 40, 10).offset).toBe(0)
    modal.handleKey({ kind: 'end' }, theme, 40, 10)
    expect(modal.frame(theme, 40, 10).offset).toBe(modal.frame(theme, 40, 10).maxOffset)
  })

  it('maps y / n / Esc / Enter and cycles Tab focus', () => {
    const modal = new GateModal(spec)
    expect(modal.handleKey({ kind: 'text', text: 'y' }, theme, 72, 16)).toBe('confirm')
    expect(modal.handleKey({ kind: 'text', text: 'n' }, theme, 72, 16)).toBe('abort')
    expect(modal.handleKey({ kind: 'escape' }, theme, 72, 16)).toBe('abort')

    expect(modal.focused).toBe('confirm')
    expect(modal.handleKey({ kind: 'enter' }, theme, 72, 16)).toBe('confirm')
    modal.tab(1)
    expect(modal.focused).toBe('edit')
    modal.handleKey({ kind: 'tab' }, theme, 72, 16)
    expect(modal.focused).toBe('abort')
    expect(modal.handleKey({ kind: 'enter' }, theme, 72, 16)).toBe('abort')
    modal.handleKey({ kind: 'shift-tab' }, theme, 72, 16)
    expect(modal.focused).toBe('edit')
  })

  it('turns e into an inline field, and Enter submits the typed revision', () => {
    const modal = new GateModal(spec)
    expect(modal.handleKey({ kind: 'text', text: 'e' }, theme, 72, 16)).toBeUndefined()
    expect(modal.focused).toBe('edit')
    const writing = modal.frame(theme, 72, 16)
    expect(writing.rows.join('\n')).toMatch(/[▌_]/u)
    expect(writing.cursor).toBeDefined()
    expect(modal.handleKey({ kind: 'text', text: 'keep the queue panel' }, theme, 72, 16)).toBeUndefined()
    expect(modal.frame(theme, 72, 16).rows.join('\n')).toContain('keep the queue panel')
    expect(modal.handleKey({ kind: 'enter' }, theme, 72, 16)).toEqual({ kind: 'edit', note: 'keep the queue panel' })
  })

  it('styles the gate chip warn and action keys by role when colored', () => {
    const modal = new GateModal(spec)
    const frame = modal.frame(painted, 72, 16)
    // warn = bright yellow for gate N/2
    expect(frame.rows[0]).toContain('\u001B[93m')
    const joined = frame.rows.join('\n')
    // y → ok (green), n → err (red); copy uses middots.
    expect(joined).toContain('\u001B[32m[y]')
    expect(joined).toContain('\u001B[31m[n]')
    expect(joined.replace(/\u001B\[[0-9;]*m/gu, '')).toContain('[y] confirm · [e] edit · [n] abort')
  })

  it('stays readable under NO_COLOR / plain theme', () => {
    const modal = new GateModal(spec)
    const text = modal.frame(theme, 72, 16).rows.join('\n')
    expect(text).not.toMatch(/\u001B\[/)
    expect(text).toContain('[y] confirm · [e] edit · [n] abort')
    expect(text).not.toContain('[y] take')
  })
})
