#!/usr/bin/env python3
"""Installed-product plugin marketplace/install lifecycle for ticket 165."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

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


def spawn_rust(launcher, cwd, env, extra):
    return subprocess.run([NODE, str(launcher), '--rust', *extra], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=20)


def write_plugin(path, name, version, license='MIT'):
    path.mkdir(parents=True, exist_ok=True)
    (path / 'plugin.json').write_text(json.dumps({
        'name': name, 'version': version, 'license': license, 'description': 'fixture plugin',
    }))
    (path / 'skills').mkdir(exist_ok=True)
    (path / 'skills' / 'SKILL.md').write_text('# skill\n')


def write_marketplace(root, name='sample-tools', version='1.0.0'):
    plugin = root / 'plugins' / name
    write_plugin(plugin, name, version)
    grok = root / '.grok-plugin'
    grok.mkdir(parents=True, exist_ok=True)
    (grok / 'marketplace.json').write_text(json.dumps({
        'name': 'Fixtures',
        'plugins': [{
            'name': name,
            'version': version,
            'license': 'MIT',
            'source': {'type': 'local', 'path': f'./plugins/{name}'},
        }],
    }))


def pty_session(name, launcher, cwd, env, output, typed, wait_after, cols=100, rows=30):
    import fcntl
    import pty
    import select
    import struct
    import termios
    import time
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
        os.write(master, typed.encode())
        for marker in wait_after:
            wait_visible(marker, 25)
        shown = visible()
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
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-plugin-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-plugin-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        canary = cwd / 'notes.txt'
        canary.write_text('keep-me\n')
        marketplace = work / 'market'
        write_marketplace(marketplace, 'sample-tools', '1.0.0')
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
        grok_home = home / '.codsh-rust' / '.grok'
        grok_home.mkdir(parents=True)
        (grok_home / 'config.toml').write_text("""
[models]
default = "user-model"

[model.user-model]
name = "User model"
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
""")
        base_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE,
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'CODSH_UPDATE_CHECK': 'off',
            'XAI_API_KEY': 'test-key-not-a-secret-for-logs',
            'CODSH_ACP_PATCH': str(patch), 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }
        results = {}

        help_run = spawn_rust(launcher, cwd, base_env, ['plugin', '--help'])
        assert help_run.returncode == 0, help_run.stderr + help_run.stdout
        assert 'Manage plugins and marketplace sources' in help_run.stdout
        assert 'install' in help_run.stdout and 'marketplace' in help_run.stdout
        results['plugin-help'] = {'exit': help_run.returncode}

        inspect_empty = spawn_rust(launcher, cwd, base_env, ['inspect', '--json'])
        assert inspect_empty.returncode == 0, inspect_empty.stderr + inspect_empty.stdout
        empty_payload = json.loads(inspect_empty.stdout)
        assert empty_payload['plugins']['autoRegisterOfficial'] is False
        assert empty_payload['plugins']['marketplaces'] == []
        assert empty_payload['plugins']['installed'] == []
        results['inspect-empty'] = {'autoRegisterOfficial': False}

        add = spawn_rust(launcher, cwd, base_env, ['plugin', 'marketplace', 'add', str(marketplace)])
        assert add.returncode == 0, add.stderr + add.stdout
        assert 'Added marketplace source' in add.stdout
        listed = spawn_rust(launcher, cwd, base_env, ['plugin', 'marketplace', 'list', '--json'])
        listed_payload = json.loads(listed.stdout)
        assert any(row['kind'] == 'local' for row in listed_payload)
        results['marketplace-add'] = {'exit': add.returncode}

        denied = spawn_rust(launcher, cwd, base_env, ['plugin', 'install', 'sample-tools'])
        assert denied.returncode != 0
        assert 'requires confirmation' in denied.stderr + denied.stdout
        inspect_denied = json.loads(spawn_rust(launcher, cwd, base_env, ['inspect', '--json']).stdout)
        assert inspect_denied['plugins']['installed'] == []
        results['install-denied'] = {'exit': denied.returncode}

        installed = spawn_rust(launcher, cwd, base_env, ['plugin', 'install', 'sample-tools', '--trust'])
        assert installed.returncode == 0, installed.stderr + installed.stdout
        assert 'Installed' in installed.stdout
        assert 'execution is not granted' in installed.stdout
        inspect_ok = json.loads(spawn_rust(launcher, cwd, base_env, ['inspect', '--json']).stdout)
        row = inspect_ok['plugins']['installed'][0]
        assert row['name'] == 'sample-tools'
        assert row['version'] == '1.0.0'
        assert row['license'] == 'MIT'
        assert row['trusted'] is True
        assert row['enabled'] is False
        assert row['executionGranted'] is False
        assert Path(row['path']).exists()
        results['install-ok'] = row

        write_plugin(marketplace / 'plugins' / 'sample-tools', 'sample-tools', '1.1.0')
        updated = spawn_rust(launcher, cwd, base_env, ['plugin', 'update', 'sample-tools'])
        assert updated.returncode == 0, updated.stderr + updated.stdout
        after_update = json.loads(spawn_rust(launcher, cwd, base_env, ['inspect', '--json']).stdout)
        assert after_update['plugins']['installed'][0]['version'] == '1.1.0'
        results['update-ok'] = {'version': '1.1.0'}

        import shutil
        shutil.rmtree(marketplace / 'plugins' / 'sample-tools')
        failed = spawn_rust(launcher, cwd, base_env, ['plugin', 'update', 'sample-tools'])
        assert failed.returncode != 0
        recovered = json.loads(spawn_rust(launcher, cwd, base_env, ['inspect', '--json']).stdout)
        assert recovered['plugins']['installed'][0]['name'] == 'sample-tools'
        assert Path(recovered['plugins']['installed'][0]['path']).exists()
        results['update-failed-recoverable'] = {'exit': failed.returncode}

        ui = pty_session('plugins-ui', launcher, cwd, base_env, output,
                         typed='/plugins\r',
                         wait_after=['Plugins', 'sample-tools', '1.1.0', 'MIT', 'market'])
        assert ui['exit'] == 0
        assert 'execution is not granted' not in ui['screen'] or 'exec=false' in ui['screen']
        assert 'exec=false' in ui['screen']
        results['pty-plugins'] = {'exit': ui['exit']}

        ctrl_l = pty_session('ctrl-l', launcher, cwd, base_env, output,
                             typed='\x0c',
                             wait_after=['Draft (not sent)'])
        assert ctrl_l['exit'] == 0
        assert 'Plugins  (Tab' not in ctrl_l['screen'], ctrl_l['screen']
        assert 'Marketplace  (Tab' not in ctrl_l['screen'], ctrl_l['screen']
        results['pty-ctrl-l'] = {'openedPlugins': False}

        removed = spawn_rust(launcher, cwd, base_env, ['plugin', 'uninstall', 'sample-tools'])
        assert removed.returncode == 0, removed.stderr + removed.stdout
        after_remove = json.loads(spawn_rust(launcher, cwd, base_env, ['inspect', '--json']).stdout)
        assert after_remove['plugins']['installed'] == []
        assert canary.read_text() == 'keep-me\n'
        results['uninstall'] = {'canary': True}

        offline = spawn_rust(launcher, cwd, {**base_env, 'GROK_MARKETPLACE_REQUIRE_SHA': '1'},
                             ['plugin', 'install', 'https://example.invalid/plugins.git', '--trust'])
        assert offline.returncode != 0
        assert 'unpinned' in (offline.stderr + offline.stdout)
        results['require-sha'] = {'exit': offline.returncode}

        git_market = work / 'git-market'
        write_marketplace(git_market, 'git-tools', '2.0.0')
        run(['git', 'init', '--initial-branch', 'main'], cwd=git_market)
        run(['git', 'config', 'user.email', 'test@example.com'], cwd=git_market)
        run(['git', 'config', 'user.name', 'Test'], cwd=git_market)
        run(['git', 'add', '.'], cwd=git_market)
        run(['git', 'commit', '-m', 'init'], cwd=git_market, env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
        git_url = f'file://{git_market}'
        added_git = spawn_rust(launcher, cwd, base_env, ['plugin', 'marketplace', 'add', git_url, '--force'])
        assert added_git.returncode == 0, added_git.stderr + added_git.stdout
        listed_git = spawn_rust(launcher, cwd, base_env, ['plugin', 'marketplace', 'list'])
        assert listed_git.returncode == 0, listed_git.stderr + listed_git.stdout
        assert 'git-tools' in listed_git.stdout, listed_git.stdout
        installed_git = spawn_rust(launcher, cwd, base_env, ['plugin', 'install', 'git-tools', '--trust'])
        assert installed_git.returncode == 0, installed_git.stderr + installed_git.stdout
        inspect_git = json.loads(spawn_rust(launcher, cwd, base_env, ['inspect', '--json']).stdout)
        names = [row['name'] for row in inspect_git['plugins']['installed']]
        assert 'git-tools' in names
        git_row = next(row for row in inspect_git['plugins']['installed'] if row['name'] == 'git-tools')
        assert git_row['version'] == '2.0.0'
        assert git_row['executionGranted'] is False
        results['git-marketplace'] = {'version': git_row['version']}

        two_market = work / 'two-market'
        write_marketplace(two_market, 'alpha-tools', '1.0.0')
        write_plugin(two_market / 'plugins' / 'beta-tools', 'beta-tools', '1.0.0')
        grok = two_market / '.grok-plugin'
        grok.mkdir(parents=True, exist_ok=True)
        (grok / 'marketplace.json').write_text(json.dumps({
            'name': 'Two',
            'plugins': [
                {'name': 'alpha-tools', 'version': '1.0.0', 'license': 'MIT',
                 'source': {'type': 'local', 'path': './plugins/alpha-tools'}},
                {'name': 'beta-tools', 'version': '1.0.0', 'license': 'MIT',
                 'source': {'type': 'local', 'path': './plugins/beta-tools'}},
            ],
        }))
        added_two = spawn_rust(launcher, cwd, base_env, ['plugin', 'marketplace', 'add', str(two_market)])
        assert added_two.returncode == 0, added_two.stderr + added_two.stdout
        listed_two = spawn_rust(launcher, cwd, base_env, ['plugin', 'marketplace', 'list'])
        assert 'alpha-tools' in listed_two.stdout and 'beta-tools' in listed_two.stdout, listed_two.stdout
        inst_alpha = spawn_rust(launcher, cwd, base_env, ['plugin', 'install', 'alpha-tools', '--trust'])
        assert inst_alpha.returncode == 0, inst_alpha.stderr + inst_alpha.stdout
        inst_beta = spawn_rust(launcher, cwd, base_env, ['plugin', 'install', 'beta-tools', '--trust'])
        assert inst_beta.returncode == 0, inst_beta.stderr + inst_beta.stdout
        inspect_two = json.loads(spawn_rust(launcher, cwd, base_env, ['inspect', '--json']).stdout)
        two_names = {row['name'] for row in inspect_two['plugins']['installed']}
        assert {'alpha-tools', 'beta-tools'} <= two_names, two_names
        two_paths = {row['name']: row['path'] for row in inspect_two['plugins']['installed']
                     if row['name'] in ('alpha-tools', 'beta-tools')}
        assert two_paths['alpha-tools'] != two_paths['beta-tools']
        results['two-plugin-marketplace'] = {'installed': sorted(two_names)}

        (output / 'result.json').write_text(json.dumps(results, indent=2) + '\n')
        print(output)
        print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
