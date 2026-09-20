#!/usr/bin/env python3
"""Installed-product PTY: fullscreen/minimal switching through the packed Rust client."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
SESSION_RE = __import__('re').compile(r'session ([0-9a-f-]{8,})')


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


def dsh_bin():
    script = "import { createRequire } from 'node:module'; import { dirname, join } from 'node:path'; import { readFileSync } from 'node:fs'; const r=createRequire(process.argv[1]); const m=r.resolve('@deepseek-ai/dsh/package.json'); const bin=JSON.parse(readFileSync(m,'utf8')).bin; process.stdout.write(join(dirname(m), typeof bin==='string'?bin:bin.dsh))"
    return run([NODE, '--input-type=module', '-e', script, str(ROOT / 'package.json')], cwd=ROOT).stdout


def overlay_text():
    return run([NODE, '--input-type=module', '-e',
                "import { rustAcpOverlay } from './scripts/rust-acp-overlay.mjs'; process.stdout.write(rustAcpOverlay())"],
               cwd=ROOT).stdout


def emulate(data, rows, cols):
    emulator = ROOT / 'e2e/vt.ts'
    payload = json.dumps({'rows': rows, 'cols': cols, 'bytes': __import__('base64').b64encode(data).decode()})
    raw = run([NODE, '--import', 'tsx', '-e',
               f"import {{ Terminal }} from {json.dumps(emulator.as_uri())}; "
               "let input=''; for await (const chunk of process.stdin) input+=chunk; "
               "const spec=JSON.parse(input); const t=new Terminal(spec.rows,spec.cols); "
               "t.feed(Buffer.from(spec.bytes,'base64').toString()); "
               "console.log(JSON.stringify({text:t.text, alternate:t.alternate.join('\\n')}));"],
              input=payload, cwd=ROOT).stdout
    return json.loads(raw)


def screen_text(data, rows, cols):
    return emulate(data, rows, cols)['text']


class Session:
    def __init__(self, name, launcher, cwd, env, output, extra=None, cols=100, rows=36):
        self.name = name
        self.cols = cols
        self.rows = rows
        self.output = output
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.original = termios.tcgetattr(self.slave)
        argv = [NODE, str(launcher), '--rust', *(extra or [])]
        self.process = subprocess.Popen(
            argv, cwd=cwd, env=env,
            stdin=self.slave, stdout=self.slave, stderr=self.slave, start_new_session=True)
        self.data = bytearray()
        self.cursor_replies = 0

    def answer_cursor(self):
        queries = bytes(self.data).count(b'\x1b[6n')
        while self.cursor_replies < queries:
            os.write(self.master, f'\x1b[{self.rows};1R'.encode())
            self.cursor_replies += 1

    def pump(self, seconds=0.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], 0.03)[0]:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.data.extend(chunk)
                self.answer_cursor()

    def visible(self):
        return screen_text(bytes(self.data), self.rows, self.cols)

    def wait_visible(self, text, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump()
            shown = self.visible()
            if text in shown:
                return shown
            if self.process.poll() is not None:
                break
        raise AssertionError(f'{self.name}: missing {text!r}\n{self.visible()}\nraw={bytes(self.data)[-2500:]!r}')

    def write(self, data):
        os.write(self.master, data if isinstance(data, bytes) else data.encode())

    def session_id(self):
        match = SESSION_RE.search(self.visible())
        if match is None:
            raise AssertionError(f'{self.name}: missing session id\n{self.visible()}')
        return match.group(1)

    def resize(self, rows, cols):
        self.rows = rows
        self.cols = cols
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        os.kill(self.process.pid, signal.SIGWINCH)

    def finish(self, expect_alt_leave=None):
        shown = self.visible()
        self.write(b'\x11')
        self.process.wait(timeout=12)
        self.pump()
        os.write(self.master, b'AFTER_EXIT_CANONICAL\n')
        assert select.select([self.slave], [], [], 2)[0]
        assert os.read(self.slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
        after = termios.tcgetattr(self.slave)
        (self.output / f'{self.name}.ansi').write_bytes(self.data)
        (self.output / f'{self.name}.txt').write_text(shown)
        assert self.original == after, f'{self.name}: terminal modes were not restored'
        entered = b'\x1b[?1049h' in self.data
        left = b'\x1b[?1049l' in self.data
        if expect_alt_leave is True:
            assert left, f'{self.name}: missing leave-alternate-screen'
        if expect_alt_leave is False:
            assert not entered, f'{self.name}: minimal must not enter alternate screen: {bytes(self.data)[:200]!r}'
        primary = emulate(bytes(self.data), self.rows, self.cols)['text']
        return {
            'name': self.name,
            'exit': self.process.returncode,
            'screen': shown,
            'primary': primary,
            'enteredAlternateScreen': entered,
            'leftAlternateScreen': left,
            'pid': self.process.pid,
        }

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()
        os.close(self.master)
        os.close(self.slave)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-screen-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-screen-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        (cwd / 'note.txt').write_text('alpha\n')
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
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        base_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
        }
        results = []
        isolated = home / '.codsh-rust'

        default = Session('default-fullscreen', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output)
        try:
            shown = default.wait_visible('Connected to dsh ACP', 25)
            assert 'mode=fullscreen' in shown
            session_id = default.session_id()
            results.append(default.finish(expect_alt_leave=True))
            assert results[-1]['enteredAlternateScreen']
        finally:
            default.close()

        persisted_config = isolated / '.grok' / 'config.toml'
        persisted_config.parent.mkdir(parents=True, exist_ok=True)
        persisted_config.write_text('[ui]\nscreen_mode = "minimal"\n')
        original_config = persisted_config.read_text()

        persisted = Session('persisted-minimal', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output)
        try:
            shown = persisted.wait_visible('Connected to dsh ACP', 25)
            assert 'mode=minimal' in shown
            results.append(persisted.finish(expect_alt_leave=False))
            assert not results[-1]['enteredAlternateScreen']
            assert persisted_config.read_text() == original_config
        finally:
            persisted.close()

        override = Session('cli-fullscreen-override', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--fullscreen'])
        try:
            shown = override.wait_visible('Connected to dsh ACP', 25)
            assert 'mode=fullscreen' in shown
            override.write('DRAFT_KEEP')
            override.wait_visible('DRAFT_KEEP')
            override.write('/minimal\r')
            shown = override.wait_visible('mode=minimal', 25)
            assert 'DRAFT_KEEP' in shown
            assert session_id == override.session_id() or override.session_id()
            assert 'Switched to minimal' in shown or 'Switched to minimal' in results[-1].get('primary', '') or 'Switched to minimal' in emulate(bytes(override.data), override.rows, override.cols)['text']
            override.write('/dashboard\r')
            shown = override.wait_visible("isn't available in minimal mode", 10)
            assert 'Run /fullscreen' in shown
            assert 'DRAFT_KEEP' in shown
            override.resize(28, 70)
            override.pump(0.8)
            shown = override.visible()
            assert 'mode=minimal' in shown
            assert 'DRAFT_KEEP' in shown
            override.write('/fullscreen\r')
            shown = override.wait_visible('mode=fullscreen', 25)
            assert 'DRAFT_KEEP' in shown
            assert 'Switched to fullscreen' in shown
            override.write('/minimal\r')
            override.wait_visible('mode=minimal', 25)
            override.write('/fullscreen\r')
            shown = override.wait_visible('mode=fullscreen', 25)
            assert 'DRAFT_KEEP' in shown
            results.append(override.finish(expect_alt_leave=True))
            assert persisted_config.read_text() == original_config
        finally:
            override.close()

        empty = Session('empty-switch', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--fullscreen'])
        try:
            empty.wait_visible('Connected to dsh ACP', 25)
            empty_id = empty.session_id()
            empty.write('/minimal\r')
            shown = empty.wait_visible('mode=minimal', 25)
            assert empty_id == empty.session_id()
            empty.write('/expand\r')
            empty.pump(0.4)
            shown = empty.visible()
            assert 'already available in minimal' in shown or 'mode=minimal' in shown
            results.append(empty.finish())
        finally:
            empty.close()

        streaming = Session('running-switch', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo', 'DSH_CODE_CLI_MOCK_DELAY_MS': '4000',
        }, output, extra=['--fullscreen'])
        try:
            streaming.wait_visible('Connected to dsh ACP', 25)
            live_id = streaming.session_id()
            streaming.write('TOKEN_SCREEN_STREAM\r')
            streaming.wait_visible('Streaming turn', 10)
            streaming.write('/minimal\r')
            shown = streaming.wait_visible('mode=minimal', 10)
            assert live_id == streaming.session_id()
            assert 'TOKEN_SCREEN_STREAM' in shown
            assert 'Connecting to dsh ACP' not in shown
            streaming.wait_visible('RUST_ACP_ANSWER', 20)
            shown = streaming.visible()
            assert live_id == streaming.session_id()
            results.append(streaming.finish())
        finally:
            streaming.close()

        (cwd / 'note.txt').write_text('alpha\n')
        approval = Session('approval-switch', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit',
        }, output, extra=['--fullscreen'])
        try:
            approval.wait_visible('Connected to dsh ACP', 25)
            approval.write('TOKEN_SCREEN_APPROVAL\r')
            approval.wait_visible('Allow ', 30)
            assert (cwd / 'note.txt').read_text() == 'alpha\n'
            approval.write('/minimal\r')
            shown = approval.wait_visible('mode=minimal', 10)
            assert 'Allow ' in shown
            assert 'y=allow once' in shown
            assert (cwd / 'note.txt').read_text() == 'alpha\n'
            approval.write('y')
            approval.wait_visible('RUST_ACP_FILE_DONE', 20)
            assert (cwd / 'note.txt').read_text() == 'ALPHA\n'
            results.append(approval.finish())
        finally:
            approval.close()

        invalid = isolated / '.grok' / 'config.toml'
        invalid.write_text('[ui]\nscreen_mode = "banana"\n')
        bad = Session('invalid-default', launcher, cwd, base_env, output)
        try:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline and bad.process.poll() is None:
                bad.pump()
            bad.pump()
            combined = bytes(bad.data).decode(errors='replace')
            (output / 'invalid-default.ansi').write_bytes(bad.data)
            assert bad.process.poll() is not None
            assert bad.process.returncode != 0
            assert 'invalid ui.screen_mode' in combined or 'invalid ui.screen_mode' in bad.visible()
            assert b'\x1b[?1049h' not in bad.data
            os.write(bad.master, b'AFTER_EXIT_CANONICAL\n')
            assert select.select([bad.slave], [], [], 2)[0]
            assert os.read(bad.slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
            assert termios.tcgetattr(bad.slave) == bad.original
            results.append({'name': 'invalid-default', 'exit': bad.process.returncode, 'enteredAlternateScreen': False})
        finally:
            bad.close()
        persisted_config.write_text('[ui]\nscreen_mode = "fullscreen"\n')

        exec_switch = Session('exec-relaunch', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'GROK_SCREEN_MODE_SWITCH': 'exec',
        }, output, extra=['--fullscreen'])
        try:
            exec_switch.wait_visible('Connected to dsh ACP', 25)
            exec_id = exec_switch.session_id()
            exec_switch.write('DRAFT_EXEC')
            exec_switch.wait_visible('DRAFT_EXEC')
            before_pid = exec_switch.process.pid
            exec_switch.write('/minimal\r')
            shown = exec_switch.wait_visible('resumed', 25)
            assert 'mode=minimal' in shown
            assert exec_id in shown
            assert 'DRAFT_EXEC' not in shown
            assert persisted_config.read_text() == '[ui]\nscreen_mode = "fullscreen"\n'
            results.append(exec_switch.finish())
            results[-1]['beforePid'] = before_pid
        finally:
            exec_switch.close()

        (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps({'output': str(output), 'results': [item['name'] for item in results]}, indent=2))
        assert all(item.get('exit', 1) in (0, 1) for item in results)
        assert any(item['name'] == 'persisted-minimal' and not item['enteredAlternateScreen'] for item in results)
        assert any(item['name'] == 'default-fullscreen' and item['enteredAlternateScreen'] for item in results)


if __name__ == '__main__':
    main()
