#!/usr/bin/env python3
"""Installed-product PTY: a workflow child's approval is asked in the main session (#220).

The packed and installed codsh runs in the default ask mode with no
permission allow rules and no CODSH_WEB_* variables. config.toml names a
keyless loopback OpenAI-compatible model and web fetch (`[features]
web_fetch`). A trusted project workflow (`/fetchone <url>`) runs one real
dsh child that calls `web_fetch`. The test checks, on the screen and at the
loopback page server:

- the approval shows in the main session with who asks (workflow and child
  label), the tool, and the URL;
- y lets the fetch run and the child reads the page;
- n returns the refusal to the child (`the user rejected tool "web_fetch"`)
  and nothing is fetched;
- a remembers the domain in the same grants file as a main-session `a`, and
  the next child fetch runs without asking;
- `/workflow stop` while a request waits closes it and the child is not
  left hanging;
- a plain -p run (no terminal to ask) keeps the old refusal.

Runs on Linux and macOS; needs `pnpm run build:rust` (the staged native
binary is what gets packed).
"""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlparse

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('screen_pty', ROOT / 'scripts/rust-screen-pty-test.py')
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)
Session = screen.Session
NODE = screen.NODE

FETCHONE = '''let meta = #{ name: "fetchone", description: "One child fetches one page", when_to_use: "#220 PTY probe" };
phase("Fetch");
let target = if type_of(args) == "map" { args.objective } else { "nothing" };
agent("CHILDAPPR_FETCH " + target, #{ label: "fetcher" }).output
'''


class Fake(http.server.BaseHTTPRequestHandler):
    """One loopback service: chat completions and the page."""
    base = ''
    pages = []
    children = []

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
        if url.path == '/page':
            Fake.pages.append(url.query)
            self.reply(200, 'text/plain; charset=utf-8', f'CHILDAPPR_PAGE_BODY {url.query}')
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
        first = next((user for user in users if 'CHILDAPPR_FETCH ' in user), '')
        headless = next((user for user in users if 'CHILDAPPR_HEADLESS ' in user), '')
        call = None
        if headless and not first and not results and 'workflow' in tools:
            url = re.search(r'CHILDAPPR_HEADLESS (\S+)', headless).group(1)
            call = ('workflow', {'source': {'type': 'name', 'name': 'fetchone'}, 'args': {'objective': url}})
        elif headless and not first and results:
            answer = 'CHILDAPPR_HEADLESS_DONE ' + ' '.join(results[-1].split())[:400]
        elif first:
            url = re.search(r'CHILDAPPR_FETCH (\S+)', first).group(1)
            if not results and 'web_fetch' not in tools:
                answer = 'CHILDAPPR_NO_FETCH_TOOL'
                Fake.children.append({'url': url, 'result': 'no web_fetch tool: ' + ','.join(tools)})
            elif not results:
                Fake.children.append({'url': url, 'tools': tools})
                call = ('web_fetch', {'url': url})
            else:
                result = ' '.join(results[-1].split())[:400]
                Fake.children.append({'url': url, 'result': result})
                answer = f'CHILDAPPR_CHILD {url} -> {result}'
        elif any('CHILDAPPR_CHILD' in user for user in users):
            answer = 'CHILDAPPR_NOTICE seen'
        else:
            answer = 'CHILDAPPR title'
        chunks = [{'role': 'assistant'}]
        if call is None:
            chunks.append({'content': answer})
            finish = 'stop'
        else:
            chunks.append({'tool_calls': [{'index': 0, 'id': f'call_{len(Fake.children)}', 'type': 'function',
                                           'function': {'name': call[0], 'arguments': json.dumps(call[1])}}]})
            finish = 'tool_calls'
        frames = [{'id': 'childappr', 'object': 'chat.completion.chunk', 'model': 'fake-model',
                   'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]} for delta in chunks]
        frames.append({'id': 'childappr', 'object': 'chat.completion.chunk', 'model': 'fake-model',
                       'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}],
                       'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}})
        if body.get('stream'):
            self.reply(200, 'text/event-stream', ''.join(f'data: {json.dumps(frame)}\n\n' for frame in frames) + 'data: [DONE]\n\n')
            return
        message = {'role': 'assistant', 'content': answer if call is None else None}
        if call is not None:
            message['tool_calls'] = chunks[1]['tool_calls']
        self.reply(200, 'application/json', json.dumps({'id': 'childappr', 'object': 'chat.completion', 'model': 'fake-model',
                                                        'choices': [{'index': 0, 'message': message, 'finish_reason': finish}],
                                                        'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}))


def config(port):
    return '\n'.join([
        '[models]', 'default = "fake"', '',
        '[model.fake]', 'model = "fake-model"', 'name = "Fake loopback model"', 'provider = "llamacpp"',
        f'base_url = "http://127.0.0.1:{port}/v1"', 'api_key = "local-no-key"', 'api_backend = "chat_completions"',
        'context_window = 32768', '',
        '[features]', 'web_fetch = true', '',
        '[toolset.web_fetch]', f'allowed_domains = ["127.0.0.1:{port}"]', 'allow_local = true', '',
    ])


def wait_until(session, predicate, what, seconds=60):
    deadline = time.monotonic() + seconds
    shown = ''
    while time.monotonic() < deadline:
        session.pump()
        shown = session.visible()
        if predicate(shown):
            return shown
        time.sleep(0.1)
    raise AssertionError(f'{what}\n{shown}')


def child_result(url, seconds=60, session=None):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        for row in Fake.children:
            if row['url'] == url and 'result' in row:
                return row['result']
        if session is not None:
            session.pump()
        else:
            time.sleep(0.1)
    raise AssertionError(f'no child result for {url}: {Fake.children}')


def run_workflow(session, url):
    session.write(f'/fetchone {url}')
    session.wait_visible(f'/fetchone {url}'[:30], 10)
    session.write(b'\r')


def approval_line(session, url):
    return wait_until(session, lambda s: 'Approval from workflow fetchone' in s and f'allow web_fetch {url}' in s,
                      f'no approval for {url}')


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-child-approval-', dir='/tmp'))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fake)
    port = server.server_address[1]
    Fake.base = f'http://127.0.0.1:{port}'
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = {}
    try:
        with tempfile.TemporaryDirectory(prefix='codsh-rust-child-approval-home-', dir='/tmp') as temporary:
            work = Path(temporary).resolve()
            home = work / 'home'
            home.mkdir()
            cwd = work / 'workspace'
            (cwd / '.grok' / 'workflows').mkdir(parents=True)
            (cwd / '.grok' / 'workflows' / 'fetchone.rhai').write_text(FETCHONE)
            launcher = pack_install(work, home)
            grok = home / '.codsh-rust' / '.grok'
            grok.mkdir(parents=True)
            (grok / 'config.toml').write_text(config(port))
            env = {
                'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
                'DSH_BIN': screen.dsh_bin(), 'CODSH_NODE': NODE,
                'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF', 'CODSH_UPDATE_CHECK': 'off',
            }
            assert not any(key.startswith('CODSH_WEB_') or key == 'CODSH_ACP_PATCH' for key in env), env

            # 0. Headless: no terminal to ask, so the child's ask is refused as
            #    before. -p runs a saved workflow through the model's workflow
            #    tool; that call (not the child's fetch) is allowed by a rule.
            (grok / 'config.toml').write_text(config(port) + '\n[permission]\nallow = ["*(workflow)"]\n')
            url0 = f'{Fake.base}/page?run=headless'
            ran = subprocess.run([NODE, str(launcher), '--rust', '--trust', '-p', f'CHILDAPPR_HEADLESS {url0}'],
                                 cwd=cwd, env=env, capture_output=True, text=True, timeout=180)
            (output / 'headless.txt').write_text(ran.stdout + '\n--- stderr ---\n' + ran.stderr)
            result = child_result(url0)
            assert 'permission mode ask' in result, (result, ran.stdout, ran.stderr)
            assert 'run=headless' not in Fake.pages, Fake.pages
            results['headless'] = result
            (grok / 'config.toml').write_text(config(port))
            assert '[permission]' not in (grok / 'config.toml').read_text()

            session = Session('child-approval', launcher, cwd, env, output,
                              extra=['--fullscreen', '--trust'], cols=200, rows=48)
            try:
                session.wait_visible('Connected to dsh ACP', 60)

                # 1. y: approve once from the main session; the child fetches.
                url1 = f'{Fake.base}/page?run=once'
                run_workflow(session, url1)
                shown = approval_line(session, url1)
                assert 'fetcher' in shown and 'y=allow once  a=remember domain  n=reject' in shown, shown
                assert 'run=once' not in Fake.pages, 'nothing is fetched before the answer'
                (output / 'approval-once.txt').write_text(shown)
                session.write('y')
                result = child_result(url1, session=session)
                assert 'CHILDAPPR_PAGE_BODY run=once' in result, result
                assert Fake.pages.count('run=once') == 1, Fake.pages
                wait_until(session, lambda s: 'Approval from workflow' not in s, 'approval line stayed')
                results['approve_once'] = result

                # 2. n: the child gets the refusal; nothing is fetched.
                url2 = f'{Fake.base}/page?run=deny'
                run_workflow(session, url2)
                approval_line(session, url2)
                session.write('n')
                result = child_result(url2, session=session)
                assert 'the user rejected tool "web_fetch"' in result, result
                assert 'run=deny' not in Fake.pages, Fake.pages
                shown = wait_until(session, lambda s: 'Approval from workflow' not in s, 'approval line stayed')
                results['deny'] = result

                # 3. a: the domain is remembered like a main-session grant...
                url3 = f'{Fake.base}/page?run=remember'
                run_workflow(session, url3)
                approval_line(session, url3)
                session.write('a')
                result = child_result(url3, session=session)
                assert 'CHILDAPPR_PAGE_BODY run=remember' in result, result
                # The main prompt's `a` writes the project's sessions/<scope>/permission.toml.
                grants = {str(path.relative_to(home)): path.read_text() for path in home.rglob('permission.toml')}
                assert any('127.0.0.1' in text for text in grants.values()), grants
                results['remember'] = grants

                # ...so the next child fetch of that domain runs without asking.
                url4 = f'{Fake.base}/page?run=granted'
                run_workflow(session, url4)
                result = child_result(url4, session=session)
                assert 'CHILDAPPR_PAGE_BODY run=granted' in result, result
                assert 'Approval from workflow' not in session.visible(), session.visible()
                results['granted'] = result

                # 4. /workflow stop while a request waits: the card closes and
                #    the child is not left hanging. A new domain asks again.
                url5 = f'http://localhost:{port}/page?run=stop'
                run_workflow(session, url5)
                shown = approval_line(session, url5)
                run = re.search(r'Approval from workflow (fetchone-\d+)', shown).group(1)
                session.send_slash(f'/workflow stop {run}')
                shown = wait_until(session, lambda s: 'Approval from workflow' not in s, 'approval line stayed after stop', 30)
                assert 'run=stop' not in Fake.pages, Fake.pages
                shown = wait_until(session, lambda s: f'workflow {run} [cancelled]' in s, 'stopped run did not end', 30)
                (output / 'after-stop.txt').write_text(shown)
                results['stopped'] = True
                results['interactive_exit'] = session.finish(expect_alt_leave=True)['exit']
            finally:
                session.close()
    finally:
        server.shutdown()
    print(json.dumps(results, indent=2))
    print(f'PASS: workflow child approvals in the main session (installed launcher); screens={output}')


def pack_install(work, home):
    spec = importlib.util.spec_from_file_location('image_gen_pty', ROOT / 'scripts/rust-image-gen-pty-test.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.pack_install(work, home)


if __name__ == '__main__':
    main()
