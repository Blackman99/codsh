/**
 * Remembered approvals: the rules a person wrote down so the same question is
 * not asked twice.
 *
 * dsh has no grant store — `ApprovalOutcome` is one-shot — so codsh keeps its
 * own, as three JSON files read on every decision: the project's committed
 * `.dsh/permissions.json`, the personal `.dsh/permissions.local.json` beside
 * it (what the approval widget writes), and `~/.dsh/permissions.json` for the
 * whole machine. Each holds `{ "allow": [rule, …] }`; the lists are unioned.
 *
 * A rule is a tool name — `write` — or a tool with a command pattern —
 * `bash(git push *)`, `bash(pnpm test)`. The pattern reads the call's
 * `command` argument: a trailing ` *` allows the exact prefix and anything
 * after a space; without it the command must match exactly. A compound
 * command — a newline, `;`, `|`, `&`, a backtick, `$(` — never matches a
 * pattern, however it starts: `git status && rm -rf .` is not a `git` call.
 * @module codsh-bundle/src/permissions
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One remembered grant. */
export interface Rule {
  /** The tool the rule is about. */
  tool: string
  /** The command pattern, when the rule is narrower than the tool. */
  command?: { kind: 'prefix'; prefix: string } | { kind: 'exact'; command: string }
}

/** Where the three rule files live. */
export interface RulePaths {
  /** Committed with the project: `<cwd>/.dsh/permissions.json`. */
  project: string
  /** Personal, beside it: `<cwd>/.dsh/permissions.local.json`. The widget writes here. */
  projectLocal: string
  /** The machine's: `~/.dsh/permissions.json`. */
  user: string
}

/** How the store reports on itself. */
export interface RuleStoreOptions {
  /** A path as a person should read it — relative to the workspace, say. */
  label?: (path: string) => string
  /** Where a file that does not parse, or a rule that does not, is named once. */
  warn?: (line: string) => void
}

/** Programs whose first argument is a subcommand worth keeping in a suggested prefix. */
const SUBCOMMAND_PROGRAMS = new Set(['git', 'npm', 'pnpm', 'cargo', 'go', 'docker'])

/** What makes a command more than one command. */
const COMPOUND = /[\n;|&`]|\$\(/u

/** `tool`, or `tool(pattern)`; the tool name is one shell-safe word. */
const RULE = /^([A-Za-z0-9_.:-]+)(?:\((.*)\))?$/su

/** A leading `NAME=value` the shell would read as an environment assignment. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u

/**
 * Read one rule as written in a file.
 * @param text - `write`, `bash(git push *)`, or `bash(pnpm test)`.
 * @returns the rule, or undefined when the text is not one.
 */
export function parseRule(text: string): Rule | undefined {
  const match = RULE.exec(text.trim())
  if (match === null) return undefined
  const [, tool, pattern] = match
  if (tool === undefined) return undefined
  if (pattern === undefined) return { tool }
  const body = pattern.trim()
  if (body === '') return undefined
  // `bash(*)` is `bash`: every command, spelled the long way.
  if (body === '*') return { tool }
  if (body.endsWith(' *')) {
    const prefix = body.slice(0, -2).trim()
    return prefix === '' ? undefined : { tool, command: { kind: 'prefix', prefix } }
  }
  return { tool, command: { kind: 'exact', command: body } }
}

/**
 * Spell a rule the way a file holds it.
 * @param rule - the rule.
 * @returns `write`, `bash(git push *)`, or `bash(pnpm test)`.
 */
export function formatRule(rule: Rule): string {
  if (rule.command === undefined) return rule.tool
  return rule.command.kind === 'prefix'
    ? `${rule.tool}(${rule.command.prefix} *)`
    : `${rule.tool}(${rule.command.command})`
}

/**
 * The call's command line, when the tool takes one.
 * @param args - the parsed call arguments.
 * @returns the `command` argument, or undefined for a tool without one.
 */
export function commandOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const { command } = args as { command?: unknown }
  return typeof command === 'string' ? command : undefined
}

/**
 * Whether a command is several commands, or runs something it does not name.
 * @param command - the command line.
 * @returns true for a newline, `;`, `|`, `&`, a backtick, or `$(`.
 */
export function isCompound(command: string): boolean {
  return COMPOUND.test(command)
}

/**
 * Whether one rule allows one call.
 * @param rule - the remembered grant.
 * @param toolName - the tool the model called.
 * @param args - the parsed call arguments; undefined when unknown, which only a tool-level rule can match.
 * @returns true when the rule covers the call.
 */
export function ruleMatches(rule: Rule, toolName: string, args: unknown): boolean {
  if (rule.tool !== toolName) return false
  if (rule.command === undefined) return true
  const command = commandOf(args)
  if (command === undefined) return false
  const trimmed = command.trim()
  if (rule.command.kind === 'exact') return trimmed === rule.command.command
  if (isCompound(trimmed)) return false
  const { prefix } = rule.command
  return trimmed === prefix || trimmed.startsWith(`${prefix} `)
}

/**
 * The rule the approval widget offers for one call.
 *
 * A tool without a command line is offered whole. A command is offered by its
 * program — plus its subcommand for `git`, `npm`, `pnpm`, `cargo`, `go`, and
 * `docker`, where `git status *` and `git push *` are different trusts — with
 * leading `NAME=value` assignments skipped. A compound command is offered
 * nothing: no prefix of it is safe to remember.
 * @param toolName - the tool the model called.
 * @param args - the parsed call arguments.
 * @returns the rule to offer, or undefined when none is safe.
 */
export function suggestRule(toolName: string, args: unknown): Rule | undefined {
  const command = commandOf(args)
  if (command === undefined) return { tool: toolName }
  const trimmed = command.trim()
  if (trimmed === '' || isCompound(trimmed)) return undefined
  const words = trimmed.split(/\s+/u)
  let at = 0
  while (at < words.length - 1 && ASSIGNMENT.test(words[at] ?? '')) at += 1
  const program = words[at]
  if (program === undefined) return undefined
  const next = words[at + 1]
  const prefix = SUBCOMMAND_PROGRAMS.has(program) && next !== undefined && !next.startsWith('-')
    ? `${program} ${next}`
    : program
  return { tool: toolName, command: { kind: 'prefix', prefix } }
}

/** The shape a rule file holds. */
interface RuleFile {
  allow: string[]
}

/**
 * The three rule files, read fresh on every question so an edit by hand takes
 * effect on the next call.
 */
export class PermissionRules {
  private readonly label: (path: string) => string
  private readonly warn: (line: string) => void
  private readonly warned = new Set<string>()

  constructor(private readonly paths: RulePaths, options: RuleStoreOptions = {}) {
    this.label = options.label ?? (path => path)
    this.warn = options.warn ?? (() => undefined)
  }

  /**
   * Every rule the files hold, the personal project file first.
   * @returns the rules; a file or a line that does not parse is named once and skipped.
   */
  async rules(): Promise<Rule[]> {
    const rules: Rule[] = []
    for (const path of [this.paths.projectLocal, this.paths.project, this.paths.user]) {
      const file = await this.read(path)
      if (file === undefined) continue
      for (const text of file.allow) {
        const rule = parseRule(text)
        if (rule === undefined) this.warnOnce(`${this.label(path)}: not a rule, skipped: ${JSON.stringify(text)}`)
        else rules.push(rule)
      }
    }
    return rules
  }

  /**
   * The first rule allowing one call.
   * @param toolName - the tool the model called.
   * @param args - the parsed call arguments, or undefined when unknown.
   * @returns the rule, or undefined when the call must be asked.
   */
  async allows(toolName: string, args: unknown): Promise<Rule | undefined> {
    return (await this.rules()).find(rule => ruleMatches(rule, toolName, args))
  }

  /**
   * Add a rule to the personal project file, creating the file and its folder.
   * @param rule - the grant to keep.
   * @returns the path written, as a person should read it.
   * @throws when the file exists and does not parse — it is not overwritten.
   */
  async remember(rule: Rule): Promise<string> {
    const path = this.paths.projectLocal
    const file = await this.read(path, { strict: true }) ?? { allow: [] }
    const text = formatRule(rule)
    if (!file.allow.includes(text)) file.allow.push(text)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ allow: file.allow }, null, 2)}\n`)
    return this.label(path)
  }

  /**
   * Read one rule file.
   * @param path - the file.
   * @param options - `strict` throws instead of warning, for a write that must not clobber.
   * @returns the file, or undefined when it is missing or (non-strict) unreadable.
   */
  private async read(path: string, options: { strict?: boolean } = {}): Promise<RuleFile | undefined> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return this.fail(path, error instanceof Error ? error.message : String(error), options.strict)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return this.fail(path, error instanceof Error ? error.message : String(error), options.strict)
    }
    const allow = (parsed as { allow?: unknown } | null)?.allow
    if (!Array.isArray(allow)) return this.fail(path, 'expected { "allow": [ … ] }', options.strict)
    return { allow: allow.filter((entry): entry is string => typeof entry === 'string') }
  }

  private fail(path: string, why: string, strict: boolean | undefined): undefined {
    const line = `${this.label(path)}: ${why}`
    if (strict) throw new Error(`${line} — fix or remove the file, then answer again`)
    this.warnOnce(line)
    return undefined
  }

  private warnOnce(line: string): void {
    if (this.warned.has(line)) return
    this.warned.add(line)
    this.warn(line)
  }
}
