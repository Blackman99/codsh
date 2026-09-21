#!/usr/bin/env python3
"""Installed-product PTY: Rust prompt -> real dsh ACP turn with a mocked model."""
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


def exercise(name, launcher, cwd, env, output, action='stream', cols=100, rows=30, typed='TOKEN_TURN_ONE', wait_for=None):
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

    def wait_visible(text, seconds=25):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            pump()
            shown = visible()
            if text in shown:
                return shown
            if process.poll() is not None:
                break
        raise AssertionError(f'{name}: missing {text!r}\n{visible()}\nraw={bytes(data)[-2000:]!r}')

    try:
        wait_visible('codsh')
        wait_visible('Draft (not sent)')
        if action == 'mismatch':
            wait_visible('protocol mismatch')
            os.write(master, typed.encode())
            wait_visible(typed)
            os.write(master, b'\r')
            pump(0.4)
            assert typed in visible()
            shown = visible()
            os.write(master, b'\x11')
            process.wait(timeout=12)
        elif action == 'drop':
            wait_visible('Connected to dsh ACP')
            os.write(master, typed.encode())
            wait_visible(typed)
            os.write(master, b'\r')
            wait_visible('FAKE_ACP_DROPPED')
            shown = visible()
            assert 'end_turn' not in shown
            assert '[error]' in shown or 'connection ended' in shown or 'ACP connection ended' in shown or 'Disconnected' in shown or 'ended' in shown.lower()
            os.write(master, b'\x11')
            process.wait(timeout=12)
        else:
            wait_visible('Connected to dsh ACP', 25)
            os.write(master, typed.encode())
            wait_visible(typed)
            os.write(master, b'\r')
            for marker in wait_for or []:
                wait_visible(marker, 25)
            if action == 'second':
                os.write(master, b'TOKEN_TURN_TWO\r')
                wait_visible('TOKEN_TURN_TWO', 25)
                wait_visible('turn=', 25)
            shown = visible()
            os.write(master, b'\x11')
            process.wait(timeout=12)
        pump()
        os.write(master, b'AFTER_EXIT_CANONICAL\n')
        assert select.select([slave], [], [], 2)[0]
        assert os.read(slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
        after = termios.tcgetattr(slave)
        (output / f'{name}.ansi').write_bytes(data)
        (output / f'{name}.txt').write_text(shown if 'shown' in locals() else visible())
        assert original == after, f'{name}: terminal modes were not restored'
        assert b'\x1b[?1049l' in data
        return {'name': name, 'exit': process.returncode, 'screen': shown if 'shown' in locals() else visible()}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-turn-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    fake = ROOT / 'scripts/fake-acp-agent.mjs'
    with tempfile.TemporaryDirectory(prefix='codsh-rust-turn-home-', dir='/tmp') as temporary:
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
        results = []
        results.append(exercise('echo', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo'}, output,
                                wait_for=['RUST_ACP_ANSWER', 'TOKEN_TURN_ONE']))
        results.append(exercise('reasoning', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'reasoning'}, output,
                                action='second', wait_for=['RUST_ACP_THOUGHT', 'RUST_ACP_ANSWER']))
        results.append(exercise('empty', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'empty'}, output,
                                wait_for=['[empty answer]']))
        fail = exercise('fail-stream', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'fail-stream'}, output,
                        wait_for=['[error]'])
        assert 'Connected to dsh ACP' in fail['screen']
        assert 'end_turn' not in fail['screen'] or '[error]' in fail['screen']
        results.append(fail)
        results.append(exercise('mismatch', launcher, cwd, {
            **base_env, 'DSH_BIN': str(fake), 'FAKE_ACP_MODE': 'mismatch',
        }, output, action='mismatch'))
        results.append(exercise('drop', launcher, cwd, {
            **base_env, 'DSH_BIN': str(fake), 'FAKE_ACP_MODE': 'drop',
        }, output, action='drop'))
        sessions = list((home / '.codsh-rust/dsh/sessions').rglob('*')) if (home / '.codsh-rust/dsh/sessions').exists() else []
        (output / 'result.json').write_text(json.dumps({
            'results': [{'name': item['name'], 'exit': item['exit']} for item in results],
            'sessionArtifacts': [str(path.relative_to(home)) for path in sessions],
            'dshBin': dsh,
        }, indent=2) + '\n')
        assert all(item['exit'] == 0 for item in results), results
        assert sessions, 'real dsh must persist session artifacts under the isolated Home'
    print(f'PASS: rust dsh streamed-turn PTY; evidence: {output}')


if __name__ == '__main__':
    main()
