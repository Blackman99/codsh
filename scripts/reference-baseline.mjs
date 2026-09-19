import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function percentile(samples, fraction) {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid baseline samples')
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

export function summarize(capture) {
  const groups = []
  function add(name, samples, unit, limitation) {
    groups.push({ name, unit, samples, median: percentile(samples, 0.5),
      p95: percentile(samples, 0.95), limitation })
  }
  add('version-process', capture.baseline.map(item => item.elapsedMs), 'ms', 'Includes sandbox-exec and process startup; not first-interactive-frame latency.')
  for (const mode of ['fullscreen', 'minimal']) {
    const runs = capture.terminals.filter(item => item.mode === mode)
    add(`${mode}:first-frame`, runs.map(item => item.firstFrameMs), 'ms', 'Warm filesystem cache, synthetic configured model; first complete fullscreen frame / minimal model label, not model response.')
    for (const action of ['draft', 'settings-open', 'settings-scroll', 'resize-narrow']) {
      const samples = runs.map(run => {
        const event = run.events.find(item => item.action === action)
        if (!event.markerFound) throw new Error(`Unobserved action: ${action}`)
        return event.observedMs - event.ms
      })
      add(`${mode}:${action}`, samples, 'ms', 'Observation upper bound includes 30ms settle and PTY polling; scroll/resize marker is next frame, not proof of completed reflow.')
    }
    add(`${mode}:sampled-peak-rss`, runs.map(run => Math.max(...run.rss.map(item => item.rssKiB))), 'KiB', 'Sampled parent RSS only, not process-tree peak or long-session growth.')
    add(`${mode}:terminal-bytes`, runs.map(run => run.outputBytes), 'bytes', 'Bytes emitted during the fixed scenario; not model-token throughput.')
  }
  return { schemaVersion: 1, reference: capture.reference, machine: capture.machine,
    capturedAt: capture.capturedAt, groups,
    thresholdPolicy: {
      status: 'method-frozen; no candidate measured; pilot is not a release threshold',
      latency: 'After at least 30 valid reference runs per scenario/machine/mode, ceiling = max(reference p95 * 1.20, reference p95 + 16.7ms). Freeze numeric values and raw capture SHA before the first candidate measurement.',
      throughput: 'Use identical deterministic 1000-chunk fixture timing and payload; floor = reference median * 0.90. Freeze bytes/s and wall-time limits before candidate measurement.',
      resources: 'Run 1000 turns plus background-task cleanup; ceiling = reference p95 process-tree RSS * 1.20. Growth above post-warmup baseline must not exceed max(reference growth * 1.20, 16MiB). Freeze per platform.',
      comparison: 'Same installed-product hardware/OS/PTY dimensions, fixture, environment, power state and cache policy; alternate reference/candidate run order. Invalid runs remain recorded, not silently discarded.',
      invalidation: 'Any fixture, terminal-driver, hardware or reference change requires new reference measurements and reviewed numeric thresholds before candidate runs.',
    },
    pending: [
      { metric: 'model-stream throughput', tickets: [202, 209], reason: 'Four-format local fixture proves output but is not a throughput workload.' },
      { metric: 'long-session process-tree resource growth', tickets: [202, 209], reason: 'Pilot captures only short-session parent RSS.' },
      { metric: 'Linux and Windows performance', tickets: [199, 200, 209], reason: 'No native host was available in this macOS worktree.' },
      { metric: 'release numeric ceilings', tickets: [202, 209], reason: 'Five-run pilot is insufficient for a stable p95; freeze 30-run thresholds before candidate measurement.' },
    ] }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2)
  const bytes = readFileSync(input)
  const result = summarize(JSON.parse(bytes))
  result.captureSha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`Summarized ${result.groups.length} raw baseline series; no candidate thresholds claimed.`)
}
