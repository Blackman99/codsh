/**
 * A terminal emulator for the end-to-end suites.
 *
 * The surface owns its screen now, so what it emits is frames — absolute cursor
 * moves, line erases, buffer switches — not lines of text. Asserting on those
 * bytes tests the drawing strategy; asserting on the screen they produce tests
 * what a person actually sees, and survives a change of strategy.
 *
 * Enough of xterm for that judgement: the two buffers and their swap (1049),
 * absolute and relative cursor movement, line and screen erases, cursor
 * visibility, and the modes that only need swallowing (mouse, synchronized
 * output, bracketed paste).
 * @module codsh/e2e/vt
 */

/** East Asian Wide and Fullwidth code points occupy two columns. */
function width(character: string): number {
  const code = character.codePointAt(0) ?? 0
  const wide = (code >= 0x1100 && code <= 0x115F)
    || (code >= 0x2E80 && code <= 0xA4CF)
    || (code >= 0xAC00 && code <= 0xD7A3)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFF00 && code <= 0xFF60)
    || (code >= 0xFFE0 && code <= 0xFFE6)
    || (code >= 0x1F300 && code <= 0x1FAFF)
  return wide ? 2 : 1
}

/** A run of cells sharing one pen, which is how a styled row is read back. */
export interface Run {
  /** The characters. */
  text: string
  /** The pen they were written with, `''` for the terminal's default. */
  pen: string
}

/** One screen buffer: a grid, a cursor, and scrolling at the bottom. */
class Buffer {
  private grid: string[][]
  /**
   * The pen each cell was written with, parallel to the grid.
   *
   * Kept beside the characters rather than inside them: a cell holds one
   * character and one pen, and a screen read back as text has to stay exactly
   * what it was before styling was recorded at all.
   */
  private pens: string[][]
  row = 0
  column = 0

  constructor(public rows: number, public columns: number) {
    this.grid = Buffer.blank(rows, columns)
    this.pens = Buffer.blankPens(rows, columns)
  }

  private static blank(rows: number, columns: number): string[][] {
    return Array.from({ length: rows }, () => Array.from({ length: columns }, () => ' '))
  }

  private static blankPens(rows: number, columns: number): string[][] {
    return Array.from({ length: rows }, () => Array.from({ length: columns }, () => ''))
  }

  /** Text of one row, trailing blanks removed. */
  line(index: number): string {
    return (this.grid[index] ?? []).join('').replace(/\s+$/u, '')
  }

  /** The whole buffer as lines. */
  get lines(): string[] {
    return Array.from({ length: this.rows }, (_, index) => this.line(index))
  }

  /**
   * One row as runs of same-pen text, trailing blanks removed.
   * @param index - the row.
   * @returns the runs, left to right.
   */
  styled(index: number): Run[] {
    const characters = this.grid[index] ?? []
    const pens = this.pens[index] ?? []
    const width_ = this.line(index).length
    const runs: Run[] = []
    for (let at = 0; at < characters.length; at += 1) {
      const character = characters[at] ?? ''
      if (character === '') continue
      // Trailing blanks are not part of the row, and neither are their pens.
      if (runs.reduce((sum, run) => sum + run.text.length, 0) >= width_) break
      const pen = pens[at] ?? ''
      const last = runs.at(-1)
      if (last !== undefined && last.pen === pen) last.text += character
      else runs.push({ text: character, pen })
    }
    return runs
  }

  /** Drop the top row and add a blank one at the bottom. */
  scroll(): void {
    this.grid.shift()
    this.grid.push(Array.from({ length: this.columns }, () => ' '))
    this.pens.shift()
    this.pens.push(Array.from({ length: this.columns }, () => ''))
  }

  /** Put one character at the cursor, wrapping and scrolling as a terminal does. */
  put(character: string, pen = ''): void {
    const cost = width(character)
    if (this.column + cost > this.columns) {
      this.column = 0
      this.newline()
    }
    const row = this.grid[this.row]
    const penRow = this.pens[this.row]
    if (row === undefined || penRow === undefined) return
    row[this.column] = character
    penRow[this.column] = pen
    if (cost === 2 && this.column + 1 < this.columns) row[this.column + 1] = ''
    this.column += cost
  }

  /** Move down a row, scrolling at the bottom. */
  newline(): void {
    this.row += 1
    if (this.row >= this.rows) {
      this.row = this.rows - 1
      this.scroll()
    }
  }

  /** Erase from the cursor to the end of its row. */
  eraseToEndOfLine(): void {
    const row = this.grid[this.row]
    const penRow = this.pens[this.row]
    if (row === undefined || penRow === undefined) return
    for (let index = this.column; index < this.columns; index += 1) {
      row[index] = ' '
      penRow[index] = ''
    }
  }

  /** Erase from the cursor to the end of the screen. */
  eraseBelow(): void {
    this.eraseToEndOfLine()
    for (let index = this.row + 1; index < this.rows; index += 1) {
      this.grid[index] = Array.from({ length: this.columns }, () => ' ')
      this.pens[index] = Array.from({ length: this.columns }, () => '')
    }
  }

  /** Erase everything. */
  eraseAll(): void {
    this.grid = Buffer.blank(this.rows, this.columns)
    this.pens = Buffer.blankPens(this.rows, this.columns)
  }

  /** Apply a new size, keeping what still fits. */
  resize(rows: number, columns: number): void {
    const grid = this.grid.slice(0, rows).map(row =>
      [...row.slice(0, columns), ...Array.from({ length: Math.max(0, columns - row.length) }, () => ' ')])
    while (grid.length < rows) grid.push(Array.from({ length: columns }, () => ' '))
    const pens = this.pens.slice(0, rows).map(row =>
      [...row.slice(0, columns), ...Array.from({ length: Math.max(0, columns - row.length) }, () => '')])
    while (pens.length < rows) pens.push(Array.from({ length: columns }, () => ''))
    this.pens = pens
    this.grid = grid
    this.rows = rows
    this.columns = columns
    this.row = Math.min(this.row, rows - 1)
    this.column = Math.min(this.column, columns - 1)
  }
}

/** A terminal with a primary and an alternate screen. */
export class Terminal {
  private readonly primaryBuffer: Buffer
  private alternateBuffer: Buffer
  /** Whether the alternate screen is showing. */
  onAlternate = false
  /** Whether the cursor is currently hidden. */
  cursorHidden = false
  /** Whether any mouse reporting mode is on. */
  mouseReporting = false
  /** Bytes held back because an escape sequence was cut across reads. */
  private held = ''
  /**
   * The pen in force, as the SGR parameters that set it.
   *
   * Only what this surface actually paints with: a foreground colour (basic or
   * 256-palette) and the bold, dim, underline and inverse attributes. Anything
   * else is swallowed as before — a screen assertion must not start failing
   * over an attribute nothing reads.
   */
  private pen = { fg: '', bold: false, dim: false, underline: false, inverse: false }

  constructor(rows = 24, columns = 80) {
    this.primaryBuffer = new Buffer(rows, columns)
    this.alternateBuffer = new Buffer(rows, columns)
  }

  /** The buffer currently on screen. */
  private get buffer(): Buffer {
    return this.onAlternate ? this.alternateBuffer : this.primaryBuffer
  }

  /** What is on screen now. */
  get screen(): string[] {
    return this.buffer.lines
  }

  /** What is on screen now, as one string. */
  get text(): string {
    return this.screen.join('\n')
  }

  /** Row the cursor sits on, from zero — which row the box put it in. */
  get cursorRow(): number {
    return this.buffer.row
  }

  /** Column the cursor sits at, from zero. */
  get cursorColumn(): number {
    return this.buffer.column
  }

  /** The buffer the person keeps — their shell's, untouched by the session. */
  get primary(): string[] {
    return this.primaryBuffer.lines
  }

  /** The session's own screen. */
  get alternate(): string[] {
    return this.alternateBuffer.lines
  }

  /** What is on screen now, each row as runs of same-pen text. */
  get styledScreen(): Run[][] {
    return Array.from({ length: this.buffer.rows }, (_, index) => this.buffer.styled(index))
  }

  /** The session's own screen, each row as runs of same-pen text. */
  get styledAlternate(): Run[][] {
    return Array.from({ length: this.alternateBuffer.rows }, (_, index) => this.alternateBuffer.styled(index))
  }

  /** Apply a window size change to both buffers. */
  resize(rows: number, columns: number): void {
    this.primaryBuffer.resize(rows, columns)
    this.alternateBuffer.resize(rows, columns)
  }

  /**
   * Feed terminal output.
   * @param data - bytes as text; a sequence cut at the end is held for the next call.
   */
  feed(data: string): void {
    let rest = this.held + data
    this.held = ''
    while (rest !== '') {
      const character = rest[0] ?? ''
      if (character === '\u001B') {
        const csi = /^\u001B\[([0-9;?<>]*)([A-Za-z])/.exec(rest)
        if (csi !== null) {
          this.control(csi[1] ?? '', csi[2] ?? '')
          rest = rest.slice(csi[0].length)
          continue
        }
        const osc = /^\u001B\][^\u0007]*\u0007/.exec(rest)
        if (osc !== null) {
          rest = rest.slice(osc[0].length)
          continue
        }
        // An incomplete sequence waits for the rest rather than printing.
        if (/^\u001B(?:\[[0-9;?<>]*|\][^\u0007]*)?$/u.test(rest)) {
          this.held = rest
          return
        }
        rest = rest.slice(2)
        continue
      }
      rest = rest.slice(character.length)
      if (character === '\r') this.buffer.column = 0
      else if (character === '\n') this.buffer.newline()
      else if (character === '\b') this.buffer.column = Math.max(0, this.buffer.column - 1)
      else if (character === '\u0007') continue
      else this.buffer.put(character, this.penKey())
    }
  }

  /**
   * Apply one SGR sequence to the pen in force.
   *
   * A bare `ESC[m` is a reset, as is `0`. Colours are the basic sixteen and
   * the 256-palette form the surface uses for secondary text; the attributes
   * are the four it sets, each with the code that clears it alone.
   * @param params - the parameter bytes of an `m` sequence.
   */
  private select(params: string): void {
    const codes = params === '' ? ['0'] : params.split(';')
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index] ?? ''
      if (code === '' || code === '0') {
        this.pen = { fg: '', bold: false, dim: false, underline: false, inverse: false }
      }
      else if (code === '1') this.pen.bold = true
      else if (code === '2') this.pen.dim = true
      else if (code === '4') this.pen.underline = true
      else if (code === '7') this.pen.inverse = true
      else if (code === '22') this.pen = { ...this.pen, bold: false, dim: false }
      else if (code === '24') this.pen.underline = false
      else if (code === '27') this.pen.inverse = false
      else if (code === '39') this.pen.fg = ''
      else if (code === '38') {
        // `38;5;N` names a palette entry; `38;2;R;G;B` a direct colour.
        const kind = codes[index + 1] ?? ''
        const span = kind === '5' ? 2 : kind === '2' ? 4 : 0
        this.pen.fg = codes.slice(index, index + span + 1).join(';')
        index += span
      }
      else if (/^(?:3[0-7]|9[0-7])$/u.test(code)) this.pen.fg = code
    }
  }

  /** The pen in force as one comparable string, `''` when nothing is set. */
  private penKey(): string {
    const parts = [
      this.pen.fg,
      this.pen.bold ? '1' : '',
      this.pen.dim ? '2' : '',
      this.pen.underline ? '4' : '',
      this.pen.inverse ? '7' : '',
    ].filter(part => part !== '')
    return parts.join(';')
  }

  /**
   * Apply one CSI sequence.
   * @param params - the parameter bytes.
   * @param final - the final byte, which selects the action.
   */
  private control(params: string, final: string): void {
    const digits = params.replace(/^[?<>]+/u, '')
    const count = /^\d+$/u.test(digits) ? Number(digits) : 1
    if (params.startsWith('?') && (final === 'h' || final === 'l')) {
      const on = final === 'h'
      const modes = new Set(digits.split(';').filter(part => /^\d+$/u.test(part)).map(Number))
      if (modes.has(1049) || modes.has(47) || modes.has(1047)) {
        this.onAlternate = on
        // A fresh alternate screen each time, as a terminal gives.
        if (on) this.alternateBuffer = new Buffer(this.primaryBuffer.rows, this.primaryBuffer.columns)
      }
      if (modes.has(25)) this.cursorHidden = !on
      if ([1000, 1002, 1003, 1006].some(mode => modes.has(mode))) this.mouseReporting = on
      return
    }
    const buffer = this.buffer
    if (final === 'm') {
      this.select(params)
      return
    }
    switch (final) {
      case 'H': {
        const [rowText = '', columnText = ''] = params.split(';')
        buffer.row = Math.min(buffer.rows - 1, Math.max(0, (/^\d+$/u.test(rowText) ? Number(rowText) : 1) - 1))
        buffer.column = Math.min(buffer.columns - 1, Math.max(0, (/^\d+$/u.test(columnText) ? Number(columnText) : 1) - 1))
        break
      }
      case 'K':
        buffer.eraseToEndOfLine()
        break
      case 'J':
        if (params === '2' || params === '3') buffer.eraseAll()
        else buffer.eraseBelow()
        break
      case 'A':
        buffer.row = Math.max(0, buffer.row - count)
        break
      case 'B':
        buffer.row = Math.min(buffer.rows - 1, buffer.row + count)
        break
      case 'C':
        buffer.column = Math.min(buffer.columns - 1, buffer.column + count)
        break
      case 'D':
        buffer.column = Math.max(0, buffer.column - count)
        break
      default:
        // Styling and everything else changes no cell position.
        break
    }
  }
}

/**
 * Render captured PTY output and report the screens it produced.
 * @param output - everything the PTY emitted, in order.
 * @param rows - the window height the run used.
 * @param columns - the window width the run used.
 * @returns the terminal, for screen-level assertions.
 */
export function render(output: string, rows: number, columns: number): Terminal {
  const terminal = new Terminal(rows, columns)
  terminal.feed(output)
  return terminal
}
