/**
 * Custom slash commands from Markdown files.
 *
 * A file named `review.md` under a commands root becomes `/review`: its
 * frontmatter `description` labels it in the completion menu, and its body is
 * the prompt submitted when the command runs — with `$ARGUMENTS` replaced by
 * whatever followed the name. They are canned prompts, not handlers: execution
 * goes through the same submission path as a typed message.
 * @module codsh/src/custom-commands
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** One loaded command. */
export interface CustomCommand {
  /** The name typed after the slash. */
  name: string
  /** Menu label, from frontmatter or a fallback naming the file. */
  description: string
  /** The prompt body, with `$ARGUMENTS` placeholders intact. */
  template: string
}

/** What loading produced: the commands, and what was skipped and why. */
export interface CustomCommandLoad {
  commands: CustomCommand[]
  /** One line per skipped file, for the surface to show once at startup. */
  warnings: string[]
}

/** The registry's command-name rule; a file that breaks it cannot register. */
const NAME = /^[a-z][a-z0-9_-]*$/

/**
 * Parse one command file: optional `---` frontmatter with a `description`
 * line, then the prompt body.
 * @param source - the file content.
 * @returns the description (empty when absent) and the body.
 */
export function parseCommandFile(source: string): { description: string; body: string } {
  if (source.startsWith('---\n')) {
    const end = source.indexOf('\n---\n', 4)
    if (end >= 0) {
      const header = source.slice(4, end)
      const description = /^description:\s*(.+)$/m.exec(header)?.[1]?.trim() ?? ''
      return { description, body: source.slice(end + 5).trim() }
    }
  }
  return { description: '', body: source.trim() }
}

/**
 * Fill a template with the typed arguments.
 * @param template - the prompt body.
 * @param typed - what followed the command name, possibly empty.
 * @returns the prompt to submit: placeholders replaced, or the arguments
 *   appended when the template never asked for them.
 */
export function expandTemplate(template: string, typed: string): string {
  if (template.includes('$ARGUMENTS')) return template.replaceAll('$ARGUMENTS', typed)
  return typed === '' ? template : `${template}\n\n${typed}`
}

/**
 * Load every command under the given roots, later roots shadowing earlier.
 *
 * A missing root is normal (most setups define no custom commands); an
 * unreadable or misnamed file is a warning, never a failed startup — a broken
 * canned prompt should cost that prompt, not the session.
 * @param roots - directories to scan, lowest precedence first.
 * @param taken - names already registered, which a file cannot shadow.
 * @returns the loaded commands and the warnings to show once.
 */
export async function loadCustomCommands(roots: readonly string[], taken: ReadonlySet<string>): Promise<CustomCommandLoad> {
  const commands = new Map<string, CustomCommand>()
  const warnings: string[] = []
  for (const root of roots) {
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      // A root that does not exist defines no commands.
      continue
    }
    for (const entry of entries.filter(name => name.endsWith('.md')).sort()) {
      const name = entry.slice(0, -3)
      if (!NAME.test(name)) {
        warnings.push(`${join(root, entry)}: "${name}" is not a command name (lowercase letters, digits, - and _)`)
        continue
      }
      if (taken.has(name)) {
        warnings.push(`${join(root, entry)}: /${name} is already a built-in command`)
        continue
      }
      try {
        const { description, body } = parseCommandFile(await readFile(join(root, entry), 'utf8'))
        if (body === '') {
          warnings.push(`${join(root, entry)}: empty prompt body`)
          continue
        }
        commands.set(name, { name, description: description === '' ? `custom command (${entry})` : description, template: body })
      } catch (error) {
        warnings.push(`${join(root, entry)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return { commands: [...commands.values()], warnings }
}
