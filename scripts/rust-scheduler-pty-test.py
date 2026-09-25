#!/usr/bin/env python3
"""PTY: scheduled prompts through the Rust client (ticket 177).

Real dsh runs every turn, owns the scheduler, and runs every fire as a real
background subagent; the keyless mock LLM (e2e/fixtures/rust-acp-mock-llm.mjs,
mode `scheduler`) scripts the model. CODSH_TEST_SCHEDULER_TIME_SCALE=20 runs
the scheduler clock 20 times faster, so a 1m loop fires every 3 seconds.
Covers the /loop usage line, /loop scheduling through scheduler_create with
fire_immediately, the status line loop count, fires waking the idle session
with their status, a typed message while the loop runs, the Ctrl+G tasks
pane listing the loop and deleting it with x (no fire after that), /loop
refused with subagents disabled, a plain -p turn with no scheduler tools, and
no leftover codsh-rust or dsh process for this workspace after quitting.

Runs on Linux and macOS against the repo launcher and the staged native
binary (run `pnpm run build:rust` first). It reuses the Session harness of
rust-screen-pty-test.py.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
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


def fires(trace):
    """Model requests a fire's child made (each fire is one child turn)."""
    if not trace.exists():
        return 0
    count = 0
    for line in trace.read_text().splitlines():
        entry = json.loads(line)
        if any('Scheduled task ' in text and '<system-reminder>' in text for text in entry.get('user', [])):
            count += 1
    return count


def ours():
    """codsh-rust and dsh processes whose cwd is this test's workspace."""
    found = []
    if not Path('/proc').exists():
        return found
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cwd = Path(os.readlink(entry / 'cwd')).resolve()
            cmdline = (entry / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
        except OSError:
            continue
        if cwd == WORKSPACE.resolve() and ('codsh-rust' in cmdline or 'dsh' in cmdline):
            found.append((int(entry.name), cmdline.strip()))
    return found


def wait_no_leftovers(seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not ours():
            return
        time.sleep(0.2)
    raise AssertionError(f'leftover processes: {ours()}')


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-scheduler-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-scheduler-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        global WORKSPACE
        WORKSPACE = cwd
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        trace = output / 'trace.jsonl'
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'scheduler',
            'CODSH_TEST_SCHEDULER_TIME_SCALE': '20',
            'CODSH_REVIEW_TRACE': str(trace),
        }
        extra = ['--fullscreen', '--always-approve']

        session = Session('scheduler', LAUNCHER, cwd, env, output, extra=extra, cols=160, rows=50)
        try:
            session.wait_visible('Connected to dsh ACP', 30)
            # 1. A bare /loop prints the usage and sends nothing. Enter on the
            #    completion row first fills in `/loop ` for the arguments.
            session.send_slash('/loop')
            session.pump(0.3)
            session.write(b'\r')
            session.wait_visible('Usage: /loop [interval] <prompt>', 10)
            assert fires(trace) == 0
            results['usage'] = True

            # 2. /loop asks the model to schedule; the first fire runs at once
            #    as a background subagent and its status wakes the session.
            session.send_slash('/loop 1m LOOP_PROBE check the deploy')
            shown = session.wait_visible('LOOP_SCHEDULED ok', 30)
            assert '"humanSchedule":"every 1 minute"' in shown, shown
            assert '/loop 1m LOOP_PROBE check the deploy' in shown, shown
            assert '# /loop -- schedule' not in shown, 'the instruction leaked into the transcript'
            shown = session.wait_visible('1 loop', 15)
            shown = wait_until(session, lambda s: 'LOOP_WOKE job=subagent-' in s and 'LOOP_STATUS n=1' in s, 'first wake', 30)
            results['loop_wake'] = True

            # 3. The next fire starts fresh from the previous status.
            shown = wait_until(session, lambda s: 'LOOP_STATUS n=2' in s, 'second fire', 30)
            assert re.search(r'LOOP_STATUS n=2 prompt=LOOP_PROBE check the deploy prior=LOOP_STATUS n=1', shown), shown
            results['second_fire'] = True

            # 4. A message typed while the loop runs is an ordinary turn.
            prompt(session, 'SCHED_LIST')
            shown = session.wait_visible('SCHED_LISTED {"tasks":[{"id":', 40)
            assert 'LOOP_PROBE check the deploy' in shown, shown
            results['message_during_loop'] = True

            # 5. Ctrl+G lists the loop after its fires; x deletes it.
            session.write(b'\x07')
            shown = session.wait_visible('Scheduled (1 active this session)', 10)
            assert '[every 1 minute] LOOP_PROBE check the deploy' in shown, shown
            assert 'loop: LOOP_PROBE check the deploy (every 1 minute)' in shown, shown
            # The loop is the last row. New fires add subagent rows above it
            # while this runs, so Down to the end and x go in one write (no
            # redraw can shift the selection in between); a miss is retried.
            deleted = False
            for _attempt in range(5):
                session.write(b'\x1b[B' * 60 + b'x')
                end = time.monotonic() + 3
                while time.monotonic() < end and not deleted:
                    session.pump(0.1)
                    deleted = 'deleted; a fire already running still reports' in session.visible()
                if deleted:
                    break
            assert deleted, session.visible()
            shown = wait_until(session, lambda s: 'Scheduled (' not in s, 'loop row gone', 10)
            session.write(b'\x1b')
            shown = wait_until(session, lambda s: '1 loop' not in s, 'status line loop count cleared', 15)
            # A fire already running settles; no new fire starts.
            time.sleep(1.5)
            settled = fires(trace)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                session.pump(0.2)
            assert fires(trace) == settled, f'fired after delete: {settled} -> {fires(trace)}'
            results['fires'] = settled
            results['pane_delete'] = True

            results['quit'] = session.finish(expect_alt_leave=True)['exit']
        finally:
            session.close()
        wait_no_leftovers()
        results['no_leftovers_after_quit'] = True

        # 6. With subagents disabled there is nothing to fire a loop.
        nosub = Session('scheduler-nosub', LAUNCHER, cwd, env, output, extra=[*extra, '--no-subagents'], cols=160, rows=50)
        try:
            nosub.wait_visible('Connected to dsh ACP', 30)
            nosub.send_slash('/loop 1m LOOP_PROBE x')
            nosub.wait_visible('/loop needs subagents', 10)
            results['nosub'] = nosub.finish(expect_alt_leave=True)['exit']
        finally:
            nosub.close()
        wait_no_leftovers()

        # 7. A plain turn ends before any fire: dsh offers no scheduler tools.
        plain = subprocess.run([NODE, str(LAUNCHER), '--rust', '--always-approve', '-p', 'SCHED_LIST'], cwd=cwd, env=env,
                               capture_output=True, text=True, timeout=90)
        assert 'SCHED_LISTED' in plain.stdout, plain.stdout + plain.stderr
        assert '{"tasks":' not in plain.stdout, plain.stdout
        results['plain'] = True
        wait_no_leftovers()
    print(json.dumps({'ok': True, 'output': str(output), **results}))


if __name__ == '__main__':
    main()
