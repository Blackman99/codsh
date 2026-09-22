#!/usr/bin/env python3
"""Installed-product check for local feedback drafts and opt-in diagnostics."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    'rust_screen_pty_test', ROOT / 'scripts' / 'rust-screen-pty-test.py')
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)
NODE = screen.NODE
Session = screen.Session
dsh_bin = screen.dsh_bin
overlay_text = screen.overlay_text
run = screen.run


class Loopback:
    def __init__(self, status):
        self.status = status
        self.bodies = []
        self.server = socket.socket()
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(('127.0.0.1', 0))
        self.server.listen(8)
        self.port = self.server.getsockname()[1]
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def url(self, path):
        return f'http://127.0.0.1:{self.port}{path}'

    def _serve(self):
        self.server.settimeout(0.2)
        while not self.stop.is_set():
            try:
                conn, _ = self.server.accept()
            except socket.timeout:
                continue
            data = b''
            conn.settimeout(1)
            while b'\r\n\r\n' not in data and len(data) < 65536:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            header, _, rest = data.partition(b'\r\n\r\n')
            length = 0
            for line in header.split(b'\r\n'):
                if line.lower().startswith(b'content-length:'):
                    length = int(line.split(b':', 1)[1].strip() or b'0')
            while len(rest) < length:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                rest += chunk
            self.bodies.append(rest.decode(errors='replace'))
            body = b'{"ok":true}' if self.status == 200 else b'{"ok":false}'
            reason = b'OK' if self.status == 200 else b'ERR'
            conn.sendall(
                f'HTTP/1.1 {self.status} {reason.decode()}\r\ncontent-length: {len(body)}\r\nconnection: close\r\n\r\n'.encode()
                + body)
            conn.close()

    def close(self):
        self.stop.set()
        self.server.close()


def spawn(launcher, cwd, env, extra):
    return subprocess.run(
        [NODE, str(launcher), '--rust', *extra], cwd=cwd, env=env,
        capture_output=True, text=True, timeout=30)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS installed-product evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-privacy-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    sink = Loopback(500)
    ok = Loopback(200)
    try:
        with tempfile.TemporaryDirectory(prefix='codsh-rust-privacy-home-', dir='/tmp') as temporary:
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
            pack = json.loads(run(
                ['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
                cwd=ROOT / 'packages/cli', env=pack_env).stdout)[0]['filename']
            prefix = work / 'installed'
            run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline',
                 '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
            launcher = prefix / 'node_modules/.bin/codsh'
            patch = work / 'overlay.yml'
            patch.write_text(overlay)
            grok = home / '.codsh-rust' / '.grok'
            grok.mkdir(parents=True)
            secret = 'sk-privacy-must-not-upload'
            (grok / 'config.toml').write_text(f"""
[models]
default = "gateway"

[model.gateway]
name = "Local gateway"
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
api_key = "{secret}"

[features]
telemetry = true
feedback = true
trace_upload = true

[privacy]
share_content = true
share_session = false

[endpoints]
telemetry_url = "{ok.url('/telemetry')}"
feedback_base_url = "{sink.url('/feedback')}"
trace_upload_url = "https://api.x.ai/v1/traces"
""")
            env = {
                'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
                'COLORTERM': 'truecolor',
                'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
                'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
                'CODSH_UPDATE_CHECK': 'off', 'XAI_API_KEY': 'test-key-not-logged',
                'GROK_DEBUG_LOG': '1',
            }
            preview = spawn(launcher, cwd, env, ['feedback', 'preview'])
            assert preview.returncode == 0, preview.stderr
            assert 'Excluded: prompts' in preview.stdout
            assert 'not model traffic' in preview.stdout
            assert secret not in preview.stdout

            inspect = spawn(launcher, cwd, env, ['inspect', '--json'])
            assert inspect.returncode == 0, inspect.stderr
            payload = json.loads(inspect.stdout)
            settings = {row['key']: row for row in payload['settings']}
            assert payload['telemetry'] is True
            assert payload['feedback'] is True
            assert payload['traceUpload'] is False
            assert payload['shareContent'] is True
            assert payload['shareSession'] is False
            assert settings['features.telemetry']['source'] == 'opt-in'
            assert settings['features.feedback']['source'] == 'opt-in'
            assert settings['privacy.share_content']['value'] == 'true'
            assert settings['features.trace_upload']['source'] == 'refused-official-endpoint'
            assert 'privacyBoundary' in payload
            assert secret not in inspect.stdout
            assert 'api.x.ai' not in inspect.stdout

            saved = spawn(launcher, cwd, env, [
                'feedback', 'save', '--session', 'pty-1', '--title', 'Fold bug',
                '--details', f'The fold hid the prompt. token={secret}', '--type', 'bug'])
            assert saved.returncode == 0, saved.stderr
            assert 'Not sent' in saved.stdout
            draft_id = saved.stdout.split()[3]
            listed = spawn(launcher, cwd, env, ['feedback', 'list', '--session', 'pty-1'])
            assert draft_id in listed.stdout
            failed = spawn(launcher, cwd, env, ['feedback', 'submit', '--session', 'pty-1', '--id', draft_id])
            assert failed.returncode != 0
            assert 'kept' in (failed.stderr + failed.stdout).lower() or 'HTTP 500' in (failed.stderr + failed.stdout)
            still = spawn(launcher, cwd, env, ['feedback', 'show', '--session', 'pty-1', '--id', draft_id])
            assert still.returncode == 0, still.stderr
            assert secret in still.stdout
            edited = spawn(launcher, cwd, env, [
                'feedback', 'edit', '--session', 'pty-1', '--id', draft_id,
                '--title', 'Fold bug edited', '--details', 'Still local after failure.',
                '--area', 'composer'])
            assert edited.returncode == 0, edited.stderr
            assert 'Not sent' in edited.stdout
            (grok / 'config.toml').write_text((grok / 'config.toml').read_text().replace(
                sink.url('/feedback'), ok.url('/feedback')))
            submitted = spawn(launcher, cwd, env, ['feedback', 'submit', '--session', 'pty-1', '--id', draft_id])
            assert submitted.returncode == 0, submitted.stderr + submitted.stdout
            assert 'submitted' in submitted.stdout
            gone = spawn(launcher, cwd, env, ['feedback', 'show', '--session', 'pty-1', '--id', draft_id])
            assert gone.returncode != 0
            wire = ''.join(ok.bodies)
            assert 'structured_feedback' in wire
            assert 'Still local after failure' in wire
            assert secret not in wire
            assert 'test-key-not-logged' not in wire
            failed_wire = ''.join(sink.bodies)
            assert 'token=' in failed_wire
            assert 'Still local after failure' not in failed_wire
            assert secret not in ''.join(ok.bodies)
            deleted_again = spawn(launcher, cwd, env, ['feedback', 'delete', '--session', 'pty-1', '--id', draft_id])
            assert deleted_again.returncode != 0

            again = spawn(launcher, cwd, env, [
                'feedback', 'save', '--session', 'pty-1', '--title', 'Keep me',
                '--details', 'Explicit delete only.'])
            kept_id = again.stdout.split()[3]
            removed = spawn(launcher, cwd, env, ['feedback', 'delete', '--session', 'pty-1', '--id', kept_id])
            assert removed.returncode == 0, removed.stderr
            assert 'deleted' in removed.stdout

            minimal = Session('privacy-minimal', launcher, cwd, env, output, extra=['--minimal'], cols=80, rows=24)
            try:
                minimal.wait_visible('Draft (not sent)')
                minimal.write(b'/feedback save --title PTY --details Local draft from the composer\r')
                shown = minimal.wait_visible('Not sent')
                assert 'Local draft from the composer' not in ''.join(ok.bodies)
                assert 'sk-' not in shown
            finally:
                summary = minimal.finish(expect_alt_leave=False)
                minimal.close()
            assert summary['exit'] == 0

            log = home / '.codsh-rust' / 'dsh' / 'privacy.log'
            assert log.is_file(), 'GROK_DEBUG_LOG did not create a local counter log'
            log_text = log.read_text()
            assert '"kind":"feedback_draft_save"' in log_text
            assert secret not in log_text
            (output / 'summary.json').write_text(json.dumps({
                'preview': True,
                'traceRefused': settings['features.trace_upload']['source'],
                'submitStatus': submitted.returncode,
                'minimalExit': summary['exit'],
                'telemetryBodies': len(ok.bodies),
                'failedBodies': len(sink.bodies),
            }, indent=2) + '\n')
            print(json.dumps({'ok': True, 'output': str(output)}))
    finally:
        sink.close()
        ok.close()


if __name__ == '__main__':
    main()
