#!/usr/bin/env python3
"""Installed-product inspect, first-run, and dsh mapping for ticket 139."""
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


def pty_session(name, launcher, cwd, env, output, typed=None, wait_before=(), wait_after=(), quit=True, cols=100, rows=30):
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
        for marker in wait_before:
            wait_visible(marker, 25)
        if typed:
            os.write(master, typed.encode())
            wait_visible(typed.split('\r', 1)[0] or typed)
        for marker in wait_after:
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
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-config-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-config-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        legacy_dsh = home / '.dsh'
        legacy_dsh.mkdir()
        (legacy_dsh / 'settings.yaml').write_text('synthetic-legacy-settings\n')
        (legacy_dsh / '.credentials.yaml').write_text('refs:\n  XAI_API_KEY: legacy-must-not-import\n')
        legacy_grok = home / '.grok'
        legacy_grok.mkdir()
        (legacy_grok / 'auth.json').write_text('{"token":"legacy-auth-must-not-import"}\n')
        (legacy_grok / 'config.toml').write_text('[model.stolen]\nbase_url="https://api.x.ai/v1"\n')
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
            'GROK_HOME': str(legacy_grok),
            'XAI_API_KEY': '',
        }
        rust_root = home / '.codsh-rust'
        grok_home = rust_root / '.grok'
        dsh_home = rust_root / 'dsh'
        results = {}

        help_home = work / 'help-home'
        help_home.mkdir()
        help_env = {**base_env, 'HOME': str(help_home)}
        help_run = spawn_inspect(launcher, cwd, help_env, ['inspect', '--help'])
        assert help_run.returncode == 0, help_run.stderr
        assert 'inspect' in help_run.stdout
        assert not (help_home / '.codsh-rust').exists()
        results['inspect-help'] = {'exit': help_run.returncode}

        empty = spawn_inspect(launcher, cwd, base_env, ['inspect', '--json'])
        assert empty.returncode == 0, empty.stderr + empty.stdout
        payload = json.loads(empty.stdout)
        assert payload['importedLegacyCredentials'] is False
        assert payload['officialLoginDisabled'] is True
        assert payload['telemetry'] is False
        assert payload['ready'] is False
        assert 'legacy-must-not-import' not in empty.stdout
        assert 'legacy-auth-must-not-import' not in empty.stdout
        assert 'api.x.ai' not in empty.stdout
        assert (legacy_dsh / 'settings.yaml').read_text() == 'synthetic-legacy-settings\n'
        assert (legacy_grok / 'auth.json').read_text().startswith('{"token":"legacy-auth-must-not-import"')
        results['inspect-empty'] = payload

        first = pty_session('first-run', launcher, cwd, base_env, output,
                            wait_before=['First-run', 'Official grok.com login/telemetry unused'])
        assert 'Connected to dsh ACP' not in first['screen']
        assert first['exit'] == 0
        results['pty-first-run'] = {'exit': first['exit']}

        grok_home.mkdir(parents=True, exist_ok=True)
        invalid_body = 'this is : not = toml [['
        (grok_home / 'config.toml').write_text(invalid_body)
        invalid = spawn_inspect(launcher, cwd, base_env, ['inspect'])
        assert invalid.returncode != 0
        assert str(grok_home / 'config.toml') in (invalid.stdout + invalid.stderr)
        assert 'Original file was not changed' in (invalid.stdout + invalid.stderr)
        assert (grok_home / 'config.toml').read_text() == invalid_body
        results['inspect-invalid'] = {'exit': invalid.returncode}

        config_text = """
[models]
default = "gateway"

[model.gateway]
name = "Local gateway"
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"

[features]
telemetry = true
"""
        (grok_home / 'config.toml').write_text(config_text)
        missing = spawn_inspect(launcher, cwd, base_env, ['inspect', '--json'])
        missing_payload = json.loads(missing.stdout)
        assert missing.returncode == 0
        assert missing_payload['ready'] is False
        assert 'XAI_API_KEY' in (missing_payload.get('missingCredential') or '')
        results['inspect-missing-key'] = missing_payload

        keyed_env = {**base_env, 'XAI_API_KEY': 'test-key-not-a-secret-for-logs'}
        ready = spawn_inspect(launcher, cwd, keyed_env, ['inspect', '--json'])
        ready_payload = json.loads(ready.stdout)
        assert ready.returncode == 0, ready.stderr
        assert ready_payload['ready'] is True
        settings = {row['key']: row for row in ready_payload['settings']}
        assert settings['models.default']['value'] == 'gateway'
        assert settings['models.default']['source'] == 'config.toml'
        assert settings['model.gateway.base_url']['value'] == 'http://127.0.0.1:9/v1'
        assert settings['XAI_API_KEY']['source'] == 'environment'
        assert settings['XAI_API_KEY']['value'] == '(set)'
        assert 'test-key-not-a-secret-for-logs' not in ready.stdout
        results['inspect-ready'] = {key: settings[key] for key in ('models.default', 'model.gateway.base_url', 'XAI_API_KEY')}

        cli = spawn_inspect(launcher, cwd, keyed_env, ['inspect', '--json', '--model', 'gateway'])
        cli_payload = json.loads(cli.stdout)
        cli_settings = {row['key']: row for row in cli_payload['settings']}
        assert cli_settings['models.default']['source'] == 'cli'
        overlay_env = {**keyed_env, 'GROK_CONFIG': json.dumps({'model': {'gateway': {'base_url': 'http://127.0.0.1:99/v1'}}})}
        overlay_run = spawn_inspect(launcher, cwd, overlay_env, ['inspect', '--json'])
        overlay_payload = json.loads(overlay_run.stdout)
        overlay_settings = {row['key']: row for row in overlay_payload['settings']}
        assert overlay_settings['model.gateway.base_url']['value'] == 'http://127.0.0.1:99/v1'
        assert overlay_settings['model.gateway.base_url']['source'] == 'overlay'
        results['inspect-precedence'] = {
            'cli': cli_settings['models.default']['source'],
            'overlay': overlay_settings['model.gateway.base_url'],
        }

        other_home = work / 'other-home'
        other_home.mkdir()
        other_env = {**keyed_env, 'HOME': str(other_home), 'GROK_HOME': str(legacy_grok)}
        other_grok = other_home / '.codsh-rust' / '.grok'
        other_grok.mkdir(parents=True)
        (other_grok / 'config.toml').write_text("""
[model.alt]
model = "alt-model"
base_url = "http://127.0.0.1:77/v1"
env_key = "XAI_API_KEY"
""")
        alt_run = spawn_inspect(launcher, cwd, other_env, ['inspect', '--json'])
        assert alt_run.returncode == 0, alt_run.stderr + alt_run.stdout
        alt_payload = json.loads(alt_run.stdout)
        alt_settings = {row['key']: row for row in alt_payload['settings']}
        assert Path(alt_settings['GROK_HOME']['value']).resolve() == other_grok.resolve()
        assert alt_settings['model.alt.base_url']['value'] == 'http://127.0.0.1:77/v1'
        assert 'api.x.ai' not in alt_run.stdout
        assert (legacy_grok / 'auth.json').read_text().startswith('{"token":"legacy-auth-must-not-import"')
        results['inspect-grok-home'] = alt_settings['GROK_HOME']

        mock_env = {**keyed_env, 'CODSH_ACP_PATCH': str(patch), 'DSH_CODE_CLI_MOCK_TOOL': 'echo'}
        configured = pty_session('configured-turn', launcher, cwd, mock_env, output,
                                 typed='TOKEN_CONFIG_ONE\r',
                                 wait_before=['Connected to dsh ACP'],
                                 wait_after=['RUST_ACP_ANSWER', 'TOKEN_CONFIG_ONE'])
        assert configured['exit'] == 0
        generated = (dsh_home / 'settings.yaml').read_text()
        assert generated.startswith('# generated-by: codsh-rust-config')
        assert 'http://127.0.0.1:9/v1' in generated
        assert (legacy_dsh / 'settings.yaml').read_text() == 'synthetic-legacy-settings\n'
        results['pty-configured'] = {'exit': configured['exit'], 'settings': generated}

        (grok_home / 'config.toml').write_text("""
[models]
default = "gateway"

[model.gateway]
name = "Local gateway"
model = "mock-model"
base_url = "http://127.0.0.1:11/v1"
env_key = "XAI_API_KEY"
""")
        restarted = spawn_inspect(launcher, cwd, keyed_env, ['inspect', '--json'])
        restarted_payload = json.loads(restarted.stdout)
        restarted_settings = {row['key']: row for row in restarted_payload['settings']}
        assert restarted_settings['model.gateway.base_url']['value'] == 'http://127.0.0.1:11/v1'
        restart_pty = pty_session('restart-turn', launcher, cwd, mock_env, output,
                                  typed='TOKEN_CONFIG_TWO\r',
                                  wait_before=['Connected to dsh ACP'],
                                  wait_after=['RUST_ACP_ANSWER', 'TOKEN_CONFIG_TWO'])
        assert restart_pty['exit'] == 0
        generated_after = (dsh_home / 'settings.yaml').read_text()
        assert 'http://127.0.0.1:11/v1' in generated_after
        results['pty-restart'] = {'base_url': restarted_settings['model.gateway.base_url']['value']}

        (dsh_home / 'settings.yaml').write_text('llm-pi-ai:\n  providers: {}\n')
        conflict = pty_session('conflict', launcher, cwd, mock_env, output,
                               wait_before=['refusing to overwrite'])
        assert (dsh_home / 'settings.yaml').read_text() == 'llm-pi-ai:\n  providers: {}\n'
        assert conflict['exit'] == 0
        results['pty-conflict'] = {'unchanged': True}

        missing_pty = pty_session('missing-credential', launcher, cwd, base_env, output,
                                  wait_before=['Missing credential', 'XAI_API_KEY'])
        assert 'No hidden default key' in missing_pty['screen']
        results['pty-missing'] = {'exit': missing_pty['exit']}

        (output / 'result.json').write_text(json.dumps({
            'results': {key: ('ok' if value is not None else value) for key, value in results.items()},
            'inspectReady': results['inspect-ready'],
            'inspectPrecedence': results['inspect-precedence'],
            'generatedAfterRestart': generated_after,
            'legacySettings': (legacy_dsh / 'settings.yaml').read_text(),
            'legacyAuth': (legacy_grok / 'auth.json').read_text(),
        }, indent=2) + '\n')
        (output / 'inspect-empty.json').write_text(empty.stdout)
        (output / 'inspect-ready.json').write_text(ready.stdout)
    print(f'PASS: rust first-run/inspect/config PTY; evidence: {output}')


if __name__ == '__main__':
    main()
