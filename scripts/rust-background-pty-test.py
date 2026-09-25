#!/usr/bin/env python3
"""PTY: background commands and completion wake through the Rust client (ticket 175).

Real dsh runs every turn and owns every job; the keyless mock LLM
(e2e/fixtures/rust-acp-mock-llm.mjs, mode `background`) scripts the model.
Covers a quick foreground command with its exit code, auto-background past
`[toolset.bash] foreground_block_budget_ms` and the wake turn its completion
starts, Ctrl+B, send-now moving the running command instead of killing it,
a blocking job_output wait interrupted by a typed message, x in the Ctrl+G
tasks pane, /new and quit stopping every command of the session (no
leftover process), and a resumed history that does not claim a command is
still running.

Runs on Linux and macOS against the repo launcher and the staged native
binary (run `pnpm run build:rust` first). It reuses the Session harness of
rust-screen-pty-test.py. Each command sleeps for a distinct time so the
pgrep checks cannot match another process on the host.
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
    (session.output / f'{session.name}-failed.ansi').write_bytes(session.data)
    raise AssertionError(f'{session.name}: {what}\n{session.visible()}')


def wait_file(session, path, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump(0.1)
        if path.exists():
            return
    raise AssertionError(f'{session.name}: {path.name} never appeared\n{session.visible()}')


def prompt(session, text):
    session.write(text)
    session.wait_visible(text[:20], 10)
    session.write(b'\r')


WORKSPACE = None


def alive(pattern):
    """A matching process runs in this test's workspace (another run on the
    host, or a leftover of an aborted one, does not count)."""
    found = subprocess.run(['pgrep', '-f', pattern], capture_output=True, text=True)
    for pid in found.stdout.split():
        if WORKSPACE is None:
            return True
        try:
            if Path(os.readlink(f'/proc/{pid}/cwd')).resolve() == WORKSPACE.resolve():
                return True
        except OSError:
            if not Path('/proc').exists():
                return True  # macOS: no /proc; the distinct sleep time is the key
    return False


def wait_gone(pattern, seconds=8, session=None):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not alive(pattern):
            return
        if session is not None:
            session.pump(0.1)
        else:
            time.sleep(0.1)
    raise AssertionError(f'{pattern!r} still running')


def write_config(home, body):
    grok = home / '.codsh-rust' / '.grok'
    grok.mkdir(parents=True, exist_ok=True)
    (grok / 'config.toml').write_text(body)


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-background-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-background-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        global WORKSPACE
        WORKSPACE = cwd
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'background',
        }
        extra = ['--fullscreen', '--always-approve']

        # A. A one-second budget: a quick command stays foreground, a slow one
        #    moves and its completion wakes the idle session.
        write_config(home, '[toolset.bash]\nforeground_block_budget_ms = 1000\n')
        auto = Session('background-auto', LAUNCHER, cwd, env, output, extra=extra, cols=150, rows=46)
        try:
            auto.wait_visible('Connected to dsh ACP', 30)
            prompt(auto, 'BG_FAST')
            shown = auto.wait_visible('RUST_BG_FAST', 30)
            shown = wait_until(auto, lambda s: 'FAST_OUT' in s and 'FAST_ERR' in s, 'fast output')
            assert 'exit code: 3' in shown or 'exit 3' in shown, shown
            assert 'command still running' not in shown and 'commands still running' not in shown, shown
            results['fast'] = True

            started = time.monotonic()
            prompt(auto, 'BG_AUTO')
            shown = auto.wait_visible('RUST_BG_MOVED job=bash-2 moved=auto tail=AUTO_START', 30)
            assert time.monotonic() - started < 3.0, 'the turn waited for the command'
            assert not (cwd / 'bg-auto-done.txt').exists()
            assert 'Command moved to background' in shown or 'moved to background' in shown, shown
            shown = auto.wait_visible('1 command still running', 10)
            shown = auto.wait_visible('◎ Task completed', 20)
            shown = wait_until(auto, lambda s: 'RUST_BG_WOKE' in s and 'AUTO_OUT' in s, 'wake answer', 20)
            shown = wait_until(auto, lambda s: 'command still running' not in s and 'commands still running' not in s, 'status cleared', 10)
            assert (cwd / 'bg-auto-done.txt').read_text() == 'AUTO_END\n'
            results['auto_wake'] = True
            results['auto'] = auto.finish(expect_alt_leave=True)['exit']
        finally:
            auto.close()

        # B. The default budget: Ctrl+B, send-now, the wait interrupt, the
        #    tasks pane, and session ends.
        write_config(home, '[toolset.bash]\nforeground_block_budget_ms = 60000\n')
        main_session = Session('background', LAUNCHER, cwd, env, output, extra=extra, cols=150, rows=46)
        try:
            main_session.wait_visible('Connected to dsh ACP', 30)

            # 1. Ctrl+B moves the running command; its completion wakes.
            prompt(main_session, 'BG_CTRLB')
            wait_file(main_session, cwd / 'bg-ctrlb-started.txt')
            assert alive('sleep 4.175')
            main_session.write(b'\x02')
            shown = main_session.wait_visible('RUST_BG_MOVED job=bash-1 moved=user tail=CTRLB_START', 15)
            assert 'User moved command' in shown, shown
            assert alive('sleep 4.175'), 'Ctrl+B killed the command'
            shown = wait_until(main_session, lambda s: 'RUST_BG_WOKE' in s and 'CTRLB_OUT' in s, 'Ctrl+B wake', 20)
            results['ctrl_b'] = True

            # 2. Send-now while a command runs moves it and runs the new row.
            prompt(main_session, 'BG_SENDNOW')
            wait_file(main_session, cwd / 'bg-sendnow-started.txt')
            prompt(main_session, 'SN_FOLLOW_UP')
            main_session.wait_visible('Queued 1', 10)
            main_session.write(b'\r')
            shown = main_session.wait_visible('RUST_BG_REPLY SN_FOLLOW_UP', 20)
            assert 'RUST_BG_MOVED job=bash-2 moved=message tail=SENDNOW_START' in shown, shown
            # The command was moved, not killed: it completes with exit 0 and
            # its completion wakes the session.
            shown = wait_until(main_session, lambda s: 'RUST_BG_WOKE job=bash-2 out=SENDNOW_OUT' in s,
                               'send-now wake', 40)
            assert 'exit code: 0' in shown, shown
            results['send_now'] = True

            # 3. A blocking job_output wait: a typed message interrupts it
            #    and the command keeps running.
            prompt(main_session, 'BG_WAIT')
            main_session.wait_visible('send a message to interrupt', 20)
            prompt(main_session, 'WAIT_BREAK')
            shown = main_session.wait_visible('RUST_BG_REPLY WAIT_BREAK', 20)
            assert alive('sleep 41.175'), 'the interrupt killed the command'
            shown = main_session.wait_visible('1 command still running', 10)
            assert 'send a message to interrupt' not in shown, shown
            results['wait_interrupt'] = True

            # 4. Ctrl+G lists the command; x stops it.
            main_session.write(b'\x07')
            shown = main_session.wait_visible('Commands (1 running', 10)
            assert 'sleep 41.175' in shown and 'run_in_background' in shown, shown
            assert '[completed]' in shown and 'Ctrl+B' in shown and 'moved by a new' in shown, shown
            main_session.write('h')  # hide finished rows: the running command is selected
            shown = main_session.wait_visible('completed hidden', 10)
            assert '[completed]' not in shown, shown
            main_session.write('x')
            main_session.wait_visible('stop requested for bash-', 10)
            wait_gone('sleep 41.175', session=main_session)
            shown = main_session.wait_visible('Commands (0 running', 10)
            main_session.write('h')
            shown = wait_until(main_session, lambda s: '[killed]' in s and 'completed hidden' not in s,
                               'killed row', 10)
            main_session.write(b'\x1b')
            shown = wait_until(main_session, lambda s: 'Commands (' not in s, 'modal did not close', 10)
            shown = wait_until(main_session, lambda s: 'command still running' not in s and 'commands still running' not in s, 'status cleared', 10)
            results['pane_kill'] = True

            # 5. /new ends the previous session's commands.
            prompt(main_session, 'BG_KEEP')
            main_session.wait_visible('RUST_BG_STARTED', 20)
            assert alive('sleep 42.175')
            main_session.wait_visible('1 command still running', 10)
            before_new = main_session.session_id()
            main_session.send_slash('/new')
            main_session.wait_visible('stopped with the previous session', 15)
            wait_gone('sleep 42.175', session=main_session)
            shown = wait_until(main_session, lambda s: 'command still running' not in s and 'commands still running' not in s, 'status cleared after /new', 10)
            deadline = time.monotonic() + 20
            while main_session.session_id() == before_new and time.monotonic() < deadline:
                main_session.pump(0.2)
            assert main_session.session_id() != before_new, 'no new session'
            wait_until(main_session, lambda s: 'RUST_BG_STARTED' not in s, 'transcript not cleared by /new', 10)
            results['new_session'] = True

            # 6. Quit with a running command leaves no process behind.
            prompt(main_session, 'BG_KEEP')
            main_session.wait_visible('RUST_BG_STARTED', 20)
            main_session.wait_visible('1 command still running', 10)
            assert alive('sleep 42.175')
            results['session_id'] = main_session.session_id()
            results['quit'] = main_session.finish(expect_alt_leave=True)['exit']
            wait_gone('sleep 42.175', seconds=6)
            results['quit_clean'] = True
        finally:
            main_session.close()

        # 7. The resumed history keeps the moved result but says the command
        #    is not running.
        resumed = Session('background-resume', LAUNCHER, cwd, env, output,
                          extra=[*extra, '--resume', results['session_id']], cols=150, rows=46)
        try:
            resumed.wait_visible('resumed', 30)
            shown = resumed.wait_visible('Background commands and monitors in this history are not running', 15)
            assert 'command still running' not in shown and 'commands still running' not in shown, shown
            assert not alive('sleep 42.175')
            prompt(resumed, 'BG_FAST')
            resumed.wait_visible('RUST_BG_FAST', 30)
            results['resume'] = resumed.finish(expect_alt_leave=True)['exit']
        finally:
            resumed.close()

        # 8. Plain mode keeps dsh's own foreground bash: no move, full wait.
        plain_started = time.monotonic()
        plain = subprocess.run([NODE, str(LAUNCHER), '--rust', '--always-approve', '-p', 'BG_AUTO'], cwd=cwd, env=env,
                               capture_output=True, text=True, timeout=90)
        assert plain.returncode == 0, plain.stderr
        assert time.monotonic() - plain_started >= 3.0
        assert 'RUST_BG_MOVED job= moved=no tail=AUTO_OUT' in plain.stdout, plain.stdout
        results['plain'] = True
    print(json.dumps({'ok': True, 'output': str(output), **results}))


if __name__ == '__main__':
    main()
