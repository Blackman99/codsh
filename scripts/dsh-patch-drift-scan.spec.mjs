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
      bundleDir: join(root, 'packages/bundle'),
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
      bundleDir: join(root, 'packages/bundle'),
    })).toEqual([
      'cordis.patch.yml references plugin id "tool-str-replace-editor", but no installed @deepseek-ai bundle declares it — the row is dead or the id was renamed upstream.',
    ])
  })

  it('reports an inserted package that is not installed', () => {
    const root = fixture({
      'packages/bundle/cordis.patch.yml':
        "- insert:\n    - id: agent-presets\n      name: '@deepseek-ai/dsh-agent-presets'\n" +
        "    - id: tools\n      name: cordis:group\n",
      'node_modules/@deepseek-ai/dsh-agent-preset/package.json': '{}',
    })

    expect(patchDriftProblems({ root, bundleDir: join(root, 'packages/bundle') })).toEqual([
      'cordis.patch.yml inserts package "@deepseek-ai/dsh-agent-presets", but it is not installed.',
    ])
  })

  it('checks every patch the bundle lists, including a preset\'s child rows by package', () => {
    const root = fixture({
      'packages/bundle/package.json': JSON.stringify({
        dsh: { bundle: { patch: ['./cordis.patch.yml', './presets/code-cli.patch.yml'] } },
      }),
      'packages/bundle/cordis.patch.yml': '- id: tool-fs\n  disabled: true\n',
      'packages/bundle/presets/code-cli.patch.yml':
        "- insert:\n    - id: preset-code-cli\n      name: '@deepseek-ai/dsh-agent-preset'\n" +
        "      config:\n        plugins:\n          - id: list-agents\n" +
        "            name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'\n",
      'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml':
        "- insert:\n    - id: tool-fs\n      name: '@deepseek-ai/dsh-tool-fs'\n",
      'node_modules/@deepseek-ai/dsh-agent-preset/package.json': '{}',
    })

    expect(patchDriftProblems({ root, bundleDir: join(root, 'packages/bundle') })).toEqual([
      'presets/code-cli.patch.yml inserts package "@deepseek-ai/dsh-tool-subagent-control/list-agents", but it is not installed.',
    ])
  })

  it('ignores a store entry the lockfile no longer pins', () => {
    const root = fixture({
      'pnpm-lock.yaml': "packages:\n\n  '@deepseek-ai/dsh-base@0.2.0-rc.2':\n    resolution: {}\n",
      'packages/bundle/cordis.patch.yml': '- id: workflow-worker-thread\n  disabled: true\n',
      'node_modules/.pnpm/@deepseek-ai+dsh-base@0.1.5-rc.2/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml':
        "- insert:\n    - id: workflow-worker-thread\n      name: '@deepseek-ai/dsh-workflow-worker-thread'\n",
      'node_modules/.pnpm/@deepseek-ai+dsh-base@0.2.0-rc.2/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml':
        "- insert:\n    - id: workflow-ptc\n      name: '@deepseek-ai/dsh-workflow-ptc'\n",
    })

    expect(patchDriftProblems({ root, bundleDir: join(root, 'packages/bundle') })).toEqual([
      'cordis.patch.yml references plugin id "workflow-worker-thread", but no installed @deepseek-ai bundle declares it — the row is dead or the id was renamed upstream.',
    ])
  })
})
