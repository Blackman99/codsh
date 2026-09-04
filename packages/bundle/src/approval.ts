/**
 * The terminal's approval answerer: it puts one pending tool call to the
 * keyboard and returns the decision.
 *
 * `ApprovalOutcome` has no remembered grant — the vocabulary is `allowed-once`,
 * `rejected`, `cancelled`, and `unavailable` — so "allow every call to this
 * tool" is this surface's own state, kept here and answered as `allowed-once`
 * without asking again. The grants that outlive the process are the rules in
 * {@link RuleStore}: a matching rule answers before the keyboard is asked, and
 * the `remember` answer writes one.
 *
 * The request carries no arguments; its `callId` links to the `tool/call` the
 * transcript already rendered. The prompt names the call through that link,
 * so the question reads "Allow bash: git push?" even when the card that says
 * so has scrolled away or sits inside a fold — and the rule it offers is cut
 * from the same arguments.
 * @module codsh-bundle/src/approval
 */

import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { formatRule, suggestRule, type Rule } from './permissions.ts'
import type { Theme } from './theme.ts'

/** One keystroke the approval prompt accepts. */
export type ApprovalAnswer = 'once' | 'always' | 'remember' | 'reject'

/** One question, as the prompt shows it. */
export interface ApprovalQuestion {
  /** The tool awaiting a decision. */
  toolName: string
  /** The asker's explanation, when it supplied one. */
  reason: string | undefined
  /** The call in one line — its command, its paths — when the transcript rendered it. */
  summary: string | undefined
  /** The rule `remember` would write, spelled `bash(git push *)`, when one is safe to offer. */
  rule: string | undefined
}

/** Reads one approval keystroke from the terminal. */
export interface ApprovalPrompt {
  /**
   * Ask the person about one pending call.
   * @param question - what to ask, and which answers are open.
   * @param signal - aborts the prompt when the call is cancelled.
   * @returns the chosen answer, or undefined when the prompt was aborted.
   */
  ask(question: ApprovalQuestion, signal: AbortSignal | undefined): Promise<ApprovalAnswer | undefined>
}

/** What the transcript knows about a pending call. */
export interface PendingCallInfo {
  /** The call in one line, or undefined when its presenter gave none. */
  summary: string | undefined
  /** The parsed call arguments. */
  args: unknown
}

/** The remembered grants the answerer consults and writes. */
export interface RuleStore {
  /**
   * The rule allowing one call, if any.
   * @param toolName - the tool the model called.
   * @param args - the parsed call arguments, or undefined when unknown.
   */
  allows(toolName: string, args: unknown): Promise<Rule | undefined>
  /**
   * Keep one rule for later processes.
   * @param rule - the grant.
   * @returns where it was written, as a person should read it.
   */
  remember(rule: Rule): Promise<string>
}

/**
 * Approval state for one terminal session.
 *
 * The remembered set is per-process and never written to disk: an
 * {@link ApprovalRequest} carries the tool name, reason, and call id but NOT
 * the call arguments, so a grant made from the request alone covers every
 * later call to that tool, and one that broad must not outlive the session.
 * What does outlive it is a {@link Rule} — narrowed to a command prefix from
 * the arguments the transcript kept — in the store, which the person chose
 * to write.
 */
export class TerminalApproval {
  private readonly allowed = new Set<string>()

  /**
   * @param prompt - reads the keystroke.
   * @param theme - styles the lines written back.
   * @param write - appends one line under the prompt.
   * @param describe - names a pending call by its id, from the transcript that
   * rendered it; undefined when nothing was rendered under that id.
   * @param rules - the remembered grants; absent, nothing is remembered or offered.
   */
  constructor(
    private readonly prompt: ApprovalPrompt,
    private readonly theme: Theme,
    private readonly write: (line: string) => void,
    private readonly describe: (callId: string) => PendingCallInfo | undefined = () => undefined,
    private readonly rules?: RuleStore,
  ) {}

  /** Tool names granted for the rest of this process, in grant order. */
  get remembered(): readonly string[] {
    return [...this.allowed]
  }

  /** Forget every session grant, so the next call of each tool asks again. Rules on disk stay. */
  clear(): void {
    this.allowed.clear()
  }

  /**
   * Decide one request: a session grant or a rule answers it; otherwise the keyboard.
   * @param req - the pending decision.
   * @returns the outcome for this request.
   */
  async decide(req: ApprovalRequest): Promise<ApprovalOutcome> {
    if (this.allowed.has(req.toolName)) return 'allowed-once'
    const pending = req.callId === undefined ? undefined : this.describe(req.callId)
    const rule = await this.rules?.allows(req.toolName, pending?.args)
    if (rule !== undefined) {
      this.write(this.theme.dim(`  ✓ ${nameCall(req.toolName, pending?.summary)} · allowed by ${formatRule(rule)}`))
      return 'allowed-once'
    }
    const offered = pending === undefined || this.rules === undefined ? undefined : suggestRule(req.toolName, pending.args)
    const answer = await this.prompt.ask({
      toolName: req.toolName,
      reason: req.reason,
      summary: pending?.summary,
      rule: offered === undefined ? undefined : formatRule(offered),
    }, req.signal)
    if (answer === undefined) return 'cancelled'
    if (answer === 'reject') {
      this.write(this.theme.error(`  ✗ denied ${nameCall(req.toolName, pending?.summary)}`))
      return 'rejected'
    }
    if (answer === 'always') {
      this.allowed.add(req.toolName)
      this.write(this.theme.dim(`  ✓ allowing every ${req.toolName} call for the rest of this session`))
    }
    if (answer === 'remember' && offered !== undefined && this.rules !== undefined) {
      try {
        const path = await this.rules.remember(offered)
        this.write(this.theme.dim(`  ✓ allowing ${formatRule(offered)} from now on · ${path}`))
      } catch (error) {
        // The call itself was allowed; only the memory of it failed.
        this.write(this.theme.error(`  ✗ could not remember ${formatRule(offered)}: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
    return 'allowed-once'
  }
}

/**
 * The call as a prompt names it: the tool, and the summary when there is one.
 * @param toolName - the tool awaiting a decision.
 * @param summary - the call in one line, or undefined.
 * @returns `bash: git push`, or just `bash`.
 */
export function nameCall(toolName: string, summary: string | undefined): string {
  return summary === undefined || summary === '' ? toolName : `${toolName}: ${summary}`
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
  if (normalized === 'd') return 'remember'
  if (normalized === 'n') return 'reject'
  return undefined
}
