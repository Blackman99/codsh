#!/usr/bin/env python3
"""PTY: typed dsh subagents through the Rust client (ticket 172).

Real dsh runs every parent and child turn; the keyless mock LLM
(e2e/fixtures/rust-acp-mock-llm.mjs, mode `subagents`) scripts the model.
Covers a restricted explore child (write absent and refused), a
general-purpose child that writes, the block and status lifecycle, the
Ctrl+G task list, a read-only child view, Ctrl+C in the child view that
cancels only that child, x cancelling a background child, /tasks after
/compact, --resume of the parent, child sessions kept out of `sessions
list`, and the headless --no-subagents / Agent(type) flags.

Runs on Linux and macOS against the repo launcher and the staged native
binary (run `pnpm run build:rust` first). It reuses the Session harness of
rust-screen-pty-test.py.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('screen_pty', ROOT / 'scripts/rust-screen-pty-test.py')
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)
Session = screen.Session
NODE = screen.NODE
LAUNCHER = ROOT / 'packages/cli/bin/codsh.mjs'


def wait_until(session, predicate, what, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump()
        shown = session.visible()
        if predicate(shown):
            return shown
        if session.process.poll() is not None:
            break
    raise AssertionError(f'{session.name}: {what}\n{session.visible()}')


def prompt(session, text):
    session.write(text)
    session.wait_visible(text[:20], 10)
    session.write(b'\r')


def session_dirs(dsh_home):
    """Every dsh session directory (sessions/<project>/<id>), parent or child."""
    root = dsh_home / 'sessions'
    return sorted(path.name for path in root.glob('*/*') if path.is_dir())


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-subagent-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-subagent-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'subagents',
        }
        dsh_home = home / '.codsh-rust' / 'dsh'
        # Always approve so the general-purpose write is not an ask; the
        # explore child must still lose write through its allow-list.
        main_session = Session('subagents', LAUNCHER, cwd, env, output,
                               extra=['--fullscreen', '--always-approve'], cols=140, rows=44)
        try:
            main_session.wait_visible('Connected to dsh ACP', 30)

            # 1. explore: the write tool is not in the child's schema and a
            #    call is refused; no file appears.
            prompt(main_session, 'SPAWN:explore:WRITE')
            shown = main_session.wait_visible('PARENT_DONE', 40)
            shown = wait_until(main_session, lambda s: 'write=denied' in s, 'explore write not denied')
            assert 'Subagent completed in' in shown, shown
            assert not list(cwd.glob('child-*.txt')), list(cwd.iterdir())
            results['explore_denied'] = True

            # 2. general-purpose inherits the parent tools and writes.
            prompt(main_session, 'SPAWN:general-purpose:WRITE')
            wait_until(main_session, lambda s: 'write=allowed' in s, 'general-purpose write not allowed', 40)
            assert len(list(cwd.glob('child-*.txt'))) == 1, list(cwd.iterdir())
            results['general_write'] = True

            # 3. A background child keeps running after the parent turn; the
            #    status line counts it and x in Ctrl+G cancels it.
            prompt(main_session, 'SPAWN:general-purpose:SLOW:bg')
            shown = wait_until(main_session, lambda s: s.count('PARENT_DONE') >= 3, 'background parent turn', 40)
            shown = main_session.wait_visible('1 subagent still running', 15)
            assert 'started background subagent job' in shown, shown
            main_session.write(b'\x07')  # Ctrl+G
            shown = main_session.wait_visible('Subagents (1 running', 10)
            main_session.write('h')
            shown = main_session.wait_visible('completed hidden', 10)
            assert '[running]' in shown and 'background' in shown, shown
            main_session.write('x')
            main_session.wait_visible('cancel requested', 10)
            shown = main_session.wait_visible('Subagents (0 running', 15)
            main_session.write('h')
            shown = main_session.wait_visible('[cancelled]', 10)
            main_session.write(b'\x1b')
            shown = wait_until(main_session, lambda s: 'Subagents (' not in s, 'modal did not close', 10)
            assert 'still running' not in shown, shown
            results['background_cancel'] = True

            # 4. Foreground child: open it read-only and cancel only it; the
            #    parent turn continues and reports the cancellation once.
            prompt(main_session, 'SPAWN:general-purpose:SLOW')
            main_session.wait_visible('Subagent running', 20)
            main_session.write(b'\x07')
            main_session.wait_visible('Subagents (1 running', 10)
            main_session.write('h')
            main_session.wait_visible('completed hidden', 10)
            main_session.write(b'\r')
            shown = main_session.wait_visible('read-only', 10)
            shown = wait_until(main_session, lambda s: 'CHILD_SLOW' in s, 'child transcript not shown', 15)
            main_session.write(b'\x03')  # Ctrl+C in the child view
            main_session.wait_visible('cancel requested for this subagent only', 10)
            main_session.write(b'\x1b')
            main_session.wait_visible('Subagents (', 10)
            main_session.pump(0.3)
            main_session.write(b'\x1b')
            wait_until(main_session, lambda s: 'Subagents (' not in s, 'modal did not close', 10)
            shown = wait_until(main_session, lambda s: s.count('PARENT_DONE') >= 4, 'foreground parent turn', 30)
            assert 'cancelled by the user' in shown, shown
            assert 'Subagent cancelled in' in shown, shown
            assert main_session.process.poll() is None
            results['foreground_child_cancel'] = True

            # 5. /compact keeps the board; /tasks lists every child.
            main_session.write('/compact\r')
            main_session.wait_visible('MOCK_COMPACTION_SUMMARY', 40)
            main_session.write('/tasks\r')
            main_session.wait_visible('Subagents (0 running, 4 total, completed hidden)', 10)
            main_session.write('h')  # the hide toggle outlives the modal
            shown = main_session.wait_visible('Subagents (0 running, 4 total)', 10)
            assert shown.count('[completed]') == 2 and shown.count('[cancelled]') == 2, shown
            main_session.write('q')
            wait_until(main_session, lambda s: 'Subagents (' not in s, 'modal did not close', 10)
            results['session_id'] = main_session.session_id()
            results['compact'] = True
            results['screen'] = main_session.finish(expect_alt_leave=True)['exit']
        finally:
            main_session.close()

        # 6. Children are dsh sessions of their own, kept out of the list.
        ids = session_dirs(dsh_home)
        assert results['session_id'] in ids, (results['session_id'], ids)
        children = [item for item in ids if item != results['session_id']]
        assert len(children) >= 4, ids
        listed = subprocess.run([NODE, str(LAUNCHER), '--rust', 'sessions', 'list'], cwd=cwd, env=env,
                                capture_output=True, text=True, timeout=60)
        assert listed.returncode == 0, listed.stderr
        assert results['session_id'][:8] in listed.stdout, listed.stdout
        for child in children:
            assert child[:8] not in listed.stdout, (child, listed.stdout)
        results['children_hidden'] = len(children)

        # 7. Resume the parent: the subagent turns replay and a new spawn
        #    still runs.
        resumed = Session('subagents-resume', LAUNCHER, cwd, env, output,
                          extra=['--fullscreen', '--always-approve', '--resume', results['session_id']],
                          cols=140, rows=44)
        try:
            resumed.wait_visible('resumed', 30)
            prompt(resumed, 'SPAWN:explore:ECHO')
            shown = resumed.wait_visible('PARENT_DONE', 40)
            shown = wait_until(resumed, lambda s: 'CHILD_ECHO tools=' in s, 'resumed child answer', 20)
            assert 'Subagent completed in' in shown, shown
            results['resume'] = resumed.finish(expect_alt_leave=True)['exit']
        finally:
            resumed.close()

        # 8. Headless flags.
        def plain(*args):
            return subprocess.run([NODE, str(LAUNCHER), '--rust', '--always-approve', '-p', *args], cwd=cwd, env=env,
                                  capture_output=True, text=True, timeout=90)
        disabled = plain('SPAWN:explore:ECHO', '--no-subagents')
        assert disabled.returncode == 0, disabled.stderr
        assert '[0:error]' in disabled.stdout, disabled.stdout
        assert 'CHILD_ECHO' not in disabled.stdout, disabled.stdout
        denied = plain('SPAWN:explore:ECHO', '--disallowed-tools', 'Agent(explore)')
        assert denied.returncode == 0, denied.stderr
        assert '[0:error]' in denied.stdout and 'explore' in denied.stdout, denied.stdout
        allowed = plain('SPAWN:plan:ECHO', '--disallowed-tools', 'Agent(explore)')
        assert allowed.returncode == 0, allowed.stderr
        assert '[0:ok]' in allowed.stdout and 'CHILD_ECHO' in allowed.stdout, allowed.stdout
        results['headless'] = True
    print(json.dumps({'ok': True, 'output': str(output), **results}))


if __name__ == '__main__':
    main()
