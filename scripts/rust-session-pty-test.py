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
SESSION_RE = re.compile(r'session ([0-9a-f-]{36})', re.I)


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
            assert alpha in shown or 'Manual Alpha' in shown
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
        assert 'Manual Alpha' in listed.stdout
        searched = cli(launcher, cwd, base_env, 'sessions', 'search', 'TOKEN_ALPHA_BODY')
        assert searched.returncode == 0, searched.stderr
        assert alpha in searched.stdout
        assert 'content' in searched.stdout
        title_hit = cli(launcher, cwd, base_env, 'sessions', 'search', 'Manual Alpha')
        assert alpha in title_hit.stdout
        assert 'title' in title_hit.stdout

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
            resumed.write(b'\x1b')
            results.append(resumed.finish())
        finally:
            resumed.close()

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
