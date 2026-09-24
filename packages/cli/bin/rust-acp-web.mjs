/**
 * Register the configured web substitute on dsh's ctx.web.
 * dsh tool-web remains the model-facing web_search / web_fetch. This plugin
 * does not replace those tools. The native `web` command owns policy, network,
 * and errors. A missing substitute is registered but unavailable, so the tool
 * stays visible and fails closed. Search and fetch availability are separate:
 * the Rust client publishes each as CODSH_WEB_SEARCH / CODSH_WEB_FETCH.
 */
export const name = 'rust-acp-web'
export const inject = ['web']

import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PROVIDER_ID = 'codsh-substitute'
const OUTPUT_CAP = 2 * 1024 * 1024

export function enabled(name, env = process.env) {
  const raw = env[name]
  return raw === '1' || raw === 'true'
}

function searchEnabled() {
  return enabled('CODSH_WEB_SEARCH')
}

function fetchEnabled() {
  return enabled('CODSH_WEB_FETCH')
}

function rustBinary() {
  if (process.env.CODSH_RUST_BIN) return process.env.CODSH_RUST_BIN
  // The ACP child is started by the native client. Use that executable when
  // the explicit path was not forwarded. Linux exposes it as /proc; macOS uses ps.
  if (process.ppid) {
    try {
      const linux = readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0')[0]
      if (linux.includes('codsh-rust')) return linux
    } catch { /* not Linux */ }
    if (process.platform === 'darwin') {
      try {
        const out = execFileSync('ps', ['-p', String(process.ppid), '-o', 'command='], { encoding: 'utf8' }).trim()
        const command = out.split(' ')[0]
        if (command.includes('codsh-rust')) return command
      } catch { /* parent exited */ }
    }
  }
  return ''
}

function cancelledResult() {
  return { ok: false, text: '', error: 'cancelled before a result was received' }
}

function stopChild(child) {
  if (!child?.pid || child.killed) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
}

export function run(kind, value, signal) {
  const binary = rustBinary()
  if (!binary) {
    return Promise.resolve({ ok: false, text: '', error: 'web tool is not connected to the Rust client; no request was made' })
  }
  if (signal?.aborted) return Promise.resolve(cancelledResult())
  return new Promise(resolve => {
    const child = spawn(binary, ['web', kind, value, '--json'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', onAbort)
      clearTimeout(timer)
      resolve(value)
    }
    const onAbort = () => {
      stopChild(child)
      finish(cancelledResult())
    }
    const timer = setTimeout(() => {
      stopChild(child)
      finish({ ok: false, text: '', error: 'web command timed out; no body was returned' })
    }, 30000)
    child.stdout?.on('data', chunk => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', chunk => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8')
    })
    child.on('error', error => finish({ ok: false, text: '', error: error.message }))
    child.on('close', () => {
      // Abort wins even if the child already printed a body. A cancelled
      // dsh tool must not turn that late text into a result.
      if (signal?.aborted) {
        stopChild(child)
        finish(cancelledResult())
        return
      }
      const line = stdout.trim().split('\n').findLast(item => item.startsWith('{'))
      if (!line) {
        finish({ ok: false, text: '', error: (stderr || 'web command produced no result').trim() })
        return
      }
      try {
        const parsed = JSON.parse(line)
        finish({
          ok: parsed.ok === true,
          text: String(parsed.text ?? ''),
          error: String(parsed.error ?? ''),
          citations: Array.isArray(parsed.citations) ? parsed.citations : [],
          url: parsed.url ? String(parsed.url) : '',
          status: Number(parsed.status ?? 0),
          contentType: parsed.contentType ? String(parsed.contentType) : '',
          content: typeof parsed.content === 'string' ? parsed.content : '',
          truncated: parsed.truncated === true,
        })
      } catch (error) {
        finish({ ok: false, text: '', error: `web command returned invalid JSON: ${error.message}` })
      }
    })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function fail(message) {
  const error = new Error(message)
  error.code = 'WEB_PROVIDER_ERROR'
  throw error
}

function citationsFrom(result) {
  const sources = []
  const seen = new Set()
  for (const item of result.citations ?? []) {
    const url = String(item?.url ?? '')
    if (!url || seen.has(url)) continue
    seen.add(url)
    const source = { url }
    const title = String(item?.title ?? '')
    if (title) source.title = title
    sources.push(source)
  }
  return sources
}

function fetchBody(result) {
  // The page is its own JSON field. Splitting the CLI header off `text` would
  // cut a page whose body contains a blank line, or depend on that header.
  const kind = /html/i.test(result.contentType ?? '') ? 'html' : 'text'
  return { kind, content: String(result.content ?? '') }
}

export function apply(ctx) {
  const binary = () => Boolean(rustBinary())
  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => searchEnabled() && binary(),
    async search(request, signal) {
      if (!searchEnabled() || !binary()) fail('web_search is disabled. Enable it explicitly; no request was made and no page text was returned.')
      const result = await run('search', String(request?.query ?? ''), signal)
      if (signal?.aborted) fail('cancelled before a result was received')
      if (!result.ok) fail(result.error || 'web_search failed; no page text was returned')
      return {
        content: result.text,
        sources: citationsFrom(result),
        truncated: result.truncated === true,
      }
    },
  })
  ctx.web.registerFetchProvider({
    id: PROVIDER_ID,
    available: () => fetchEnabled() && binary(),
    async fetch(request, signal) {
      if (!fetchEnabled() || !binary()) fail('web_fetch is disabled. Enable it explicitly; no request was made and no page text was returned.')
      const url = String(request?.url ?? '')
      const result = await run('fetch', url, signal)
      if (signal?.aborted) fail('cancelled before a result was received')
      if (!result.ok) fail(result.error || 'web_fetch failed; no body was returned')
      return {
        url: result.url || url,
        statusCode: result.status || 200,
        body: fetchBody(result),
        truncated: result.truncated === true,
      }
    },
  })
}
