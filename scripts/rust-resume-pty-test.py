#!/usr/bin/env python3
"""Installed-product PTY: resume the same dsh session and refuse a second writer."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
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
        assert b'\x1b[?1049l' in self.data
        return {'name': self.name, 'exit': self.process.returncode, 'screen': shown}

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()
        os.close(self.master)
        os.close(self.slave)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-resume-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-resume-home-', dir='/tmp') as temporary:
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

        first = Session('normal-exit', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output)
        try:
            first.wait_visible('Connected to dsh ACP', 25)
            session_id = first.session_id()
            first.write('TOKEN_RESUME_ONE\r')
            first.wait_visible('TOKEN_RESUME_ONE', 20)
            first.wait_visible('RUST_ACP_ANSWER', 20)
            results.append(first.finish())
        finally:
            first.close()

        continued = Session('continue', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--continue'])
        try:
            shown = continued.wait_visible('resumed', 25)
            assert 'TOKEN_RESUME_ONE' in shown, shown
            assert session_id in shown, shown
            continued.write('TOKEN_RESUME_TWO')
            continued.wait_visible('TOKEN_RESUME_TWO', 10)
            continued.write(b'\r')
            shown = continued.wait_visible('turn=', 20)
            assert 'TOKEN_RESUME_TWO' in shown
            assert 'TOKEN_RESUME_ONE' in shown
            results.append(continued.finish())
        finally:
            continued.close()

        owner = Session('owner', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--resume', session_id])
        try:
            owner.wait_visible('Connected to dsh ACP', 25)
            assert owner.session_id() == session_id
            rival = Session('rival', launcher, cwd, {
                **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            }, output, extra=['--resume', session_id])
            try:
                shown = rival.wait_visible('Write owner refused', 25)
                assert session_id in shown
                assert 'already running' in shown or 'already owned' in shown or 'already active' in shown
                results.append(rival.finish())
            finally:
                rival.close()
            results.append(owner.finish())
        finally:
            owner.close()

        crashing = Session('crash', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit', 'DSH_CODE_CLI_TOOL_DELAY_MS': '8000',
        }, output)
        try:
            crashing.wait_visible('Connected to dsh ACP', 25)
            crash_id = crashing.session_id()
            crashing.write('TOKEN_CRASH_EDIT\r')
            crashing.wait_visible('Allow ', 30)
            crashing.write(b'y')
            crashing.pump(0.2)
            try:
                os.killpg(crashing.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                crashing.process.kill()
            crashing.process.wait(timeout=8)
            crashing.pump()
            (output / 'crash.ansi').write_bytes(crashing.data)
            time.sleep(0.3)
        finally:
            crashing.close()
        assert (cwd / 'note.txt').read_text() == 'alpha\n'

        recovered = Session('recovered', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--resume', crash_id])
        try:
            shown = recovered.wait_visible('resumed', 25)
            assert crash_id in shown
            assert '[interrupted]' in shown or 'unknown' in shown.lower()
            assert (cwd / 'note.txt').read_text() == 'alpha\n'
            recovered.write('TOKEN_AFTER_CRASH\r')
            recovered.wait_visible('TOKEN_AFTER_CRASH', 20)
            assert (cwd / 'note.txt').read_text() == 'alpha\n'
            results.append(recovered.finish())
        finally:
            recovered.close()

        (output / 'result.json').write_text(json.dumps({
            'results': [{'name': item['name'], 'exit': item.get('exit')} for item in results],
            'sessionId': session_id,
            'crashId': crash_id,
            'note': (cwd / 'note.txt').read_text(),
            'dshBin': dsh,
        }, indent=2) + '\n')
        assert (cwd / 'note.txt').read_text() == 'alpha\n'
    print(f'PASS: rust dsh resume PTY; evidence: {output}')


if __name__ == '__main__':
    main()
