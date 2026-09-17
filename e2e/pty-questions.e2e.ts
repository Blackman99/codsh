/** Consecutive /ship questions through the real tool, prompt, and PTY. */
import { describe, expect, it } from 'vitest'
import { drivePtySteps, screenOf, type Driven } from './pty-driver.ts'
import { ENTER, ESCAPE, PASTE_END, PASTE_START } from './pty-helpers.ts'

const LEFT = `${ESCAPE}[D`
const RIGHT = `${ESCAPE}[C`
const DOWN = `${ESCAPE}[B`

function beforeStep(run: Driven, index: number, columns = 120): string {
  const offset = run.offsets[index]
  if (offset === undefined) throw new Error(`Missing PTY step ${index + 1}`)
  return screenOf(run.output, offset, 40, columns).alternate.join('\n')
}

describe.skipIf(process.platform === 'win32')('consecutive ship questions (real PTY)', () => {
  it.each([50, 120])('revises prior answers and retains multiple selections at %i columns', async columns => {
    const run = await drivePtySteps('questions', [
      ['Welcome to codsh', `interview${ENTER}`, 200],
      ['Storage?', ENTER, 200],
      ['Features?', ` ${DOWN} ${ENTER}`, 200],
      ['Path?', LEFT, 200],
      ['Features?', LEFT, 200],
      ['Storage?', `${DOWN}${ENTER}`, 200],
      ['Features?', RIGHT, 200],
      ['Path?', `e${PASTE_START}next${PASTE_END}${ENTER}`, 200],
      ['QUESTIONS_DONE', `/exit${ENTER}`, 300],
    ], { columns })
    const revisited = beforeStep(run, 4, columns)
    expect(revisited.match(/\[x\]/g)).toHaveLength(2)
    expect(revisited).not.toContain('✓ SQLite')
    const final = beforeStep(run, 8, columns)
    expect(final.match(/✓ Postgres/g)).toHaveLength(1)
    expect(final.match(/✓ Tests, Docs/g)).toHaveLength(1)
    expect(final.match(/✓ next/g)).toHaveLength(1)
    expect(final).not.toContain('✓ SQLite')
    // The tool gutter continues through the settled answers; without it the
    // left rule breaks on every reply.
    expect(final).toMatch(/│\s*✓ Postgres/)
    expect(final).toMatch(/│\s*✓ Tests, Docs/)
    expect(final).toMatch(/│\s*✓ next/)
    const compact = final.replace(/[│\s]/gu, '')
    expect(compact).toContain('"selected":["Postgres"]')
    expect(compact).toContain('"selected":["Tests","Docs"]')
    expect(compact).toContain('"custom":"next"')
  })

  it('dismisses the whole pending batch on Escape', async () => {
    const run = await drivePtySteps('questions', [
      ['Welcome to codsh', `interview${ENTER}`, 200],
      ['Storage?', ESCAPE, 200],
      ['QUESTIONS_DONE', `/exit${ENTER}`, 300],
    ])
    const final = beforeStep(run, 2)
    expect(final).not.toContain('✓')
    expect(final.replace(/\s+/g, '')).toContain('"id":"features","selected":[]')
  })
})
