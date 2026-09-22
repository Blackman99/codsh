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


def sign_payload(payload):
    script = """
import { generateKeyPairSync, sign } from 'node:crypto';
const payload = process.argv[1];
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const signature = sign(null, Buffer.from(payload), privateKey).toString('base64');
process.stdout.write(JSON.stringify({ pub, signature }));
"""
    signed = json.loads(run([NODE, '--input-type=module', '-e', script, payload]).stdout)
    return signed['pub'], signed['signature']


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
    pub, signature = sign_payload(payload)
    sidecar = {
        'signed_payload': payload,
        'signature': signature,
        'key_id': 'v1',
    }
    return pub, sidecar


def install_verifiable_requirements(grok, requirements):
    """Sign fail-closed requirements so the team pin, not a missing sidecar, is the gate."""
    payload = json.dumps({
        'typ': 'managed-policy',
        'expires_at': int(time.time()) + 3600,
        'team_id': 'team-good',
        'managed_config': '',
        'requirements': requirements,
    }, separators=(',', ':'))
    pub, signature = sign_payload(payload)
    (grok / 'managed_config.sig.json').write_text(json.dumps({
        'signed_payload': payload,
        'signature': signature,
        'key_id': 'v1',
    }))
    return pub


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
        top_body = 'fail_closed = true\nforce_login_team_uuid = "team-good"\n'
        (top_grok / 'requirements.toml').write_text(top_body)
        top_pub = install_verifiable_requirements(top_grok, top_body)
        top_env = {**base_env, 'HOME': str(top_home), 'GROK_MANAGED_CONFIG_PUBKEY': top_pub}
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

        other_managed = 'remote_fetch = false\n'
        other_requirements = 'fail_closed = true\n'
        other_payload = json.dumps({
            'typ': 'managed-policy',
            'key_id': 'v1',
            'expires_at': int(time.time()) + 3600,
            'deployment_id': 'dep-other',
            'managed_config': other_managed,
            'requirements': other_requirements,
            'fail_closed': True,
        }, separators=(',', ':'))
        other_pub, other_sig = sign_payload(other_payload)
        other_body = json.dumps({
            'deployment_id': 'dep-1',
            'managed_config': other_managed,
            'requirements': other_requirements,
            'signatures': [{
                'signed_payload': other_payload,
                'signature': other_sig,
                'key_id': 'v1',
            }],
        })
        other_url, stop_other = serve(lambda line: (200, other_body, 'application/json') if 'GET ' in line else (404, 'no', 'text/plain'))
        other_home = work / 'other-principal-home'
        other_home.mkdir()
        other_grok = other_home / '.codsh-rust' / '.grok'
        other_grok.mkdir(parents=True)
        (other_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        (other_grok / 'auth.json').write_text(json.dumps({
            'access_token': 'caller-token',
            'method': 'external',
            'team_id': 'team-caller',
            'expires_at': int(time.time()) + 3600,
        }))
        try:
            other = spawn_inspect(launcher, cwd, {
                **base_env,
                'HOME': str(other_home),
                'GROK_MANAGED_CONFIG_URL': other_url + '/deployment/config',
                'GROK_DEPLOYMENT_KEY': 'dep',
                'GROK_MANAGED_CONFIG_PUBKEY': other_pub,
            }, ['setup'])
            other_text = other.stdout + other.stderr
            assert other.returncode != 0, other_text
            assert 'different principal' in other_text
            assert not (other_grok / 'managed_config.toml').exists()
        finally:
            stop_other.set()
        results['setup-other-principal'] = True

        omitted_payload = json.dumps({
            'typ': 'managed-policy',
            'key_id': 'v1',
            'expires_at': int(time.time()) + 3600,
            'managed_config': other_managed,
            'requirements': other_requirements,
            'fail_closed': True,
        }, separators=(',', ':'))
        omitted_pub, omitted_sig = sign_payload(omitted_payload)
        omitted_body = json.dumps({
            'managed_config': other_managed,
            'requirements': other_requirements,
            'signatures': [{
                'signed_payload': omitted_payload,
                'signature': omitted_sig,
                'key_id': 'v1',
            }],
        })
        omitted_url, stop_omitted = serve(lambda line: (200, omitted_body, 'application/json') if 'GET ' in line else (404, 'no', 'text/plain'))
        omitted_home = work / 'omitted-principal-home'
        omitted_home.mkdir()
        omitted_grok = omitted_home / '.codsh-rust' / '.grok'
        omitted_grok.mkdir(parents=True)
        (omitted_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        (omitted_grok / 'auth.json').write_text((other_grok / 'auth.json').read_text())
        try:
            omitted = spawn_inspect(launcher, cwd, {
                **base_env,
                'HOME': str(omitted_home),
                'GROK_MANAGED_CONFIG_URL': omitted_url + '/deployment/config',
                'GROK_DEPLOYMENT_KEY': 'dep',
                'GROK_MANAGED_CONFIG_PUBKEY': omitted_pub,
            }, ['setup'])
            omitted_text = omitted.stdout + omitted.stderr
            assert omitted.returncode != 0, omitted_text
            assert 'omits its principal' in omitted_text or 'different principal' in omitted_text
            assert not (omitted_grok / 'managed_config.toml').exists()
        finally:
            stop_omitted.set()
        results['setup-omitted-principal'] = True

        noteam_payload = json.dumps({
            'typ': 'managed-policy',
            'key_id': 'v1',
            'expires_at': int(time.time()) + 3600,
            'deployment_id': 'dep-other',
            'managed_config': other_managed,
            'requirements': other_requirements,
            'fail_closed': True,
        }, separators=(',', ':'))
        noteam_pub, noteam_sig = sign_payload(noteam_payload)
        noteam_body = json.dumps({
            'managed_config': other_managed,
            'requirements': other_requirements,
            'signatures': [{
                'signed_payload': noteam_payload,
                'signature': noteam_sig,
                'key_id': 'v1',
            }],
        })
        noteam_url, stop_noteam = serve(lambda line: (200, noteam_body, 'application/json') if 'GET ' in line else (404, 'no', 'text/plain'))
        noteam_home = work / 'noteam-other-home'
        noteam_home.mkdir()
        noteam_grok = noteam_home / '.codsh-rust' / '.grok'
        noteam_grok.mkdir(parents=True)
        (noteam_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        try:
            noteam = spawn_inspect(launcher, cwd, {
                **base_env,
                'HOME': str(noteam_home),
                'GROK_MANAGED_CONFIG_URL': noteam_url + '/deployment/config',
                'GROK_DEPLOYMENT_KEY': 'dep',
                'GROK_MANAGED_CONFIG_PUBKEY': noteam_pub,
            }, ['setup'])
            noteam_text = noteam.stdout + noteam.stderr
            assert noteam.returncode != 0, noteam_text
            assert 'different principal' in noteam_text or 'omits its principal' in noteam_text
            assert not (noteam_grok / 'managed_config.toml').exists()
        finally:
            stop_noteam.set()
        blank_payload = json.dumps({
            'typ': 'managed-policy',
            'key_id': 'v1',
            'expires_at': int(time.time()) + 3600,
            'managed_config': other_managed,
            'requirements': other_requirements,
            'fail_closed': True,
        }, separators=(',', ':'))
        blank_pub, blank_sig = sign_payload(blank_payload)
        blank_body = json.dumps({
            'managed_config': other_managed,
            'requirements': other_requirements,
            'signatures': [{
                'signed_payload': blank_payload,
                'signature': blank_sig,
                'key_id': 'v1',
            }],
        })
        blank_url, stop_blank = serve(lambda line: (200, blank_body, 'application/json') if 'GET ' in line else (404, 'no', 'text/plain'))
        try:
            blank = spawn_inspect(launcher, cwd, {
                **base_env,
                'HOME': str(noteam_home),
                'GROK_MANAGED_CONFIG_URL': blank_url + '/deployment/config',
                'GROK_DEPLOYMENT_KEY': 'dep',
                'GROK_MANAGED_CONFIG_PUBKEY': blank_pub,
            }, ['setup'])
            blank_text = blank.stdout + blank.stderr
            assert blank.returncode != 0, blank_text
            assert 'omits its principal' in blank_text or 'different principal' in blank_text
            assert not (noteam_grok / 'managed_config.toml').exists()
        finally:
            stop_blank.set()
        results['setup-noteam-deployment-key'] = True

        disk_home = work / 'disk-other-home'
        disk_home.mkdir()
        disk_grok = disk_home / '.codsh-rust' / '.grok'
        disk_grok.mkdir(parents=True)
        (disk_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        (disk_grok / 'managed_config.toml').write_text(other_managed)
        (disk_grok / 'requirements.toml').write_text(other_requirements)
        (disk_grok / 'auth.json').write_text(json.dumps({
            'access_token': 'caller-token',
            'method': 'external',
            'team_id': 'team-caller',
            'expires_at': int(time.time()) + 3600,
        }))
        (disk_grok / 'managed_config.sig.json').write_text(json.dumps({
            'signed_payload': other_payload,
            'signature': other_sig,
            'key_id': 'v1',
        }))
        disk = spawn_inspect(launcher, cwd, {
            **base_env,
            'HOME': str(disk_home),
            'GROK_MANAGED_CONFIG_PUBKEY': other_pub,
            'GROK_DEPLOYMENT_KEY': 'dep',
        }, ['inspect', '--json'])
        disk_text = disk.stdout + disk.stderr
        assert disk.returncode != 0, disk_text
        assert 'different principal' in disk_text or 'omits its principal' in disk_text
        disk_payload = inspect_json(disk)
        assert disk_payload is not None, disk_text
        assert disk_payload['ready'] is False
        (disk_grok / 'managed_config.sig.json').write_text(json.dumps({
            'signed_payload': omitted_payload,
            'signature': omitted_sig,
            'key_id': 'v1',
        }))
        disk_blank = spawn_inspect(launcher, cwd, {
            **base_env,
            'HOME': str(disk_home),
            'GROK_MANAGED_CONFIG_PUBKEY': omitted_pub,
        }, ['inspect', '--json'])
        disk_blank_text = disk_blank.stdout + disk_blank.stderr
        assert disk_blank.returncode != 0, disk_blank_text
        assert 'omits its principal' in disk_blank_text or 'different principal' in disk_blank_text
        results['inspect-other-principal'] = True

        locked_home = work / 'locked-unverifiable-home'
        locked_home.mkdir()
        locked_grok = locked_home / '.codsh-rust' / '.grok'
        locked_grok.mkdir(parents=True)
        (locked_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        (locked_grok / 'managed_config.toml').write_text('remote_fetch = false\n')
        (locked_grok / 'requirements.toml').write_text('fail_closed = true\n')
        locked = spawn_inspect(launcher, cwd, {**base_env, 'HOME': str(locked_home)}, ['inspect', '--json'])
        locked_text = locked.stdout + locked.stderr
        assert locked.returncode != 0, locked_text
        assert 'cannot be verified' in locked_text
        locked_payload = inspect_json(locked)
        assert locked_payload is not None, locked_text
        assert locked_payload['ready'] is False
        results['inspect-unverifiable-lock'] = True

        revoke_seen = {'n': 0}

        def revoke_handler(line):
            if line.startswith('POST /revoke'):
                revoke_seen['n'] += 1
                return 200, '{"revoked":true}', 'application/json'
            return 404, 'no', 'text/plain'

        revoke_url, stop_revoke = serve(revoke_handler)
        revoke_home = work / 'revoke-home'
        revoke_home.mkdir()
        revoke_grok = revoke_home / '.codsh-rust' / '.grok'
        revoke_grok.mkdir(parents=True)
        (revoke_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        (revoke_grok / 'auth.json').write_text(json.dumps({
            'access_token': 'revoke-me',
            'method': 'external',
            'expires_at': int(time.time()) + 3600,
        }))
        try:
            revoked = spawn_inspect(launcher, cwd, {
                **base_env,
                'HOME': str(revoke_home),
                'GROK_AUTH_REVOKE_URL': revoke_url + '/revoke',
            }, ['logout'])
        finally:
            stop_revoke.set()
        revoke_text = revoked.stdout + revoked.stderr
        assert revoked.returncode == 0, revoke_text
        assert revoke_seen['n'] == 1
        assert not (revoke_grok / 'auth.json').exists()
        assert 'revoked' in revoke_text.lower()
        results['logout-revokes'] = True

        def revoke_down(_line):
            return 500, 'down', 'text/plain'

        down_url, stop_down = serve(revoke_down)
        down_home = work / 'revoke-down-home'
        down_home.mkdir()
        down_grok = down_home / '.codsh-rust' / '.grok'
        down_grok.mkdir(parents=True)
        (down_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        (down_grok / 'auth.json').write_text((revoke_grok / 'auth.json').read_text() if (revoke_grok / 'auth.json').exists() else json.dumps({
            'access_token': 'keep-me',
            'method': 'external',
        }))
        (down_grok / 'auth.json').write_text(json.dumps({
            'access_token': 'keep-me',
            'method': 'external',
            'expires_at': int(time.time()) + 3600,
        }))
        try:
            down = spawn_inspect(launcher, cwd, {
                **base_env,
                'HOME': str(down_home),
                'GROK_AUTH_REVOKE_URL': down_url + '/revoke',
            }, ['logout'])
        finally:
            stop_down.set()
        down_text = down.stdout + down.stderr
        assert down.returncode != 0, down_text
        assert 'revocation failed' in down_text.lower() or 'revocation' in down_text.lower()
        assert json.loads((down_grok / 'auth.json').read_text())['access_token'] == 'keep-me'
        results['logout-revoke-keeps-session'] = True

        unsigned_url, stop_unsigned = serve(lambda line: (200, '{"deployment_id":"dep-1","managed_config":"x=1\\n"}', 'application/json'))
        try:
            unsigned = spawn_inspect(launcher, cwd, {**base_env, 'GROK_MANAGED_CONFIG_URL': unsigned_url + '/deployment/config', 'GROK_DEPLOYMENT_KEY': 'dep'}, ['setup'])
            text = unsigned.stdout + unsigned.stderr
            assert unsigned.returncode != 0
            assert 'verif' in text.lower() or 'unsigned' in text.lower() or 'authentic' in text.lower()
        finally:
            stop_unsigned.set()
        results['setup-unsigned'] = True

        managed = '[features]\nremote_fetch = false\n'
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

        device_polls = {'n': 0}

        def device_handler(line):
            if '/oauth2/device/code' in line:
                body = json.dumps({
                    'device_code': 'device-1',
                    'user_code': 'ABCD-EFGH',
                    'verification_uri': 'http://127.0.0.1/device',
                    'expires_in': 30,
                    'interval': 1,
                })
                return 200, body, 'application/json'
            device_polls['n'] += 1
            if device_polls['n'] == 1:
                return 400, '{"error":"authorization_pending"}', 'application/json'
            return 200, '{"access_token":"device-token","refresh_token":"rt","expires_in":3600}', 'application/json'

        device_url, stop_device = serve(device_handler)
        device_home = work / 'device-home'
        device_home.mkdir()
        device_grok = device_home / '.codsh-rust' / '.grok'
        device_grok.mkdir(parents=True)
        (device_grok / 'config.toml').write_text(
            (grok_home / 'config.toml').read_text()
            + f'\n[auth.oauth2]\nissuer = "{device_url}"\nclient_id = "device-client"\n'
        )
        try:
            device_login = spawn_inspect(
                launcher, cwd, {**base_env, 'HOME': str(device_home)},
                ['login', '--device-auth'], timeout=40,
            )
        finally:
            stop_device.set()
        device_text = device_login.stdout + device_login.stderr
        assert device_login.returncode == 0, device_text
        assert 'device-code' in device_text
        assert device_polls['n'] >= 2
        stored_device = json.loads((device_grok / 'auth.json').read_text())
        assert stored_device['access_token'] == 'device-token'
        assert stored_device['method'] == 'device'
        results['login-device-auth'] = {'polls': device_polls['n']}

        pin_pty_home = work / 'pin-pty-home'
        pin_pty_grok = pin_pty_home / '.codsh-rust' / '.grok'
        pin_pty_grok.mkdir(parents=True)
        (pin_pty_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        pinned = pty_session(
            'slash-login-under-pin', launcher, cwd,
            {**base_env, 'HOME': str(pin_pty_home), 'GROK_DISABLE_API_KEY_AUTH': '1', 'GROK_AUTH_PROVIDER_COMMAND': provider},
            output,
            typed='/login\r',
            wait_before=['disables API-key authentication'],
            wait_after=['external provider', 'not transferred', 'Connected to dsh ACP'],
        )
        assert pinned['exit'] == 0
        screen = pinned['screen']
        assert 'external provider' in screen
        assert 'Connected to dsh ACP' in screen
        assert 'disables API-key authentication' not in screen
        assert 'Execution unavailable' not in screen
        results['pty-slash-under-pin'] = {'exit': pinned['exit']}

        capture_path = work / 'dsh-child-env.json'
        capture_agent = work / 'capture-dsh.mjs'
        capture_agent.write_text(
            "import { appendFileSync } from 'node:fs';\n"
            f"const out = {json.dumps(str(capture_path))};\n"
            "appendFileSync(out, JSON.stringify({\n"
            "  GROK_AUTH_PATH: process.env.GROK_AUTH_PATH ?? null,\n"
            "  GROK_AUTH_ACCESS_TOKEN: process.env.GROK_AUTH_ACCESS_TOKEN ?? null,\n"
            "  GROK_AUTH_PROVIDER_COMMAND: process.env.GROK_AUTH_PROVIDER_COMMAND ?? null,\n"
            "  GROK_AUTH_NOISE: process.env.GROK_AUTH_NOISE ?? null,\n"
            "}) + '\\n');\n"
            "let buffer = '';\n"
            "process.stdin.setEncoding('utf8');\n"
            "process.stdin.on('data', chunk => {\n"
            "  buffer += chunk;\n"
            "  let newline;\n"
            "  while ((newline = buffer.indexOf('\\n')) >= 0) {\n"
            "    const line = buffer.slice(0, newline);\n"
            "    buffer = buffer.slice(newline + 1);\n"
            "    let message;\n"
            "    try { message = JSON.parse(line); } catch { continue; }\n"
            "    const id = message.id;\n"
            "    const method = message.method;\n"
            "    const reply = payload => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: payload }) + '\\n');\n"
            "    if (method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });\n"
            "    else if (method === 'session/new') reply({ sessionId: 'handed-session' });\n"
            "    else if (method === 'session/set_config' || method === 'session/set_config_option') reply({});\n"
            "    else if (id !== undefined) reply({});\n"
            "  }\n"
            "});\n"
        )
        handoff_home = work / 'handoff-home'
        handoff_home.mkdir()
        handoff_grok = handoff_home / '.codsh-rust' / '.grok'
        handoff_grok.mkdir(parents=True)
        (handoff_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        (handoff_grok / 'auth.json').write_text(json.dumps({
            'access_token': 'handed-to-dsh',
            'method': 'external',
            'expires_at': int(time.time()) + 3600,
        }))
        handoff = pty_session(
            'identity-handed-to-dsh', launcher, cwd,
            {
                **base_env,
                'HOME': str(handoff_home),
                'GROK_DISABLE_API_KEY_AUTH': '1',
                'GROK_AUTH_PROVIDER_COMMAND': provider,
                'GROK_AUTH_NOISE': 'must-not-reach-child',
                'DSH_BIN': str(capture_agent),
            },
            output,
            wait_after=['Connected to dsh ACP'],
        )
        assert handoff['exit'] == 0, handoff['screen']
        assert capture_path.is_file(), 'ready identity session did not spawn dsh'
        child_env = json.loads(capture_path.read_text().splitlines()[-1])
        assert child_env['GROK_AUTH_ACCESS_TOKEN'] == 'handed-to-dsh', child_env
        assert child_env['GROK_AUTH_PATH']
        assert 'printf' in (child_env['GROK_AUTH_PROVIDER_COMMAND'] or ''), child_env
        assert child_env['GROK_AUTH_NOISE'] is None, child_env
        results['identity-handed-to-dsh'] = True

        slash_home = work / 'slash-home'
        slash_home.mkdir()
        slash_grok = slash_home / '.codsh-rust' / '.grok'
        slash_grok.mkdir(parents=True)
        (slash_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        slash = pty_session(
            'slash-login-logout', launcher, cwd,
            {**base_env, 'HOME': str(slash_home), 'GROK_AUTH_PROVIDER_COMMAND': provider},
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
