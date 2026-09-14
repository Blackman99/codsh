/**
 * Adjacent `/ship` snapshot: freeze original and Main Track beside the spec.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  freezeEqual,
  headedMainTrack,
  initialShipSnapshot,
  parseShipSnapshot,
  readShipSnapshot,
  recoverOriginal,
  sealOriginalIfNeeded,
  sealTrackIfNeeded,
  snapshotPathFor,
  validateSnapshotAgainstSpec,
  writeShipSnapshot,
} from '../src/ship-snapshot.ts'

const specAt = (cwd: string, name: string): string => {
  const dir = join(cwd, 'docs', 'specs')
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

describe('ship-snapshot', () => {
  it('derives the sidecar from the spec path, never from markdown', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-snap-'))
    const path = specAt(cwd, 'widget.md')
    expect(snapshotPathFor(path)).toBe(join(cwd, 'docs', 'specs', 'widget.ship.json'))
    expect(snapshotPathFor(join(cwd, 'docs', 'specs', 'widget.MD'))).toBe(join(cwd, 'docs', 'specs', 'widget.ship.json'))
  })

  it('recovers a dedicated original ahead of a design summary or typed idea', () => {
    const markdown = [
      '## Original Requirement',
      '',
      'Keep offline use.',
      '',
      '### Constraints',
      '',
      'Never upload files.',
      '',
      '## Requirement',
      '',
      'A design summary.',
      '',
      '## Main Track',
      '',
      '**Idea.** silently rewritten.',
    ].join('\n')
    const recovered = recoverOriginal(markdown, 'typed later')
    expect(recovered).toEqual({
      text: 'Keep offline use.\n\n### Constraints\n\nNever upload files.',
      sealed: true,
      limitedHistory: false,
      fromTrack: false,
    })
  })

  it('infers limited history from Main Track when no original exists', () => {
    const recovered = recoverOriginal('## Main Track\n\n**Idea.** Bind /goal.\n', '')
    expect(recovered).toMatchObject({
      text: '**Idea.** Bind /goal.',
      sealed: false,
      limitedHistory: true,
      fromTrack: true,
    })
  })

  it('seals Main Track and acceptance criteria at Confirm without weakening later', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-snap-'))
    const path = specAt(cwd, 'widget.md')
    const markdown = [
      'Status: interviewing',
      '',
      '## Original Requirement',
      '',
      'Keep offline use.',
      '',
      '## Main Track',
      '',
      '**Idea.** Keep offline use.',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0',
    ].join('\n')
    let snapshot = initialShipSnapshot(path, markdown, '')
    expect(snapshot?.originalSealed).toBe(true)
    expect(snapshot?.trackSealed).toBe(false)
    snapshot = sealTrackIfNeeded(snapshot!, markdown.replace('Status: interviewing', 'Status: confirmed'))
    expect(snapshot.trackSealed).toBe(true)
    expect(snapshot.mainTrack).toBe(headedMainTrack('**Idea.** Keep offline use.'))
    expect(snapshot.acceptanceCriteria).toContain('pnpm test')
    const later = sealTrackIfNeeded(snapshot, markdown.replace('**Idea.** Keep offline use.', '**Idea.** weaker.'))
    expect(later.mainTrack).toBe(snapshot.mainTrack)
  })

  it('writes atomically and refuses corrupt JSON without claiming a parse', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ship-snap-'))
    const path = specAt(cwd, 'widget.md')
    writeFileSync(path, 'Status: interviewing\n')
    const snapshot = initialShipSnapshot(path, 'Status: interviewing\n\n## Original Requirement\n\nKeep offline use.\n', '')
    expect(snapshot).toBeDefined()
    writeShipSnapshot(snapshot!, path)
    const sidecar = snapshotPathFor(path)
    const parsed = readShipSnapshot(path)
    expect(parsed).toMatchObject({ originalRequirement: 'Keep offline use.', originalSealed: true })
    expect(readFileSync(sidecar, 'utf8')).toContain('"version": 1')
    expect(parseShipSnapshot('{nope')).toMatchObject({ error: expect.stringMatching(/not valid JSON/i) })
    expect(parseShipSnapshot('{"version":2,"specPath":"x","originalRequirement":"","originalSealed":false,"trackSealed":false}')).toMatchObject({
      error: expect.stringMatching(/unsupported/i),
    })
  })

  it('reports freeze drift for original, track, and weakened acceptance criteria', () => {
    const path = '/repo/docs/specs/widget.md'
    const snapshot = initialShipSnapshot(path, [
      'Status: confirmed',
      '',
      '## Original Requirement',
      '',
      'Keep offline use.',
      '',
      '## Main Track',
      '',
      '**Idea.** Keep offline use.',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0',
    ].join('\n'), '')!
    expect(validateSnapshotAgainstSpec(snapshot, path, [
      'Status: confirmed',
      '',
      '## Original Requirement',
      '',
      'Keep offline use.',
      '',
      '## Main Track',
      '',
      '**Idea.** Keep offline use.',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0',
    ].join('\n'))).toBeUndefined()
    expect(validateSnapshotAgainstSpec(snapshot, path, 'Status: confirmed\n\n## Main Track\n\n**Idea.** Keep offline use.\n'))
      .toMatch(/Original Requirement is missing/)
    expect(validateSnapshotAgainstSpec(snapshot, path, [
      'Status: confirmed',
      '',
      '## Original Requirement',
      '',
      'Keep offline use.',
      '',
      '## Main Track',
      '',
      '**Idea.** rewritten.',
      '',
      '## Acceptance Criteria',
      '',
      '1. `pnpm test` exits 0',
    ].join('\n'))).toMatch(/Main Track no longer matches/)
    expect(validateSnapshotAgainstSpec(snapshot, path, [
      'Status: confirmed',
      '',
      '## Original Requirement',
      '',
      'Keep offline use.',
      '',
      '## Main Track',
      '',
      '**Idea.** Keep offline use.',
      '',
      '## Acceptance Criteria',
      '',
      '1. skip the tests',
    ].join('\n'))).toMatch(/acceptance criteria/)
  })

  it('treats freeze text as newline-normalized', () => {
    expect(freezeEqual('Keep offline use.\r\nNever upload.', 'Keep offline use.\nNever upload.')).toBe(true)
  })

  it('does not seal a dedicated original that disagrees with the freeze', () => {
    const path = '/repo/docs/specs/widget.md'
    const snapshot = initialShipSnapshot(path, 'Status: interviewing\n', 'Keep offline use.')!
    const next = sealOriginalIfNeeded(snapshot, '## Original Requirement\n\nA different product.\n')
    expect(next.originalSealed).toBe(false)
    expect(next.originalRequirement).toBe('Keep offline use.')
  })
})
