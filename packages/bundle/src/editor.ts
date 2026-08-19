/**
 * The prompt's editing model: a multi-line buffer, a cursor, history, and the
 * completion menu.
 *
 * Pure state. It takes keys and answers with what changed, so every behaviour
 * here is testable without a terminal — the rendering and the raw-mode plumbing
 * are somebody else's job.
 * @module codsh-bundle/src/editor
 */

import type { CompletableCommand, CompletionResult } from './completion.ts'
import type { Key } from './keys.ts'

/** One entry offered in the completion menu. */
export interface Candidate {
  /** The text that replaces the token when accepted. */
  value: string
  /** What it does, shown beside it. Empty for a path, which explains itself. */
  detail: string
}

/** What the editor is showing right now. */
export interface EditorView {
  /** Buffer lines; always at least one, possibly empty. */
  lines: readonly string[]
  /** Cursor line index. */
  row: number
  /** Cursor column within that line, in code points. */
  column: number
  /** Candidates to offer, empty when the menu is closed. */
  candidates: readonly Candidate[]
  /** Which candidate is selected, meaningless when there are none. */
  selected: number
  /** The token under the cursor, which is what the candidates matched. */
  token: string
}

/** What the caller must do after a key. */
export type EditorAction =
  | { kind: 'none' }
  | { kind: 'submit'; text: string }
  | { kind: 'interrupt' }
  | { kind: 'eof' }
  | { kind: 'escape' }

/** How the editor finds candidates for the token under the cursor. */
export interface EditorSources {
  /** The commands currently registered. */
  commands(): readonly CompletableCommand[]
  /** Path candidates for an `@` mention, as the completer produces them. */
  paths(token: string): CompletionResult
  /**
   * Argument candidates for one command's first argument.
   *
   * `/plan off`, `/permission workspace-write`, `/model <id>` — the values a
   * command takes are the command's own knowledge, so the editor asks rather
   * than guessing. Absent or empty means the argument is free-form.
   * @param command - the command name without its slash.
   * @param typed - what has been typed of the argument so far.
   * @returns candidates to offer, best first.
   */
  commandArguments?(command: string, typed: string): readonly Candidate[]
}

/** Longest run of history the editor keeps for one session. */
const HISTORY_LIMIT = 200

/**
 * Split text into the units the cursor counts.
 *
 * Code points, not grapheme clusters: a column here is one cursor step, and the
 * terminal moves the cursor by code point too. A combining mark or a ZWJ emoji
 * therefore takes more than one step, which is the same limit the width
 * measurement carries.
 * @param text - the text to split.
 * @returns its code points.
 */
const points = (text: string): string[] => Array.from(text)

/** A multi-line prompt editor. */
export class Editor {
  private lines = ['']
  private row = 0
  private column = 0
  private candidates: Candidate[] = []
  private selected = 0
  private readonly history: string[] = []
  /** Where the caller is in history; equals `history.length` when not browsing. */
  private browsing = 0
  /** The buffer set aside while history is being browsed. */
  private stashed: string[] | undefined

  constructor(private readonly sources: EditorSources) {}

  /** What to render. */
  get view(): EditorView {
    return {
      lines: this.lines,
      row: this.row,
      column: this.column,
      candidates: this.candidates,
      selected: this.selected,
      token: this.token(),
    }
  }

  /** The buffer as one string. */
  get text(): string {
    return this.lines.join('\n')
  }

  /** Whether nothing has been typed. */
  get empty(): boolean {
    return this.text === ''
  }

  /**
   * Replace the buffer with earlier text, cursor at its end.
   *
   * This is recall-for-editing: the second Escape puts the previous submission
   * back so it can be corrected and resent.
   * @param text - the text to edit, possibly multi-line.
   */
  prefill(text: string): void {
    this.lines = text.split('\n')
    this.row = this.lines.length - 1
    this.column = points(this.line()).length
    this.candidates = []
  }

  /** Submissions this session recorded, oldest first, for persistence. */
  get pastSubmissions(): readonly string[] {
    return this.history
  }

  /**
   * Preload history from an earlier session.
   *
   * Applied before any live submission, so recall starts where the last
   * session ended rather than empty.
   * @param entries - past submissions, oldest first.
   */
  seedHistory(entries: readonly string[]): void {
    this.history.splice(0, this.history.length, ...entries.slice(-HISTORY_LIMIT))
    this.browsing = this.history.length
  }

  /**
   * Apply one key.
   * @param key - the decoded keystroke.
   * @returns what the caller must do about it.
   */
  handle(key: Key): EditorAction {
    switch (key.kind) {
      case 'text': return this.insert(key.text)
      case 'paste':
        // Pasted newlines are content, never submissions: the terminal told us
        // this was a paste, so the block enters the buffer whole.
        return this.insert(key.text)
      case 'enter': return this.accept()
      case 'newline': return this.insert('\n')
      case 'tab': return this.complete()
      case 'backspace': return this.backspace()
      case 'delete': return this.forwardDelete()
      case 'up': return this.moveUp()
      case 'down': return this.moveDown()
      case 'left': return this.moveLeft()
      case 'right': return this.moveRight()
      case 'home': return this.jump(0)
      case 'end': return this.jump(points(this.line()).length)
      case 'kill-line': return this.killLine()
      case 'kill-input': return this.killInput()
      case 'kill-word': return this.killWord()
      case 'word-left': return this.wordLeft()
      case 'word-right': return this.wordRight()
      case 'escape': return this.cancel()
      case 'interrupt': return { kind: 'interrupt' }
      case 'eof':
        // End-of-file only means "leave" on an untouched prompt; with text in
        // hand it would silently discard work.
        return this.text === '' ? { kind: 'eof' } : { kind: 'none' }
      default: return { kind: 'none' }
    }
  }

  /** The line the cursor is on. */
  private line(): string {
    return this.lines[this.row] ?? ''
  }

  /** Replace the cursor's line. */
  private setLine(text: string): void {
    this.lines[this.row] = text
  }

  /**
   * Insert text at the cursor, splitting lines on newlines.
   * @param text - the text to insert.
   * @returns always `none`; insertion never completes a read.
   */
  private insert(text: string): EditorAction {
    const line = this.line()
    const before = points(line).slice(0, this.column).join('')
    const after = points(line).slice(this.column).join('')
    const parts = (before + text + after).split('\n')
    // The inserted text's own line count decides where the cursor lands.
    const inserted = (before + text).split('\n')
    this.lines.splice(this.row, 1, ...parts)
    this.row += inserted.length - 1
    this.column = points(inserted.at(-1) ?? '').length
    this.refresh()
    return { kind: 'none' }
  }

  /**
   * Submit, or accept the highlighted candidate when the menu is open.
   * @returns the submission, or `none` when a candidate was taken instead.
   */
  private accept(): EditorAction {
    if (this.candidates.length > 0) return this.take()
    const text = this.text
    if (text.trim() === '') return { kind: 'none' }
    this.remember(text)
    this.lines = ['']
    this.row = 0
    this.column = 0
    this.candidates = []
    return { kind: 'submit', text }
  }

  /** Record a submission for history, collapsing an immediate repeat. */
  private remember(text: string): void {
    if (this.history.at(-1) !== text) this.history.push(text)
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
    this.browsing = this.history.length
    this.stashed = undefined
  }

  /**
   * Open the menu, or move through it when it is already open.
   * @returns always `none`.
   */
  private complete(): EditorAction {
    if (this.candidates.length === 0) this.refresh()
    // One candidate is not a choice: Tab means "finish this word".
    if (this.candidates.length === 1) return this.take()
    if (this.candidates.length > 1) this.selected = (this.selected + 1) % this.candidates.length
    return { kind: 'none' }
  }

  /**
   * Replace the token under the cursor with the selected candidate.
   * @returns always `none`.
   */
  private take(): EditorAction {
    const candidate = this.candidates[this.selected]
    this.candidates = []
    if (candidate === undefined) return { kind: 'none' }
    const line = this.line()
    const cells = points(line)
    const start = this.tokenStart()
    const replaced = [...cells.slice(0, start), candidate.value, ...cells.slice(this.column)]
    this.setLine(replaced.join(''))
    this.column = start + points(candidate.value).length
    return { kind: 'none' }
  }

  /** Where the token under the cursor begins, in code points. */
  private tokenStart(): number {
    const before = points(this.line()).slice(0, this.column)
    return before.lastIndexOf(' ') + 1
  }

  /** The token under the cursor. */
  private token(): string {
    return points(this.line()).slice(this.tokenStart(), this.column).join('')
  }

  /**
   * Recompute the candidate list for the token under the cursor.
   *
   * Recomputed on every edit rather than only on Tab, which is what makes the
   * menu appear as a command is typed instead of after a key that asks for it.
   */
  private refresh(): void {
    const token = this.token()
    const wholeLine = this.row === 0 && this.tokenStart() === 0
    const line = this.lines[0] ?? ''
    const command = /^\/([a-z][a-z0-9_-]*) /.exec(line)?.[1]
    // The argument slot: the second word of a command line, cursor inside it.
    const inArgument = this.row === 0 && command !== undefined
      && this.tokenStart() === command.length + 2
    if (token.startsWith('@')) {
      const [values] = this.sources.paths(token)
      this.candidates = values.map(value => ({ value, detail: '' }))
    } else if (wholeLine && token.startsWith('/')) {
      this.candidates = this.sources.commands()
        .filter(entry => `/${entry.name}`.startsWith(token))
        .map(entry => ({ value: `/${entry.name}`, detail: entry.description }))
    } else if (inArgument) {
      this.candidates = [...this.sources.commandArguments?.(command, token) ?? []]
    } else {
      this.candidates = []
    }
    // An exact single match is not worth a menu; the word is already finished.
    if (this.candidates.length === 1 && this.candidates[0]?.value === token) this.candidates = []
    this.selected = 0
  }

  /** Remove the character before the cursor, joining lines at a boundary. */
  private backspace(): EditorAction {
    if (this.column > 0) {
      const cells = points(this.line())
      cells.splice(this.column - 1, 1)
      this.setLine(cells.join(''))
      this.column -= 1
    } else if (this.row > 0) {
      const previous = this.lines[this.row - 1] ?? ''
      const current = this.line()
      this.lines.splice(this.row - 1, 2, previous + current)
      this.row -= 1
      this.column = points(previous).length
    }
    this.refresh()
    return { kind: 'none' }
  }

  /** Remove the character after the cursor, joining lines at a boundary. */
  private forwardDelete(): EditorAction {
    const cells = points(this.line())
    if (this.column < cells.length) {
      cells.splice(this.column, 1)
      this.setLine(cells.join(''))
    } else if (this.row < this.lines.length - 1) {
      const next = this.lines[this.row + 1] ?? ''
      this.lines.splice(this.row, 2, this.line() + next)
    }
    this.refresh()
    return { kind: 'none' }
  }

  /** Move up a line, or back through history from the first line. */
  private moveUp(): EditorAction {
    if (this.candidates.length > 0) {
      this.selected = (this.selected - 1 + this.candidates.length) % this.candidates.length
      return { kind: 'none' }
    }
    if (this.row > 0) {
      this.row -= 1
      this.column = Math.min(this.column, points(this.line()).length)
      return { kind: 'none' }
    }
    return this.recall(-1)
  }

  /** Move down a line, or forward through history from the last line. */
  private moveDown(): EditorAction {
    if (this.candidates.length > 0) {
      this.selected = (this.selected + 1) % this.candidates.length
      return { kind: 'none' }
    }
    if (this.row < this.lines.length - 1) {
      this.row += 1
      this.column = Math.min(this.column, points(this.line()).length)
      return { kind: 'none' }
    }
    return this.recall(1)
  }

  /**
   * Step through history.
   * @param delta - -1 for older, 1 for newer.
   * @returns always `none`.
   */
  private recall(delta: number): EditorAction {
    const next = this.browsing + delta
    if (next < 0 || next > this.history.length) return { kind: 'none' }
    // The buffer being edited is set aside on the way in, so stepping past the
    // newest entry gives it back rather than an empty prompt.
    if (this.browsing === this.history.length) this.stashed = this.lines
    this.browsing = next
    const entry = next === this.history.length ? (this.stashed ?? ['']) : (this.history[next] ?? '').split('\n')
    this.lines = [...entry]
    this.row = this.lines.length - 1
    this.column = points(this.line()).length
    this.candidates = []
    return { kind: 'none' }
  }

  /** Move the cursor one position left, wrapping to the previous line. */
  private moveLeft(): EditorAction {
    if (this.column > 0) this.column -= 1
    else if (this.row > 0) {
      this.row -= 1
      this.column = points(this.line()).length
    }
    return { kind: 'none' }
  }

  /** Move the cursor one position right, wrapping to the next line. */
  private moveRight(): EditorAction {
    if (this.column < points(this.line()).length) this.column += 1
    else if (this.row < this.lines.length - 1) {
      this.row += 1
      this.column = 0
    }
    return { kind: 'none' }
  }

  /**
   * Put the cursor at a column on the current line.
   * @param column - the target column.
   * @returns always `none`.
   */
  private jump(column: number): EditorAction {
    this.column = column
    return { kind: 'none' }
  }

  /** Drop everything after the cursor on this line. */
  private killLine(): EditorAction {
    this.setLine(points(this.line()).slice(0, this.column).join(''))
    this.refresh()
    return { kind: 'none' }
  }

  /** Drop everything before the cursor on this line. */
  private killInput(): EditorAction {
    this.setLine(points(this.line()).slice(this.column).join(''))
    this.column = 0
    this.refresh()
    return { kind: 'none' }
  }

  /** Move the cursor to the start of the word before it. */
  private wordLeft(): EditorAction {
    const cells = points(this.line())
    let at = this.column
    while (at > 0 && cells[at - 1] === ' ') at -= 1
    while (at > 0 && cells[at - 1] !== ' ') at -= 1
    this.column = at
    return { kind: 'none' }
  }

  /** Move the cursor past the end of the word after it. */
  private wordRight(): EditorAction {
    const cells = points(this.line())
    let at = this.column
    while (at < cells.length && cells[at] === ' ') at += 1
    while (at < cells.length && cells[at] !== ' ') at += 1
    this.column = at
    return { kind: 'none' }
  }

  /** Drop the word before the cursor. */
  private killWord(): EditorAction {
    const cells = points(this.line())
    let at = this.column
    while (at > 0 && cells[at - 1] === ' ') at -= 1
    while (at > 0 && cells[at - 1] !== ' ') at -= 1
    this.setLine([...cells.slice(0, at), ...cells.slice(this.column)].join(''))
    this.column = at
    this.refresh()
    return { kind: 'none' }
  }

  /**
   * Close the menu, or report Escape when there is none to close.
   * @returns `none` when a menu was dismissed, otherwise `escape`.
   */
  private cancel(): EditorAction {
    if (this.candidates.length > 0) {
      this.candidates = []
      return { kind: 'none' }
    }
    return { kind: 'escape' }
  }
}
