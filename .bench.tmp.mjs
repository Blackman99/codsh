import { truncate } from './src/theme.ts'
import { wrapStyled } from './src/wrap.ts'
import { performance } from 'node:perf_hooks'

for (const kb of [10, 100, 1000]) {
  const line = 'x'.repeat(kb * 1024)
  let t = performance.now()
  truncate(line, 80)
  const t1 = performance.now() - t
  t = performance.now()
  wrapStyled(line, 80)
  const t2 = performance.now() - t
  console.log(`${kb}KB  truncate=${t1.toFixed(1)}ms  wrap=${t2.toFixed(1)}ms`)
}
