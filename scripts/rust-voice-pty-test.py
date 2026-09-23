#!/usr/bin/env python3
"""Installed-product PTY: explicit voice dictation into the draft, not a submit."""
import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    'rust_resume_pty_test', ROOT / 'scripts' / 'rust-resume-pty-test.py')
resume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resume)
screen_spec = importlib.util.spec_from_file_location(
    'rust_screen_pty_test', ROOT / 'scripts' / 'rust-screen-pty-test.py')
screen = importlib.util.module_from_spec(screen_spec)
screen_spec.loader.exec_module(screen)
prompt_spec = importlib.util.spec_from_file_location(
    'rust_prompt_pty_test', ROOT / 'scripts' / 'rust-prompt-pty-test.py')
prompt = importlib.util.module_from_spec(prompt_spec)
prompt_spec.loader.exec_module(prompt)
Session = screen.Session
pack_install = prompt.pack_install
overlay_text = resume.overlay_text
dsh_bin = resume.dsh_bin
NODE = resume.NODE


class Stt(BaseHTTPRequestHandler):
    seen = []
    body = b'{"text":"fixture words"}'
    status = 200

    def log_message(self, _format, *_args):
        return

    def do_POST(self):
        length = int(self.headers.get('content-length', '0'))
        payload = self.rfile.read(length)
        Stt.seen.append({
            'path': self.path,
            'language': b'name="language"' in payload,
            'zh': b'\r\nzh\r\n' in payload or payload.endswith(b'zh\r\n') or b'\nzh\r\n' in payload,
            'audio': b'RIFFvoice-fixture' in payload,
            'auth': self.headers.get('authorization', ''),
            'host': self.headers.get('host', ''),
        })
        body = Stt.body
        self.send_response(Stt.status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Stt)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-voice-', dir='/tmp'))
    server = serve()
    host, port = server.server_address
    base = f'http://{host}:{port}/v1'
    try:
        with tempfile.TemporaryDirectory(prefix='codsh-rust-voice-home-', dir='/tmp') as temporary:
            work = Path(temporary)
            home = work / 'home'
            home.mkdir()
            cwd = work / 'workspace'
            cwd.mkdir()
            grok = home / '.codsh-rust' / '.grok'
            grok.mkdir(parents=True)
            (grok / 'config.toml').write_text(
                '[ui]\nvoice_capture_mode = "toggle"\nvoice_keybind_enabled = true\n'
                'voice_stt_language = "zh"\n'
                '[voice]\nlanguage = "en"\napi_base = "%s"\nenv_key = "CODSH_STT_KEY"\n'
                'sample_rate = 16000\n[features]\nvoice_mode = true\n' % base
            )
            fixture = work / 'clip.bin'
            fixture.write_bytes(b'RIFFvoice-fixture')
            launcher = pack_install(work, home)
            patch = work / 'overlay.yml'
            patch.write_text(overlay_text())
            env = {
                'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
                'DSH_BIN': dsh_bin(), 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
                'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
                'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
                'DSH_CODE_CLI_MOCK_TOOL': 'echo',
                'CODSH_STT_KEY': 'fixture-stt-key',
                'CODSH_VOICE_FIXTURE': str(fixture),
                'CODSH_VOICE_DEVICES': 'MacBook Pro Microphone|0\npermission=granted\n',
            }
            doctor = resume.run(
                [NODE, str(launcher), '--rust', 'voice', 'doctor', '--json'],
                cwd=cwd, env=env,
            )
            report = json.loads(doctor.stdout)
            assert report['recording'] is False, report
            assert report['finding'] is None, report
            assert report['devices'], report
            assert 'MacBook Pro Microphone' in doctor.stdout

            session = Session('voice-dictation', launcher, cwd, env, output, extra=['--fullscreen'])
            try:
                session.wait_visible('Connected to dsh ACP', 25)
                session.write('KEEP')
                session.wait_visible('KEEP')
                before = prompt.answer_lines(session.visible())
                session.write('/voice\r')
                shown = session.wait_visible('recording', 10)
                assert 'not submitted' in shown or '127.0.0.1' in shown, shown
                assert 'KEEP' in shown
                assert len(prompt.answer_lines(shown)) == len(before)
                session.write('/voice stop\r')
                shown = session.wait_visible('fixture words', 15)
                draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
                assert 'KEEP' in draft and 'fixture words' in draft, shown
                assert len(prompt.answer_lines(shown)) == len(before)
                assert Stt.seen, 'substitute server received nothing'
                posted = Stt.seen[-1]
                assert posted['path'] == '/v1/audio/transcriptions', posted
                assert posted['language'] and posted['zh'], posted
                assert posted['audio'], posted
                assert posted['auth'] == 'Bearer fixture-stt-key', posted
                assert 'api.x.ai' not in posted['host']

                session.write('x')
                session.pump(0.2)
                changed = session.visible()
                assert 'KEEPx' in changed or changed.count('x') >= 1
                stale = len(Stt.seen)
                Stt.body = b'{"text":"late words"}'
                session.write('/voice\r')
                session.wait_visible('recording', 10)
                session.write('/voice cancel\r')
                session.pump(0.4)
                shown = session.visible()
                assert 'late words' not in shown, shown
                assert 'voice cancelled' in shown, shown
                assert len(prompt.answer_lines(shown)) == len(before)
                assert len(Stt.seen) == stale, Stt.seen

                session.write('\x03')
                session.write('/voice doctor\r')
                shown = session.wait_visible('recording false', 10)
                assert 'recording false' in shown, shown
                assert 'MacBook Pro Microphone' in shown, shown
                assert len(prompt.answer_lines(shown)) == len(before)
            finally:
                session.finish(expect_alt_leave=True)
                session.close()

            slash = Session('voice-slash', launcher, cwd, env, output, extra=['--fullscreen'])
            try:
                # Typing "/" while recording parks the draft. Enter on another
                # slash command must put that draft back. Esc must not say the
                # draft is unchanged while the box shows only "/".
                Stt.body = b'{"text":"slash words"}'
                slash.wait_visible('Connected to dsh ACP', 25)
                slash.write('KEEP')
                slash.wait_visible('KEEP')
                slash.write('/voice\r')
                shown = slash.wait_visible('recording', 10)
                assert 'KEEP' in shown, shown
                slash.write('/')
                slash.pump(0.3)
                parked = slash.visible()
                assert 'slash completion' in parked, parked
                slash.write('compact\r')
                slash.pump(0.8)
                shown = slash.visible()
                assert 'KEEP' in shown, shown
                assert 'slash completion' not in shown, shown
                slash.write('\x1b')
                slash.pump(0.5)
                shown = slash.visible()
                assert 'KEEP' in shown, shown
                assert 'slash words' not in shown, shown
                tail = shown.split('KEEP')[-1]
                assert not tail.strip().startswith('/'), shown
            finally:
                slash.finish(expect_alt_leave=True)
                slash.close()

            disabled = dict(env)
            disabled['GROK_VOICE_MODE'] = 'false'
            quiet = Session('voice-disabled', launcher, cwd, disabled, output, extra=['--fullscreen'])
            try:
                quiet.wait_visible('Connected to dsh ACP', 25)
                quiet.write('/voice\r')
                shown = quiet.wait_visible('voice mode is off', 10)
                assert 'recording (' not in shown, shown
            finally:
                quiet.finish(expect_alt_leave=True)
                quiet.close()
    finally:
        server.shutdown()
    print(f'voice pty ok {output}')


if __name__ == '__main__':
    main()
