#!/usr/bin/env python3
"""PTY: monitors and session wake through the Rust client (ticket 176).

Real dsh runs every turn and owns every monitor process; the keyless mock
LLM (e2e/fixtures/rust-acp-mock-llm.mjs, mode `monitor`) scripts the model.
Covers a monitor whose output lines each wake the idle session as a
`◎ Monitor event` turn, the status line and the Ctrl+G tasks pane row, x
stopping the monitor (its process is gone, no further event arrives, and
the model is told once at its next step), a monitor that exits on its own
(one event, then one completion wake and the end hint), /new and quit
leaving no monitor process behind, and a plain `-p` turn that has no monitor
tool.

Runs on Linux and macOS against the repo launcher and the staged native
binary (run `pnpm run build:rust` first). It reuses the Session harness of
rust-screen-pty-test.py. Each monitor sleeps for a distinct time so the
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
WORKSPACE = None


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


def prompt(session, text):
    session.write(text)
    session.wait_visible(text[:20], 10)
    session.write(b'\r')


def alive(pattern):
    """A matching process runs in this test's workspace."""
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


def trace_lines(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-monitor-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-monitor-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        global WORKSPACE
        WORKSPACE = cwd
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        trace = work / 'trace.jsonl'
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'monitor', 'CODSH_MOCK_MONITOR_TRACE': str(trace),
        }
        extra = ['--fullscreen', '--always-approve']
        session = Session('monitor', LAUNCHER, cwd, env, output, extra=extra, cols=160, rows=48)
        try:
            session.wait_visible('Connected to dsh ACP', 30)

            # 1. Each output line wakes the idle session with its own turn.
            ticks = {'command': 'echo PTY_TICK_1; sleep 1.5; echo PTY_TICK_2; sleep 44.176',
                     'description': 'pty ticks', 'timeout_ms': 120000}
            prompt(session, 'MON_CALL ' + json.dumps(ticks))
            shown = session.wait_visible('RUST_MON_STARTED Monitor started (task ', 30)
            assert 'timeout 120000ms' in shown, shown
            session.wait_visible('1 monitor still running', 10)
            shown = wait_until(session, lambda s: '◎ Monitor event · pty ticks: PTY_TICK_1' in s
                               and 'RUST_MON_EVENT <monitor-event description="pty ticks"' in s, 'first event turn', 20)
            shown = wait_until(session, lambda s: '◎ Monitor event · pty ticks: PTY_TICK_2' in s
                               and 'PTY_TICK_2⏎</monitor-event>' in s, 'second event turn', 20)
            assert alive('sleep 44.176'), 'the monitor process ended early'
            events = [line for line in trace_lines(trace) if line['latest'].startswith('<monitor-event')]
            assert len(events) == 2, events
            results['event_turns'] = len(events)

            # 2. Ctrl+G lists the monitor with its events; x stops it.
            session.write(b'\x07')
            shown = session.wait_visible('Commands and monitors (1 running', 10)
            assert '[running] pty ticks · monitor · ' in shown, shown
            assert 'timeout 120s · 2 events' in shown, shown
            session.write('x')
            session.wait_visible('stop requested for monitor-1', 10)
            wait_gone('sleep 44.176', session=session)
            shown = wait_until(session, lambda s: '[killed] pty ticks · monitor · ' in s, 'killed row', 10)
            session.write(b'\x1b')
            wait_until(session, lambda s: 'Commands and monitors (' not in s, 'modal did not close', 10)
            shown = wait_until(session, lambda s: 'monitor still running' not in s, 'status cleared', 10)
            calls = len(trace_lines(trace))
            session.pump(2.0)
            assert len(trace_lines(trace)) == calls, 'the stopped monitor woke the session'
            results['pane_kill'] = True

            # 3. The model is told at its next step that the user stopped it.
            prompt(session, 'MON_LIST')
            shown = wait_until(session, lambda s: 'RUST_MON_LIST monitor-1 [monitor] killed' in s and 'told=1' in s,
                               'kill notice', 30)
            results['kill_notice'] = True

            # 4. A monitor that exits: one event, then one completion wake.
            once = {'command': 'sleep 0.8; echo PTY_ONCE_OUT; sleep 1.2', 'description': 'pty once'}
            prompt(session, 'MON_CALL ' + json.dumps(once))
            session.wait_visible('RUST_MON_STARTED Monitor started (task monitor-2', 30)
            shown = wait_until(session, lambda s: '◎ Monitor event · pty once: PTY_ONCE_OUT' in s
                               and 'PTY_ONCE_OUT⏎</monitor-event>' in s, 'once event', 20)
            shown = wait_until(session, lambda s: '◎ Task completed · monitor [monitor] pty once' in s
                               and 'RUST_MON_ENDED background job monitor-2' in s, 'completion wake', 20)
            shown = session.wait_visible('monitor "pty once" ended: exited (code 0)', 10)
            wait_until(session, lambda s: 'monitor still running' not in s, 'status cleared after exit', 10)
            latest = [line['latest'] for line in trace_lines(trace)]
            assert len([text for text in latest if 'PTY_ONCE_OUT' in text and text.startswith('<monitor-event')]) == 1, latest
            assert len([text for text in latest if text.startswith('background job monitor-2')]) == 1, latest
            results['exit_wake'] = True

            # 5. /new ends the previous session's monitors.
            keep = {'command': 'sleep 45.176', 'description': 'pty keep', 'persistent': True}
            prompt(session, 'MON_CALL ' + json.dumps(keep))
            wait_until(session, lambda s: 'RUST_MON_STARTED Monitor started (task monitor-3, persistent -- runs until job_kill or session end)' in s,
                       'persistent start', 30)
            session.wait_visible('1 monitor still running', 10)
            assert alive('sleep 45.176')
            before_new = session.session_id()
            session.send_slash('/new')
            session.wait_visible('1 monitor(s) stopped with the previous session', 15)
            wait_gone('sleep 45.176', session=session)
            wait_until(session, lambda s: 'monitor still running' not in s, 'status cleared after /new', 10)
            deadline = time.monotonic() + 20
            while session.session_id() == before_new and time.monotonic() < deadline:
                session.pump(0.2)
            assert session.session_id() != before_new, 'no new session'
            wait_until(session, lambda s: 'RUST_MON_STARTED' not in s, 'transcript not cleared by /new', 10)
            results['new_session'] = True

            # 6. Quit with a running monitor leaves no process behind.
            keep = {'command': 'sleep 46.176', 'description': 'pty quit', 'persistent': True}
            prompt(session, 'MON_CALL ' + json.dumps(keep))
            shown = wait_until(session, lambda s: 'RUST_MON_STARTED' in s and 'persistent -- runs until job_kill or session end' in s,
                               'persistent start after /new', 30)
            session.wait_visible('1 monitor still running', 10)
            assert alive('sleep 46.176')
            results['quit'] = session.finish(expect_alt_leave=True)['exit']
            wait_gone('sleep 46.176', seconds=6)
            results['quit_clean'] = True
        finally:
            session.close()

        # 7. A plain turn has no monitor tool.
        plain = subprocess.run([NODE, str(LAUNCHER), '--rust', '--always-approve', '-p',
                                'MON_CALL ' + json.dumps({'command': 'echo PLAIN_NO', 'description': 'plain'})],
                               cwd=cwd, env=env, capture_output=True, text=True, timeout=90)
        assert plain.returncode == 0, plain.stderr
        assert 'RUST_MON_ERROR' in plain.stdout and 'RUST_MON_EVENT' not in plain.stdout, plain.stdout
        results['plain'] = True
    print(json.dumps({'ok': True, 'output': str(output), **results}))


if __name__ == '__main__':
    main()
