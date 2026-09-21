#!/usr/bin/env python3
"""Installed-product PTY: Ctrl+C/Esc cancel semantics through real dsh."""
import fcntl
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


class Session:
    def __init__(self, name, launcher, cwd, env, output, cols=100, rows=36):
        self.name = name
        self.cols = cols
        self.rows = rows
        self.output = output
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.original = termios.tcgetattr(self.slave)
        self.process = subprocess.Popen(
            [NODE, str(launcher), '--rust'], cwd=cwd, env=env,
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
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-cancel-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-cancel-home-', dir='/tmp') as temporary:
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

        stream = Session('stream-keys', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo', 'DSH_CODE_CLI_MOCK_DELAY_MS': '5000',
        }, output)
        try:
            stream.wait_visible('codsh')
            stream.wait_visible('Draft (not sent)')
            stream.wait_visible('Connected to dsh ACP', 25)
            stream.write('TOKEN_CANCEL_STREAM')
            stream.wait_visible('TOKEN_CANCEL_STREAM')
            stream.write(b'\r')
            stream.wait_visible('Streaming turn', 10)
            stream.write('DRAFT_KEEP')
            stream.wait_visible('DRAFT_KEEP')
            stream.write(b'\x1b')
            stream.pump(0.4)
            shown = stream.visible()
            assert 'DRAFT_KEEP' in shown
            assert '[cancelled]' not in shown
            assert 'Press Ctrl+C to cancel the turn' in shown
            stream.write(b'\x03')
            stream.pump(0.4)
            shown = stream.visible()
            assert 'DRAFT_KEEP' not in shown
            assert '[cancelled]' not in shown
            stream.write(b'\x03')
            stream.wait_visible('[cancelled]', 20)
            stream.write('TOKEN_AFTER_CANCEL\r')
            stream.wait_visible('TOKEN_AFTER_CANCEL', 20)
            stream.wait_visible('RUST_ACP_ANSWER', 20)
            results.append(stream.finish())
        finally:
            stream.close()

        pending = Session('pending-approval', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit',
        }, output)
        try:
            pending.wait_visible('Connected to dsh ACP', 25)
            pending.write('TOKEN_CANCEL_PERMISSION')
            pending.wait_visible('TOKEN_CANCEL_PERMISSION')
            pending.write(b'\r')
            pending.wait_visible('Allow ', 30)
            pending.write('DRAFT_PERM')
            pending.wait_visible('DRAFT_PERM')
            pending.write(b'\x1b')
            pending.pump(0.3)
            shown = pending.visible()
            assert 'Allow ' in shown
            assert '[cancelled]' not in shown
            assert (cwd / 'note.txt').read_text() == 'alpha\n'
            pending.write(b'\x03')
            pending.pump(0.3)
            shown = pending.visible()
            assert 'DRAFT_PERM' not in shown
            assert 'Allow ' in shown
            assert (cwd / 'note.txt').read_text() == 'alpha\n'
            pending.write(b'\x03')
            pending.wait_visible('[cancelled]', 20)
            assert (cwd / 'note.txt').read_text() == 'alpha\n'
            results.append(pending.finish())
        finally:
            pending.close()

        tool = Session('in-tool', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit', 'DSH_CODE_CLI_TOOL_DELAY_MS': '4000',
        }, output)
        try:
            (cwd / 'note.txt').write_text('alpha\n')
            tool.wait_visible('Connected to dsh ACP', 25)
            tool.write('TOKEN_CANCEL_TOOL')
            tool.wait_visible('TOKEN_CANCEL_TOOL')
            tool.write(b'\r')
            tool.wait_visible('Allow ', 30)
            tool.write(b'y')
            tool.pump(0.3)
            tool.write(b'\x03')
            tool.wait_visible('[cancelled]', 20)
            assert (cwd / 'note.txt').read_text() == 'alpha\n'
            results.append(tool.finish())
        finally:
            tool.close()

        race = Session('complete-race', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output)
        try:
            race.wait_visible('Connected to dsh ACP', 25)
            race.write('TOKEN_COMPLETE_RACE')
            race.wait_visible('TOKEN_COMPLETE_RACE')
            race.write(b'\r')
            race.wait_visible('RUST_ACP_ANSWER', 25)
            race.write(b'\x03')
            deadline = time.monotonic() + 0.4
            while time.monotonic() < deadline and race.process.poll() is None:
                race.pump(0.05)
            if race.process.poll() is not None:
                shown = race.visible()
                (output / 'complete-race-quit.txt').write_text(shown)
                raise AssertionError(
                    'complete-race: Ctrl+C at the finished instant quit instead of a no-op cancel\n'
                    + shown
                )
            race.write('TOKEN_AFTER_RACE\r')
            race.wait_visible('TOKEN_AFTER_RACE', 25)
            race.wait_visible('turn=3', 25)
            shown = race.visible()
            assert 'TOKEN_AFTER_RACE' in shown
            results.append(race.finish())
        finally:
            race.close()

        (output / 'result.json').write_text(json.dumps({
            'results': [{'name': item['name'], 'exit': item['exit']} for item in results],
            'note': (cwd / 'note.txt').read_text(),
            'dshBin': dsh,
        }, indent=2) + '\n')
        assert all(item['exit'] == 0 for item in results), results
        assert (cwd / 'note.txt').read_text() == 'alpha\n'
    print(f'PASS: rust dsh cancel PTY; evidence: {output}')


if __name__ == '__main__':
    main()
