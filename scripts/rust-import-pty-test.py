#!/usr/bin/env python3
"""Installed-product explicit legacy config import for ticket 193."""
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


def overlay_text():
    return run([NODE, '--input-type=module', '-e',
                "import { rustAcpOverlay } from './scripts/rust-acp-overlay.mjs'; process.stdout.write(rustAcpOverlay())"],
               cwd=ROOT).stdout


def screen_text(data, rows, cols):
    emulator = ROOT / 'e2e/vt.ts'
    payload = json.dumps({'rows': rows, 'cols': cols, 'bytes': __import__('base64').b64encode(data).decode()})
    return run([NODE, '--import', 'tsx', '-e',
                f"import {{ Terminal }} from {json.dumps(emulator.as_uri())}; "
                "let input=''; for await (const chunk of process.stdin) input+=chunk; "
                "const spec=JSON.parse(input); const t=new Terminal(spec.rows,spec.cols); "
                "t.feed(Buffer.from(spec.bytes,'base64').toString()); console.log(t.text);"],
               input=payload, cwd=ROOT).stdout


def source_files(host_dsh, host_grok):
    names = [
        host_dsh / 'settings.yaml',
        host_dsh / '.credentials.yaml',
        host_dsh / '.env',
        host_dsh / 'code-cli-thinking.json',
        host_dsh / 'code-cli-ui.json',
        host_dsh / 'code-cli-settings.json',
        host_dsh / 'permissions.json',
        host_grok / 'auth.json',
    ]
    return {str(path): path.read_text() for path in names}


def spawn_rust(launcher, cwd, env, extra, timeout=20):
    return subprocess.run([NODE, str(launcher), '--rust', *extra], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=timeout)


def pty_session(name, argv, cwd, env, output, typed=None, wait_before=(), wait_after=(),
                quit=True, cols=100, rows=30, alt=True):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    original = termios.tcgetattr(slave)
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=slave, stdout=slave,
                               stderr=slave, start_new_session=True)
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

    def wait_visible(text, seconds=30):
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
        for marker in wait_before:
            wait_visible(marker, 30)
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
        if alt:
            assert b'\x1b[?1049l' in data
        (output / f'{name}.ansi').write_bytes(data)
        (output / f'{name}.txt').write_text(shown)
        return {'name': name, 'exit': process.returncode, 'screen': shown, 'raw': bytes(data)}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def sse_chat(answer):
    chunks = [
        {'id': 'import-193', 'object': 'chat.completion.chunk', 'choices': [
            {'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}]},
        {'id': 'import-193', 'object': 'chat.completion.chunk', 'choices': [
            {'index': 0, 'delta': {'content': answer}, 'finish_reason': None}]},
        {'id': 'import-193', 'object': 'chat.completion.chunk', 'choices': [
            {'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
    ]
    return ''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n'


class RecordingLLM(http.server.BaseHTTPRequestHandler):
    log = None
    token = 'IMPORT_TOKEN'

    def log_message(self, *_):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('content-length', 0) or 0))
        try:
            body = json.loads(raw.decode() or '{}')
        except json.JSONDecodeError:
            body = {}
        item = {
            'path': self.path.split('?', 1)[0],
            'authorization': self.headers.get('Authorization'),
            'model': body.get('model') if isinstance(body, dict) else None,
        }
        self.log.append(item)
        auth_ok = self.headers.get('Authorization') == f'Bearer {self.token}'
        if not auth_ok:
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"invalid api key"}}')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        answer = f"DSH_IMPORT_OK model={item['model']}"
        self.wfile.write(sse_chat(answer).encode())
        self.wfile.flush()


def start_server(log, token='IMPORT_TOKEN'):
    RecordingLLM.log = log
    RecordingLLM.token = token
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), RecordingLLM)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def pack_launcher(work, pack_env):
    pack = json.loads(run(['npm', 'pack', '--json', '--ignore-scripts', '--offline',
                           '--pack-destination', str(work)],
                          cwd=ROOT / 'packages/cli', env=pack_env).stdout)[0]['filename']
    prefix = work / 'installed'
    run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline',
         '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
    return prefix / 'node_modules/.bin/codsh'


def write_legacy_settings(path, port):
    path.write_text(f"""
llm-pi-ai:
  providers:
    acme-gateway:
      displayName: Acme Gateway
      apiKeyEnv: ACME_GATEWAY_API_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:{port}/v1
      models:
        - id: acme-large
          name: Acme Large
          contextWindow: 65536
          reasoningEfforts:
            high: high
agent-default-model:
  provider: acme-gateway
  model: acme-large
  reasoningEffort: high
""")


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-import-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-import-home-', dir='/tmp') as temporary:
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
        launcher = pack_launcher(work, pack_env)
        patch = work / 'overlay.yml'
        patch.write_text(overlay)

        log = []
        server = start_server(log)
        port = server.server_address[1]
        try:
            host_dsh = home / '.dsh'
            host_dsh.mkdir()
            write_legacy_settings(host_dsh / 'settings.yaml', port)
            cred_path = host_dsh / '.credentials.yaml'
            cred_path.write_text(
                'version: 1\n\nrefs:\n  ACME_GATEWAY_API_KEY: legacy-secret-must-not-copy\n')
            cred_path.chmod(0o600)
            (host_dsh / '.env').write_text('ACME_GATEWAY_API_KEY=dotenv-secret\n')
            (host_dsh / 'code-cli-thinking.json').write_text('{"acme-gateway/acme-large":"high"}')
            (host_dsh / 'code-cli-ui.json').write_text('{"density":"comfortable"}')
            (host_dsh / 'code-cli-settings.json').write_text('{"bell":false}')
            (host_dsh / 'permissions.json').write_text('{"allow":["bash(git *)"]}')
            host_grok = home / '.grok'
            host_grok.mkdir()
            (host_grok / 'auth.json').write_text('{"token":"official-token-must-not-copy"}')
            sources_before = source_files(host_dsh, host_grok)

            base_env = {
                'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
                'DSH_BIN': dsh, 'CODSH_NODE': NODE,
                'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
                'CODSH_UPDATE_CHECK': 'off',
                'DSH_HOME': str(host_dsh),
            }

            help_home = work / 'help-home'
            help_home.mkdir()
            help_env = {**base_env, 'HOME': str(help_home), 'DSH_HOME': str(host_dsh)}
            help_run = spawn_rust(launcher, cwd, help_env, ['import', '--help'])
            assert help_run.returncode == 0, help_run.stderr + help_run.stdout
            assert 'import' in help_run.stdout
            assert 'settings.yaml' in help_run.stdout
            assert 'code-cli-settings.json' in help_run.stdout
            assert not (help_home / '.codsh-rust').exists()
            assert source_files(host_dsh, host_grok) == sources_before

            preview = spawn_rust(launcher, cwd, base_env, ['import', '--preview', '--json'])
            assert preview.returncode == 0, preview.stderr + preview.stdout
            payload = json.loads(preview.stdout)
            assert payload['importedLegacyCredentials'] is False
            assert payload['officialTokensCopied'] is False
            assert payload['trustGranted'] is False
            assert payload['defaultModel'] == 'acme-gateway'
            assert any(item['kind'] == 'dsh.settings.yaml' for item in payload['sources'])
            assert any('code-cli-settings.json' in item.get('source', '') for item in payload['unsupported'])
            assert any(item['provider'] == 'acme-gateway' for item in payload['selected'])
            assert any('.credentials.yaml' in item.get('source', '') for item in payload['skippedSecrets'])
            assert any('permissions.json' in item.get('source', '') for item in payload['skippedTrust'])
            combined = preview.stdout + preview.stderr
            assert 'legacy-secret-must-not-copy' not in combined
            assert 'official-token-must-not-copy' not in combined
            assert 'dotenv-secret' not in combined
            assert source_files(host_dsh, host_grok) == sources_before
            isolated = home / '.codsh-rust'
            assert not (isolated / '.grok' / 'config.toml').exists()

            cancel = spawn_rust(launcher, cwd, base_env, ['import'])
            assert cancel.returncode == 0, cancel.stderr + cancel.stdout
            assert 'No files written' in cancel.stdout
            assert source_files(host_dsh, host_grok) == sources_before
            assert not (isolated / '.grok' / 'config.toml').exists() or \
                'acme-gateway' not in (isolated / '.grok' / 'config.toml').read_text()

            apply = spawn_rust(launcher, cwd, {**base_env, 'ACME_GATEWAY_API_KEY': 'IMPORT_TOKEN'},
                               ['import', '--apply', '--providers', 'acme-gateway', '--authorize-env'])
            assert apply.returncode == 0, apply.stderr + apply.stdout
            assert source_files(host_dsh, host_grok) == sources_before
            config_path = isolated / '.grok' / 'config.toml'
            config_text = config_path.read_text()
            assert 'acme-gateway' in config_text
            assert f'http://127.0.0.1:{port}/v1' in config_text
            assert 'legacy-secret-must-not-copy' not in config_text
            assert 'IMPORT_TOKEN' not in config_text
            assert not (isolated / 'dsh' / '.credentials.yaml').exists()
            inspect = spawn_rust(launcher, cwd, {**base_env, 'ACME_GATEWAY_API_KEY': 'IMPORT_TOKEN'},
                                 ['inspect', '--json'])
            inspect_payload = json.loads(inspect.stdout)
            assert inspect.returncode == 0, inspect.stderr
            settings = {row['key']: row for row in inspect_payload['settings']}
            assert settings['models.default']['value'] == 'acme-gateway'
            assert settings['model.acme-gateway.base_url']['value'] == f'http://127.0.0.1:{port}/v1'
            assert inspect_payload['importedLegacyCredentials'] is False
            assert 'legacy-secret-must-not-copy' not in inspect.stdout

            existing = config_path.read_text()
            repeat = spawn_rust(launcher, cwd, {**base_env, 'ACME_GATEWAY_API_KEY': 'IMPORT_TOKEN'},
                                ['import', '--apply', '--providers', 'acme-gateway'])
            assert repeat.returncode == 0, repeat.stderr + repeat.stdout
            assert config_path.read_text() == existing
            assert source_files(host_dsh, host_grok) == sources_before

            mock_env = {
                **base_env,
                'ACME_GATEWAY_API_KEY': 'IMPORT_TOKEN',
                'CODSH_ACP_PATCH': str(patch),
                'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            }
            rust_turn = pty_session(
                'rust-imported-route',
                [NODE, str(launcher), '--rust'],
                cwd, mock_env, output,
                wait_before=['Connected to dsh ACP'],
                typed='TOKEN_IMPORT_RUST\r',
                wait_after=['RUST_ACP_ANSWER', 'TOKEN_IMPORT_RUST'],
            )
            assert rust_turn['exit'] == 0
            generated = (isolated / 'dsh' / 'settings.yaml').read_text()
            assert generated.startswith('# generated-by: codsh-rust-config')
            assert f'http://127.0.0.1:{port}/v1' in generated
            assert source_files(host_dsh, host_grok) == sources_before

            rust_live = {**base_env, 'ACME_GATEWAY_API_KEY': 'IMPORT_TOKEN'}
            live = pty_session(
                'rust-live-route',
                [NODE, str(launcher), '--rust'],
                cwd, rust_live, output,
                wait_before=['Connected to dsh ACP', 'acme-gateway'],
                typed='TOKEN_IMPORT_LIVE\r',
                wait_after=['DSH_IMPORT_OK', 'acme-large'],
            )
            assert live['exit'] == 0
            assert any(item['model'] == 'acme-large' and item['authorization'] == 'Bearer IMPORT_TOKEN'
                       for item in log), log
            assert source_files(host_dsh, host_grok) == sources_before

            bundle_pack = json.loads(run(
                ['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
                cwd=ROOT / 'packages' / 'bundle', env=pack_env).stdout)[0]['filename']
            legacy_overlay = work / 'legacy-overlay.yml'
            # Empty overlay: the old version must read original $DSH_HOME/settings.yaml
            # (llm-pi-ai + agent-default-model) rather than a mock or deepseek pin.
            legacy_overlay.write_text('[]\n')
            legacy_env = {
                'HOME': str(home),
                'PATH': os.environ['PATH'],
                'TERM': 'xterm-256color',
                'DSH_HOME': str(host_dsh),
                'DSH_BIN': dsh,
                'DSH_TELEMETRY_DISABLED': '1',
                'CODSH_UPDATE_CHECK': 'off',
                'ACME_GATEWAY_API_KEY': 'IMPORT_TOKEN',
                'CODSH_CLIPBOARD': 'osc52',
                'CODSH_BUNDLE_SPEC': f'file:{work / bundle_pack}',
                'npm_config_cache': str(work / 'npm-cache'),
                'npm_config_userconfig': str(work / 'empty-user.npmrc'),
                'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
                'npm_config_update_notifier': 'false',
            }
            legacy = subprocess.run(
                [NODE, str(launcher), '--patch', str(legacy_overlay), '-p', 'TOKEN_IMPORT_LEGACY'],
                cwd=cwd, env=legacy_env, capture_output=True, text=True, timeout=120)
            (output / 'legacy-stdout.txt').write_text(legacy.stdout)
            (output / 'legacy-stderr.txt').write_text(legacy.stderr)
            Path('/tmp/codsh-import-legacy-stdout.txt').write_text(legacy.stdout)
            Path('/tmp/codsh-import-legacy-stderr.txt').write_text(legacy.stderr)
            assert source_files(host_dsh, host_grok) == sources_before
            combined_legacy = legacy.stdout + legacy.stderr
            snippet = combined_legacy[-1500:]
            assert legacy.returncode == 0, snippet
            assert 'Welcome to codsh · acme-large' in combined_legacy, snippet
            assert 'DSH_IMPORT_OK model=acme-large' in combined_legacy, snippet
            assert 'NO_ADAPTER' not in combined_legacy

            (output / 'result.json').write_text(json.dumps({
                'preview': {key: payload[key] for key in (
                    'defaultModel', 'importedLegacyCredentials', 'officialTokensCopied', 'trustGranted')},
                'inspectDefault': settings['models.default'],
                'legacySettingsUnchanged': source_files(host_dsh, host_grok) == sources_before,
                'rustLive': any(item.get('model') == 'acme-large' for item in log),
            }, indent=2) + '\n')
            (output / 'import-preview.json').write_text(preview.stdout)
            (output / 'inspect-after.json').write_text(inspect.stdout)
        finally:
            server.shutdown()
    print(f'PASS: rust legacy-config import PTY; evidence: {output}')


if __name__ == '__main__':
    main()
