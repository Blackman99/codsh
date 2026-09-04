/** GateModal layout, focus, and key mapping for /ship approval gates. */

import { describe, expect, it } from 'vitest'
import { GateModal, gateChip, gateTitle } from '../src/gate-modal.ts'
import { createTheme } from '../src/theme.ts'

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

  it('maps y / e / n / Esc / Enter and cycles Tab focus', () => {
    const modal = new GateModal(spec)
    expect(modal.handleKey({ kind: 'text', text: 'y' }, theme, 72, 16)).toBe('confirm')
    expect(modal.handleKey({ kind: 'text', text: 'e' }, theme, 72, 16)).toBe('edit')
    expect(modal.handleKey({ kind: 'text', text: 'n' }, theme, 72, 16)).toBe('abort')
    expect(modal.handleKey({ kind: 'escape' }, theme, 72, 16)).toBe('abort')

    expect(modal.focused).toBe('confirm')
    expect(modal.handleKey({ kind: 'enter' }, theme, 72, 16)).toBe('confirm')
    modal.tab(1)
    expect(modal.focused).toBe('edit')
    expect(modal.handleKey({ kind: 'enter' }, theme, 72, 16)).toBe('edit')
    modal.handleKey({ kind: 'tab' }, theme, 72, 16)
    expect(modal.focused).toBe('abort')
    expect(modal.handleKey({ kind: 'enter' }, theme, 72, 16)).toBe('abort')
    modal.handleKey({ kind: 'shift-tab' }, theme, 72, 16)
    expect(modal.focused).toBe('edit')
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
