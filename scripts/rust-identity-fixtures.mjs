// Deployable organization identity for ticket 207 tests: a real Ory Hydra
// (Apache-2.0 OAuth 2.0 / OpenID Connect server, sqlite build) on loopback,
// plus the organization's login and consent app that Hydra delegates to.
// The app is the organization's user directory: it knows each user's team
// and whether an administrator has locked them. Nothing here always
// succeeds: Hydra issues, refreshes, introspects, and revokes every token.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { freePort, until } from './rust-clone-fixtures.mjs'

/** Hydra binary from CODSH_TEST_HYDRA (the binary or its directory), or PATH. */
export function findHydra() {
  const configured = process.env.CODSH_TEST_HYDRA
  const candidates = configured ? [configured, join(configured, 'hydra')] : []
  for (const candidate of candidates) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      const probe = spawnSync(candidate, ['version'], { encoding: 'utf8' })
      if (probe.status === 0) return candidate
    }
  }
  const probe = spawnSync('hydra', ['version'], { encoding: 'utf8' })
  return probe.status === 0 ? 'hydra' : null
}

async function json(response) {
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${response.url}: ${text}`)
  return text ? JSON.parse(text) : {}
}

/**
 * Start Hydra and the organization app. `users` maps a subject to its team.
 * `state.nextUser` picks who signs in at the next login; `state.locked`
 * lists subjects the directory refuses.
 */
export async function startIdentity(hydra, dir, { users }) {
  const publicPort = await freePort()
  const adminPort = await freePort()
  const appPort = await freePort()
  const issuer = `http://127.0.0.1:${publicPort}`
  const admin = `http://127.0.0.1:${adminPort}`
  const app = `http://127.0.0.1:${appPort}`
  const state = { nextUser: Object.keys(users)[0], locked: new Set(), logins: [] }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, app)
      if (url.pathname === '/login') {
        const challenge = url.searchParams.get('login_challenge')
        const subject = state.nextUser
        state.logins.push(subject)
        const body = state.locked.has(subject) || !users[subject]
          ? await json(await fetch(`${admin}/admin/oauth2/auth/requests/login/reject?login_challenge=${encodeURIComponent(challenge)}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ error: 'access_denied', error_description: 'the organization directory refused this user' }),
          }))
          : await json(await fetch(`${admin}/admin/oauth2/auth/requests/login/accept?login_challenge=${encodeURIComponent(challenge)}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ subject, remember: false }),
          }))
        res.writeHead(302, { location: body.redirect_to }).end()
        return
      }
      if (url.pathname === '/consent') {
        const challenge = url.searchParams.get('consent_challenge')
        const request = await json(await fetch(`${admin}/admin/oauth2/auth/requests/consent?consent_challenge=${encodeURIComponent(challenge)}`))
        const team = users[request.subject]?.team ?? null
        const body = await json(await fetch(`${admin}/admin/oauth2/auth/requests/consent/accept?consent_challenge=${encodeURIComponent(challenge)}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_scope: request.requested_scope,
            grant_access_token_audience: request.requested_access_token_audience,
            remember: false,
            session: { access_token: { team_id: team }, id_token: { team_id: team } },
          }),
        }))
        res.writeHead(302, { location: body.redirect_to }).end()
        return
      }
      res.writeHead(404).end()
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error))
    }
  })
  await new Promise(done => server.listen(appPort, '127.0.0.1', done))

  const config = join(dir, 'hydra.yml')
  writeFileSync(config, [
    `dsn: sqlite://${join(dir, 'hydra.sqlite')}?_fk=true`,
    'serve:',
    `  public: { port: ${publicPort}, host: 127.0.0.1 }`,
    `  admin: { port: ${adminPort}, host: 127.0.0.1 }`,
    'urls:',
    `  self: { issuer: ${issuer} }`,
    `  login: ${app}/login`,
    `  consent: ${app}/consent`,
    'secrets:',
    '  system: [codsh-test-system-secret-207-0123456789]',
    'strategies:',
    '  access_token: jwt',
    'oauth2:',
    '  allowed_top_level_claims: [team_id]',
    '  expose_internal_errors: true',
    'ttl:',
    '  access_token: 1h',
    '  refresh_token: 24h',
    'log:',
    '  level: warn',
    '',
  ].join('\n'))
  const env = { PATH: process.env.PATH, HOME: dir }
  const migrate = spawnSync(hydra, ['migrate', 'sql', 'up', '-e', '--yes', '--config', config], {
    encoding: 'utf8', env: { ...env, DSN: `sqlite://${join(dir, 'hydra.sqlite')}?_fk=true` },
  })
  if (migrate.status !== 0) throw new Error(`hydra migrate failed: ${migrate.stderr}`)
  const child = spawn(hydra, ['serve', 'all', '--dev', '--config', config], {
    env, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let log = ''
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-8000) })
  await until(async () => {
    try {
      return (await fetch(`${admin}/health/ready`)).ok && (await fetch(`${issuer}/.well-known/openid-configuration`)).ok
    } catch {
      return false
    }
  }, `hydra ready\n${log}`, 30000)

  return {
    issuer,
    admin,
    app,
    state,
    introspection: `${admin}/admin/oauth2/introspect`,
    log: () => log,
    /** A public PKCE client for `codsh --rust login` (loopback redirect, any port). */
    async createClient({ id, audience, accessLifespan }) {
      await json(await fetch(`${admin}/admin/clients`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: id,
          client_name: id,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: 'openid profile email offline_access api:access',
          redirect_uris: ['http://127.0.0.1/callback'],
          audience,
        }),
      }))
      if (accessLifespan) {
        await json(await fetch(`${admin}/admin/clients/${encodeURIComponent(id)}/lifespans`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            authorization_code_grant_access_token_lifespan: accessLifespan,
            refresh_token_grant_access_token_lifespan: accessLifespan,
          }),
        }))
      }
    },
    /** What Hydra's RFC 7662 endpoint says about a token. */
    async introspect(token) {
      return json(await fetch(`${admin}/admin/oauth2/introspect`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      }))
    },
    /** An administrator revokes every consent session and token of a subject. */
    async revokeSubject(subject) {
      const response = await fetch(`${admin}/admin/oauth2/auth/sessions/consent?subject=${encodeURIComponent(subject)}&all=true`, { method: 'DELETE' })
      if (!response.ok && response.status !== 204) throw new Error(`revoke ${subject}: ${response.status} ${await response.text()}`)
    },
    /** Act as the user's browser: follow the authorize URL through login and consent to the loopback callback. */
    async browse(start) {
      const cookies = new Map()
      let url = start
      for (let hop = 0; hop < 20; hop += 1) {
        const target = new URL(url)
        const ours = [issuer, app].includes(target.origin)
        const response = await fetch(url, {
          redirect: 'manual',
          headers: ours && cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
        })
        for (const line of response.headers.getSetCookie?.() ?? []) {
          const [pair] = line.split(';')
          const at = pair.indexOf('=')
          cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
        }
        if (!ours) return { status: response.status, body: await response.text(), url }
        const location = response.headers.get('location')
        if (response.status >= 300 && response.status < 400 && location) {
          url = new URL(location, url).toString()
          continue
        }
        throw new Error(`browser stopped at ${url}: ${response.status} ${await response.text()}`)
      }
      throw new Error('too many redirects')
    },
    async stop() {
      child.kill('SIGTERM')
      await new Promise(done => server.close(done))
    },
  }
}
