#!/usr/bin/env python3
"""Installed-product PTY: settings, themes, and status line for ticket 154."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    'rust_screen_pty_test', ROOT / 'scripts' / 'rust-screen-pty-test.py')
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)
NODE = screen.NODE
Session = screen.Session
dsh_bin = screen.dsh_bin
overlay_text = screen.overlay_text
run = screen.run


def spawn_inspect(launcher, cwd, env, extra):
    return subprocess.run([NODE, str(launcher), '--rust', *extra], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=20)


def write_ready(grok, extra=''):
    grok.mkdir(parents=True, exist_ok=True)
    (grok / 'config.toml').write_text(f"""
[models]
default = "gateway"

[model.gateway]
name = "Local gateway"
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
api_key = "settings-secret"
{extra}
""")


def mouse_click(row, col=6):
    return f'\x1b[<0;{col};{row}M\x1b[<0;{col};{row}m'


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-settings-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-settings-home-', dir='/tmp') as temporary:
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
            'COLORTERM': 'truecolor',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }
        grok = home / '.codsh-rust' / '.grok'
        write_ready(grok)
        results = {}

        inspect = spawn_inspect(launcher, cwd, base_env, ['inspect', '--json'])
        assert inspect.returncode == 0, inspect.stderr + inspect.stdout
        payload = json.loads(inspect.stdout)
        settings = {row['key']: row for row in payload['settings']}
        assert settings['ui.theme']['value'] == 'groknight'
        assert settings['ui.status_line.type']['value'] == 'disabled'
        assert payload['appearance']['statusLine'] == 'disabled'
        results['inspect-default'] = settings['ui.theme']

        session = Session('theme-preview-cancel', launcher, cwd, base_env, output)
        try:
            session.wait_visible('Connected to dsh ACP', 25)
            session.write('DRAFT_KEEP')
            session.wait_visible('DRAFT_KEEP')
            session.write('/theme\r')
            session.wait_visible('Theme', 10)
            session.wait_visible('Grok Night', 5)
            assert 'DRAFT_KEEP' in session.visible()
            session.write('\x1b[B')  # Down
            session.pump(0.4)
            session.write('\x1b')  # Esc cancel
            session.wait_visible('DRAFT_KEEP', 5)
            shown = session.visible()
            assert 'Settings' not in shown or 'Theme' not in shown.split('Draft')[0]
            assert (grok / 'config.toml').read_text().count('theme') == 0
            session.write('/theme grokday\r')
            session.wait_visible('theme = grokday', 10)
            body = (grok / 'config.toml').read_text()
            assert 'theme = "grokday"' in body
            session.write('/theme banana\r')
            session.wait_visible('Unknown theme', 8)
            assert 'theme = "grokday"' in (grok / 'config.toml').read_text()
            session.write('/settings\r')
            shown = session.wait_visible('Settings', 10)
            assert 'Compact mode' in shown
            assert 'Theme' in shown or 'theme' in shown.lower()
            assert 'Status line' in shown or 'status' in shown.lower()
            session.write('\x1b')
            session.wait_visible('DRAFT_KEEP', 5)
            results['pty-theme'] = session.finish(expect_alt_leave=True)
        finally:
            session.close()

        write_ready(grok, '[ui]\ntheme = "grokday"\ncompact_mode = true\nshow_timestamps = true\n')
        restart = Session('theme-restart', launcher, cwd, base_env, output)
        try:
            restart.wait_visible('Connected to dsh ACP', 25)
            inspect_after = spawn_inspect(launcher, cwd, base_env, ['inspect', '--json'])
            after = json.loads(inspect_after.stdout)
            after_settings = {row['key']: row for row in after['settings']}
            assert after_settings['ui.theme']['value'] == 'grokday'
            assert after_settings['ui.compact_mode']['value'] == 'true'
            restart.write('/timestamps\r')
            restart.wait_visible('timestamps off', 8)
            assert 'show_timestamps = false' in (grok / 'config.toml').read_text()
            restart.write('/compact-mode\r')
            restart.wait_visible('compact_mode off', 8)
            results['pty-restart'] = restart.finish(expect_alt_leave=True)
        finally:
            restart.close()

        locked_home = work / 'locked-home'
        locked_home.mkdir()
        locked_grok = locked_home / '.codsh-rust' / '.grok'
        write_ready(locked_grok, '[ui]\ntheme = "grokday"\n')
        (locked_grok / 'requirements.toml').write_text('[ui]\ntheme = "groknight"\n')
        locked_env = {**base_env, 'HOME': str(locked_home)}
        locked_inspect = spawn_inspect(launcher, cwd, locked_env, ['inspect', '--json'])
        locked_payload = json.loads(locked_inspect.stdout)
        locked_settings = {row['key']: row for row in locked_payload['settings']}
        assert locked_settings['ui.theme']['value'] == 'groknight'
        assert locked_settings['ui.theme.lock']['value'] == 'requirements'
        locked = Session('locked-theme', launcher, cwd, locked_env, output)
        try:
            locked.wait_visible('Connected to dsh ACP', 25)
            locked.write('/settings\r')
            shown = locked.wait_visible('locked (requirements)', 10)
            assert 'Theme' in shown
            (output / 'locked-theme-open.txt').write_text(shown)
            locked.write('\x1b')
            locked.pump(0.3)
            locked.write('/theme grokday\r')
            shown = locked.wait_visible('ui.theme is locked', 8)
            assert 'requirements' in shown
            assert 'theme = "groknight"' in (locked_grok / 'requirements.toml').read_text()
            user_body = (locked_grok / 'config.toml').read_text()
            assert 'theme = "grokday"' in user_body
            results['pty-locked'] = locked.finish(expect_alt_leave=True)
        finally:
            locked.close()

        readonly_home = work / 'readonly-home'
        readonly_home.mkdir()
        readonly_grok = readonly_home / '.codsh-rust' / '.grok'
        write_ready(readonly_grok)
        os.chmod(readonly_grok, 0o555)
        ro_env = {**base_env, 'HOME': str(readonly_home)}
        save_fail = Session('save-fail', launcher, cwd, ro_env, output)
        try:
            save_fail.wait_visible('Connected to dsh ACP', 25)
            save_fail.write('/theme grokday\r')
            shown = save_fail.wait_visible("Couldn't save", 10)
            assert 'writable' in shown.lower() or 'GROK_HOME' in shown
            results['pty-save-fail'] = save_fail.finish(expect_alt_leave=True)
        finally:
            save_fail.close()
            os.chmod(readonly_grok, 0o755)

        script = grok / 'statusline.sh'
        script.write_text('#!/bin/sh\nread -r line\necho STATUS_LINE_OK\n')
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        write_ready(grok, f'''
[ui.status_line]
type = "command"
command = "{script}"
''')
        command_row = Session('status-command', launcher, cwd, base_env, output)
        try:
            command_row.wait_visible('Connected to dsh ACP', 25)
            command_row.wait_visible('STATUS_LINE_OK', 12)
            results['pty-status-command'] = command_row.finish(expect_alt_leave=True)
        finally:
            command_row.close()

        canary = work / 'rc-canary'
        slow = grok / 'slow.sh'
        slow.write_text(f'''#!/bin/sh
echo started
(sleep 30; echo leaked >> "{canary}") &
exec sleep 30
''')
        slow.chmod(slow.stat().st_mode | stat.S_IEXEC)
        write_ready(grok, f'''
[ui.status_line]
type = "command"
command = "{slow}"
''')
        timeout_env = {**base_env, 'BASH_ENV': f'echo rc-ran >> {canary}', 'ENV': f'echo rc-ran >> {canary}'}
        timeout = Session('status-timeout', launcher, cwd, timeout_env, output)
        try:
            timeout.wait_visible('Connected to dsh ACP', 25)
            shown = timeout.wait_visible('[status line: timed out]', 15)
            assert 'leaked' not in shown
            timeout.write('STILL_TYPING')
            timeout.wait_visible('STILL_TYPING', 5)
            timeout.pump(0.4)
            results['pty-status-timeout'] = timeout.finish(expect_alt_leave=True)
            time.sleep(0.3)
            assert not canary.exists(), f'BASH_ENV/ENV ran or descendant leaked: {canary.read_text() if canary.exists() else ""}'
        finally:
            timeout.close()

        quit_canary = work / 'quit-leaked'
        quit_started = work / 'quit-started'
        quit_slow = grok / 'quit-slow.sh'
        quit_slow.write_text(f'''#!/bin/sh
echo started > "{quit_started}"
(sleep 1; echo leaked > "{quit_canary}") &
exec sleep 30
''')
        quit_slow.chmod(quit_slow.stat().st_mode | stat.S_IEXEC)
        write_ready(grok, f'''
[ui.status_line]
type = "command"
command = "{quit_slow}"
''')
        quit_before = Session('status-quit-before-timeout', launcher, cwd, base_env, output)
        try:
            quit_before.wait_visible('Connected to dsh ACP', 8)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not quit_started.exists():
                time.sleep(0.05)
            assert quit_started.exists(), 'status-line command never started before quit'
            time.sleep(0.15)
            results['pty-status-quit'] = quit_before.finish(expect_alt_leave=True)
            time.sleep(1.6)
            assert not quit_canary.exists(), f'quit must kill leftover descendants: {quit_canary.read_text() if quit_canary.exists() else ""}'
        finally:
            quit_before.close()

        write_ready(grok, '''
[ui]
theme = "tokyonight"
[ui.status_line]
type = "builtin"
items = ["cwd", "model", "context"]
''')
        builtin = Session('status-builtin', launcher, cwd, base_env, output)
        try:
            shown = builtin.wait_visible('Connected to dsh ACP', 25)
            assert 'workspace' in shown or 'mock-model' in shown or 'ctx' in shown or '│' in shown
            builtin.write('/minimal\r')
            shown = builtin.wait_visible('mode=minimal', 15)
            assert "isn't available in minimal mode" not in shown or 'terminal' in shown.lower()
            builtin.write('/theme\r')
            shown = builtin.wait_visible("isn't available in minimal mode", 8)
            assert 'terminal' in shown.lower() or 'palette' in shown.lower()
            builtin.write('/settings\r')
            shown = builtin.wait_visible('Settings', 8)
            assert 'Theme rows hidden' in shown or 'Theme' not in shown
            builtin.write('\x1b')
            results['pty-minimal'] = builtin.finish(expect_alt_leave=True)
        finally:
            builtin.close()

        write_ready(grok, '[ui]\ncompact_mode = false\n')
        mouse = Session('settings-mouse', launcher, cwd, base_env, output, rows=36, cols=100)
        try:
            mouse.wait_visible('Connected to dsh ACP', 25)
            mouse.write('/settings\r')
            shown = mouse.wait_visible('Compact mode', 8)
            assert 'Compact mode  off' in shown or 'Compact mode off' in shown.replace('\n', ' ')
            click_row = None
            for idx, line in enumerate(shown.splitlines(), start=1):
                if 'Compact mode' in line:
                    click_row = idx
                    break
            assert click_row is not None, shown
            mouse.write(mouse_click(click_row, 20))
            shown = mouse.wait_visible('ui.compact_mode on', 8)
            assert 'Compact mode  on' in shown or 'Compact mode on' in shown.replace('\n', ' ')
            (output / 'settings-mouse-open.txt').write_text(shown)
            mouse.write('\x1b')
            mouse.pump(0.3)
            results['pty-mouse'] = mouse.finish(expect_alt_leave=True)
            body = (grok / 'config.toml').read_text()
            assert 'compact_mode = true' in body, body
        finally:
            mouse.close()

        nocolor_env = {**base_env, 'NO_COLOR': '1'}
        write_ready(grok, '[ui]\ntheme = "tokyonight"\n')
        nocolor = spawn_inspect(launcher, cwd, nocolor_env, ['inspect', '--json'])
        nocolor_payload = json.loads(nocolor.stdout)
        assert nocolor_payload['appearance']['colorLevel'] == 'none'
        results['inspect-nocolor'] = nocolor_payload['appearance']['colorLevel']

        (output / 'result.json').write_text(json.dumps({
            'results': {key: ('ok' if value is not None else value) for key, value in results.items()},
        }, indent=2) + '\n')
    print(f'PASS: rust settings/theme/status-line PTY; evidence: {output}')


if __name__ == '__main__':
    main()
