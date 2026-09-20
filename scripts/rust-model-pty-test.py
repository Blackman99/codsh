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


def route_kind(path):
    normalized = path.split('?', 1)[0].rstrip('/')
    if normalized.endswith('/chat/completions'):
        return 'chat'
    if normalized.endswith('/responses'):
        return 'responses'
    if normalized.endswith('/messages'):
        return 'messages'
    return 'other'


def effort_from_body(body):
    if not isinstance(body, dict):
        return None
    if body.get('reasoning_effort'):
        return body.get('reasoning_effort')
    reasoning = body.get('reasoning')
    if isinstance(reasoning, dict):
        return reasoning.get('effort') or reasoning.get('summary')
    thinking = body.get('thinking')
    if isinstance(thinking, dict):
        return thinking.get('type') or thinking.get('budget_tokens')
    return None


def sse_chat(answer, fail=False):
    chunks = []
    if fail:
        chunks.append({'id': 'x', 'object': 'chat.completion.chunk', 'choices': [
            {'index': 0, 'delta': {'content': 'PARTIAL_MODEL'}, 'finish_reason': None}]})
        payload = ''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks)
        return payload + 'data: {"error":{"message":"provider failed mid-stream"}}\n\n'
    for delta, finish in [({'role': 'assistant'}, None), ({'content': answer}, None), ({}, 'stop')]:
        chunks.append({'id': 'model-140', 'object': 'chat.completion.chunk', 'model': 'shared-name',
                       'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]})
    return ''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n'


def sse_responses(answer, fail=False):
    events = [
        {'type': 'response.created', 'response': {'id': 'resp_140', 'status': 'in_progress'}},
        {'type': 'response.output_item.added', 'output_index': 0,
         'item': {'id': 'msg_140', 'type': 'message', 'role': 'assistant', 'content': []}},
        {'type': 'response.output_text.delta', 'output_index': 0, 'content_index': 0,
         'delta': 'PARTIAL_MODEL' if fail else answer},
    ]
    if fail:
        events.append({'type': 'error', 'error': {'message': 'provider failed mid-stream'}})
    else:
        events.append({'type': 'response.completed', 'response': {
            'id': 'resp_140', 'status': 'completed',
            'output': [{'id': 'msg_140', 'type': 'message', 'role': 'assistant',
                        'content': [{'type': 'output_text', 'text': answer}]}]},
        })
    return ''.join('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n' for event in events)


def sse_messages(answer, fail=False):
    events = [
        ('message_start', {'type': 'message_start', 'message': {
            'id': 'msg_140', 'type': 'message', 'role': 'assistant', 'content': [],
            'model': 'shared-name', 'stop_reason': None, 'stop_sequence': None,
            'usage': {'input_tokens': 1, 'output_tokens': 1}}}),
        ('content_block_start', {'type': 'content_block_start', 'index': 0,
                                 'content_block': {'type': 'text', 'text': ''}}),
        ('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                                 'delta': {'type': 'text_delta', 'text': 'PARTIAL_MODEL' if fail else answer}}),
    ]
    if fail:
        events.append(('error', {'type': 'error', 'error': {
            'type': 'api_error', 'message': 'provider failed mid-stream'}}))
    else:
        events.extend([
            ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
            ('message_delta', {'type': 'message_delta', 'delta': {
                'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 8}}),
            ('message_stop', {'type': 'message_stop'}),
        ])
    return ''.join(f'event: {name}\ndata: {json.dumps(payload)}\n\n' for name, payload in events)


class RecordingLLM(http.server.BaseHTTPRequestHandler):
    log = None
    mode = 'ok'
    token = 'ROUTE_TOKEN'

    def log_message(self, *_):
        pass

    def _record(self, body=None):
        path = self.path.split('?', 1)[0]
        item = {
            'method': self.command,
            'path': path,
            'kind': route_kind(path),
            'authorization': self.headers.get('Authorization'),
            'x_api_key': self.headers.get('x-api-key'),
            'model': None,
            'effort': None,
            'body': body,
        }
        if isinstance(body, dict):
            item['model'] = body.get('model')
            item['effort'] = effort_from_body(body)
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
        kind = item['kind']
        auth_ok = (self.headers.get('Authorization') == f'Bearer {self.token}'
                   or self.headers.get('x-api-key') == self.token)
        if self.mode == 'unauth' or not auth_ok:
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"invalid api key"}}')
            return
        if kind == 'other':
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        fail = self.mode == 'stream-fail'
        answer = f"DSH_MODEL_OK model={item['model']} effort={item['effort'] or 'none'} kind={kind}"
        if kind == 'chat':
            payload = sse_chat(answer, fail=fail)
        elif kind == 'responses':
            payload = sse_responses(answer, fail=fail)
        else:
            payload = sse_messages(answer, fail=fail)
        self.wfile.write(payload.encode())
        self.wfile.flush()


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
                actions=None, quit=True, cols=100, rows=36):
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
        if actions:
            for action in actions:
                text = action.get('type')
                if text:
                    os.write(master, text.encode())
                    prefix = text.split('\r', 1)[0]
                    if prefix.startswith('/') and text.endswith('\r'):
                        deadline = time.monotonic() + 10
                        while time.monotonic() < deadline:
                            pump()
                            shown = visible()
                            if prefix not in shown:
                                break
                            time.sleep(0.03)
                for marker in action.get('after', ()):
                    wait_visible(marker, 40)
        elif typed:
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


def write_catalog(path, port, default='chat'):
    path.write_text(f"""
[models]
default = "{default}"
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

[model.responses]
name = "Shared name"
model = "shared-name"
base_url = "http://127.0.0.1:{port}/v1"
env_key = "XAI_API_KEY"
api_backend = "responses"
supports_reasoning_effort = true
reasoning_efforts = ["low", "high"]

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
            assert settings['model.responses.api']['value'] == 'openai-responses'
            assert settings['model.messages.api']['value'] == 'anthropic-messages'
            assert 'unavailable' in settings['model.mystery.api']['value']
            assert payload['defaultEffort'] == 'high'
            assert payload['routing']['api'] == 'openai-completions'
            assert any(item.get('unavailable') for item in payload['catalog'] if item['id'] == 'mystery')
            results['inspect-catalog'] = payload['routing']

            generated = (home / '.codsh-rust' / 'dsh' / 'settings.yaml')
            golden = pty_session('same-session', launcher, cwd, base_env, output,
                                 wait_before=['Connected to dsh ACP', 'openai-completions'],
                                 actions=[
                                     {'type': 'TOKEN_MODEL_ONE\r',
                                      'after': ['DSH_MODEL_OK', 'usage=unknown']},
                                     {'type': '/model\r',
                                      'after': ['Model menu', 'openai-completions', 'openai-responses',
                                                'anthropic-messages', 'unavailable']},
                                     {'type': '/effort\r',
                                      'after': ['Effort menu', 'available=low, high']},
                                     {'type': '/effort xhigh\r',
                                      'after': ['Unsupported effort', 'xhigh']},
                                     {'type': '/model responses\r',
                                      'after': ['openai-responses', 'saved and active']},
                                     {'type': 'TOKEN_MODEL_RESP\r',
                                      'after': ['DSH_MODEL_OK', 'kind=responses']},
                                     {'type': '/model messages\r',
                                      'after': ['anthropic-messages']},
                                     {'type': 'TOKEN_MODEL_MSG\r',
                                      'after': ['DSH_MODEL_OK', 'kind=messages']},
                                 ])
            assert golden['exit'] == 0
            assert 'used=' not in golden['screen']
            assert 'cost=unknown' in golden['screen']
            yaml = generated.read_text()
            assert 'api: openai-completions' in yaml
            assert 'api: openai-responses' in yaml
            assert 'api: anthropic-messages' in yaml
            assert 'mystery-protocol' not in yaml
            posts = [item for item in log if item['method'] == 'POST']
            kinds = [item['kind'] for item in posts]
            assert 'chat' in kinds, posts
            assert 'responses' in kinds, posts
            assert 'messages' in kinds, posts
            chat_posts = [item for item in posts if item['kind'] == 'chat']
            assert chat_posts[-1]['model'] == 'shared-name'
            assert chat_posts[-1]['authorization'] == 'Bearer ROUTE_TOKEN'
            assert chat_posts[-1]['effort'] == 'high'
            response_posts = [item for item in posts if item['kind'] == 'responses']
            assert response_posts[-1]['model'] == 'shared-name'
            assert response_posts[-1]['authorization'] == 'Bearer ROUTE_TOKEN'
            message_posts = [item for item in posts if item['kind'] == 'messages']
            assert message_posts[-1]['model'] == 'shared-name'
            assert message_posts[-1]['x_api_key'] == 'ROUTE_TOKEN' or message_posts[-1]['authorization']
            results['pty-same-session'] = {'kinds': kinds}

            saved = grok / 'model-selection.toml'
            assert saved.is_file()
            assert 'default = "messages"' in saved.read_text()
            inspect_saved = spawn_inspect(launcher, cwd, base_env, ['inspect', '--json'])
            saved_payload = json.loads(inspect_saved.stdout)
            assert saved_payload.get('defaultModel') == 'messages'
            results['inspect-saved'] = saved_payload.get('defaultModel')

            def protocol_home(name, default, mode):
                last_error = None
                for attempt in range(2):
                    protocol_log = []
                    protocol_server = start_server(protocol_log, mode=mode)
                    protocol_root = work / f'{name}-home-{attempt}'
                    protocol_root.mkdir()
                    protocol_grok = protocol_root / '.codsh-rust' / '.grok'
                    protocol_grok.mkdir(parents=True)
                    write_catalog(protocol_grok / 'config.toml', protocol_server.server_address[1], default=default)
                    protocol_env = {**base_env, 'HOME': str(protocol_root)}
                    try:
                        run = pty_session(name, launcher, cwd, protocol_env, output,
                                          typed='TOKEN_MODEL_ERR\r',
                                          wait_before=['Connected to dsh ACP'],
                                          wait_after=['error'])
                    except AssertionError as error:
                        last_error = error
                        protocol_server.shutdown()
                        time.sleep(1)
                        continue
                    protocol_server.shutdown()
                    assert run['exit'] == 0
                    assert 'DSH_MODEL_OK' not in run['screen']
                    return protocol_log, run
                raise last_error

            chat_auth_log, _ = protocol_home('chat-auth', 'chat', 'unauth')
            assert any(item['kind'] == 'chat' and item['method'] == 'POST' for item in chat_auth_log)
            results['pty-chat-auth'] = True
            responses_auth_log, _ = protocol_home('responses-auth', 'responses', 'unauth')
            assert any(item['kind'] == 'responses' and item['method'] == 'POST' for item in responses_auth_log)
            results['pty-responses-auth'] = True
            messages_auth_log, _ = protocol_home('messages-auth', 'messages', 'unauth')
            assert any(item['kind'] == 'messages' and item['method'] == 'POST' for item in messages_auth_log)
            results['pty-messages-auth'] = True
            responses_fail_log, _ = protocol_home('responses-stream-fail', 'responses', 'stream-fail')
            assert any(item['kind'] == 'responses' and item['method'] == 'POST' for item in responses_fail_log)
            results['pty-responses-stream-fail'] = True
            messages_fail_log, _ = protocol_home('messages-stream-fail', 'messages', 'stream-fail')
            assert any(item['kind'] == 'messages' and item['method'] == 'POST' for item in messages_fail_log)
            results['pty-messages-stream-fail'] = True

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
