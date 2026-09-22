#!/usr/bin/env python3
"""Installed-product substitute login, logout, and managed setup for ticket 189."""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import termios
import threading
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


def spawn_inspect(launcher, cwd, env, extra, timeout=20):
    return subprocess.run([NODE, str(launcher), '--rust', *extra], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=timeout)


def inspect_json(result):
    text = result.stdout + result.stderr
    start = text.find('{')
    end = text.rfind('}')
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None


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
            if prefix and not prefix.startswith('/'):
                wait_visible(prefix)
        for marker in wait_after:
            wait_visible(marker, 25)
        if then_typed:
            os.write(master, then_typed.encode())
            prefix = then_typed.split('\r', 1)[0]
            if prefix and not prefix.startswith('/'):
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


def serve(handler):
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', 0))
    listener.listen(8)
    port = listener.getsockname()[1]
    stop = threading.Event()

    def loop():
        listener.settimeout(0.2)
        while not stop.is_set():
            try:
                conn, _ = listener.accept()
            except socket.timeout:
                continue
            with conn:
                data = b''
                conn.settimeout(1)
                try:
                    while b'\r\n\r\n' not in data:
                        chunk = conn.recv(4096)
                        if not chunk:
                            break
                        data += chunk
                except OSError:
                    continue
                request = data.decode('latin1', 'replace')
                line = request.split('\r\n', 1)[0]
                status, body, content_type = handler(line)
                payload = body.encode()
                conn.sendall(
                    f'HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {len(payload)}\r\nConnection: close\r\n\r\n'.encode()
                    + payload
                )

    thread = threading.Thread(target=loop, daemon=True)
    thread.start()
    return f'http://127.0.0.1:{port}', stop


def sign_policy(_work, managed, requirements):
    payload = json.dumps({
        'typ': 'managed-policy',
        'key_id': 'v1',
        'expires_at': int(time.time()) + 3600,
        'deployment_id': 'dep-1',
        'managed_config': managed,
        'requirements': requirements,
        'fail_closed': True,
    }, separators=(',', ':'))
    script = """
import { generateKeyPairSync, sign } from 'node:crypto';
const payload = process.argv[1];
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const signature = sign(null, Buffer.from(payload), privateKey).toString('base64');
process.stdout.write(JSON.stringify({ pub, signature }));
"""
    signed = json.loads(run([NODE, '--input-type=module', '-e', script, payload]).stdout)
    sidecar = {
        'signed_payload': payload,
        'signature': signed['signature'],
        'key_id': 'v1',
    }
    return signed['pub'], sidecar


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-auth-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-auth-home-', dir='/tmp') as temporary:
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
default = "gateway"

[model.gateway]
name = "Local gateway"
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
""")
        results = {}

        help_home = work / 'help-home'
        help_home.mkdir()
        help_env = {**base_env, 'HOME': str(help_home)}
        for command in ('login', 'logout', 'setup'):
            shown = spawn_inspect(launcher, cwd, help_env, [command, '--help'])
            assert shown.returncode == 0, shown.stderr + shown.stdout
            assert command in shown.stdout.lower() or 'Sign' in shown.stdout or 'Fetch' in shown.stdout
            assert not (help_home / '.codsh-rust').exists()
        results['help-no-home'] = True

        refused = spawn_inspect(launcher, cwd, base_env, ['login', '--oauth'])
        combined = refused.stdout + refused.stderr
        assert refused.returncode != 0
        assert 'Official grok.com' in combined
        assert 'subscription' in combined.lower() or 'entitlement' in combined.lower()
        results['login-refuses-official'] = True

        inspect = spawn_inspect(launcher, cwd, base_env, ['inspect', '--json'])
        payload = json.loads(inspect.stdout)
        assert inspect.returncode == 0, inspect.stderr
        assert payload['officialLoginDisabled'] is True
        assert payload['auth']['method'] == 'api_key'
        assert payload['auth']['sessionTransferredToExternalServices'] is False
        results['inspect-api-key'] = payload['auth']

        blocked = spawn_inspect(launcher, cwd, {**base_env, 'GROK_DISABLE_API_KEY_AUTH': '1'}, ['inspect', '--json'])
        blocked_text = blocked.stdout + blocked.stderr
        assert blocked.returncode != 0
        blocked_payload = inspect_json(blocked)
        assert blocked_payload is not None, blocked_text
        assert blocked_payload['ready'] is False
        assert blocked_payload['auth']['disableApiKeyAuth'] is True
        assert 'disables API-key authentication' in blocked_text or 'identity session' in blocked_text
        results['inspect-disable-api-key'] = True

        pin_home = work / 'pin-home'
        pin_home.mkdir()
        pin_grok = pin_home / '.codsh-rust' / '.grok'
        pin_grok.mkdir(parents=True)
        (pin_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        pin_provider = 'printf \'%s\' \'{"access_token":"pin-token","expires_in":3600,"issuer":"http://127.0.0.1/idp"}\''
        pin_env = {
            **base_env,
            'HOME': str(pin_home),
            'GROK_DISABLE_API_KEY_AUTH': '1',
            'GROK_AUTH_PROVIDER_COMMAND': pin_provider,
        }
        pin_login = spawn_inspect(launcher, cwd, pin_env, ['login'])
        assert pin_login.returncode == 0, pin_login.stderr + pin_login.stdout
        stored_pin = json.loads((pin_grok / 'auth.json').read_text())
        assert stored_pin['access_token'] == 'pin-token'
        pin_inspect = spawn_inspect(launcher, cwd, pin_env, ['inspect', '--json'])
        assert pin_inspect.returncode == 0, pin_inspect.stderr + pin_inspect.stdout
        pin_payload = inspect_json(pin_inspect)
        assert pin_payload is not None, pin_inspect.stdout + pin_inspect.stderr
        assert pin_payload['ready'] is True
        assert pin_payload['auth']['sessionPresent'] is True
        assert pin_payload['auth']['disableApiKeyAuth'] is True
        results['login-under-org-pin'] = True

        empty_team = spawn_inspect(launcher, cwd, {**base_env, 'GROK_FORCE_LOGIN_TEAM_ID': '[]'}, ['inspect', '--json'])
        empty_text = empty_team.stdout + empty_team.stderr
        assert empty_team.returncode != 0
        empty_payload = inspect_json(empty_team)
        assert empty_payload is not None, empty_text
        assert empty_payload['ready'] is False
        assert empty_payload['auth']['forceLoginTeam'] == []
        results['inspect-empty-team'] = True

        req_home = work / 'req-home'
        req_home.mkdir()
        req_grok = req_home / '.codsh-rust' / '.grok'
        req_grok.mkdir(parents=True)
        (req_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        (req_grok / 'requirements.toml').write_text('[auth]\ndisable_api_key_auth = true\nforce_login_team_uuid = "team-good"\n')
        req_env = {**base_env, 'HOME': str(req_home)}
        locked = spawn_inspect(launcher, cwd, req_env, ['inspect', '--json'])
        locked_text = locked.stdout + locked.stderr
        assert locked.returncode != 0
        locked_payload = inspect_json(locked)
        assert locked_payload is not None, locked_text
        assert locked_payload['ready'] is False
        assert locked_payload['auth']['disableApiKeyAuth'] is True
        assert locked_payload['auth']['forceLoginTeam'] == ['team-good']
        results['inspect-locked-auth'] = True

        top_home = work / 'top-home'
        top_home.mkdir()
        top_grok = top_home / '.codsh-rust' / '.grok'
        top_grok.mkdir(parents=True)
        (top_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        (top_grok / 'requirements.toml').write_text('fail_closed = true\nforce_login_team_uuid = "team-good"\n')
        top_env = {**base_env, 'HOME': str(top_home)}
        top = spawn_inspect(launcher, cwd, top_env, ['inspect', '--json'])
        top_text = top.stdout + top.stderr
        assert top.returncode != 0
        top_payload = inspect_json(top)
        assert top_payload is not None, top_text
        assert top_payload['ready'] is False
        assert top_payload['auth']['forceLoginTeam'] == ['team-good']
        assert 'unknown security' not in top_text.lower()
        results['inspect-top-level-team'] = True

        provider = 'printf \'%s\' \'{"access_token":"sess-token","expires_in":3600,"issuer":"http://127.0.0.1/idp"}\''
        keyed = {**base_env, 'GROK_AUTH_PROVIDER_COMMAND': provider, 'GROK_AUTH_PROVIDER_LABEL': 'Acme'}
        logged = spawn_inspect(launcher, cwd, keyed, ['login'])
        assert logged.returncode == 0, logged.stderr + logged.stdout
        assert 'external provider' in logged.stdout
        assert 'not transferred' in logged.stdout
        auth_path = grok_home / 'auth.json'
        assert auth_path.is_file()
        assert (auth_path.stat().st_mode & 0o777) == 0o600
        stored = json.loads(auth_path.read_text())
        assert stored['access_token'] == 'sess-token'
        (grok_home / 'mcp_credentials.json').write_text('{"keep":true}')
        logged_inspect = json.loads(spawn_inspect(launcher, cwd, keyed, ['inspect', '--json']).stdout)
        assert logged_inspect['auth']['sessionPresent'] is True
        assert logged_inspect['auth']['method'] == 'external'
        results['login-external'] = {'mode': auth_path.stat().st_mode & 0o777}

        logged_out = spawn_inspect(launcher, cwd, keyed, ['logout'])
        assert logged_out.returncode == 0, logged_out.stderr + logged_out.stdout
        assert not auth_path.exists()
        assert (grok_home / 'mcp_credentials.json').read_text() == '{"keep":true}'
        assert 'not revoked' in logged_out.stdout
        results['logout'] = True

        unsigned_url, stop_unsigned = serve(lambda line: (200, '{"deployment_id":"dep-1","managed_config":"x=1\\n"}', 'application/json'))
        try:
            unsigned = spawn_inspect(launcher, cwd, {**base_env, 'GROK_MANAGED_CONFIG_URL': unsigned_url + '/deployment/config', 'GROK_DEPLOYMENT_KEY': 'dep'}, ['setup'])
            text = unsigned.stdout + unsigned.stderr
            assert unsigned.returncode != 0
            assert 'verif' in text.lower() or 'unsigned' in text.lower() or 'authentic' in text.lower()
        finally:
            stop_unsigned.set()
        results['setup-unsigned'] = True

        managed = 'remote_fetch = false\n'
        requirements = 'fail_closed = true\n'
        pubkey, sidecar = sign_policy(work, managed, requirements)
        body = json.dumps({
            'deployment_id': 'dep-1',
            'managed_config': managed,
            'requirements': requirements,
            'signatures': [sidecar],
        })
        signed_url, stop_signed = serve(lambda line: (200, body, 'application/json') if 'GET ' in line else (404, 'no', 'text/plain'))
        try:
            signed = spawn_inspect(launcher, cwd, {
                **base_env,
                'GROK_MANAGED_CONFIG_URL': signed_url + '/deployment/config',
                'GROK_DEPLOYMENT_KEY': 'dep',
                'GROK_MANAGED_CONFIG_PUBKEY': pubkey,
            }, ['setup'])
            assert signed.returncode == 0, signed.stderr + signed.stdout
            assert (grok_home / 'managed_config.toml').read_text() == managed
            assert (grok_home / 'managed_config.sig.json').is_file()
            assert ((grok_home / 'managed_config.sig.json').stat().st_mode & 0o777) == 0o600
        finally:
            stop_signed.set()
        results['setup-signed'] = True

        slash = pty_session(
            'slash-login-logout', launcher, cwd,
            {**base_env, 'GROK_AUTH_PROVIDER_COMMAND': provider},
            output,
            typed='/login\r',
            wait_before=['Connected to dsh ACP'],
            wait_after=['external provider', 'not transferred', 'Official grok.com'],
            then_typed='/logout\r',
            then_wait=['Signed out', 'not revoked'],
        )
        assert slash['exit'] == 0
        assert 'Signed out' in slash['screen']
        assert 'not revoked' in slash['screen']
        results['pty-slash'] = {'exit': slash['exit']}

        (output / 'result.json').write_text(json.dumps({'results': results}, indent=2) + '\n')
        print(output)
        print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
