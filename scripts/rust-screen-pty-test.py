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
               "console.log(JSON.stringify({"
               "text:t.text, primary:t.primary.join('\\n'), alternate:t.alternate.join('\\n'), "
               "onAlternate:t.onAlternate}));"],
              input=payload, cwd=ROOT).stdout
    return json.loads(raw)


def screen_text(data, rows, cols):
    return emulate(data, rows, cols)['text']


def alt_enter_count(data):
    return bytes(data).count(b'\x1b[?1049h')


def alt_leave_count(data):
    return bytes(data).count(b'\x1b[?1049l')


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

    def send_slash(self, command):
        # `/` on a nonempty draft stashes that draft, runs the command, and
        # restores it. Do not Ctrl+C: that would discard the unsaved text.
        self.write(command if command.endswith('\r') else command + '\r')

    def current_text(self):
        snap = self.snapshot()
        return '\n'.join([snap['text'], snap['primary']])

    def session_id(self):
        blob = self.current_text()
        match = SESSION_RE.search(blob)
        if match is None:
            raise AssertionError(f'{self.name}: missing session id\n{blob}')
        return match.group(1)

    def wait_session(self, session_id, seconds=10):
        needle = f'session {session_id}'
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump()
            blob = self.current_text()
            if needle in blob:
                return blob
            if self.process.poll() is not None:
                break
        raise AssertionError(
            f'{self.name}: missing live session {session_id}\n{self.current_text()}\n'
            f'raw={bytes(self.data)[-2500:]!r}'
        )

    def snapshot(self):
        emu = emulate(bytes(self.data), self.rows, self.cols)
        emu['entered'] = alt_enter_count(self.data)
        emu['left'] = alt_leave_count(self.data)
        return emu

    def assert_native_minimal(self, *history, leaves_before=0):
        snap = self.snapshot()
        assert snap['left'] > leaves_before, (
            f'{self.name}: missing CSI ?1049l at switch (before={leaves_before} after={snap["left"]})'
        )
        assert not snap['onAlternate'], (
            f'{self.name}: still on alternate screen after /minimal\n'
            f'primary={snap["primary"]!r}\nalternate={snap["alternate"]!r}'
        )
        for marker in history:
            assert marker in snap['primary'], (
                f'{self.name}: missing native history {marker!r} in primary\n{snap["primary"]}'
            )
        return snap

    def resize(self, rows, cols):
        self.rows = rows
        self.cols = cols
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        os.kill(self.process.pid, signal.SIGWINCH)

    def finish(self, expect_alt_leave=None):
        shown = self.visible()
        self.write(b'\x11')
        deadline = time.monotonic() + 12
        while self.process.poll() is None:
            if time.monotonic() > deadline:
                self.kill_group()
                raise TimeoutError(
                    f'{self.name}: quit hung after Ctrl+Q; unanswered CSI 6n queries='
                    f'{bytes(self.data).count(b"\x1b[6n") - self.cursor_replies}'
                )
            self.pump(0.15)
        self.pump(0.2)
        os.write(self.master, b'AFTER_EXIT_CANONICAL\n')
        assert select.select([self.slave], [], [], 2)[0]
        assert os.read(self.slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
        after = termios.tcgetattr(self.slave)
        (self.output / f'{self.name}.ansi').write_bytes(self.data)
        (self.output / f'{self.name}.txt').write_text(shown)
        assert self.original == after, f'{self.name}: terminal modes were not restored'
        snap = emulate(bytes(self.data), self.rows, self.cols)
        entered = alt_enter_count(self.data)
        left = alt_leave_count(self.data)
        if expect_alt_leave is True:
            assert left, f'{self.name}: missing leave-alternate-screen'
            assert not snap['onAlternate'], f'{self.name}: still on alternate screen after exit'
        if expect_alt_leave is False:
            assert not entered, f'{self.name}: minimal must not enter alternate screen: {bytes(self.data)[:200]!r}'
            assert not snap['onAlternate'], f'{self.name}: minimal painted the alternate screen'
        return {
            'name': self.name,
            'exit': self.process.returncode,
            'screen': shown,
            'primary': snap['primary'],
            'alternate': snap['alternate'],
            'onAlternate': snap['onAlternate'],
            'enteredAlternateScreen': bool(entered),
            'leftAlternateScreen': bool(left),
            'altEnterCount': entered,
            'altLeaveCount': left,
            'pid': self.process.pid,
        }

    def kill_group(self):
        if self.process.poll() is not None:
            return
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            self.process.terminate()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                self.process.kill()
            self.process.wait(timeout=2)

    def close(self):
        self.kill_group()
        for fd in (self.master, self.slave):
            try:
                os.close(fd)
            except OSError:
                pass


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
            live = default.snapshot()
            assert live['onAlternate'], f'default-fullscreen must use alternate screen\n{live["text"]}'
            results.append(default.finish(expect_alt_leave=True))
            assert results[-1]['enteredAlternateScreen']
            assert results[-1]['altLeaveCount'] >= 1
            assert 'mode=fullscreen' not in results[-1]['primary']
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
            live = persisted.snapshot()
            assert not live['onAlternate'], f'persisted-minimal used alternate screen\n{live["alternate"]}'
            assert live['entered'] == 0
            assert 'mode=minimal' in live['primary']
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
            assert override.snapshot()['onAlternate']
            override_id = override.session_id()
            override.write('DRAFT_KEEP')
            override.wait_visible('DRAFT_KEEP')
            leaves_before = alt_leave_count(override.data)
            override.send_slash('/minimal')
            shown = override.wait_visible('Switched to minimal', 25)
            shown = override.wait_visible('DRAFT_KEEP')
            assert 'DRAFT_KEEP' in shown
            assert override.session_id() == override_id
            override.assert_native_minimal('Switched to minimal', leaves_before=leaves_before)
            override.send_slash('/dashboard')
            shown = override.wait_visible('Run /fullscreen', 10)
            shown = override.wait_visible('DRAFT_KEEP')
            assert 'Run /fullscreen' in shown
            assert 'DRAFT_KEEP' in shown
            override.resize(28, 70)
            override.pump(0.8)
            shown = override.visible()
            assert 'mode=minimal' in shown
            assert 'DRAFT_KEEP' in shown
            assert not override.snapshot()['onAlternate']
            override.send_slash('/fullscreen')
            shown = override.wait_visible('mode=fullscreen', 25)
            shown = override.wait_visible('DRAFT_KEEP')
            assert 'DRAFT_KEEP' in shown
            assert 'Switched to fullscreen' in shown
            assert override.snapshot()['onAlternate']
            assert override.session_id() == override_id
            override.send_slash('/minimal')
            override.wait_visible('mode=minimal', 25)
            override.wait_visible('DRAFT_KEEP')
            override.assert_native_minimal('Switched to minimal')
            override.send_slash('/fullscreen')
            shown = override.wait_visible('mode=fullscreen', 25)
            shown = override.wait_visible('DRAFT_KEEP')
            assert 'DRAFT_KEEP' in shown
            assert override.session_id() == override_id
            results.append(override.finish(expect_alt_leave=True))
            assert 'Switched to minimal' in results[-1]['primary']
            assert persisted_config.read_text() == original_config
        finally:
            override.close()

        empty = Session('empty-switch', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--fullscreen'])
        try:
            empty.wait_visible('Connected to dsh ACP', 25)
            empty_id = empty.session_id()
            leaves_before = alt_leave_count(empty.data)
            empty.send_slash('/minimal')
            shown = empty.wait_visible('mode=minimal', 25)
            assert empty_id == empty.session_id()
            empty.assert_native_minimal('Switched to minimal', leaves_before=leaves_before)
            empty.write('/expand\r')
            shown = empty.wait_visible('no folded block to expand', 10)
            assert 'no folded block to expand' in shown
            assert empty_id == empty.session_id()
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
            leaves_before = alt_leave_count(streaming.data)
            streaming.send_slash('/minimal')
            shown = streaming.wait_visible('mode=minimal', 10)
            assert live_id == streaming.session_id()
            assert 'TOKEN_SCREEN_STREAM' in shown
            assert 'Connecting to dsh ACP' not in shown
            streaming.assert_native_minimal('Switched to minimal', leaves_before=leaves_before)
            live_pid = streaming.process.pid
            streaming.wait_visible('RUST_ACP_ANSWER', 20)
            shown = streaming.wait_session(live_id, 10)
            assert streaming.process.poll() is None
            assert streaming.process.pid == live_pid
            assert live_id == streaming.session_id()
            snap = streaming.snapshot()
            assert not snap['onAlternate']
            assert 'TOKEN_SCREEN_STREAM' in snap['primary']
            assert 'RUST_ACP_ANSWER' in snap['primary']
            assert f'session {live_id}' in shown or f'session {live_id}' in snap['primary']
            results.append(streaming.finish())
        finally:
            streaming.close()

        (cwd / 'note.txt').write_text('alpha\n')
        approval = Session('approval-switch', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit',
        }, output, extra=['--fullscreen'])
        try:
            approval.wait_visible('Connected to dsh ACP', 25)
            approval_id = approval.session_id()
            approval.write('TOKEN_SCREEN_APPROVAL\r')
            approval.wait_visible('Allow ', 30)
            assert (cwd / 'note.txt').read_text() == 'alpha\n'
            leaves_before = alt_leave_count(approval.data)
            approval.send_slash('/minimal')
            shown = approval.wait_visible('mode=minimal', 10)
            assert approval.session_id() == approval_id
            assert 'Allow ' in shown
            assert 'y=allow once' in shown
            assert (cwd / 'note.txt').read_text() == 'alpha\n'
            approval.assert_native_minimal(leaves_before=leaves_before)
            approval.write('y')
            approval.wait_visible('RUST_ACP_FILE_DONE', 20)
            assert (cwd / 'note.txt').read_text() == 'ALPHA\n'
            assert approval.session_id() == approval_id
            results.append(approval.finish())
        finally:
            approval.close()

        stash = Session('aborted-slash-stash', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--fullscreen'])
        try:
            stash.wait_visible('Connected to dsh ACP', 25)
            stash_id = stash.session_id()
            stash.write('DRAFT_STALE')
            stash.wait_visible('DRAFT_STALE')
            stash.write('/')
            shown = stash.wait_visible('slash completion', 10)
            assert 'DRAFT_STALE/' not in shown
            stash.write('\x1b')
            stash.pump(0.3)
            shown = stash.visible()
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert 'DRAFT_STALE' in draft
            assert 'DRAFT_STALE/' not in draft
            stash.write('\x03')
            stash.pump(0.2)
            stash.write('TOKEN_AFTER_ABORT\r')
            stash.wait_visible('RUST_ACP_ANSWER', 20)
            shown = stash.visible()
            assert 'TOKEN_AFTER_ABORT' in shown
            leaves_before = alt_leave_count(stash.data)
            stash.send_slash('/minimal')
            shown = stash.wait_visible('mode=minimal', 25)
            assert stash.session_id() == stash_id
            stash.assert_native_minimal('TOKEN_AFTER_ABORT', leaves_before=leaves_before)
            results.append(stash.finish())
            assert 'TOKEN_AFTER_ABORT' in results[-1]['primary'] or 'TOKEN_AFTER_ABORT' in results[-1]['screen']
        finally:
            stash.close()

        compact = Session('compact-minimal', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--minimal'])
        try:
            compact.wait_visible('Connected to dsh ACP', 25)
            shown = compact.visible()
            assert 'mode=minimal' in shown
            compact_id = compact.session_id()
            for token in ['TOKEN_OLD_ONE', 'TOKEN_OLD_TWO', 'TOKEN_OLD_THREE', 'TOKEN_OLD_FOUR']:
                compact.write(token + '\r')
                compact.wait_visible('RUST_ACP_ANSWER', 20)
            snap = compact.snapshot()
            assert not snap['onAlternate']
            assert 'TOKEN_OLD_ONE' in snap['primary']
            compact.write('/compact keep the auth plan\r')
            shown = compact.wait_visible('purpose=compaction', 40)
            shown = compact.wait_session(compact_id, 10)
            assert compact.session_id() == compact_id
            snap = compact.snapshot()
            assert not snap['onAlternate']
            assert 'purpose=compaction' in snap['primary'] or 'MOCK_COMPACTION_SUMMARY' in snap['primary'] or 'MOCK_COMPACTION_SUMMARY' in shown
            assert 'MOCK_COMPACTION_SUMMARY' in shown or 'MOCK_COMPACTION_SUMMARY' in snap['primary']
            results.append(compact.finish(expect_alt_leave=False))
            assert 'purpose=compaction' in results[-1]['primary'] or 'MOCK_COMPACTION_SUMMARY' in results[-1]['primary']
        finally:
            compact.close()

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
            exec_switch.send_slash('/minimal')
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
