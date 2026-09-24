#!/usr/bin/env python3
"""Installed-product check: configurable web search and fetch through dsh."""
import hashlib
import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
_screen_spec = importlib.util.spec_from_file_location(
    'rust_screen_pty_test', ROOT / 'scripts' / 'rust-screen-pty-test.py')
_screen = importlib.util.module_from_spec(_screen_spec)
_screen_spec.loader.exec_module(_screen)
Session = _screen.Session


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


class Handler(BaseHTTPRequestHandler):
    pages = {}
    searches = []
    searxng = []
    malformed = False

    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/search':
            query = ''
            if '?' in self.path:
                from urllib.parse import parse_qs, urlsplit
                query = parse_qs(urlsplit(self.path).query).get('q', [''])[0]
            record = {
                'path': self.path,
                'query': query,
                'authorization': self.headers.get('authorization', ''),
            }
            self.searxng.append(record)
            if '/hang' in self.path:
                record['hung'] = True
                record['closed'] = False
                try:
                    self.rfile.read(1)
                except Exception:
                    pass
                record['closed'] = True
                return
            body = json.dumps({
                'query': query,
                'results': [
                    {
                        'url': 'https://docs.example/searx',
                        'title': 'Searx Guide',
                        'content': 'SEARXNG_RESULT_BODY',
                    },
                    {
                        'url': 'https://evil.example/widen',
                        'title': 'Must Not Widen',
                        'content': 'SEARXNG_DROPPED_BODY',
                    },
                    {
                        'url': 'https://docs.example/searx',
                        'title': 'Searx Guide again',
                        'content': 'SEARXNG_DUP',
                    },
                ],
            }).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith('/redirect-path'):
            self.send_response(302)
            self.send_header('location', '/secret-path')
            self.end_headers()
            return
        if self.path.startswith('/secret-path'):
            body = b'SECRET_PATH_BODY'
            self.send_response(200)
            self.send_header('content-type', 'text/plain')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith('/redirect'):
            self.send_response(302)
            self.send_header('location', 'https://docs.rs/tokio')
            self.end_headers()
            return
        if self.path.startswith('/secret'):
            self.send_response(401)
            self.send_header('content-type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<html><body>SECRET_BODY</body></html>')
            return
        if self.path.startswith('/limited'):
            self.send_response(429)
            self.end_headers()
            self.wfile.write(b'please wait')
            return
        page = self.pages.get(self.path, '<html><body><h1>WEB_PAGE_TITLE</h1><p>WEB_PAGE_BODY</p></body></html>')
        body = page.encode()
        self.send_response(200)
        self.send_header('content-type', 'text/html; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get('content-length', '0'))
        raw = self.rfile.read(length)
        if '/hang' in self.path:
            record = {'hung': True, 'closed': False}
            self.searches.append(record)
            try:
                self.rfile.read(1)
            except Exception:
                pass
            record['closed'] = True
            return
        self.searches.append(json.loads(raw.decode()))
        if Handler.malformed:
            body = b'not-json'
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = json.dumps({
            'output': [{
                'content': [{
                    'type': 'output_text',
                    'text': 'SEARCH_RESULT_BODY',
                    'annotations': [
                        {'type': 'url_citation', 'url': 'https://docs.example/guide', 'title': 'Guide'},
                        {'type': 'url_citation', 'url': 'https://docs.example/guide', 'title': 'Guide again'},
                    ],
                }],
            }],
        }).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS evidence required')
    binary = ROOT / 'rust/target/debug/codsh-rust'
    if not binary.exists():
        run(['cargo', 'build', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'codsh-rust'], cwd=ROOT)
    identity = run([NODE, '-e', "process.stdout.write(process.platform + '-' + process.arch)"]).stdout
    staged = ROOT / 'packages/cli/native' / identity
    staged.mkdir(parents=True, exist_ok=True)
    shutil.copy2(binary, staged / 'codsh-rust')
    digest = hashlib.sha256((staged / 'codsh-rust').read_bytes()).hexdigest()
    platform, arch = identity.split('-', 1)
    (staged / 'artifact.json').write_text(json.dumps({
        'platform': platform, 'arch': arch, 'sha256': digest,
    }))
    server = serve()
    host = f'127.0.0.1:{server.server_address[1]}'
    try:
        with tempfile.TemporaryDirectory(prefix='codsh-rust-web-', dir='/tmp') as temporary:
            home = Path(temporary)
            # The packed launcher pins GROK_HOME to the isolated Home, so the
            # packed sessions below read this same file without GROK_HOME.
            grok = home / '.codsh-rust' / '.grok'
            grok.mkdir(parents=True)
            (grok / 'config.toml').write_text(f'''
[models]
default = "chat"
web_search = "search-model"

[model.chat]
model = "chat-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "CHAT_API_KEY"

[model.search-model]
model = "search-model"
base_url = "http://{host}/v1"
env_key = "SEARCH_API_KEY"
supports_backend_search = true

[features]
web_fetch = true

[toolset.web_search]
allowed_domains = ["docs.example"]
excluded_domains = ["blocked.example"]

[toolset.web_fetch]
allowed_domains = ["{host}", "docs.rs"]
allow_local = true
''')
            env = {
                'HOME': str(home),
                'GROK_HOME': str(grok),
                'PATH': os.environ['PATH'],
                'CHAT_API_KEY': 'chat-secret',
                'SEARCH_API_KEY': 'search-secret',
            }
            disabled = run([str(binary), 'inspect', '--json'], env={**env, 'GROK_DISABLE_WEB_FETCH': '1'}, cwd=home)
            inspected = json.loads(disabled.stdout)
            assert inspected['web']['webFetchEnabled'] is False, inspected['web']
            fetched_off = subprocess.run(
                [str(binary), 'web', 'fetch', f'http://{host}/page', '--json'],
                env={**env, 'GROK_DISABLE_WEB_FETCH': '1'}, cwd=home, capture_output=True, text=True,
            )
            off = json.loads(fetched_off.stdout)
            assert off['ok'] is False
            assert 'disabled' in off['error']
            assert 'WEB_PAGE_BODY' not in off['error']
            assert fetched_off.returncode != 0

            fetched = run([str(binary), 'web', 'fetch', f'http://{host}/page', '--json'], env=env, cwd=home)
            page = json.loads(fetched.stdout)
            assert page['ok'] is True, page
            assert 'WEB_PAGE_TITLE' in page['text']
            assert 'WEB_PAGE_BODY' in page['text']
            assert page['url'].endswith('/page'), page
            assert page['status'] == 200
            assert page['truncated'] is False
            assert 'truncated: false' in page['text']

            secret = subprocess.run(
                [str(binary), 'web', 'fetch', f'http://{host}/secret', '--json'],
                env=env, cwd=home, capture_output=True, text=True,
            )
            secret_json = json.loads(secret.stdout)
            assert secret_json['ok'] is False
            assert 'SECRET_BODY' not in secret.stdout
            assert '401' in secret_json['error'] or 'authentication' in secret_json['error']

            limited = subprocess.run(
                [str(binary), 'web', 'fetch', f'http://{host}/limited', '--json'],
                env=env, cwd=home, capture_output=True, text=True,
            )
            limited_json = json.loads(limited.stdout)
            assert limited_json['ok'] is False
            assert '429' in limited_json['error'] or 'rate limited' in limited_json['error']
            assert 'please wait' not in limited.stdout

            private = subprocess.run(
                [str(binary), 'web', 'fetch', 'http://10.1.2.3/meta', '--json'],
                env=env, cwd=home, capture_output=True, text=True,
            )
            private_json = json.loads(private.stdout)
            assert private_json['ok'] is False
            assert '10.1.2.3' in private_json['error']

            redirect = subprocess.run(
                [str(binary), 'web', 'fetch', f'http://{host}/redirect', '--json'],
                env=env, cwd=home, capture_output=True, text=True,
            )
            redirect_json = json.loads(redirect.stdout)
            assert redirect_json['ok'] is False
            assert 'cross-host' in redirect_json['error']
            assert 'WEB_PAGE_BODY' not in redirect.stdout

            path_home = home / 'path-home'
            path_grok = path_home / '.grok'
            path_grok.mkdir(parents=True)
            (path_grok / 'config.toml').write_text(f'''
[features]
web_fetch = true
[toolset.web_fetch]
allowed_domains = ["{host}/public"]
allow_local = true
''')
            path_env = {
                'HOME': str(path_home), 'GROK_HOME': str(path_grok), 'PATH': os.environ['PATH'],
            }
            scoped = subprocess.run(
                [str(binary), 'web', 'fetch', f'http://{host}/redirect-path', '--json'],
                env=path_env, cwd=path_home, capture_output=True, text=True,
            )
            scoped_json = json.loads(scoped.stdout)
            assert scoped_json['ok'] is False, scoped_json
            assert 'SECRET_PATH_BODY' not in scoped.stdout
            allowed_page = run(
                [str(binary), 'web', 'fetch', f'http://{host}/public/page', '--json'],
                env=path_env, cwd=path_home,
            )
            allowed_json = json.loads(allowed_page.stdout)
            assert allowed_json['ok'] is True, allowed_json
            assert allowed_json['truncated'] is False
            assert allowed_json['status'] == 200

            searched = run([str(binary), 'web', 'search', 'rust web policy', '--json'], env=env, cwd=home)
            found = json.loads(searched.stdout)
            assert found['ok'] is True, found
            assert 'SEARCH_RESULT_BODY' in found['text']
            assert found['citations'] == [{'url': 'https://docs.example/guide', 'title': 'Guide'}], found
            assert 'https://docs.example/guide' in found['text']
            assert 'Guide' in found['text']
            assert found['text'].count('https://docs.example/guide') == 1
            assert Handler.searches, 'search substitute received no request'
            filters = Handler.searches[-1]['tools'][0]['filters']
            assert filters['allowed_domains'] == ['docs.example']
            assert 'excluded_domains' not in filters
            assert Handler.searches[-1]['model'] == 'search-model'
            plain = run([str(binary), 'web', 'search', 'rust web policy'], env=env, cwd=home)
            assert plain.stdout == found['text'] + '\n' or plain.stdout.strip() == found['text'].strip()

            public_home = home / 'public-home'
            public_grok = public_home / '.grok'
            public_grok.mkdir(parents=True)
            (public_grok / 'config.toml').write_text('''
[models]
default = "chat"
[model.chat]
model = "chat"
base_url = "http://127.0.0.1:9/v1"
env_key = "CHAT_API_KEY"
[features]
web_fetch = true
[toolset.web_fetch]
allowed_domains = ["example.com"]
''')
            public = run(
                [str(binary), 'web', 'fetch', 'http://example.com/', '--json'],
                env={
                    'HOME': str(public_home),
                    'GROK_HOME': str(public_grok),
                    'PATH': os.environ['PATH'],
                    'CHAT_API_KEY': 'chat-secret',
                },
                cwd=public_home,
            )
            public_json = json.loads(public.stdout)
            assert public_json['ok'] is True, public_json
            assert 'example' in public_json['text'].lower()
            assert 'https://example.com/' in public_json['text']
            assert public_json['text'] == run(
                [str(binary), 'web', 'fetch', 'http://example.com/'],
                env={
                    'HOME': str(public_home),
                    'GROK_HOME': str(public_grok),
                    'PATH': os.environ['PATH'],
                    'CHAT_API_KEY': 'chat-secret',
                },
                cwd=public_home,
            ).stdout.strip()

            plugin = ROOT / 'packages/cli/bin/rust-acp-web.mjs'
            probe = run([
                NODE, '--input-type=module', '-e',
                "import { pathToFileURL } from 'node:url';"
                "const plugin = await import(pathToFileURL(process.argv[1]).href);"
                "const providers = { search: [], fetch: [] };"
                "const ctx = { web: {"
                "  registerSearchProvider(provider) { providers.search.push(provider) },"
                "  registerFetchProvider(provider) { providers.fetch.push(provider) },"
                "} };"
                "plugin.apply(ctx);"
                "const search = await providers.search[0].search({ query: 'rust web policy' });"
                "const fetched = await providers.fetch[0].fetch({ url: process.argv[2] });"
                "process.stdout.write(JSON.stringify({"
                "  ids: [providers.search[0].id, providers.fetch[0].id],"
                "  available: providers.search[0].available(),"
                "  search, fetched,"
                "}));",
                str(plugin), f'http://{host}/page',
            ], env={
                **env,
                'CODSH_WEB_SEARCH': '1',
                'CODSH_WEB_FETCH': '1',
                'CODSH_RUST_BIN': str(binary),
            }, cwd=home)
            tool = json.loads(probe.stdout)
            assert tool['ids'] == ['codsh-substitute', 'codsh-substitute'], tool
            assert tool['available'] is True
            assert 'SEARCH_RESULT_BODY' in tool['search']['content']
            assert tool['search']['sources'] == [{'url': 'https://docs.example/guide', 'title': 'Guide'}], tool
            assert tool['search']['truncated'] is False
            assert 'WEB_PAGE_BODY' in tool['fetched']['body']['content']
            assert tool['fetched']['truncated'] is False
            assert tool['fetched']['statusCode'] == 200
            assert tool['fetched']['url'].endswith('/page')

            # A denied permission must not contact the substitute.
            before = len(Handler.searches)
            denied = subprocess.run(
                [NODE, '--input-type=module', '-e',
                 "import { pathToFileURL } from 'node:url';"
                 "const mod = await import(pathToFileURL(process.argv[1]).href);"
                 "const decision = mod.evaluatePermission("
                 "  { mode: 'ask', rules: [{ action: 'deny', tool: 'web_search', pattern: 'secret', patternMode: 'glob', source: 'test' }], grants: {} },"
                 "  { kind: 'websearch', query: 'secret plan' }, '');"
                 "process.stdout.write(JSON.stringify(decision));",
                 str(ROOT / 'packages/cli/bin/rust-acp-file-approval.mjs')],
                cwd=home, capture_output=True, text=True, env={**env, 'CODSH_WEB_SEARCH': '1'})
            denied_json = json.loads(denied.stdout)
            assert denied_json['kind'] == 'deny', denied_json
            assert 'secret plan' not in json.dumps(Handler.searches[before:])

            missing_key = home / 'missing-key'
            missing_grok = missing_key / '.grok'
            missing_grok.mkdir(parents=True)
            (missing_grok / 'config.toml').write_text(f'''
[models]
web_search = "search-model"
[model.search-model]
model = "search-model"
base_url = "http://{host}/v1"
env_key = "SEARCH_API_KEY"
supports_backend_search = true
''')
            absent = subprocess.run(
                [str(binary), 'web', 'search', 'no key', '--json'],
                env={'HOME': str(missing_key), 'GROK_HOME': str(missing_grok), 'PATH': os.environ['PATH']},
                cwd=missing_key, capture_output=True, text=True,
            )
            absent_json = json.loads(absent.stdout)
            assert absent_json['ok'] is False, absent_json
            assert 'SEARCH_API_KEY' in absent_json['error'] or 'disabled' in absent_json['error'] or 'unconfigured' in absent_json['error']
            assert 'SEARCH_RESULT_BODY' not in absent.stdout

            Handler.malformed = True
            malformed = subprocess.run(
                [str(binary), 'web', 'search', 'broken', '--json'],
                env=env, cwd=home, capture_output=True, text=True,
            )
            Handler.malformed = False
            malformed_json = json.loads(malformed.stdout)
            assert malformed_json['ok'] is False, malformed_json
            assert 'SEARCH_RESULT_BODY' not in malformed.stdout

            # Real dsh session: the model tool path reaches the same substitute.
            from importlib.util import spec_from_file_location, module_from_spec
            prompt_spec = spec_from_file_location('rust_prompt_pty_test', ROOT / 'scripts' / 'rust-prompt-pty-test.py')
            prompt = module_from_spec(prompt_spec)
            prompt_spec.loader.exec_module(prompt)
            resume_spec = spec_from_file_location('rust_resume_pty_test', ROOT / 'scripts' / 'rust-resume-pty-test.py')
            resume = module_from_spec(resume_spec)
            resume_spec.loader.exec_module(resume)
            work = home / 'pty'
            work.mkdir()
            cwd = work / 'workspace'
            cwd.mkdir()
            isolated = work / 'home'
            isolated.mkdir()
            launcher = prompt.pack_install(work, isolated)
            patch = work / 'overlay.yml'
            os.environ['CODSH_WEB_SEARCH'] = '1'
            os.environ['CODSH_WEB_FETCH'] = '1'
            patch.write_text(resume.overlay_text())
            pty_env = {
                'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
                'DSH_BIN': resume.dsh_bin(), 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
                'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
                'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
                'DSH_CODE_CLI_MOCK_TOOL': 'web-search',
                'SEARCH_API_KEY': 'search-secret',
                'CHAT_API_KEY': 'chat-secret',
            }
            (home / 'pty-out').mkdir(exist_ok=True)
            session = Session('web-search', launcher, cwd, pty_env, home / 'pty-out', extra=['--fullscreen'])
            try:
                session.wait_visible('Connected to dsh ACP', 40)
                session.write('search the web\r')
                shown = session.wait_visible('SEARCH_RESULT_BODY', 40)
                assert 'RUST_ACP_WEB_DONE' in shown, shown
                assert 'allowed domains: docs.example' in shown, shown
                session.write('\x1b[C')
                shown = session.wait_visible('https://docs.example/guide', 10)
                assert 'Guide' in shown, shown
            finally:
                session.finish(expect_alt_leave=True)
                session.close()

            config_path = grok / 'config.toml'
            saved_config = config_path.read_text()
            config_path.write_text(f'''
[models]
default = "chat"
web_search = "search-model"
[model.chat]
model = "chat-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "CHAT_API_KEY"
[model.search-model]
model = "search-model"
base_url = "http://{host}/v1/hang"
env_key = "SEARCH_API_KEY"
supports_backend_search = true
[features]
web_fetch = true
''')
            cancelled = subprocess.Popen(
                [str(binary), 'web', 'search', 'hang', '--json'],
                env=env, cwd=home,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            deadline = __import__('time').monotonic() + 8
            while __import__('time').monotonic() < deadline and not any(item.get('hung') for item in Handler.searches):
                if cancelled.poll() is not None:
                    break
                __import__('time').sleep(0.05)
            if not any(item.get('hung') for item in Handler.searches):
                out, err = cancelled.communicate(timeout=2)
                raise AssertionError(f'cancel fixture was not contacted\nstdout={out}\nstderr={err}\ncode={cancelled.returncode}')
            cancelled.send_signal(__import__('signal').SIGINT)
            try:
                out, err = cancelled.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                cancelled.kill()
                out, err = cancelled.communicate()
                raise AssertionError(f'cancel left the web command running\nstdout={out}\nstderr={err}')
            combined = f'{out}\n{err}'
            assert cancelled.returncode != 0
            assert cancelled.returncode > 0, cancelled.returncode
            assert 'SEARCH_RESULT_BODY' not in combined
            assert 'cancelled' in combined.lower()
            # The slow service must observe the socket close, not a late success.
            deadline = __import__('time').monotonic() + 2
            while __import__('time').monotonic() < deadline and not any(item.get('closed') for item in Handler.searches):
                __import__('time').sleep(0.05)
            assert any(item.get('closed') for item in Handler.searches), Handler.searches

            # dsh abort must reach the provider while the substitute is still hung.
            # spawnSync would block this event loop; the plugin has to spawn.
            Handler.searches.clear()
            dsh_cancel = run([
                NODE, '--input-type=module', '-e',
                "import { pathToFileURL } from 'node:url';"
                "const plugin = await import(pathToFileURL(process.argv[1]).href);"
                "const providers = { search: [] };"
                "plugin.apply({ web: { registerSearchProvider(p) { providers.search.push(p) }, registerFetchProvider() {} } });"
                "const controller = new AbortController();"
                "const pending = providers.search[0].search({ query: 'hang' }, controller.signal);"
                "const started = Date.now();"
                "await new Promise(resolve => setTimeout(resolve, 400));"
                "controller.abort();"
                "let failed = '';"
                "try { await pending } catch (error) { failed = String(error?.message ?? error) }"
                "process.stdout.write(JSON.stringify({ elapsed: Date.now() - started, failed, aborted: controller.signal.aborted }));",
                str(plugin),
            ], env={
                **env,
                'CODSH_WEB_SEARCH': '1',
                'CODSH_WEB_FETCH': '0',
                'CODSH_RUST_BIN': str(binary),
            }, cwd=home)
            dsh = json.loads(dsh_cancel.stdout)
            assert dsh['aborted'] is True, dsh
            assert dsh['elapsed'] < 3000, dsh
            assert 'cancelled' in dsh['failed'].lower(), dsh
            assert 'SEARCH_RESULT_BODY' not in dsh_cancel.stdout
            assert any(item.get('closed') for item in Handler.searches), Handler.searches

            # SearXNG JSON is a second configured substitute. No API key.
            # Domain policy is applied to result URLs, not sent as a request filter.
            config_path.write_text(saved_config.replace(
                'supports_backend_search = true',
                'protocol = "searxng"\nsupports_backend_search = true',
                1,
            ).replace(
                f'base_url = "http://{host}/v1"',
                f'base_url = "http://{host}"',
                1,
            ))
            before_searx = len(Handler.searxng)
            before_posts = len(Handler.searches)
            searx = run([str(binary), 'web', 'search', 'rust searx policy', '--json'], env=env, cwd=home)
            searx_json = json.loads(searx.stdout)
            assert searx_json['ok'] is True, searx_json
            assert 'SEARXNG_RESULT_BODY' in searx_json['text']
            assert 'SEARXNG_DROPPED_BODY' not in searx.stdout
            assert 'evil.example' not in searx.stdout
            assert searx_json['citations'] == [{'url': 'https://docs.example/searx', 'title': 'Searx Guide'}], searx_json
            assert len(Handler.searxng) == before_searx + 1
            assert len(Handler.searches) == before_posts, 'searxng must not POST a Responses body'
            request = Handler.searxng[-1]
            assert request['query'] == 'rust searx policy', request
            assert 'format=json' in request['path']
            assert request['path'].startswith('/search?')
            assert 'allowed_domains' not in request['path']
            assert request['authorization'] == ''
            plain_searx = run([str(binary), 'web', 'search', 'rust searx policy'], env=env, cwd=home)
            assert 'SEARXNG_RESULT_BODY' in plain_searx.stdout
            assert 'https://docs.example/searx' in plain_searx.stdout

            searx_probe = run([
                NODE, '--input-type=module', '-e',
                "import { pathToFileURL } from 'node:url';"
                "const plugin = await import(pathToFileURL(process.argv[1]).href);"
                "const providers = { search: [] };"
                "plugin.apply({ web: {"
                "  registerSearchProvider(provider) { providers.search.push(provider) },"
                "  registerFetchProvider() {},"
                "} });"
                "const search = await providers.search[0].search({ query: 'rust searx policy', allowed_domains: ['evil.example'] });"
                "process.stdout.write(JSON.stringify(search));",
                str(plugin),
            ], env={
                **env,
                'CODSH_WEB_SEARCH': '1',
                'CODSH_WEB_FETCH': '0',
                'CODSH_RUST_BIN': str(binary),
            }, cwd=home)
            tool_searx = json.loads(searx_probe.stdout)
            assert 'SEARXNG_RESULT_BODY' in tool_searx['content'], tool_searx
            assert tool_searx['sources'] == [{'url': 'https://docs.example/searx', 'title': 'Searx Guide'}], tool_searx
            assert 'evil.example' not in searx_probe.stdout
            widened = Handler.searxng[-1]
            assert widened['query'] == 'rust searx policy', widened
            assert 'evil.example' not in widened['path']
            assert 'allowed_domains' not in widened['path']

            # Packed session: the model tool path reaches the SearXNG substitute.
            (home / 'pty-searx').mkdir(exist_ok=True)
            searx_session = Session('web-searx', launcher, cwd, {
                **pty_env,
                'DSH_CODE_CLI_MOCK_TOOL': 'web-search',
            }, home / 'pty-searx', extra=['--fullscreen'])
            try:
                searx_session.wait_visible('Connected to dsh ACP', 40)
                searx_session.write('search searx\r')
                shown = searx_session.wait_visible('SEARXNG_RESULT_BODY', 40)
                assert 'RUST_ACP_WEB_DONE' in shown, shown
                assert 'evil.example' not in shown, shown
                assert 'SEARXNG_DROPPED_BODY' not in shown, shown
                searx_session.write('\x1b[C')
                shown = searx_session.wait_visible('https://docs.example/searx', 10)
                assert 'Searx Guide' in shown, shown
            finally:
                searx_session.finish(expect_alt_leave=True)
                searx_session.close()

            # Packed session: Ctrl+C during a hung dsh web_search must not print
            # a late search body. The plugin abort has to run while dsh is live.
            config_path.write_text(saved_config.replace(
                f'base_url = "http://{host}/v1"',
                f'base_url = "http://{host}/v1/hang"',
                1,
            ))
            Handler.searches.clear()
            (home / 'pty-cancel').mkdir(exist_ok=True)
            cancel_session = Session('web-cancel', launcher, cwd, {
                **pty_env,
                'DSH_CODE_CLI_MOCK_TOOL': 'web-search-hang',
            }, home / 'pty-cancel', extra=['--fullscreen'])
            try:
                cancel_session.wait_visible('Connected to dsh ACP', 40)
                cancel_session.write('search and hang\r')
                deadline = __import__('time').monotonic() + 20
                while __import__('time').monotonic() < deadline and not any(item.get('hung') for item in Handler.searches):
                    cancel_session.pump(0.05)
                assert any(item.get('hung') for item in Handler.searches), 'packed session never reached the hung substitute'
                # The first Ctrl+C clears a leftover draft. The second cancels
                # the running dsh turn, which aborts the hung search.
                cancel_session.write('\x03')
                cancel_session.pump(0.3)
                cancel_session.write('\x03')
                shown = cancel_session.wait_visible('cancelled before a result', 20)
                assert 'SEARCH_RESULT_BODY' not in shown, shown
                assert 'RUST_ACP_WEB_DONE' not in shown, shown
                deadline = __import__('time').monotonic() + 3
                while __import__('time').monotonic() < deadline and not any(item.get('closed') for item in Handler.searches):
                    cancel_session.pump(0.05)
                assert any(item.get('closed') for item in Handler.searches), Handler.searches
            finally:
                cancel_session.finish(expect_alt_leave=True)
                cancel_session.close()
        print(f'PASS: configurable web search and fetch; substitute={host}')
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
