/**
 * Conservative destructive-command classifier.
 *
 * A command is "destructive" when one of its segments has a head — the first
 * program after environment assignments and wrapper words — that is one of the
 * decision-13 categories: a recursive delete, a history rewrite or force push,
 * a disk or permission change, or a database/remote kill. Each `&&`/`||`/`;`/
 * `|`/newline segment is checked, so a dangerous command chained after a benign
 * one is still caught. Matching is anchored to that head and its normalized
 * tokens, never to substring containment, so a benign command that merely
 * mentions `rm -rf` inside an argument is not flagged.
 *
 * Deliberately conservative: a miss is an accepted risk, so the vocabulary is
 * extended by category rather than by one-off patterns. Pure: no I/O, no theme.
 * @module codsh-bundle/src/destructive
 */

/** The four destructive categories of Grill decision 13. */
export type DestructiveCategory = 'delete' | 'history' | 'disk' | 'database'

/** Wrapper words that precede the real program in a command head. */
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'nohup', 'time', 'exec'])

/** Shells whose `-c` argument is another command to check. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/**
 * Split a command line into its pipeline/sequence segments, keeping quoted runs
 * whole so a separator inside an argument is not mistaken for a chain.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at] ?? ''
    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\n' || char === ';') {
      segments.push(current)
      current = ''
      continue
    }
    if (char === '&' && command[at + 1] === '&') {
      segments.push(current)
      current = ''
      at += 1
      continue
    }
    if (char === '|' && command[at + 1] === '|') {
      segments.push(current)
      current = ''
      at += 1
      continue
    }
    if (char === '|') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments.map(segment => segment.trim()).filter(segment => segment !== '')
}

/** Split one command head into tokens, keeping quoted runs whole. */
function headTokens(segment: string): string[] {
  const raw = segment.match(/"[^"]*"|'[^']*'|\S+/gu) ?? []
  const tokens = raw.map(token => token.replace(/^["']|["']$/gu, ''))
  let at = 0
  while (at < tokens.length) {
    const token = tokens[at] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token) || WRAPPERS.has(token)) {
      at += 1
      continue
    }
    break
  }
  return tokens.slice(at)
}

/** Whether any token is a short flag carrying `letter`. */
function hasShortFlag(tokens: readonly string[], letter: string): boolean {
  return tokens.some((token) => {
    if (!/^-[A-Za-z]+$/u.test(token)) return false
    return token.slice(1).includes(letter)
  })
}

/** The base program name, with any leading path removed and lowercased. */
function programName(token: string): string {
  return (token.split('/').at(-1) ?? token).toLowerCase()
}

/** The `-c` / `-e` script a client was handed, when present. */
function scriptArgument(tokens: readonly string[]): string | undefined {
  for (let at = 1; at < tokens.length - 1; at += 1) {
    const flag = tokens[at]
    if (flag === '-c' || flag === '-e' || flag === '--command' || flag === '--execute') return tokens[at + 1]
  }
  return undefined
}

/** Classify one already-split command segment by its head. */
function classifyHead(segment: string): DestructiveCategory | undefined {
  const tokens = headTokens(segment)
  const [head = '', ...args] = tokens
  const program = programName(head)

  if (program === 'rm') {
    if (hasShortFlag(args, 'r') || hasShortFlag(args, 'R') || args.includes('--recursive')) return 'delete'
    return undefined
  }

  if (program === 'git') {
    const [sub = '', ...flags] = args
    if (sub === 'push' && flags.some(flag => flag === '-f' || flag === '--force' || flag.startsWith('--force-with-lease'))) return 'history'
    if (sub === 'reset' && flags.includes('--hard')) return 'history'
    if (sub === 'clean' && (hasShortFlag(flags, 'f') || hasShortFlag(flags, 'd'))) return 'history'
    if (sub === 'branch' && (flags.includes('-D') || flags.includes('--delete') && flags.includes('--force'))) return 'history'
    return undefined
  }

  if (SHELLS.has(program)) {
    const script = scriptArgument(tokens)
    if (script !== undefined) return destructiveCategory(script)
    return undefined
  }

  if (program.startsWith('mkfs')) return 'disk'
  if (program === 'dd' && args.some(arg => arg.startsWith('of='))) return 'disk'
  if (program === 'chmod' && (args.includes('-R') || args.includes('--recursive')) && args.includes('777')) return 'disk'
  if (program === 'shutdown') return 'disk'

  if (program === 'kill' && (args.includes('-9') || args.includes('-KILL') || args.includes('-SIGKILL'))) return 'database'

  const sql = program === 'psql' || program === 'mysql' || program === 'sqlite3' || program === 'mariadb'
  const statement = (sql ? scriptArgument(tokens) : tokens.join(' '))?.trim().toUpperCase() ?? ''
  if (statement.startsWith('DROP TABLE') || statement.startsWith('TRUNCATE')) return 'database'

  return undefined
}

/**
 * Classify a shell command as destructive, by category.
 *
 * @param command - the command exactly as the presenter declared it.
 * @returns the matched category, or undefined for anything not on the list.
 */
export function destructiveCategory(command: string): DestructiveCategory | undefined {
  for (const segment of splitSegments(command)) {
    const match = classifyHead(segment)
    if (match !== undefined) return match
  }
  return undefined
}

/**
 * Whether a command is destructive at all.
 * @param command - the command exactly as the presenter declared it.
 * @returns true when {@link destructiveCategory} matches a category.
 */
export function isDestructiveCommand(command: string): boolean {
  return destructiveCategory(command) !== undefined
}
