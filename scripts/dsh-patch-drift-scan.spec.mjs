/**
 * Nightly sync must still see dsh-base when pnpm leaves it in the virtual
 * store instead of hoisting it into node_modules/@deepseek-ai.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declaredPluginIds, patchDriftProblems } from './dsh-patch-drift.mjs'

function fixture(layout) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-patch-drift-'))
  for (const [rel, body] of Object.entries(layout)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
  return root
}

describe('declaredPluginIds', () => {
  it('reads dsh-base from pnpm\'s virtual store when it is not hoisted', () => {
    const root = fixture({
      'node_modules/.pnpm/@deepseek-ai+dsh-base@0.1.5-rc.1/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml':
        '- insert:\n    - id: tool-fs\n      name: \'@deepseek-ai/dsh-tool-fs\'\n',
    })

    expect([...declaredPluginIds(root)]).toEqual(['tool-fs'])
  })
})

describe('patchDriftProblems', () => {
  it('accepts a host row declared only under .pnpm', () => {
    const root = fixture({
      'packages/bundle/cordis.patch.yml': '- id: tool-fs\n  disabled: true\n',
      'node_modules/.pnpm/@deepseek-ai+dsh-base@0.1.5-rc.1/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml':
        '- insert:\n    - id: tool-fs\n      name: \'@deepseek-ai/dsh-tool-fs\'\n',
    })

    expect(patchDriftProblems({
      root,
      patchPath: join(root, 'packages/bundle/cordis.patch.yml'),
    })).toEqual([])
  })

  it('reports a host row no installed bundle still inserts', () => {
    const root = fixture({
      'packages/bundle/cordis.patch.yml': '- id: tool-str-replace-editor\n  disabled: true\n',
      'node_modules/.pnpm/@deepseek-ai+dsh-base@0.1.5-rc.1/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml':
        '- insert:\n    - id: tool-fs\n      name: \'@deepseek-ai/dsh-tool-fs\'\n',
    })

    expect(patchDriftProblems({
      root,
      patchPath: join(root, 'packages/bundle/cordis.patch.yml'),
    })).toEqual([
      'cordis.patch.yml references plugin id "tool-str-replace-editor", but no installed @deepseek-ai bundle declares it — the row is dead or the id was renamed upstream.',
    ])
  })
})
