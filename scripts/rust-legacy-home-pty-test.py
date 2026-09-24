#!/usr/bin/env python3
"""Packed `codsh --rust` never creates or writes an inherited legacy Home.

HOME stays the fixture. An inherited GROK_HOME or DSH_HOME names a separate
legacy directory, missing or populated. Submitting a prompt makes the client
write prompt history and draft state. Those writes must land in the isolated
~/.codsh-rust/.grok, and the legacy path must stay absent or unchanged.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


def snapshot_tree(root):
    return {str(path.relative_to(root)): {'symlink': os.readlink(path)} if path.is_symlink()
            else 'directory' if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob('*')}


def pack_install(work):
    pack_env = {
        'HOME': str(work), 'PATH': os.environ['PATH'],
        'npm_config_cache': str(work / 'npm-cache'),
        'npm_config_userconfig': str(work / 'empty-user.npmrc'),
        'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
        'npm_config_update_notifier': 'false',
    }
    pack = json.loads(run(['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
                         cwd=ROOT / 'packages/cli', env=pack_env).stdout)[0]['filename']
    prefix = work / 'installed'
    run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
    package = prefix / 'node_modules/codsh-cli'
    binary = package / 'native' / ('darwin-arm64' if os.uname().machine == 'arm64' else 'darwin-x64') / 'codsh-rust'
    assert binary.exists(), 'stage the native candidate first: node scripts/build-rust.mjs'
    assert (package / 'bin/rust.mjs').read_bytes() == (ROOT / 'packages/cli/bin/rust.mjs').read_bytes()
    return prefix / 'node_modules/.bin/codsh'


def drive(launcher, cwd, env, emulator, capture, prompt):
    rows, cols = 30, 100
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
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

    def screen():
        payload = {'rows': rows, 'cols': cols, 'bytes': base64.b64encode(data).decode()}
        return run([NODE, '--import', 'tsx', str(emulator)], input=json.dumps(payload), cwd=ROOT).stdout

    def wait_visible(text):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            pump()
            if text in screen():
                return
            if process.poll() is not None:
                break
        raise AssertionError(f'{capture.name}: missing {text!r}\n{screen()}')

    try:
        wait_visible('Draft (not sent)')
        os.write(master, prompt.encode())
        wait_visible(prompt)
        os.write(master, b'\r')
        wait_visible('Execution unavailable')
        os.write(master, b'\x03')
        pump(0.3)
        os.write(master, b'\x11')
        process.wait(timeout=12)
        pump()
        assert process.returncode == 0, f'{capture.name}: exit {process.returncode}\n{screen()}'
        capture.write_bytes(data)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required; other platforms remain unverified')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-legacy-home-', dir='/tmp'))
    emulator = output / 'screen.mjs'
    emulator.write_text(f"import {{ Terminal }} from {json.dumps((ROOT / 'e2e/vt.ts').as_uri())};\n"
                        "let input=''; for await (const chunk of process.stdin) input+=chunk; const spec=JSON.parse(input); const t=new Terminal(spec.rows,spec.cols); t.feed(Buffer.from(spec.bytes,'base64').toString()); console.log(t.text);\n")
    results = []
    with tempfile.TemporaryDirectory(prefix='codsh-rust-legacy-home-work-', dir='/tmp') as temporary:
        work = Path(temporary)
        launcher = pack_install(work)
        for variable in ['GROK_HOME', 'DSH_HOME']:
            # A sibling spelled like the isolated root must not be mistaken for it.
            for name in ['.codsh-rust-other', '.separate-legacy']:
                for kind in ['missing', 'existing']:
                    label = f'{variable}-{name}-{kind}'
                    home = work / f'home-{label}'
                    home.mkdir()
                    cwd = work / f'workspace-{label}'
                    cwd.mkdir()
                    parent = home / name
                    legacy = parent / 'DSH'
                    if kind == 'existing':
                        legacy.mkdir(parents=True)
                        (legacy / 'canary').write_text('synthetic legacy content\n')
                        (legacy / 'config.toml').write_text('[ui]\ncompact_mode = true\n')
                        (legacy / 'prompt-history.json').write_text('["synthetic legacy history"]\n')
                        before = snapshot_tree(parent)
                    assert not (home / '.codsh-rust').exists()
                    env = {'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
                           'DSH_BIN': '/no/runtime/must/be/started', variable: str(legacy)}
                    prompt = f'LEGACY_HOME_PROMPT_{len(results)}'
                    drive(launcher, cwd, env, emulator, output / f'{label}.ansi', prompt)
                    if kind == 'missing':
                        assert not parent.exists(), f'{label}: inherited legacy Home was created: {sorted(snapshot_tree(parent))}'
                    else:
                        after = snapshot_tree(parent)
                        assert after == before, f'{label}: inherited legacy Home was written: {before} -> {after}'
                    isolated = home / '.codsh-rust' / '.grok'
                    history = isolated / 'prompt-history.json'
                    assert history.is_file() and prompt in history.read_text(), f'{label}: prompt history is not in the isolated Home'
                    assert (home / '.codsh-rust/dsh/profiles/rust/package.json').is_file()
                    results.append({'variable': variable, 'path': name, 'case': kind, 'legacyUntouched': True,
                                    'isolatedHistory': True})
    (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(f'PASS: {len(results)} inherited legacy Home launches left legacy data untouched; evidence={output}')


if __name__ == '__main__':
    main()
