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
share_content = false
share_session = true

[endpoints]
telemetry_url = "{ok.url('/telemetry')}"
feedback_base_url = "{sink.url('/feedback')}"
trace_upload_url = "{ok.url('/traces')}"
""")
            env = {
                'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
                'COLORTERM': 'truecolor',
                'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
                'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
                'CODSH_UPDATE_CHECK': 'off', 'XAI_API_KEY': 'test-key-not-logged',
                'GROK_DEBUG_LOG': '1',
                'GROK_USER_METADATA': '{"structured_feedback":{"type":"idea"},"client":"codsh-pty"}',
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
            assert payload['shareContent'] is False
            assert payload['shareSession'] is True
            assert payload['traceUpload'] is True
            assert settings['features.telemetry']['source'] == 'opt-in'
            assert settings['features.feedback']['source'] == 'opt-in'
            assert settings['privacy.share_content']['value'] == 'false'
            assert settings['privacy.share_session']['value'] == 'true'
            assert settings['features.trace_upload']['source'] == 'opt-in'
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
            wire = ''.join(body for body in ok.bodies if 'structured_feedback' in body)
            assert 'structured_feedback' in wire
            assert 'redacted' in wire
            assert '"client":"codsh-pty"' in wire
            assert '"type":"idea"' not in wire
            assert '"type":"bug"' in wire
            assert 'Still local after failure' not in wire
            assert secret not in wire
            assert 'test-key-not-logged' not in ''.join(ok.bodies)
            failed_wire = ''.join(sink.bodies)
            assert 'redacted' in failed_wire
            assert secret not in failed_wire
            assert 'token=' not in failed_wire
            trace_wire = ''.join(body for body in ok.bodies if '"kind":"feedback_draft_op"' in body or '"kind":"feedback_submit"' in body)
            assert 'pty-1' in trace_wire
            assert secret not in trace_wire
            deleted_again = spawn(launcher, cwd, env, ['feedback', 'delete', '--session', 'pty-1', '--id', draft_id])
            assert deleted_again.returncode != 0

            again = spawn(launcher, cwd, env, [
                'feedback', 'save', '--session', 'pty-1', '--title', 'Keep me',
                '--details', 'Explicit delete only.'])
            kept_id = again.stdout.split()[3]
            removed = spawn(launcher, cwd, env, ['feedback', 'delete', '--session', 'pty-1', '--id', kept_id])
            assert removed.returncode == 0, removed.stderr
            assert 'deleted' in removed.stdout

            shared = (grok / 'config.toml').read_text().replace(
                'share_content = false', 'share_content = true', 1)
            (grok / 'config.toml').write_text(shared)
            shared_save = spawn(launcher, cwd, env, [
                'feedback', 'save', '--session', 'pty-share', '--title', 'Shared fold',
                '--details', 'Included because share_content is on.',
                '--task-category', 'debug'])
            assert shared_save.returncode == 0, shared_save.stderr
            shared_id = shared_save.stdout.split()[3]
            before_shared = len(ok.bodies)
            shared_submit = spawn(launcher, cwd, env, [
                'feedback', 'submit', '--session', 'pty-share', '--id', shared_id])
            assert shared_submit.returncode == 0, shared_submit.stderr + shared_submit.stdout
            assert 'draft text included' in shared_submit.stdout
            shared_wire = ''.join(ok.bodies[before_shared:])
            assert 'Included because share_content is on.' in shared_wire
            assert '"task_category":"debug"' in shared_wire
            assert secret not in shared_wire
            (grok / 'config.toml').write_text(shared.replace(
                'share_content = true', 'share_content = false', 1).replace(
                ok.url('/feedback'), sink.url('/feedback')))

            before_form = len(ok.bodies)
            minimal = Session('privacy-minimal', launcher, cwd, env, output, extra=['--minimal'], cols=80, rows=24)
            try:
                minimal.wait_visible('Draft (not sent)')
                minimal.write(b'/feedback\r')
                minimal.wait_visible('tab=Write')
                minimal.write(b'PTY fold')
                minimal.write(b'\x1b[B')
                minimal.write(b'composer hid the prompt')
                minimal.write(b'\r')
                failed_form = minimal.wait_visible('HTTP 500')
                assert 'tab=Drafts' in failed_form
                sink_before = len(sink.bodies)
                minimal.write(b'e')
                minimal.wait_visible('edit title')
                minimal.write(b'!\r')
                minimal.wait_visible('Not sent')
                minimal.write(b'\r')
                retried = minimal.wait_visible('HTTP 500')
                assert 'tab=Drafts' in retried
                minimal.write(b'x')
                deleted = minimal.wait_visible('deleted local draft')
                minimal.write(b'\x1b')
                closed = minimal.wait_visible('Draft (not sent)')
                assert 'tab=Write' not in closed
                assert secret not in closed
                assert 'composer hid the prompt' not in deleted
            finally:
                summary = minimal.finish(expect_alt_leave=False)
                minimal.close()
            assert summary['exit'] == 0
            form_failed = ''.join(sink.bodies[sink_before:])
            assert 'redacted' in form_failed
            assert secret not in form_failed
            assert 'composer hid the prompt' not in form_failed
            assert 'Included because share_content is on.' not in form_failed
            assert secret not in ''.join(ok.bodies[before_form:])
            immediate_before = len(sink.bodies)
            fullscreen = Session('privacy-fullscreen', launcher, cwd, env, output, cols=80, rows=24)
            try:
                fullscreen.wait_visible('Draft (not sent)')
                fullscreen.write(b'/feedback The fold hid the prompt\r')
                sent_text = fullscreen.wait_visible('HTTP 500')
                assert 'unsupported feedback command' not in sent_text
                fullscreen.write(b'\x1b')
                fullscreen.wait_visible('Draft (not sent)')
            finally:
                full_summary = fullscreen.finish(expect_alt_leave=True)
                fullscreen.close()
            assert full_summary['exit'] == 0
            immediate = ''.join(sink.bodies[immediate_before:])
            assert 'The fold hid the prompt' not in immediate
            assert 'redacted' in immediate

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
