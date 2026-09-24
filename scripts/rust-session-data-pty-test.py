#!/usr/bin/env python3
"""Installed-product PTY: export, share, delete, and disk usage for one session."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    'rust_resume_pty_test', ROOT / 'scripts' / 'rust-resume-pty-test.py')
resume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resume)
NODE = resume.NODE
Session = resume.Session
dsh_bin = resume.dsh_bin
overlay_text = resume.overlay_text
run = resume.run


def wait_idle(session, marker, seconds=20):
    session.wait_visible(marker, seconds)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump()
        shown = session.visible()
        if 'Streaming turn' not in shown and 'Cancelling turn' not in shown:
            return shown
    raise AssertionError(f'{session.name}: still streaming after {marker!r}\n{session.visible()}')


def cli(launcher, cwd, env, *args):
    return subprocess.run(
        [NODE, str(launcher), '--rust', *args],
        cwd=cwd, env=env, capture_output=True, text=True)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-session-data-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-session-data-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        other = work / 'other'
        other.mkdir()
        pack_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'],
            'npm_config_cache': str(work / 'npm-cache'),
            'npm_config_userconfig': str(work / 'empty-user.npmrc'),
            'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
            'npm_config_update_notifier': 'false',
        }
        pack = json.loads(run(
            ['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
            cwd=ROOT / 'packages/cli', env=pack_env).stdout)[0]['filename']
        prefix = work / 'installed'
        run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline',
             '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
        launcher = prefix / 'node_modules/.bin/codsh'
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        base_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
        }
        help_text = run([NODE, str(launcher), '--rust', '--help'], env=base_env, cwd=cwd).stdout
        assert 'export <id>' in help_text
        assert 'share <id>' in help_text
        assert 'sessions delete' in help_text
        assert 'disk-usage' in help_text

        keeper = Session('keep', launcher, other, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, cols=120, rows=40)
        try:
            keeper.wait_visible('Connected to dsh ACP', 25)
            keeper.write('KEEP_OTHER')
            keeper.wait_visible('KEEP_OTHER', 10)
            keeper.write('\r')
            wait_idle(keeper, 'RUST_ACP_ANSWER', 25)
            keep_id = keeper.session_id()
            keeper.finish()
        finally:
            keeper.close()

        live = Session('export', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, cols=120, rows=40)
        try:
            live.wait_visible('Connected to dsh ACP', 25)
            live.write('DROP_TOKEN')
            live.wait_visible('DROP_TOKEN', 10)
            live.write('\r')
            wait_idle(live, 'RUST_ACP_ANSWER', 25)
            drop_id = live.session_id()
            live.write('/export')
            live.wait_visible('/export', 10)
            live.write('\r')
            shown = live.wait_visible('clipboard', 20)
            assert 'not a claim' in shown or 'not a redaction' in shown or 'Conversation copied' in shown
            export_path = work / 'drop.md'
            exported = cli(launcher, cwd, base_env, 'export', drop_id, str(export_path))
            assert exported.returncode == 0, exported.stderr
            body = export_path.read_text()
            assert 'DROP_TOKEN' in body
            assert 'KEEP_OTHER' not in body
            assert 'not a claim' in body
            missing = cli(launcher, cwd, base_env, 'share', drop_id)
            assert missing.returncode != 0
            assert 'Nothing was uploaded' in (missing.stderr + missing.stdout)
            official = cli(launcher, cwd, base_env, 'share', '--url', 'https://grok.com/build/share', drop_id)
            assert official.returncode != 0
            assert 'Official' in (official.stderr + official.stdout)
            captured = work / 'posted.json'
            port_file = work / 'port'
            server = subprocess.Popen(
                ['python3', str(ROOT / 'scripts' / 'share-fixture.py'), str(captured), str(port_file)])
            deadline = time.monotonic() + 5
            port = ''
            while time.monotonic() < deadline and not port:
                if port_file.exists():
                    port = port_file.read_text().strip()
                time.sleep(0.02)
            assert port, 'share fixture did not bind'
            env_shared = cli(
                launcher, cwd, {**base_env, 'CODSH_SHARE_URL': f'http://127.0.0.1:{port}/share'},
                'share', drop_id)
            assert env_shared.returncode == 0, env_shared.stderr + env_shared.stdout
            assert 'http://127.0.0.1/shared/selected' in env_shared.stdout
            shared = cli(
                launcher, cwd, base_env, 'share', '--url', f'http://127.0.0.1:{port}/share', drop_id)
            server.wait(timeout=5)
            assert shared.returncode == 0, shared.stderr
            assert 'http://127.0.0.1/shared/selected' in shared.stdout
            posted = captured.read_text()
            assert drop_id in posted
            assert 'DROP_TOKEN' in posted
            assert 'KEEP_OTHER' not in posted
            live.write('/delete')
            live.wait_visible('/delete', 10)
            live.write('\r')
            live.wait_visible('Delete session', 15)
            live.write('n')
            shown = live.wait_visible('delete cancelled', 15)
            assert drop_id in shown or 'delete cancelled' in shown
            listed = cli(launcher, cwd, base_env, 'sessions', 'list')
            assert listed.returncode == 0, listed.stderr
            assert drop_id in listed.stdout
            assert keep_id in listed.stdout
            refused = cli(launcher, cwd, base_env, 'sessions', 'delete', drop_id, '--yes')
            assert refused.returncode != 0
            assert 'write owner' in (refused.stderr + refused.stdout)
            assert drop_id in cli(launcher, cwd, base_env, 'sessions', 'list').stdout
            live.finish()
        finally:
            live.close()

        deleted = cli(launcher, cwd, base_env, 'sessions', 'delete', drop_id, '--yes')
        assert deleted.returncode == 0, deleted.stderr
        assert 'deleted session' in deleted.stdout
        after = cli(launcher, cwd, base_env, 'sessions', 'list')
        assert drop_id not in after.stdout
        assert keep_id in after.stdout
        disk = cli(launcher, home, base_env, 'du', '--json')
        assert disk.returncode == 0, disk.stderr
        report = json.loads(disk.stdout)
        assert report['schema_version'] == 1
        assert report['total_bytes'] >= 0
        assert 'does not delete' in report['note']
        names = [item['name'] for item in report['top_level_dirs']]
        assert 'dsh' in names, names
        print('session-data-pty ok', drop_id, keep_id)


if __name__ == '__main__':
    main()
