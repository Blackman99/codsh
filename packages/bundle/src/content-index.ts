/** Stable raw-content addresses for assistant answers and fenced code blocks. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { parseMarkdownFence } from './markdown.ts'

/** One copyable raw-content target. */
export interface CopyTarget {
  /** Human-facing stable address: `N` for an answer or `N:C` for code. */
  address: string
  /** Raw answer Markdown or fence-free code. */
  text: string
  /** Short plain-text selector label. */
  label: string
  /** One-based assistant-answer number. */
  answer: number
  /** One-based fenced-code number within the answer. */
  code?: number
  kind: 'answer' | 'code'
}

function stripTerminalEscapes(text: string): string {
  let plain = ''
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code !== 0x1B && code !== 0x9B) {
      plain += text[index] ?? ''
      index += 1
      continue
    }
    const introducer = code === 0x9B ? '[' : text[index + 1]
    if (introducer === '[') {
      index += code === 0x9B ? 1 : 2
      while (index < text.length) {
        const final = text.charCodeAt(index)
        index += 1
        if (final >= 0x40 && final <= 0x7E) break
      }
      continue
    }
    if (introducer === ']' || introducer === 'P' || introducer === 'X' || introducer === '^' || introducer === '_') {
      index += 2
      while (index < text.length) {
        if (text[index] === '\u0007') {
          index += 1
          break
        }
        if (text[index] === '\u001B' && text[index + 1] === '\\') {
          index += 2
          break
        }
        index += 1
      }
      continue
    }
    index += code === 0x1B && index + 1 < text.length ? 2 : 1
  }
  return plain
}

function assistantText(event: SessionEvent): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  const message = event.data.message
  const text = stripTerminalEscapes(message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(''))
  return text.trim().length > 0 ? text : undefined
}

function firstLine(text: string): string {
  const line = text.split(/\r\n|[\r\n]/u).find(candidate => candidate.trim().length > 0)?.trim() ?? ''
  return line.length > 72 ? `${line.slice(0, 71)}…` : line
}

interface SourceLine {
  body: string
  ending: string
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  while (start < text.length) {
    let end = start
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end += 1
    let after = end
    if (text[end] === '\r' && text[end + 1] === '\n') after += 2
    else if (end < text.length) after += 1
    lines.push({ body: text.slice(start, end), ending: text.slice(end, after) })
    start = after
  }
  return lines
}

function fencedCode(text: string): string[] {
  const lines = sourceLines(text)
  const blocks: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (parseMarkdownFence(lines[index]?.body ?? '') === undefined) continue
    let closed = false
    for (let closing = index + 1; closing < lines.length; closing += 1) {
      if (parseMarkdownFence(lines[closing]?.body ?? '') === undefined) continue
      const content = lines.slice(index + 1, closing)
      const code = content.map((line, contentIndex) => (
        line.body + (contentIndex < content.length - 1 ? line.ending : '')
      )).join('')
      blocks.push(code)
      index = closing
      closed = true
      break
    }
    if (!closed) break
  }
  return blocks
}

/** Build chronological copy targets from raw session events, independent of rendering. */
export function indexConversationContent(events: readonly SessionEvent[]): CopyTarget[] {
  const targets: CopyTarget[] = []
  let answer = 0
  for (const event of events) {
    const text = assistantText(event)
    if (text === undefined) continue
    answer += 1
    targets.push({
      address: String(answer),
      text,
      label: firstLine(text),
      answer,
      kind: 'answer',
    })
    fencedCode(text).forEach((codeText, index) => {
      const code = index + 1
      targets.push({
        address: `${answer}:${code}`,
        text: codeText,
        label: firstLine(codeText) || '(empty code block)',
        answer,
        code,
        kind: 'code',
      })
    })
  }
  return targets
}

/** Present newest answers first without separating their code targets. */
export function newestCopyTargets(targets: readonly CopyTarget[]): CopyTarget[] {
  return [...targets].sort((left, right) => right.answer - left.answer || Number(left.code ?? 0) - Number(right.code ?? 0))
}

/** Resolve one canonical `N` or `N:C` copy address. */
export function resolveCopyTarget(targets: readonly CopyTarget[], address: string): CopyTarget | undefined {
  if (!/^[1-9]\d*(?::[1-9]\d*)?$/u.test(address)) return undefined
  return targets.find(target => target.address === address)
}
