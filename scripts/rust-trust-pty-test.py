#!/usr/bin/env python3
"""Installed-product managed policy and workspace trust for ticket 141."""
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


def spawn_inspect(launcher, cwd, env, extra):
    return subprocess.run([NODE, str(launcher), '--rust', *extra], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=20)


def pty_session(name, launcher, cwd, env, output, extra=(), typed=None, wait_before=(), wait_after=(),
                then_typed=None, then_wait=(), after_visible=None, quit=True, cols=100, rows=30):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    original = termios.tcgetattr(slave)
    process = subprocess.Popen([NODE, str(launcher), '--rust', *extra], cwd=cwd, env=env,
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
        for marker in wait_before:
            wait_visible(marker, 25)
        if after_visible:
            after_visible()
        if typed:
            os.write(master, typed.encode())
            prefix = typed.split('\r', 1)[0]
            if prefix:
                wait_visible(prefix)
        for marker in wait_after:
            wait_visible(marker, 25)
        if then_typed:
            os.write(master, then_typed.encode())
            prefix = then_typed.split('\r', 1)[0]
            if prefix:
                wait_visible(prefix)
        for marker in then_wait:
            wait_visible(marker, 25)
        shown = visible()
        if quit:
            os.write(master, b'\x11')
            process.wait(timeout=12)
        pump()
        os.write(master, b'AFTER_EXIT_CANONICAL\n')
        assert select.select([slave], [], [], 2)[0]
        assert os.read(slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
        assert original == termios.tcgetattr(slave), f'{name}: terminal modes were not restored'
        assert b'\x1b[?1049l' in data
        (output / f'{name}.ansi').write_bytes(data)
        (output / f'{name}.txt').write_text(shown)
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
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-trust-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-trust-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        (cwd / '.git').mkdir()
        (cwd / 'AGENTS.md').write_text('# MARKER_UNTRUSTED_INSTRUCTIONS\n')
        grok_ws = cwd / '.grok'
        grok_ws.mkdir()
        (grok_ws / 'hooks').mkdir()
        (grok_ws / 'hooks' / 'sessionstart.sh').write_text('#!/bin/sh\necho ran > canary\n')
        (grok_ws / 'config.toml').write_text("""
[models]
default = "project-model"

[model.project-model]
model = "project"
base_url = "http://127.0.0.1:55/v1"
env_key = "XAI_API_KEY"
""")
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
            'DSH_BIN': dsh, 'CODSH_NODE': NODE,
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'CODSH_UPDATE_CHECK': 'off',
            'XAI_API_KEY': 'test-key-not-a-secret-for-logs',
            'CODSH_ACP_PATCH': str(patch), 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }
        rust_root = home / '.codsh-rust'
        grok_home = rust_root / '.grok'
        grok_home.mkdir(parents=True)
        (grok_home / 'config.toml').write_text("""
[models]
default = "user-model"

[model.user-model]
name = "User model"
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"

[model.project-model]
model = "project"
base_url = "http://127.0.0.1:55/v1"
env_key = "XAI_API_KEY"

[model.locked-model]
model = "locked"
base_url = "http://127.0.0.1:66/v1"
env_key = "XAI_API_KEY"
""")
        results = {}

        denied = pty_session('trust-deny', launcher, cwd, base_env, output,
                             wait_before=['Trust this workspace', 'hooks'],
                             typed='n',
                             wait_after=['Connected to dsh ACP'],
                             then_typed='TOKEN_DENY_PROMPT\r',
                             then_wait=['RUST_ACP_ANSWER', 'TOKEN_DENY_PROMPT'])
        assert denied['exit'] == 0
        assert not (cwd / 'canary').exists()
        assert 'MARKER_UNTRUSTED_INSTRUCTIONS' not in denied['screen']
        assert 'Instructions from: AGENTS.md' not in denied['screen']
        results['pty-deny'] = {'exit': denied['exit'], 'canary': False, 'instructions': False}

        inspect_denied = spawn_inspect(launcher, cwd, base_env, ['inspect', '--json'])
        assert inspect_denied.returncode == 0, inspect_denied.stderr + inspect_denied.stdout
        denied_payload = json.loads(inspect_denied.stdout)
        denied_settings = {row['key']: row for row in denied_payload['settings']}
        assert denied_payload['workspaceTrusted'] is False
        assert denied_payload['projectAssetsActive'] is False
        assert denied_settings['models.default']['value'] == 'user-model'
        assert denied_settings['workspace.project_assets']['value'] == 'inactive'
        results['inspect-denied'] = {
            'workspaceTrusted': False,
            'default': denied_settings['models.default']['value'],
        }

        allowed = pty_session('trust-allow', launcher, cwd, base_env, output,
                              extra=['--trust'],
                              wait_before=['Connected to dsh ACP'],
                              typed='TOKEN_TRUST_ALLOW\r',
                              wait_after=['RUST_ACP_ANSWER', 'TOKEN_TRUST_ALLOW'])
        assert allowed['exit'] == 0
        assert 'Trust this workspace' not in allowed['screen']
        assert not (cwd / 'canary').exists()
        store = (grok_home / 'trusted_folders.toml').read_text()
        assert 'trusted = true' in store
        inspect_allowed = spawn_inspect(launcher, cwd, base_env, ['inspect', '--json'])
        allowed_payload = json.loads(inspect_allowed.stdout)
        allowed_settings = {row['key']: row for row in allowed_payload['settings']}
        assert allowed_payload['workspaceTrusted'] is True
        assert allowed_settings['models.default']['value'] == 'project-model'
        assert allowed_settings['model.project-model.base_url']['value'] == 'http://127.0.0.1:55/v1'
        results['pty-allow'] = {'exit': allowed['exit'], 'default': allowed_settings['models.default']['value']}

        revoked = spawn_inspect(launcher, cwd, base_env, ['--revoke-trust', 'inspect', '--json'])
        revoked_payload = json.loads(revoked.stdout)
        assert revoked.returncode == 0, revoked.stderr + revoked.stdout
        assert revoked_payload['workspaceTrusted'] is False
        assert revoked_payload['projectAssetsActive'] is False
        results['inspect-revoked'] = {'workspaceTrusted': False}

        (grok_home / 'requirements.toml').write_text("""
fail_closed = true

[models]
default = "locked-model"

[features]
remote_fetch = false
""")
        locked = spawn_inspect(launcher, cwd, {**base_env, 'GROK_CONFIG': json.dumps({'models': {'default': 'user-model'}, 'features': {'remote_fetch': True}})},
                               ['inspect', '--json', '--model', 'user-model'])
        assert locked.returncode == 0, locked.stderr + locked.stdout
        locked_payload = json.loads(locked.stdout)
        locked_settings = {row['key']: row for row in locked_payload['settings']}
        assert locked_settings['models.default']['value'] == 'locked-model'
        assert locked_settings['models.default']['source'] == 'requirements'
        assert locked_payload['remoteFetch'] is False
        assert locked_settings['features.remote_fetch']['value'] == 'false'
        assert locked_settings['features.remote_fetch']['source'] == 'requirements'
        results['inspect-locked'] = {
            'default': locked_settings['models.default'],
            'remoteFetch': locked_settings['features.remote_fetch'],
        }

        (grok_home / 'requirements.toml').write_text('fail_closed = true\nunknown_security_gate = true\n')
        unknown = spawn_inspect(launcher, cwd, base_env, ['inspect'])
        combined = unknown.stdout + unknown.stderr
        assert unknown.returncode != 0
        assert 'unknown_security_gate' in combined
        assert 'fail_closed' in combined or 'folder_trust' in combined
        assert 'requirements' in combined
        results['inspect-unknown'] = {'exit': unknown.returncode}

        unknown_pty = pty_session('policy-unknown', launcher, cwd, base_env, output,
                                  wait_before=['unknown_security_gate', 'Original file was not changed'])
        assert 'Connected to dsh ACP' not in unknown_pty['screen']
        results['pty-unknown'] = {'exit': unknown_pty['exit']}

        (grok_home / 'requirements.toml').unlink()
        readonly_home = work / 'readonly-home'
        readonly_home.mkdir()
        readonly_env = {**base_env, 'HOME': str(readonly_home)}
        readonly_grok = readonly_home / '.codsh-rust' / '.grok'
        readonly_grok.mkdir(parents=True)
        (readonly_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        os.chmod(readonly_grok, 0o555)
        try:
            readonly = pty_session('trust-readonly', launcher, cwd, readonly_env, output,
                                   extra=['--trust'],
                                   wait_before=['Couldn\'t save folder trust'])
            assert readonly['exit'] == 0
            assert not (readonly_grok / 'trusted_folders.toml').exists()
            results['pty-readonly'] = {'exit': readonly['exit'], 'durable': False}
        finally:
            os.chmod(readonly_grok, 0o755)

        (output / 'result.json').write_text(json.dumps({
            'results': {key: ('ok' if value is not None else value) for key, value in results.items()},
            'inspectDenied': results['inspect-denied'],
            'inspectLocked': results['inspect-locked'],
            'canaryExists': (cwd / 'canary').exists(),
        }, indent=2) + '\n')
        print(output)
        print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
