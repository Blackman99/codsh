/**
 * The terminal's approval answerer: it puts one pending tool call to the
 * keyboard and returns the decision.
 *
 * `ApprovalOutcome` has no remembered grant — the vocabulary is `allowed-once`,
 * `rejected`, `cancelled`, and `unavailable` — so "allow every call to this
 * tool" is this surface's own state, kept here and answered as `allowed-once`
 * without asking again.
 * @module codsh-bundle/src/approval
 */

import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Theme } from './theme.ts'

/** One keystroke the approval prompt accepts. */
export type ApprovalAnswer = 'once' | 'always' | 'reject'

/** Reads one approval keystroke from the terminal. */
export interface ApprovalPrompt {
  /**
   * Ask the person about one pending call.
   * @param toolName - the tool awaiting a decision.
   * @param reason - the asker's explanation, when it supplied one.
   * @param signal - aborts the prompt when the call is cancelled.
   * @returns the chosen answer, or undefined when the prompt was aborted.
   */
  ask(toolName: string, reason: string | undefined, signal: AbortSignal | undefined): Promise<ApprovalAnswer | undefined>
}

/**
 * Approval state for one terminal session.
 *
 * The remembered set is per-process and never written to disk. An
 * {@link ApprovalRequest} carries the tool name, reason, and call id but NOT
 * the call arguments, so a grant cannot be narrowed to "this command" — it
 * covers every later call to that tool. Persisting a grant that broad across
 * runs would outlive the intent that produced it.
 */
export class TerminalApproval {
  private readonly allowed = new Set<string>()

  constructor(
    private readonly prompt: ApprovalPrompt,
    private readonly theme: Theme,
    private readonly write: (line: string) => void,
  ) {}

  /** Tool names granted for the rest of this process, in grant order. */
  get remembered(): readonly string[] {
    return [...this.allowed]
  }

  /** Forget every remembered grant, so the next call of each tool asks again. */
  clear(): void {
    this.allowed.clear()
  }

  /**
   * Decide one request, asking the keyboard unless the tool is already granted.
   * @param req - the pending decision.
   * @returns the outcome for this request.
   */
  async decide(req: ApprovalRequest): Promise<ApprovalOutcome> {
    if (this.allowed.has(req.toolName)) return 'allowed-once'
    const answer = await this.prompt.ask(req.toolName, req.reason, req.signal)
    if (answer === undefined) return 'cancelled'
    if (answer === 'reject') {
      this.write(this.theme.error(`  ✗ denied ${req.toolName}`))
      return 'rejected'
    }
    if (answer === 'always') {
      this.allowed.add(req.toolName)
      this.write(this.theme.dim(`  ✓ allowing every ${req.toolName} call for the rest of this session`))
    }
    return 'allowed-once'
  }
}

/**
 * Map one keystroke to an approval answer.
 * @param key - the character typed at the prompt.
 * @returns the answer, or undefined when the key means nothing here.
 */
export function answerForKey(key: string): ApprovalAnswer | undefined {
  const normalized = key.trim().toLowerCase()
  if (normalized === 'y' || normalized === '') return 'once'
  if (normalized === 'a') return 'always'
  if (normalized === 'n') return 'reject'
  return undefined
}
