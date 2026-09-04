/**
 * The terminal answerer decides one call per prompt, and a remembered grant
 * answers later calls of the same tool without asking again.
 */

import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import { answerForKey, nameCall, TerminalApproval, type ApprovalAnswer } from '../src/approval.ts'
import { formatRule, parseRule, ruleMatches, type Rule } from '../src/permissions.ts'
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
      ask: ({ toolName }) => {
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

  it('maps d to the remembered answer', () => {
    expect(answerForKey('d')).toBe('remember')
  })
})

describe('remembered rules', () => {
  /** A store over an in-memory rule list, recording what it is asked to keep. */
  function stored(rules: string[], answers: (ApprovalAnswer | undefined)[], failWrite = false) {
    const kept: string[] = []
    const questions: { toolName: string; rule: string | undefined }[] = []
    const written: string[] = []
    const approval = new TerminalApproval(
      {
        ask: ({ toolName, rule }) => {
          questions.push({ toolName, rule })
          return Promise.resolve(answers[questions.length - 1])
        },
      },
      theme,
      line => void written.push(line),
      callId => callId === 'push' ? { summary: 'git push origin main', args: { command: 'git push origin main' } }
        : callId === 'compound' ? { summary: 'git status && rm -rf .', args: { command: 'git status && rm -rf .' } }
        : callId === 'write' ? { summary: 'src/a.ts', args: { file_path: 'src/a.ts' } }
        : undefined,
      {
        allows: (toolName, args) => Promise.resolve(rules.map(text => parseRule(text) as Rule).find(rule => ruleMatches(rule, toolName, args))),
        remember: (rule) => {
          if (failWrite) return Promise.reject(new Error('.dsh/permissions.local.json: Unexpected token'))
          kept.push(formatRule(rule))
          rules.push(formatRule(rule))
          return Promise.resolve('.dsh/permissions.local.json')
        },
      },
    )
    return { approval, kept, questions, written }
  }
  const request = (toolName: string, callId: string): ApprovalRequest => ({ toolName, callId } as unknown as ApprovalRequest)

  it('answers a call a rule covers without asking, and says which rule', async () => {
    const { approval, questions, written } = stored(['bash(git push *)'], [])
    expect(await approval.decide(request('bash', 'push'))).toBe('allowed-once')
    expect(questions).toEqual([])
    expect(written).toEqual([theme.dim('  ✓ bash: git push origin main · allowed by bash(git push *)')])
  })

  it('offers the prefix of the call, and keeps it when the answer is remember', async () => {
    const { approval, kept, questions, written } = stored([], ['remember'])
    expect(await approval.decide(request('bash', 'push'))).toBe('allowed-once')
    expect(questions).toEqual([{ toolName: 'bash', rule: 'bash(git push *)' }])
    expect(kept).toEqual(['bash(git push *)'])
    expect(written).toEqual([theme.dim('  ✓ allowing bash(git push *) from now on · .dsh/permissions.local.json')])
    // The next call is covered by what was just written.
    expect(await approval.decide(request('bash', 'push'))).toBe('allowed-once')
    expect(questions).toHaveLength(1)
  })

  it('offers a tool without a command whole, and nothing for a compound command or an unknown call', async () => {
    const { approval, questions } = stored([], ['once', 'once', 'once'])
    await approval.decide(request('write', 'write'))
    await approval.decide(request('bash', 'compound'))
    await approval.decide(request('bash', 'never-rendered'))
    expect(questions.map(question => question.rule)).toEqual(['write', undefined, undefined])
  })

  it('still allows the call when the rule cannot be written, and says so', async () => {
    const { approval, kept, written } = stored([], ['remember'], true)
    expect(await approval.decide(request('bash', 'push'))).toBe('allowed-once')
    expect(kept).toEqual([])
    expect(written.join('\n')).toContain('could not remember bash(git push *): .dsh/permissions.local.json: Unexpected token')
  })

  it('treats remember as once when nothing was offered', async () => {
    const { approval, kept } = stored([], ['remember'])
    expect(await approval.decide(request('bash', 'compound'))).toBe('allowed-once')
    expect(kept).toEqual([])
  })

  it('lets a tool-level rule answer a request that names no call', async () => {
    const { approval, questions } = stored(['write'], [])
    expect(await approval.decide({ toolName: 'write' } as unknown as ApprovalRequest)).toBe('allowed-once')
    expect(questions).toEqual([])
  })
})

describe('naming the call', () => {
  /** An answerer whose transcript knows one call, `c1`, as `git push`. */
  function named(answers: (ApprovalAnswer | undefined)[]) {
    const summaries: (string | undefined)[] = []
    const written: string[] = []
    const approval = new TerminalApproval(
      {
        ask: ({ summary }) => {
          summaries.push(summary)
          return Promise.resolve(answers[summaries.length - 1])
        },
      },
      theme,
      line => void written.push(line),
      callId => callId === 'c1' ? { summary: 'git push', args: { command: 'git push' } } : undefined,
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

  it('offers no rule without a store, so the prompt shows three answers', async () => {
    const offered: (string | undefined)[] = []
    const approval = new TerminalApproval(
      { ask: ({ rule }) => { offered.push(rule); return Promise.resolve('once') } },
      theme,
      () => undefined,
      () => ({ summary: 'git push', args: { command: 'git push' } }),
    )
    await approval.decide({ toolName: 'bash', callId: 'c1' } as unknown as ApprovalRequest)
    expect(offered).toEqual([undefined])
  })

  it.each([
    { toolName: 'bash', summary: 'git push', named: 'bash: git push' },
    { toolName: 'bash', summary: undefined, named: 'bash' },
    { toolName: 'bash', summary: '', named: 'bash' },
  ])('nameCall($toolName, $summary) is $named', ({ toolName, summary, named: expected }) => {
    expect(nameCall(toolName, summary)).toBe(expected)
  })
})
