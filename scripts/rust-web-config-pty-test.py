#!/usr/bin/env python3
"""Installed-product PTY: web tools come from config.toml alone (ticket 206).

The packed and installed codsh runs with its own launcher overlay: no
CODSH_ACP_PATCH, no mock overlay, and no CODSH_WEB_SEARCH / CODSH_WEB_FETCH in
the environment. config.toml names a keyless loopback OpenAI-compatible model,
a loopback SearXNG substitute (`[models] web_search`) and web fetch
(`[features] web_fetch`). The launcher's overlay only has a fail-closed
placeholder; the Rust client appends the tool-web row for the effective
settings. The test checks what the model is offered and what the tools did:

- interactive: the model's request lists web_search and web_fetch, it calls
  both, the substitute receives the query and the page is fetched;
- -p --output-format streaming-messages-json: the init line lists the
  session's tools (web_search, web_fetch, workflow) and /deep-research;
- GROK_DISABLE_WEB_SEARCH=1 (an env override of the effective settings)
  drops only web_search; without web config a stray CODSH_WEB_SEARCH=1 /
  CODSH_WEB_FETCH=1 turns nothing on.

Runs on Linux and macOS; needs `pnpm run build:rust` (the staged native
binary is what gets packed).
"""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlparse

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('screen_pty', ROOT / 'scripts/rust-screen-pty-test.py')
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)
Session = screen.Session
NODE = screen.NODE
WEB_TOOLS = {'web_search', 'web_fetch'}


class Fake(http.server.BaseHTTPRequestHandler):
    """One loopback service: chat completions, SearXNG JSON and a page."""
    base = ''
    requests = []
    searches = []
    pages = []

    def log_message(self, *args):
        pass

    def reply(self, status, kind, body):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header('content-type', kind)
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/search':
            query = parse_qs(url.query).get('q', [''])[0]
            Fake.searches.append(query)
            self.reply(200, 'application/json', json.dumps({'query': query, 'results': [
                {'title': 'Config Page', 'url': f'{Fake.base}/page', 'content': 'WEBCFG_SNIPPET from searx'}]}))
            return
        if url.path == '/page':
            Fake.pages.append(url.path)
            self.reply(200, 'text/plain; charset=utf-8', 'WEBCFG_PAGE_BODY config-only fetch works')
            return
        self.reply(404, 'text/plain', 'not found')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length') or 0)) or b'{}')
        if not urlparse(self.path).path.endswith('/chat/completions'):
            self.reply(404, 'text/plain', 'not found')
            return
        tools = [tool.get('function', {}).get('name', '') for tool in body.get('tools') or []]
        messages = body.get('messages') or []
        text = lambda message: message.get('content') if isinstance(message.get('content'), str) else ' '.join(
            part.get('text', '') for part in message.get('content') or [] if isinstance(part, dict))
        users = [text(message) for message in messages if message.get('role') == 'user']
        results = [text(message) for message in messages if message.get('role') == 'tool']
        Fake.requests.append({'tools': tools, 'users': users, 'results': results})
        first = next((user for user in users if 'WEBCFG_' in user), '')
        call = None
        if 'WEBCFG_SEARCH' in first and not results:
            call = ('web_search', {'queries': ['codsh config only']})
        elif 'WEBCFG_SEARCH' in first and len(results) == 1:
            call = ('web_fetch', {'url': f'{Fake.base}/page'})
        if 'WEBCFG_SEARCH' in first and call is None:
            joined = '\n'.join(results)
            answer = f"WEBCFG_DONE snippet={'WEBCFG_SNIPPET' in joined} page={'WEBCFG_PAGE_BODY' in joined}"
        elif 'WEBCFG_TOOLS' in first:
            answer = 'WEBCFG_TOOLS ' + (','.join(sorted(WEB_TOOLS & set(tools))) or 'none')
        else:
            answer = 'WEBCFG title'
        chunks = [{'role': 'assistant'}]
        if call is None:
            chunks.append({'content': answer})
            finish = 'stop'
        else:
            chunks.append({'tool_calls': [{'index': 0, 'id': f'call_{len(Fake.requests)}', 'type': 'function',
                                           'function': {'name': call[0], 'arguments': json.dumps(call[1])}}]})
            finish = 'tool_calls'
        frames = [{'id': 'webcfg', 'object': 'chat.completion.chunk', 'model': 'fake-model',
                   'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]} for delta in chunks]
        frames.append({'id': 'webcfg', 'object': 'chat.completion.chunk', 'model': 'fake-model',
                       'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}],
                       'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}})
        if body.get('stream'):
            self.reply(200, 'text/event-stream', ''.join(f'data: {json.dumps(frame)}\n\n' for frame in frames) + 'data: [DONE]\n\n')
            return
        message = {'role': 'assistant', 'content': answer if call is None else None}
        if call is not None:
            message['tool_calls'] = chunks[1]['tool_calls']
        self.reply(200, 'application/json', json.dumps({'id': 'webcfg', 'object': 'chat.completion', 'model': 'fake-model',
                                                        'choices': [{'index': 0, 'message': message, 'finish_reason': finish}],
                                                        'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}))


def config(port, web=True):
    lines = [
        '[models]', 'default = "fake"', *(['web_search = "searx"'] if web else []), '',
        '[model.fake]', 'model = "fake-model"', 'name = "Fake loopback model"', 'provider = "llamacpp"',
        f'base_url = "http://127.0.0.1:{port}/v1"', 'api_key = "local-no-key"', 'api_backend = "chat_completions"',
        'context_window = 32768', '',
    ]
    if web:
        lines += [
            '[model.searx]', f'base_url = "http://127.0.0.1:{port}"', 'protocol = "searxng"', 'supports_backend_search = true', '',
            '[features]', 'web_fetch = true', '',
            '[toolset.web_fetch]', f'allowed_domains = ["127.0.0.1:{port}"]', 'allow_local = true', '',
        ]
    return '\n'.join(lines)


def plain(launcher, cwd, env, prompt, *extra):
    return subprocess.run([NODE, str(launcher), '--rust', '--always-approve', *extra, '-p', prompt],
                          cwd=cwd, env=env, capture_output=True, text=True, timeout=180)


def init_line(stdout):
    for line in stdout.splitlines():
        if line.startswith('{'):
            row = json.loads(line)
            if row.get('type') == 'system' and row.get('subtype') == 'init':
                return row
    raise AssertionError(f'no init line in\n{stdout}')


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-web-config-', dir='/tmp'))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fake)
    port = server.server_address[1]
    Fake.base = f'http://127.0.0.1:{port}'
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = {}
    try:
        with tempfile.TemporaryDirectory(prefix='codsh-rust-web-config-home-', dir='/tmp') as temporary:
            work = Path(temporary).resolve()
            home = work / 'home'
            home.mkdir()
            cwd = work / 'workspace'
            cwd.mkdir()
            launcher = screen_pack_install(work, home)
            grok = home / '.codsh-rust' / '.grok'
            grok.mkdir(parents=True)
            (grok / 'config.toml').write_text(config(port))
            env = {
                'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
                'DSH_BIN': screen.dsh_bin(), 'CODSH_NODE': NODE,
                'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF', 'CODSH_UPDATE_CHECK': 'off',
            }
            assert not any(key.startswith('CODSH_WEB_') or key == 'CODSH_ACP_PATCH' for key in env), env

            # 1. Interactive: the model is offered both tools and both run.
            session = Session('web-config', launcher, cwd, env, output,
                              extra=['--fullscreen', '--always-approve', '--trust'], cols=140, rows=44)
            try:
                session.wait_visible('Connected to dsh ACP', 60)
                session.write('WEBCFG_SEARCH please\r')
                shown = session.wait_visible('WEBCFG_DONE', 90)
                assert 'WEBCFG_DONE snippet=True page=True' in shown, shown
                results['interactive'] = session.finish(expect_alt_leave=True)['exit']
            finally:
                session.close()
            asked = [row for row in Fake.requests if row['users'] and 'WEBCFG_SEARCH' in ' '.join(row['users'])]
            assert asked and WEB_TOOLS <= set(asked[0]['tools']), Fake.requests
            assert Fake.searches == ['codsh config only'], Fake.searches
            assert Fake.pages == ['/page'], Fake.pages
            dsh_home = home / '.codsh-rust' / 'dsh'
            placeholder = (dsh_home / 'rust-file-approval.yml').read_text()
            assert '- id: tool-web\n  config:\n    search: false\n    fetch: false\n' in placeholder, placeholder
            effective = (dsh_home / 'rust-effective.yml').read_text()
            tail = effective[effective.rindex('- id: tool-web\n'):]
            assert tail.startswith('- id: tool-web\n  config:\n    search: true\n    fetch: true\n'), effective
            assert effective.rindex('- id: tool-web\n') > effective.index('rust-acp-web'), effective
            results['offered'] = sorted(WEB_TOOLS & set(asked[0]['tools']))

            # 2. Headless: the init line lists the session's tools and /deep-research.
            Fake.requests.clear()
            ran = plain(launcher, cwd, env, 'WEBCFG_TOOLS list', '--output-format', 'streaming-messages-json')
            assert ran.returncode == 0, ran.stderr + ran.stdout
            init = init_line(ran.stdout)
            assert {'web_search', 'web_fetch', 'workflow'} <= set(init['tools']), init
            assert init['slash_commands'] == ['deep-research'], init
            assert 'WEBCFG_TOOLS web_fetch,web_search' in ran.stdout, ran.stdout
            (output / 'headless-init.json').write_text(json.dumps(init, indent=1))
            results['headless_init'] = {'tools': len(init['tools']), 'slash_commands': init['slash_commands']}

            # 3. An env override is part of the effective settings.
            ran = plain(launcher, cwd, {**env, 'GROK_DISABLE_WEB_SEARCH': '1'}, 'WEBCFG_TOOLS list')
            assert ran.returncode == 0, ran.stderr
            assert ran.stdout.strip() == 'WEBCFG_TOOLS web_fetch', ran.stdout
            results['env_override'] = ran.stdout.strip()

            # 4. No web config: a stray CODSH_WEB_* value turns nothing on.
            (grok / 'config.toml').write_text(config(port, web=False))
            ran = plain(launcher, cwd, {**env, 'CODSH_WEB_SEARCH': '1', 'CODSH_WEB_FETCH': '1'}, 'WEBCFG_TOOLS list')
            assert ran.returncode == 0, ran.stderr
            assert ran.stdout.strip() == 'WEBCFG_TOOLS none', ran.stdout
            results['unconfigured'] = ran.stdout.strip()
    finally:
        server.shutdown()
    print(json.dumps(results, indent=2))
    print(f'PASS: web tools from config.toml only (installed launcher); screens={output}')


def screen_pack_install(work, home):
    spec = importlib.util.spec_from_file_location('image_gen_pty', ROOT / 'scripts/rust-image-gen-pty-test.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.pack_install(work, home)


if __name__ == '__main__':
    main()
