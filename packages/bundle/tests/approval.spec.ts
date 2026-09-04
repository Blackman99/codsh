/**
 * The terminal answerer decides one call per prompt, and a remembered grant
 * answers later calls of the same tool without asking again.
 */

import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import { answerForKey, nameCall, TerminalApproval, type ApprovalAnswer } from '../src/approval.ts'
import { createTheme } from '../src/theme.ts'

const theme = createTheme(false, {})

/** One request stand-in; the answerer reads only the tool name and reason. */
function request(toolName: string, reason?: string): ApprovalRequest {
  return { toolName, ...reason === undefined ? {} : { reason } } as ApprovalRequest
}

/**
 * Build an answerer whose prompt replays a fixed script.
 * @param answers - the answers to return, in ask order.
 * @returns the answerer, the lines it wrote, and how many times it asked.
 */
function harness(answers: (ApprovalAnswer | undefined)[]) {
  const asked: string[] = []
  const written: string[] = []
  const approval = new TerminalApproval(
    {
      ask: (toolName) => {
        asked.push(toolName)
        return Promise.resolve(answers[asked.length - 1])
      },
    },
    theme,
    line => void written.push(line),
  )
  return { approval, asked, written }
}

describe('TerminalApproval', () => {
  it('allows one call without remembering it', async () => {
    const { approval, asked } = harness(['once', 'once'])
    expect(await approval.decide(request('bash'))).toBe('allowed-once')
    expect(await approval.decide(request('bash'))).toBe('allowed-once')
    expect(asked).toEqual(['bash', 'bash'])
    expect(approval.remembered).toEqual([])
  })

  it('stops asking after a remembered grant', async () => {
    const { approval, asked } = harness(['always'])
    expect(await approval.decide(request('bash'))).toBe('allowed-once')
    expect(await approval.decide(request('bash'))).toBe('allowed-once')
    expect(await approval.decide(request('bash'))).toBe('allowed-once')
    expect(asked).toEqual(['bash'])
    expect(approval.remembered).toEqual(['bash'])
  })

  it('keeps a grant scoped to the tool it was given for', async () => {
    const { approval, asked } = harness(['always', 'reject'])
    expect(await approval.decide(request('bash'))).toBe('allowed-once')
    expect(await approval.decide(request('write'))).toBe('rejected')
    expect(asked).toEqual(['bash', 'write'])
  })

  it('rejects and says so', async () => {
    const { approval, written } = harness(['reject'])
    expect(await approval.decide(request('write'))).toBe('rejected')
    expect(written.join('\n')).toContain('denied write')
  })

  it('reports an aborted prompt as cancelled rather than a denial', async () => {
    const { approval } = harness([undefined])
    expect(await approval.decide(request('bash'))).toBe('cancelled')
  })

  it('forgets every grant on clear', async () => {
    const { approval, asked } = harness(['always', 'once'])
    await approval.decide(request('bash'))
    approval.clear()
    expect(approval.remembered).toEqual([])
    await approval.decide(request('bash'))
    expect(asked).toEqual(['bash', 'bash'])
  })
})

describe('answerForKey', () => {
  it.each([
    { key: 'y', answer: 'once' },
    { key: 'Y', answer: 'once' },
    { key: '', answer: 'once' },
    { key: 'a', answer: 'always' },
    { key: ' A ', answer: 'always' },
    { key: 'n', answer: 'reject' },
  ])('maps $key to $answer', ({ key, answer }) => {
    expect(answerForKey(key)).toBe(answer)
  })

  it('maps an unrecognised key to nothing, so the caller decides the default', () => {
    expect(answerForKey('q')).toBeUndefined()
  })
})

describe('naming the call', () => {
  /** An answerer whose transcript knows one call, `c1`, as `git push`. */
  function named(answers: (ApprovalAnswer | undefined)[]) {
    const summaries: (string | undefined)[] = []
    const written: string[] = []
    const approval = new TerminalApproval(
      {
        ask: (_toolName, _reason, summary) => {
          summaries.push(summary)
          return Promise.resolve(answers[summaries.length - 1])
        },
      },
      theme,
      line => void written.push(line),
      callId => callId === 'c1' ? 'git push' : undefined,
    )
    return { approval, summaries, written }
  }

  it('hands the prompt the call the transcript rendered under the request id', async () => {
    const { approval, summaries } = named(['once'])
    await approval.decide({ toolName: 'bash', callId: 'c1' } as unknown as ApprovalRequest)
    expect(summaries).toEqual(['git push'])
  })

  it('asks by tool name alone when the id names nothing, or there is no id', async () => {
    const { approval, summaries } = named(['once', 'once'])
    await approval.decide({ toolName: 'bash', callId: 'unknown' } as unknown as ApprovalRequest)
    await approval.decide(request('bash'))
    expect(summaries).toEqual([undefined, undefined])
  })

  it('names the command in the denial line', async () => {
    const { approval, written } = named(['reject'])
    await approval.decide({ toolName: 'bash', callId: 'c1' } as unknown as ApprovalRequest)
    expect(written.join('\n')).toContain('denied bash: git push')
  })

  it.each([
    { toolName: 'bash', summary: 'git push', named: 'bash: git push' },
    { toolName: 'bash', summary: undefined, named: 'bash' },
    { toolName: 'bash', summary: '', named: 'bash' },
  ])('nameCall($toolName, $summary) is $named', ({ toolName, summary, named: expected }) => {
    expect(nameCall(toolName, summary)).toBe(expected)
  })
})
