#!/usr/bin/env python3
"""Installed-product PTY: session search, rename, dashboard, and resume."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
SESSION_RE = re.compile(r'session ([0-9a-f-]{36}|fake-session-\d+)', re.I)


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


class Session:
    def __init__(self, name, launcher, cwd, env, output, extra=None, cols=110, rows=40):
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

    def rows_with(self, marker, seconds=20):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump()
            shown = self.visible()
            rows = [
                line for line in shown.splitlines()
                if line.startswith('> ○') or line.startswith('> ·') or line.startswith('> ●')
                or line.startswith('  ○') or line.startswith('  ·') or line.startswith('  ●')
            ]
            if any(marker in line for line in rows):
                return shown, rows
            if self.process.poll() is not None:
                break
        raise AssertionError(f'{self.name}: no row with {marker!r}\n{self.visible()}')

    def session_id(self):
        shown = self.visible()
        match = SESSION_RE.search(shown)
        if match is None:
            raise AssertionError(f'{self.name}: missing session id\n{shown}')
        return match.group(1)

    def finish(self):
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
        if b'\x1b[?1049h' in self.data:
            assert b'\x1b[?1049l' in self.data
        return {'name': self.name, 'exit': self.process.returncode, 'screen': shown}

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()
        os.close(self.master)
        os.close(self.slave)


def cli(launcher, cwd, env, *args):
    completed = subprocess.run(
        [NODE, str(launcher), '--rust', *args],
        cwd=cwd, env=env, capture_output=True, text=True,
    )
    return completed


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-sessions-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-sessions-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        other = work / 'other-workspace'
        cwd.mkdir()
        other.mkdir()
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

        listed = cli(launcher, cwd, base_env, 'sessions', 'list')
        assert listed.returncode == 0, listed.stderr
        assert 'No sessions' in listed.stdout
        empty = cli(launcher, cwd, base_env, 'sessions', 'search', 'nothing-here')
        assert empty.returncode == 0, empty.stderr
        assert 'No sessions match' in empty.stdout
        missing = cli(launcher, cwd, base_env, '--resume', '00000000-0000-4000-8000-000000000000')
        assert missing.returncode != 0
        assert 'not resumable' in (missing.stderr + missing.stdout)

        first = Session('alpha', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output)
        try:
            first.wait_visible('Connected to dsh ACP', 25)
            alpha = first.session_id()
            first.write('TOKEN_ALPHA_BODY\r')
            first.wait_visible('TOKEN_ALPHA_BODY', 20)
            first.write('/rename Manual Alpha\r')
            first.wait_visible('renamed to Manual Alpha', 15)
            first.write('/dashboard\r')
            shown = first.wait_visible('Agent Dashboard', 15)
            assert 'Manual Alpha' in shown
            assert alpha in shown, shown
            first.write(b'\x1b')
            first.wait_visible('left dashboard', 10)
            results.append(first.finish())
        finally:
            first.close()

        second = Session('beta', launcher, other, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output)
        try:
            second.wait_visible('Connected to dsh ACP', 25)
            beta = second.session_id()
            second.write('TOKEN_BETA_BODY\r')
            second.wait_visible('TOKEN_BETA_BODY', 20)
            second.write('/rename Manual Alpha\r')
            second.wait_visible('renamed to Manual Alpha', 15)
            results.append(second.finish())
        finally:
            second.close()

        listed = cli(launcher, cwd, base_env, 'sessions', 'list')
        assert listed.returncode == 0, listed.stderr
        assert alpha in listed.stdout
        assert beta in listed.stdout, listed.stdout
        assert 'Manual Alpha' in listed.stdout
        assert 'unread' in listed.stdout, listed.stdout
        searched = cli(launcher, cwd, base_env, 'sessions', 'search', 'TOKEN_ALPHA_BODY')
        assert searched.returncode == 0, searched.stderr
        assert alpha in searched.stdout
        assert 'content' in searched.stdout
        title_hit = cli(launcher, cwd, base_env, 'sessions', 'search', 'Manual Alpha')
        assert alpha in title_hit.stdout
        assert beta in title_hit.stdout, title_hit.stdout
        title_lines = [line for line in title_hit.stdout.splitlines() if 'Manual' in line or alpha in line or beta in line]
        assert any(line.startswith(alpha) and '\ttitle\t' in line for line in title_lines), title_hit.stdout

        resumed = Session('resume-title', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--resume', 'Manual Alpha'])
        try:
            shown = resumed.wait_visible('resumed', 25)
            assert alpha in shown
            assert 'TOKEN_ALPHA_BODY' in shown
            assert 'TOKEN_BETA_BODY' not in shown
            resumed.write('/resume\r')
            picker = resumed.wait_visible('Resume session', 15)
            assert 'Manual Alpha' in picker
            assert alpha in picker and beta in picker, picker
            selected = next(line for line in picker.splitlines() if line.startswith('> ○') or line.startswith('> ·'))
            assert beta in selected, picker
            resumed.write(b'\r')
            refused = resumed.wait_visible('occupied', 20)
            assert 'Resume session' in refused, refused
            assert f'session {alpha}' in refused, refused
            assert 'Connected to dsh ACP session' in refused
            results.append(resumed.finish())
        finally:
            resumed.close()

        startup = Session('dashboard-startup', launcher, cwd, {
            **base_env,
            'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'GROK_OPEN_DASHBOARD_AT_STARTUP': '1',
            'GROK_SESSION_PICKER_GROUPED': '1',
        }, output, extra=['dashboard'])
        try:
            shown = startup.wait_visible('Agent Dashboard', 25)
            assert alpha in shown, shown
            assert 'grouping=directory' in shown, shown
            startup.write(b'\x1b')
            results.append(startup.finish())
        finally:
            startup.close()

        minimal = Session('minimal-dashboard', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--minimal', '--resume', alpha])
        try:
            minimal.wait_visible('Connected to dsh ACP', 25)
            minimal.write('/dashboard\r')
            shown = minimal.wait_visible("isn't available in minimal mode", 15)
            assert '/fullscreen' in shown
            results.append(minimal.finish())
        finally:
            minimal.close()

        peer = Session('same-directory-peer', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output)
        try:
            peer.wait_visible('Connected to dsh ACP', 25)
            gamma = peer.session_id()
            peer.write('TOKEN_GAMMA_BODY\r')
            peer.wait_visible('TOKEN_GAMMA_BODY', 20)
            peer.write('/rename gammapeer\r')
            peer.wait_visible('renamed to gammapeer', 15)
            results.append(peer.finish())
        finally:
            peer.close()

        store = work / 'active-store.json'
        store.write_text(json.dumps({'sessions': {
            alpha: {'sessionId': alpha, 'cwd': str(cwd), 'closed': True, 'owned': False, 'prompts': []},
            gamma: {'sessionId': gamma, 'cwd': str(cwd), 'closed': True, 'owned': False, 'prompts': []},
        }}))
        same = Session('same-directory-active', launcher, cwd, {
            **base_env,
            'DSH_BIN': str(ROOT / 'scripts/fake-acp-agent.mjs'),
            'FAKE_ACP_MODE': 'echo',
            'FAKE_ACP_STORE': str(store),
            # gamma is closed in the catalog and unlocked. The agent still
            # answers session/resume with already active, which must not close
            # the session this client just opened.
            'FAKE_ACP_HELD_SESSION': gamma,
        }, output)
        try:
            connected = same.wait_visible('Connected to dsh ACP', 25)
            live = same.session_id()
            same.write('/resume\r')
            picker = same.wait_visible('Resume session', 15)
            assert 'gammapeer' in picker and gamma in picker, picker
            # A short lowercase title fits the notice slot. Shift is not a filter key.
            for ch in 'gammapeer':
                same.write(ch.encode())
                same.pump(0.2)
            picker, rows = same.rows_with('gammapeer', 20)
            assert rows and all(alpha not in line for line in rows), (rows, picker)
            same.write(b'\r')
            refused = same.wait_visible('already active', 20)
            assert 'gammapeer' in refused or 'Resume session' in refused, refused
            assert gamma in refused and f'session {live}' in refused, refused
            same.write(b'\x1b')
            left = same.wait_visible('Connected to dsh ACP', 10)
            assert f'session {live}' in left, left
            same.write('/dashboard\r')
            board = same.wait_visible('Agent Dashboard', 15)
            assert 'gammapeer' in board and gamma in board, board
            selected = next(line for line in board.splitlines() if line.startswith('> '))
            assert 'gammapeer' in selected, board
            same.write(b'\r')
            board = same.wait_visible('already active', 20)
            assert 'Agent Dashboard' in board or 'gammapeer' in board, board
            assert gamma in board and f'session {live}' in board, board
            results.append(same.finish())
        finally:
            same.close()

        marker = cli(launcher, cwd, {**base_env, 'GROK_OPEN_DASHBOARD_AT_STARTUP': '0'}, 'dashboard')
        assert marker.returncode == 0, marker.stderr
        assert 'GROK_OPEN_DASHBOARD_AT_STARTUP=1' in marker.stdout
        (output / 'results.json').write_text(json.dumps({
            'alpha': alpha,
            'beta': beta,
            'screens': [item['name'] for item in results],
        }, indent=2))
        print(f'PASS {output}')


if __name__ == '__main__':
    main()
