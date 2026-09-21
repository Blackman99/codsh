#!/usr/bin/env python3
"""Installed-product PTY: real dsh file tools, diffs, and allow/reject."""
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


def exercise(name, launcher, cwd, env, output, typed, wait_for, action='allow', cols=100, rows=36):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    original = termios.tcgetattr(slave)
    process = subprocess.Popen([NODE, str(launcher), '--rust'], cwd=cwd, env=env,
                               stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
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
        wait_visible('codsh')
        wait_visible('Draft (not sent)')
        wait_visible('Connected to dsh ACP', 25)
        os.write(master, typed.encode())
        wait_visible(typed)
        os.write(master, b'\r')
        if action in {'allow', 'reject', 'quit-approval'}:
            wait_visible('Allow ', 30)
            wait_visible('y=allow once', 10)
            if action == 'allow':
                os.write(master, b'y')
            elif action == 'reject':
                os.write(master, b'n')
            else:
                os.write(master, b'\x11')
                process.wait(timeout=12)
                pump()
                shown = visible()
                os.write(master, b'AFTER_EXIT_CANONICAL\n')
                assert select.select([slave], [], [], 2)[0]
                assert os.read(slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
                after = termios.tcgetattr(slave)
                (output / f'{name}.ansi').write_bytes(data)
                (output / f'{name}.txt').write_text(shown)
                assert original == after, f'{name}: terminal modes were not restored'
                assert b'\x1b[?1049l' in data
                return {'name': name, 'exit': process.returncode, 'screen': shown}
        for marker in wait_for:
            wait_visible(marker, 30)
        shown = visible()
        os.write(master, b'\x11')
        process.wait(timeout=12)
        pump()
        os.write(master, b'AFTER_EXIT_CANONICAL\n')
        assert select.select([slave], [], [], 2)[0]
        assert os.read(slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
        after = termios.tcgetattr(slave)
        (output / f'{name}.ansi').write_bytes(data)
        (output / f'{name}.txt').write_text(shown)
        assert original == after, f'{name}: terminal modes were not restored'
        assert b'\x1b[?1049l' in data
        return {'name': name, 'exit': process.returncode, 'screen': shown}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-file-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-file-home-', dir='/tmp') as temporary:
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
        (cwd / 'note.txt').write_text('alpha\n')
        allow = exercise('allow-edit', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'}, output,
                         typed='TOKEN_FILE_EDIT', wait_for=['+ALPHA', 'successfully.'], action='allow')
        assert 'edit note.txt' in allow['screen']
        assert '-alpha' in allow['screen'] and '+ALPHA' in allow['screen']
        assert (cwd / 'note.txt').read_text() == 'ALPHA\n'
        assert 'successfully.' in allow['screen']

        (cwd / 'note.txt').write_text('alpha\n')
        reject = exercise('reject-edit', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'}, output,
                          typed='TOKEN_FILE_REJECT', wait_for=['failed'], action='reject')
        assert (cwd / 'note.txt').read_text() == 'alpha\n'
        assert 'failed' in reject['screen'] or 'rejected' in reject['screen'].lower()
        assert 'successfully.' not in reject['screen']

        (cwd / 'note.txt').write_text('alpha\n')
        cancelled = exercise('quit-approval', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'}, output,
                             typed='TOKEN_FILE_QUIT', wait_for=[], action='quit-approval')
        assert (cwd / 'note.txt').read_text() == 'alpha\n'
        assert cancelled['exit'] == 0

        missing = exercise('missing-file', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-missing'}, output,
                           typed='TOKEN_FILE_MISSING', wait_for=['cannot read', 'failed'], action='none')
        assert not (cwd / 'missing-note.txt').exists()
        assert 'successfully.' not in missing['screen']
        assert 'failed' in missing['screen']
        assert 'cannot read' in missing['screen']

        (cwd / 'note.txt').write_text('alpha\n')
        error = exercise('tool-error', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-error'}, output,
                         typed='TOKEN_FILE_ERROR', wait_for=['failed'], action='allow')
        assert (cwd / 'note.txt').read_text() == 'alpha\n'
        assert 'successfully.' not in error['screen']

        (output / 'result.json').write_text(json.dumps({
            'results': [
                {'name': allow['name'], 'exit': allow['exit']},
                {'name': reject['name'], 'exit': reject['exit']},
                {'name': cancelled['name'], 'exit': cancelled['exit']},
                {'name': missing['name'], 'exit': missing['exit']},
                {'name': error['name'], 'exit': error['exit']},
            ],
            'dshBin': dsh,
            'noteAfterAllow': 'ALPHA\\n',
        }, indent=2) + '\n')
        assert all(item['exit'] == 0 for item in [allow, reject, cancelled, missing, error])
    print(f'PASS: rust dsh file-tool PTY; evidence: {output}')


if __name__ == '__main__':
    main()
