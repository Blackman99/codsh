#!/usr/bin/env python3
"""Installed-product PTY: mouse, search, jump, vim, and reading-position restore."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    'rust_resume_pty_test', ROOT / 'scripts' / 'rust-resume-pty-test.py')
resume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resume)
screen_spec = importlib.util.spec_from_file_location(
    'rust_screen_pty_test', ROOT / 'scripts' / 'rust-screen-pty-test.py')
screen = importlib.util.module_from_spec(screen_spec)
screen_spec.loader.exec_module(screen)
NODE = resume.NODE
Session = screen.Session
dsh_bin = resume.dsh_bin
overlay_text = resume.overlay_text
run = resume.run
READ_RE = re.compile(r'read=(\d+)\.(\d+)')


def wait_idle(session, marker, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump()
        shown = session.visible()
        raw = bytes(session.data).decode('utf-8', 'replace')
        if marker in shown or marker in raw:
            if 'Streaming turn' not in shown and 'Cancelling turn' not in shown:
                return shown
        if session.process.poll() is not None:
            break
    raise AssertionError(
        f'{session.name}: still streaming after {marker!r}\n{session.visible()}'
    )


def sgr_mouse(kind, col, row):
    # kind: 0 press, 32 drag, 64 wheel-up, 65 wheel-down; lowercase m is release.
    return f'\x1b[<{kind};{col};{row}M'.encode()


def sgr_release(col, row):
    return f'\x1b[<0;{col};{row}m'.encode()


def locate(shown, needle):
    for index, row in enumerate(shown.splitlines()):
        column = row.find(needle)
        if column >= 0:
            return column + 1, index + 1, row
    raise AssertionError(f'missing {needle!r} in\n{shown}')


def locate_row(shown, predicate):
    for index, row in enumerate(shown.splitlines()):
        if predicate(row):
            return index + 1, row
    raise AssertionError(f'missing matching row in\n{shown}')


def session_blob(session):
    shown = session.visible()
    raw = bytes(session.data).decode('utf-8', 'replace')
    return shown + '\n' + raw


def assert_same_session(session, live_id):
    blob = session_blob(session)
    assert live_id in blob, f'{session.name}: lost session {live_id}\n{session.visible()}'


def reading(shown):
    match = READ_RE.search(shown)
    if match is None:
        raise AssertionError(f'missing read= bookmark in\n{shown}')
    return match.group(0)


def osc52_payloads(data):
    payloads = []
    raw = bytes(data)
    for match in re.finditer(rb'\x1b]52;c;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)', raw):
        payloads.append(base64.b64decode(match.group(1)).decode())
    return payloads


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-nav-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-nav-home-', dir='/tmp') as temporary:
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
        grok = home / '.codsh-rust' / '.grok'
        grok.mkdir(parents=True)
        (grok / 'config.toml').write_text(
            '[ui]\nmouse_reporting_toggle = true\nvim_mode = false\nscroll_mode = "wheel"\nscroll_speed = 50\ninvert_scroll = false\n'
            '[features]\ndock = false\n'
        )
        # Ticket 155: copies must not reach the tester's real clipboard. Failing
        # stand-ins for the native tools plus the wrap sink marker make every
        # copy an unconfirmed OSC 52 write (captured by this PTY) on any OS.
        no_clipboard = home.parent / 'no-clipboard-bin'
        no_clipboard.mkdir(exist_ok=True)
        for tool in ('pbcopy', 'xclip', 'xsel', 'wl-copy'):
            (no_clipboard / tool).write_text('#!/bin/sh\ncat >/dev/null\nexit 1\n')
            (no_clipboard / tool).chmod(0o755)
        base_env = {
            'HOME': str(home), 'PATH': f"{no_clipboard}:{os.environ['PATH']}", 'TERM': 'xterm-256color',
            'LC_GROK_OSC52_SINK': '1',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'GROK_MOUSE_REPORTING_TOGGLE': '1',
            'GROK_SCROLL_MODE': 'trackpad',
            'GROK_SCROLL_SPEED': '80',
            'GROK_INVERT_SCROLL': 'true',
        }
        results = []

        help_text = run([NODE, str(launcher), '--rust', '--help'], env=base_env, cwd=cwd).stdout
        assert '/find searches the transcript' in help_text
        assert '/jump lists turns' in help_text
        inspect = run([NODE, str(launcher), '--rust', 'inspect'], env=base_env, cwd=cwd).stdout
        assert 'ui.vim_mode' in inspect
        assert 'ui.mouse_reporting_toggle' in inspect
        assert 'true' in inspect
        assert 'ui.scroll_mode' in inspect
        assert 'trackpad' in inspect and '(env)' in inspect
        assert 'ui.scroll_speed' in inspect and '80' in inspect
        assert re.search(r'ui.scroll_mode\s+trackpad\s+\(env\)', inspect), inspect
        assert re.search(r'ui.scroll_speed\s+80\s+\(env\)', inspect), inspect
        assert re.search(r'ui.invert_scroll\s+true\s+\(env\)', inspect), inspect
        inspect_json = json.loads(run([NODE, str(launcher), '--rust', 'inspect', '--json'], env=base_env, cwd=cwd).stdout)
        settings = {row['key']: row for row in inspect_json['settings']}
        assert settings['ui.scroll_mode']['value'] == 'trackpad'
        assert settings['ui.scroll_mode']['source'] == 'env'
        assert settings['ui.scroll_speed']['value'] == '80'
        assert settings['ui.scroll_speed']['source'] == 'env'
        assert settings['ui.invert_scroll']['value'] == 'true'
        assert settings['ui.mouse_reporting_toggle']['source'] == 'env'
        assert 'features.dock' in settings

        welcome = Session('nav-welcome-tab', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--fullscreen'], cols=100, rows=36)
        try:
            shown = welcome.wait_visible('Connected to dsh ACP', 25)
            assert 'Enter submits a prompt through dsh.' in shown
            assert 'focus=prompt' in shown
            before_draft = shown.split('Draft (not sent)')[-1]
            assert '\t' not in before_draft
            welcome.write('\t')
            welcome.pump(0.4)
            shown = welcome.visible()
            draft = shown.split('Draft (not sent)')[-1]
            assert '\t' not in draft, shown
            assert 'focus=prompt' in shown
            assert welcome.process.poll() is None
            results.append(welcome.finish(expect_alt_leave=True))
        finally:
            welcome.close()

        session = Session('nav-fullscreen', launcher, cwd, {
            **base_env,
            'DSH_CODE_CLI_MOCK_TOOL': 'reasoning',
            'DSH_CODE_CLI_MOCK_DELAY_MS': '4000',
        }, output, extra=['--fullscreen'], cols=100, rows=24)
        try:
            session.wait_visible('Connected to dsh ACP', 25)
            live_id = session.session_id()
            assert session.snapshot()['onAlternate']
            tokens = [
                'TOKEN_ALPHA unique-nav',
                'TOKEN_BETA unique-nav',
                'TOKEN_GAMMA unique-nav',
            ] + [f'TOKEN_{index:02} unique-nav' for index in range(4, 8)]
            for index, token in enumerate(tokens):
                session.write(token)
                session.wait_visible(token, 10)
                session.write('\r')
                if index == 0:
                    shown = session.wait_visible('Streaming turn', 15)
                    assert 'Streaming turn' in shown
                    assert session.process.poll() is None
                    session.write('\x1b[5~')
                    session.pump(0.15)
                    session.write(sgr_mouse(65, 10, 4))
                    session.pump(0.2)
                    shown = session.visible()
                    assert 'Streaming turn' in shown, shown
                    assert 'TOKEN_ALPHA unique-nav' in shown
                    assert session.process.poll() is None
                    wait_idle(session, 'RUST_ACP_ANSWER', 20)
                else:
                    wait_idle(session, 'RUST_ACP_ANSWER')
            session.write('DRAFT_KEEP')
            session.wait_visible('DRAFT_KEEP')
            shown = session.visible()
            assert 'focus=prompt' in shown
            assert 'mouse=captured' in shown
            assert 'vim=off' in shown
            assert 'dock=hidden' in shown
            assert 'read=' in shown
            before = reading(shown)

            session.write('/find ALPHA unique-nav\r')
            shown = session.wait_visible('Find:', 10)
            assert 'ALPHA unique-nav' in shown
            assert 'browse n/N' in shown, shown
            assert 'composing' not in shown, shown
            assert 'DRAFT_KEEP' in shown
            assert_same_session(session, live_id)
            first_find = reading(shown)
            session.write('n')
            session.pump(0.3)
            shown = session.visible()
            assert 'Find: ALPHA unique-nav' in shown or 'Find: ALPHA unique-n' in shown
            assert 'Find: ALPHA unique-navn' not in shown, shown
            assert 'DRAFT_KEEP' in shown
            session.write('\x1b')
            shown = session.wait_visible('focus=scrollback', 10)
            assert 'Find:' not in shown, shown
            assert 'Esc restores reading position' not in shown, shown
            assert 'DRAFT_KEEP' in shown
            assert reading(shown) == before, shown
            assert_same_session(session, live_id)
            assert first_find != before or 'read=0.' in shown

            session.write('\t')
            shown = session.wait_visible('focus=prompt', 10)
            session.write('/find \r')
            shown = session.wait_visible('composing', 10)
            session.write('\x1b]52;c;dW5pcXVlLW5hdg==\x07')  # not a paste
            session.write('\x1b[200~unique-nav\x1b[201~')
            shown = session.wait_visible('unique-nav', 10)
            assert 'Find:' in shown
            assert 'unique-nav' in shown
            assert 'DRAFT_KEEP' in shown
            pasted_read = reading(shown)
            assert pasted_read != before or '[1/' in shown or '[0/' in shown
            session.write('\x1b')
            session.wait_visible('focus=scrollback', 10)

            session.write('\t')
            session.wait_visible('focus=prompt', 10)
            session.write('\x03')
            session.pump(0.2)
            session.write('DRAFT_KEEP')
            session.wait_visible('DRAFT_KEEP')
            session.write('\x10')
            shown = session.wait_visible("No command palette", 10)
            assert 'DRAFT_KEEP' in shown
            assert_same_session(session, live_id)
            session.pump(0.2)
            assert session.process.poll() is None

            session.write('/jump\r')
            shown = session.wait_visible('Jump to which turn?', 10)
            assert 'DRAFT_KEEP' in shown
            session.write('\x1b[B')
            session.pump(0.2)
            shown = session.visible()
            preview = reading(shown)
            session.write('\x1b')
            shown = session.wait_visible('focus=scrollback', 10)
            assert 'Jump to which turn?' not in shown
            assert 'DRAFT_KEEP' in shown
            assert reading(shown) == before, shown
            assert preview != before, shown
            assert_same_session(session, live_id)

            shown = session.visible()
            for _ in range(12):
                if '[thought]' in shown and 'RUST_ACP_THOUGHT' in shown:
                    break
                session.write('\x1b[5~')
                session.pump(0.15)
                shown = session.visible()
            shown = session.wait_visible('RUST_ACP_THOUGHT', 10)
            assert 'DRAFT_KEEP' in shown
            col, row, line = locate(shown, '[thought]')
            thoughts_before = shown.count('RUST_ACP_THOUGHT')
            session.write(sgr_mouse(0, col + 2, row))
            session.pump(0.15)
            session.write(sgr_release(col + 2, row))
            deadline = time.monotonic() + 4
            folded = False
            while time.monotonic() < deadline:
                session.pump(0.1)
                shown = session.visible()
                if 'click to expand' in shown.split('┌readline')[0] or 'click to expand' in shown.split('┌Draft')[0]:
                    folded = True
                    break
            if not folded:
                raise AssertionError(
                    f'click did not fold thought at col={col} row={row} line={line!r}\n{shown}'
                )
            assert 'DRAFT_KEEP' in shown
            assert shown.count('RUST_ACP_THOUGHT') == thoughts_before - 1, shown

            row, line = locate_row(
                shown,
                lambda item: 'TOKEN_GAMMA unique-nav' in item and 'RUST_ACP_ANSWER' not in item,
            )
            start = line.find('TOKEN_GAMMA') + 1
            end = start + len('TOKEN_GAMMA')
            session.write(sgr_mouse(0, start, row))
            session.pump(0.1)
            session.write(sgr_mouse(32, end, row))
            session.pump(0.1)
            session.write(sgr_release(end, row))
            shown = session.wait_visible('via OSC 52, unconfirmed', 10)
            assert 'Copied!' not in shown
            assert 'DRAFT_KEEP' in shown
            assert 'folded · click to expand' in shown.split('┌Draft')[0]
            payloads = osc52_payloads(session.data)
            assert payloads, 'missing OSC 52'
            copied = payloads[-1]
            assert 'TOKEN_GAMMA' in copied, copied
            assert 'RUST_ACP_ANSWER' not in copied, copied
            assert_same_session(session, live_id)

            session.write('\t')
            shown = session.wait_visible('focus=prompt', 10)
            assert 'DRAFT_KEEP' in shown
            session.write('/vim-mode\r')
            shown = session.wait_visible('Vim scrollback navigation on', 10)
            assert 'ui.simple_mode unchanged' in shown
            assert 'DRAFT_KEEP' in shown
            config_after = (grok / 'config.toml').read_text()
            assert 'vim_mode = true' in config_after, config_after
            assert 'mouse_reporting_toggle = true' in config_after, config_after
            session.write('\t')
            shown = session.wait_visible('focus=scrollback', 10)
            session.write('g')
            shown = session.wait_visible('read=0.', 10)
            assert 'DRAFT_KEEP' in shown
            session.write('y')
            shown = session.wait_visible('via OSC 52, unconfirmed', 10)
            yanked = osc52_payloads(session.data)[-1]
            assert yanked.count('\n') == 0, yanked
            assert 'TOKEN_ALPHA unique-nav' in yanked, yanked
            assert 'RUST_ACP_ANSWER' not in yanked, yanked
            assert '[thought]' not in yanked, yanked
            session.write('j')
            session.pump(0.2)
            shown = session.visible()
            assert 'DRAFT_KEEP' in shown
            assert 'focus=scrollback' in shown
            session.write('k')
            session.pump(0.2)
            session.write('G')
            session.pump(0.2)
            shown = session.visible()
            assert 'DRAFT_KEEP' in shown
            session.write('Y')
            shown = session.wait_visible('via OSC 52, unconfirmed', 10)
            meta = osc52_payloads(session.data)[-1]
            assert meta.startswith('thought ') or meta.startswith('answer ') or meta.startswith('user '), meta
            assert '\n' not in meta, meta

            session.write('\t')
            session.wait_visible('focus=prompt', 10)
            session.write('/vim-mode\r')
            shown = session.wait_visible('Vim scrollback navigation off', 10)
            session.write('\t')
            session.wait_visible('focus=scrollback', 10)
            session.write('j')
            shown = session.wait_visible('focus=prompt', 10)
            draft = shown.split('┌Draft')[-1]
            assert 'j' in draft, shown
            session.write('\x03')
            session.pump(0.2)
            session.write('DRAFT_KEEP')
            session.wait_visible('DRAFT_KEEP')
            session.write('\t')
            shown = session.wait_visible('focus=scrollback', 10)
            assert 'mouse=captured' in shown
            session.write('\x12')
            shown = session.wait_visible('mouse=native', 10)
            assert 'DRAFT_KEEP' in shown
            assert 'focus=scrollback' in shown
            session.write('\x12')
            shown = session.wait_visible('mouse=captured', 10)
            assert 'DRAFT_KEEP' in shown
            assert 'focus=scrollback' in shown
            session.write('\x1b[5~')
            session.pump(0.3)
            shown = session.visible()
            before_ctrl_d = reading(shown)
            session.write('\x04')
            deadline = time.monotonic() + 3
            shown = session.visible()
            while time.monotonic() < deadline and reading(shown) == before_ctrl_d:
                session.pump(0.1)
                shown = session.visible()
            assert session.process.poll() is None, 'Ctrl+D quit the session'
            assert reading(shown) != before_ctrl_d, shown
            assert 'DRAFT_KEEP' in shown
            assert_same_session(session, live_id)
            assert 'focus=scrollback' in shown

            before_wheel = reading(shown)
            row, line = locate_row(
                shown,
                lambda item: item.startswith('  ') or item.startswith('> ') or item.startswith('|>'),
            )
            session.write(sgr_mouse(65, 8, row))
            deadline = time.monotonic() + 3
            shown = session.visible()
            while time.monotonic() < deadline and reading(shown) == before_wheel:
                session.pump(0.1)
                shown = session.visible()
            after_wheel = reading(shown)
            assert after_wheel != before_wheel, shown
            assert 'DRAFT_KEEP' in shown
            session.resize(28, 70)
            session.pump(0.8)
            shown = session.visible()
            assert 'DRAFT_KEEP' in shown
            assert_same_session(session, live_id)
            restored = reading(shown)
            assert restored.split('.')[0] == after_wheel.split('.')[0], shown
            results.append(session.finish(expect_alt_leave=True))
        finally:
            session.close()

        (grok / 'config.toml').write_text(
            '[ui]\nmouse_reporting_toggle = false\nvim_mode = false\n'
            '[features]\ndock = false\n'
        )
        off_env = {key: value for key, value in base_env.items() if key != 'GROK_MOUSE_REPORTING_TOGGLE'}
        off_env['GROK_MOUSE_REPORTING_TOGGLE'] = '0'
        mouse_off = Session('nav-mouse-off', launcher, cwd, {
            **off_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--fullscreen'], cols=100, rows=36)
        try:
            mouse_off.wait_visible('Connected to dsh ACP', 25)
            mouse_off.write('TOKEN_MOUSE_OFF\r')
            wait_idle(mouse_off, 'RUST_ACP_ANSWER')
            mouse_off.write('\t')
            shown = mouse_off.wait_visible('focus=scrollback', 10)
            assert 'mouse=captured' in shown
            mouse_off.write('\x12')
            mouse_off.pump(0.4)
            shown = mouse_off.visible()
            assert 'mouse=captured' in shown
            assert 'mouse=native' not in shown
            results.append(mouse_off.finish(expect_alt_leave=True))
        finally:
            mouse_off.close()

        dock_env = dict(base_env)
        dock_env['GROK_DOCK'] = '1'
        dock = Session('nav-dock', launcher, cwd, {
            **dock_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--fullscreen'], cols=100, rows=24)
        try:
            dock.wait_visible('Connected to dsh ACP', 25)
            dock.write('TOKEN_DOCK unique-nav\r')
            wait_idle(dock, 'RUST_ACP_ANSWER')
            dock.write('DRAFT_KEEP')
            dock.wait_visible('DRAFT_KEEP')
            shown = dock.visible()
            assert 'dock=unsupported' in shown or 'no dock pane' in shown
            dock.write('/find TOKEN_DOCK\r')
            shown = dock.wait_visible('Find:', 10)
            assert 'Find:' in shown
            assert 'TOKEN_DOCK' in shown
            assert 'DRAFT_KEEP' in shown
            dock.write('\x1b')
            shown = dock.wait_visible('focus=scrollback', 10)
            assert 'Find:' not in shown, shown
            assert 'DRAFT_KEEP' in shown
            dock.write('\t')
            dock.wait_visible('focus=prompt', 10)
            dock.write('/jump\r')
            shown = dock.wait_visible('Jump to which turn?', 10)
            assert 'DRAFT_KEEP' in shown
            dock.write('\x1b')
            shown = dock.wait_visible('focus=scrollback', 10)
            assert 'Jump to which turn?' not in shown
            assert 'DRAFT_KEEP' in shown
            results.append(dock.finish(expect_alt_leave=True))
        finally:
            dock.close()

        minimal = Session('nav-minimal', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--minimal'], cols=100, rows=36)
        try:
            shown = minimal.wait_visible('Connected to dsh ACP', 25)
            assert 'mode=minimal' in shown
            assert not minimal.snapshot()['onAlternate']
            minimal.write('DRAFT_MIN')
            minimal.wait_visible('DRAFT_MIN')
            minimal.write('/find ALPHA\r')
            shown = minimal.wait_visible("isn't available in minimal mode", 10)
            assert 'fullscreen' in shown.lower()
            assert 'use your terminal' in shown or 'search overlay' in shown or 'no scrollback pane' in shown
            assert 'DRAFT_MIN' in shown
            minimal.write('/jump\r')
            shown = minimal.wait_visible("isn't available in minimal mode", 10)
            assert 'fullscreen' in shown.lower(), shown
            assert 'native scrollback' in shown or 'turn navigation' in shown, shown
            assert 'DRAFT_MIN' in shown
            results.append(minimal.finish(expect_alt_leave=False))
        finally:
            minimal.close()

        (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps({'output': str(output), 'results': [item['name'] for item in results]}, indent=2))
        assert all(item.get('exit') == 0 for item in results), results


if __name__ == '__main__':
    main()
