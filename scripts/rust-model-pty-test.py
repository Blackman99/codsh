#!/usr/bin/env python3
"""Installed-product model/protocol/effort PTY for ticket 140."""
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


def dsh_bin():
    script = "import { createRequire } from 'node:module'; import { dirname, join } from 'node:path'; import { readFileSync } from 'node:fs'; const r=createRequire(process.argv[1]); const m=r.resolve('@deepseek-ai/dsh/package.json'); const bin=JSON.parse(readFileSync(m,'utf8')).bin; process.stdout.write(join(dirname(m), typeof bin==='string'?bin:bin.dsh))"
    return run([NODE, '--input-type=module', '-e', script, str(ROOT / 'package.json')], cwd=ROOT).stdout


def screen_text(data, rows, cols):
    emulator = ROOT / 'e2e/vt.ts'
    payload = json.dumps({'rows': rows, 'cols': cols, 'bytes': __import__('base64').b64encode(data).decode()})
    return run([NODE, '--import', 'tsx', '-e',
                f"import {{ Terminal }} from {json.dumps(emulator.as_uri())}; "
                "let input=''; for await (const chunk of process.stdin) input+=chunk; "
                "const spec=JSON.parse(input); const t=new Terminal(spec.rows,spec.cols); "
                "t.feed(Buffer.from(spec.bytes,'base64').toString()); console.log(t.text);"],
               input=payload, cwd=ROOT).stdout


class RecordingLLM(http.server.BaseHTTPRequestHandler):
    log = None
    mode = 'ok'
    token = 'ROUTE_TOKEN'

    def log_message(self, *_):
        pass

    def _record(self, body=None):
        item = {
            'method': self.command,
            'path': self.path.split('?', 1)[0],
            'authorization': self.headers.get('Authorization'),
            'x_api_key': self.headers.get('x-api-key'),
            'model': None,
            'effort': None,
            'body': body,
        }
        if isinstance(body, dict):
            item['model'] = body.get('model')
            item['effort'] = body.get('reasoning_effort') or (body.get('thinking') or {}).get('type')
        self.log.append(item)
        return item

    def do_GET(self):
        self._record()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"data":[{"id":"shared-name"}]}')

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('content-length', 0) or 0))
        try:
            body = json.loads(raw.decode() or '{}')
        except json.JSONDecodeError:
            body = {'raw': raw.decode(errors='replace')}
        item = self._record(body)
        path = item['path']
        auth_ok = (self.headers.get('Authorization') == f'Bearer {self.token}'
                   or self.headers.get('x-api-key') == self.token)
        if self.mode == 'unauth' or not auth_ok:
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"invalid api key"}}')
            return
        if self.mode == 'stream-fail' and '/chat/completions' in path:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            chunk = {'id': 'x', 'object': 'chat.completion.chunk', 'choices': [
                {'index': 0, 'delta': {'content': 'PARTIAL_MODEL'}, 'finish_reason': None}]}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            self.wfile.flush()
            self.wfile.write(b'data: {"error":{"message":"provider failed mid-stream"}}\n\n')
            return
        if '/chat/completions' in path:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            answer = f"DSH_MODEL_OK model={item['model']} effort={item['effort'] or 'none'}"
            for delta, finish in [({'role': 'assistant'}, None), ({'content': answer}, None), ({}, 'stop')]:
                event = {'id': 'model-140', 'object': 'chat.completion.chunk', 'model': item['model'],
                         'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()
            self.wfile.write(b'data: [DONE]\n\n')
            return
        if path.endswith('/messages') or path.endswith('/v1/messages'):
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"type":"error","error":{"type":"invalid_request_error","message":"messages backend is not chat_completions"}}')
            return
        self.send_response(404)
        self.end_headers()


def start_server(log, mode='ok', token='ROUTE_TOKEN'):
    RecordingLLM.log = log
    RecordingLLM.mode = mode
    RecordingLLM.token = token
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), RecordingLLM)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def spawn_inspect(launcher, cwd, env, extra):
    return subprocess.run([NODE, str(launcher), '--rust', *extra], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=20)


def pty_session(name, launcher, cwd, env, output, typed=None, wait_before=(), wait_after=(),
                quit=True, cols=100, rows=36):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    original = termios.tcgetattr(slave)
    process = subprocess.Popen([NODE, str(launcher), '--rust'], cwd=cwd, env=env,
                               stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    data = bytearray()

    def pump(seconds=0.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.03)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                data.extend(chunk)

    def visible():
        return screen_text(bytes(data), rows, cols)

    def wait_visible(text, seconds=40):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            pump()
            shown = visible()
            if text in shown:
                return shown
            if process.poll() is not None:
                break
        raise AssertionError(f'{name}: missing {text!r}\n{visible()}\nraw={bytes(data)[-2500:]!r}')

    try:
        wait_visible('codsh')
        wait_visible('Draft (not sent)')
        for marker in wait_before:
            wait_visible(marker, 40)
        if typed:
            os.write(master, typed.encode())
            prefix = typed.split('\r', 1)[0]
            if prefix and not prefix.startswith('/'):
                wait_visible(prefix[:40] if len(prefix) > 40 else prefix)
        for marker in wait_after:
            wait_visible(marker, 40)
        shown = visible()
        if quit:
            os.write(master, b'\x11')
            process.wait(timeout=15)
        pump()
        os.write(master, b'AFTER_EXIT_CANONICAL\n')
        assert select.select([slave], [], [], 2)[0]
        assert os.read(slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
        assert original == termios.tcgetattr(slave), f'{name}: terminal modes were not restored'
        assert b'\x1b[?1049l' in data
        (output / f'{name}.ansi').write_bytes(data)
        (output / f'{name}.txt').write_text(shown)
        return {'name': name, 'exit': process.returncode, 'screen': shown}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def write_catalog(path, port):
    path.write_text(f"""
[models]
default = "chat"
default_reasoning_effort = "high"

[model.chat]
name = "Shared name"
model = "shared-name"
base_url = "http://127.0.0.1:{port}/v1"
env_key = "XAI_API_KEY"
api_backend = "chat_completions"
supports_reasoning_effort = true
reasoning_efforts = ["low", "high"]
context_window = 128000

[model.messages]
name = "Shared name"
model = "shared-name"
base_url = "http://127.0.0.1:{port}"
env_key = "ANTHROPIC_API_KEY"
api_backend = "messages"
supports_reasoning_effort = false

[model.mystery]
name = "Mystery"
model = "shared-name"
base_url = "http://127.0.0.1:{port}/v1"
env_key = "XAI_API_KEY"
api_backend = "mystery-protocol"
""")


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-model-', dir='/tmp'))
    dsh = dsh_bin()
    log = []
    server = start_server(log)
    port = server.server_address[1]
    try:
        with tempfile.TemporaryDirectory(prefix='codsh-rust-model-home-', dir='/tmp') as temporary:
            work = Path(temporary)
            home = work / 'home'
            home.mkdir()
            cwd = work / 'workspace'
            cwd.mkdir()
            pack_env = {
                'HOME': str(home), 'PATH': os.environ['PATH'],
                'npm_config_cache': str(work / 'npm-cache'),
                'npm_config_userconfig': str(work / 'empty-user.npmrc'),
                'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
                'npm_config_update_notifier': 'false',
            }
            pack = json.loads(run(['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
                                 cwd=ROOT / 'packages/cli', env=pack_env).stdout)[0]['filename']
            prefix = work / 'installed'
            run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
            launcher = prefix / 'node_modules/.bin/codsh'
            grok = home / '.codsh-rust' / '.grok'
            grok.mkdir(parents=True)
            write_catalog(grok / 'config.toml', port)
            base_env = {
                'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
                'DSH_BIN': dsh, 'CODSH_NODE': NODE,
                'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
                'CODSH_UPDATE_CHECK': 'off',
                'XAI_API_KEY': 'ROUTE_TOKEN',
                'ANTHROPIC_API_KEY': 'ROUTE_TOKEN',
            }
            results = {}

            inspect = spawn_inspect(launcher, cwd, base_env, ['inspect', '--json'])
            assert inspect.returncode == 0, inspect.stderr + inspect.stdout
            payload = json.loads(inspect.stdout)
            assert payload['ready'] is True
            settings = {row['key']: row for row in payload['settings']}
            assert settings['model.chat.api']['value'] == 'openai-completions'
            assert settings['model.messages.api']['value'] == 'anthropic-messages'
            assert 'unavailable' in settings['model.mystery.api']['value']
            assert payload['defaultEffort'] == 'high'
            assert payload['routing']['api'] == 'openai-completions'
            assert 'mystery-protocol' in inspect.stdout or any(
                item.get('unavailable') for item in payload['catalog'] if item['id'] == 'mystery')
            results['inspect-catalog'] = payload['routing']

            generated = (home / '.codsh-rust' / 'dsh' / 'settings.yaml')
            turn = pty_session('chat-turn', launcher, cwd, base_env, output,
                               typed='TOKEN_MODEL_ONE\r',
                               wait_before=['Connected to dsh ACP', 'openai-completions'],
                               wait_after=['DSH_MODEL_OK', 'shared-name'])
            assert turn['exit'] == 0
            assert 'usage=unknown' in turn['screen'] or 'used=' in turn['screen']
            assert 'cost=unknown' in turn['screen'] or 'cost=' in turn['screen']
            assert '0.0' not in turn['screen'] or 'cost=unknown' in turn['screen']
            yaml = generated.read_text()
            assert 'api: openai-completions' in yaml
            assert 'api: anthropic-messages' in yaml
            assert 'mystery-protocol' not in yaml
            chat_posts = [item for item in log if item['method'] == 'POST' and 'chat/completions' in item['path']]
            assert chat_posts, log
            assert chat_posts[-1]['model'] == 'shared-name'
            assert chat_posts[-1]['authorization'] == 'Bearer ROUTE_TOKEN'
            assert chat_posts[-1]['effort'] in {None, 'high', 'low'}
            results['pty-chat'] = {'model': chat_posts[-1]['model'], 'effort': chat_posts[-1]['effort']}

            menu = pty_session('model-menu', launcher, cwd, base_env, output,
                               typed='/model\r',
                               wait_before=['Connected to dsh ACP'],
                               wait_after=['Model menu', 'chat', 'messages', 'unavailable'])
            assert menu['exit'] == 0
            assert 'mystery' in menu['screen']
            results['pty-menu'] = True

            unsupported = pty_session('unsupported-effort', launcher, cwd, base_env, output,
                                      typed='/effort xhigh\r',
                                      wait_before=['Connected to dsh ACP'],
                                      wait_after=['Unsupported effort', 'xhigh'])
            assert unsupported['exit'] == 0
            results['pty-unsupported-effort'] = True

            before_messages = len(log)
            switched = pty_session('switch-messages', launcher, cwd, base_env, output,
                                   typed='/model messages\r',
                                   wait_before=['Connected to dsh ACP'],
                                   wait_after=['anthropic-messages'])
            assert switched['exit'] == 0
            assert 'Selected' in switched['screen'] or 'anthropic-messages' in switched['screen']
            results['pty-switch-messages'] = True

            messages_turn = pty_session('messages-turn', launcher, cwd, base_env, output,
                                        typed='TOKEN_MODEL_TWO\r',
                                        wait_before=['Connected to dsh ACP', 'anthropic-messages'],
                                        wait_after=['error'])
            assert messages_turn['exit'] == 0
            later = log[before_messages:]
            message_posts = [item for item in later if item['method'] == 'POST' and item['path'].rstrip('/').endswith('messages')]
            chat_after = [item for item in later if item['method'] == 'POST' and 'chat/completions' in item['path']]
            assert message_posts, later
            assert message_posts[-1]['model'] == 'shared-name'
            assert 'DSH_MODEL_OK' not in messages_turn['screen']
            results['pty-messages-not-equivalent'] = {
                'messages': len(message_posts),
                'chatAfter': len(chat_after),
            }

            unauth_log = []
            unauth_server = start_server(unauth_log, mode='unauth')
            unauth_home = work / 'unauth-home'
            unauth_home.mkdir()
            unauth_grok = unauth_home / '.codsh-rust' / '.grok'
            unauth_grok.mkdir(parents=True)
            write_catalog(unauth_grok / 'config.toml', unauth_server.server_address[1])
            unauth_env = {**base_env, 'HOME': str(unauth_home)}
            auth = pty_session('auth-error', launcher, cwd, unauth_env, output,
                               typed='TOKEN_MODEL_AUTH\r',
                               wait_before=['Connected to dsh ACP'],
                               wait_after=['error'])
            assert auth['exit'] == 0
            assert 'DSH_MODEL_OK' not in auth['screen']
            unauth_server.shutdown()
            results['pty-auth'] = True

            fail_log = []
            fail_server = start_server(fail_log, mode='stream-fail')
            fail_home = work / 'fail-home'
            fail_home.mkdir()
            fail_grok = fail_home / '.codsh-rust' / '.grok'
            fail_grok.mkdir(parents=True)
            write_catalog(fail_grok / 'config.toml', fail_server.server_address[1])
            fail_env = {**base_env, 'HOME': str(fail_home)}
            failed = pty_session('stream-fail', launcher, cwd, fail_env, output,
                                 typed='TOKEN_MODEL_FAIL\r',
                                 wait_before=['Connected to dsh ACP'],
                                 wait_after=['error'])
            assert failed['exit'] == 0
            assert 'DSH_MODEL_OK' not in failed['screen']
            fail_server.shutdown()
            results['pty-stream-fail'] = True

            saved = grok / 'model-selection.toml'
            assert saved.is_file() or '/model messages' in switched['screen']
            inspect_saved = spawn_inspect(launcher, cwd, base_env, ['inspect', '--json'])
            saved_payload = json.loads(inspect_saved.stdout)
            results['inspect-saved'] = saved_payload.get('defaultModel')

            (output / 'result.json').write_text(json.dumps({
                'results': results,
                'requests': log,
                'generated': yaml,
            }, indent=2) + '\n')
            assert all(results.values()), results
    finally:
        server.shutdown()
    print(f'PASS: rust dsh model/protocol/effort PTY; evidence: {output}')


if __name__ == '__main__':
    main()
