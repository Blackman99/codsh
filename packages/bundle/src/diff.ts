/** Unified-diff styling, shared by the `/diff` command and the fullscreen reader. */

import { structuredPatch } from 'diff'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import type { Theme } from './theme.ts'

/** Context lines kept on each side of a hunk, matching the transcript card. */
const CONTEXT = 3

/**
 * Style one unified-diff line.
 *
 * Order matters: a file header opens with `+++` or `---`, which are also the
 * prefixes an added and a removed line carry, so the headers are answered
 * first and the markers only reach lines that are really content.
 * @param line - the raw diff line.
 * @param theme - styling for additions, removals, and headers.
 * @returns the styled line.
 */
export function styleDiffLine(line: string, theme: Theme): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return theme.dim(line)
  if (line.startsWith('@@')) return theme.tool(line)
  if (line.startsWith('+')) return theme.success(line)
  if (line.startsWith('-')) return theme.error(line)
  return theme.dim(line)
}

/**
 * Render a card's file changes back into unified-diff text.
 *
 * The transcript styles a {@link FileDiff} straight into coloured rows, which
 * is the right artefact for a card and the wrong one for a reader: the reader
 * colours raw text itself, and what it is given should read like the diff a
 * person would get from git. A `null` `oldText` is a create, which git writes
 * against `/dev/null` rather than an empty file.
 * @param diffs - the file changes the card covers.
 * @param relative - shortens a workspace-rooted path for display.
 * @returns unified-diff text, one file after another.
 */
export function unifiedDiffText(diffs: readonly FileDiff[], relative: (path: string) => string): string {
  const out: string[] = []
  for (const diff of diffs) {
    const path = relative(diff.path)
    if (diff.oldText === null) {
      const lines = diff.newText.split('\n')
      // A file's trailing newline splits into a final empty element; emitting
      // it would claim a line the file does not have.
      if (lines.at(-1) === '') lines.pop()
      out.push(`diff --git a/${path} b/${path}`, 'new file', '--- /dev/null', `+++ b/${path}`)
      out.push(`@@ -0,0 +1,${lines.length} @@`)
      for (const line of lines) out.push(`+${line}`)
      continue
    }
    out.push(`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`)
    for (const hunk of structuredPatch('', '', diff.oldText, diff.newText, undefined, undefined, { context: CONTEXT }).hunks) {
      out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
      out.push(...hunk.lines)
    }
  }
  return out.join('\n')
}
