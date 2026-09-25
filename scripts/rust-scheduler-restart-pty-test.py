#!/usr/bin/env python3
"""PTY: saved loops across restarts through the Rust client (ticket 178).

Real dsh owns the scheduler and runs every fire as a real background
subagent; the keyless mock LLM (e2e/fixtures/rust-acp-mock-llm.mjs, mode
`scheduler`) scripts the model. CODSH_TEST_SCHEDULER_TIME_SCALE=20 runs the
scheduler clock 20 times faster (a 1m loop fires every 3 seconds) from one
shared CODSH_TEST_SCHEDULER_EPOCH, so every process of the test agrees on
the time; CODSH_TEST_SCHEDULER_OFFSET_MS simulates downtime before a resume.

Covers: a /loop saved with its session and shown as saved; quitting and
`--continue` 10 minutes later restores it and fires it once, not once per
missed interval; a second client on the same session is refused and adds
no fires; a slow fire in flight when the client is killed with SIGKILL
leaves no dsh behind, comes back as outcome unknown and is not run again
(the next fire is told it was interrupted); a pane delete persists across a
restart; `--no-subagents` lists the saved loop as paused and fires nothing;
a changed permission mode is shown; 8 days of downtime expire the loop
without a fire and remove its file; no leftover codsh-rust or dsh process
for this workspace.

Runs on Linux and macOS against the repo launcher and the staged native
binary (run `pnpm run build:rust` first). It reuses the Session harness of
rust-screen-pty-test.py and the helpers of rust-scheduler-pty-test.py.
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('scheduler_pty', ROOT / 'scripts/rust-scheduler-pty-test.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
screen = base.screen
Session = screen.Session
LAUNCHER = base.LAUNCHER
wait_until = base.wait_until
fires = base.fires
prompt = base.prompt


def child_prompts(trace, needle):
    """Fire prompts (one per child model request) whose task text has `needle`."""
    if not trace.exists():
        return []
    found = []
    for line in trace.read_text().splitlines():
        entry = json.loads(line)
        for text in entry.get('user', []):
            if 'Scheduled task ' in text and '<system-reminder>' in text and needle in text:
                found.append(text)
                break
    return found


def saved_file(home, session_id):
    matches = list(home.rglob(f'codsh-schedules/{session_id}.json'))
    return matches[0] if matches else None


def saved_tasks(home, session_id):
    path = saved_file(home, session_id)
    return json.loads(path.read_text())['tasks'] if path else []


def settle(session, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump(0.1)


def open_pane(session, needle):
    session.write(b'\x07')
    return wait_until(session, lambda s: needle in s, f'tasks pane with {needle!r}', 15)


def drawn(session, text, seconds=20):
    """Wait until `text` is on screen once; a later hint may replace it."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump(0.1)
        if text in session.visible():
            return
    (session.output / f'{session.name}-failed.ansi').write_bytes(session.data)
    raise AssertionError(f'{session.name}: never drew {text!r}\n{session.visible()}')


def pane_rows(shown):
    """The tasks pane's rows: the text inside its box borders."""
    rows = []
    for line in shown.splitlines():
        if '│' not in line:
            rows.append('')
            continue
        rows.append(line.split('│', 1)[1].rsplit('│', 1)[0].strip())
    return rows


def selected_row(shown):
    return next((row for row in pane_rows(shown) if row.startswith('> ')), '')


def select_loop(session, needle, seconds=20):
    """Select the loop row whose text has `needle`. Loops are the last rows,
    so a burst of Down reaches the last one and Up walks back; new fires add
    subagent rows above the loops meanwhile, so it keeps adjusting."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        for _ in range(40):
            session.write(b'\x1b[B')
        session.pump(0.2)
        shown = session.visible()
        rows = pane_rows(shown)
        current = next((index for index, row in enumerate(rows) if row.startswith('> ')), None)
        target = next((index for index, row in enumerate(rows) if row.lstrip('> ').startswith('[every ') and needle in row), None)
        if current is not None and target is not None and target < current:
            # Only loop rows (one line each) lie between them.
            for _ in range(current - target):
                session.write(b'\x1b[A')
            session.pump(0.2)
            shown = session.visible()
            rows = pane_rows(shown)
            current = next((index for index, row in enumerate(rows) if row.startswith('> ')), None)
        if current is not None and current == target:
            return shown
    raise AssertionError(f'{session.name}: could not select the {needle!r} loop\n{session.visible()}')


def delete_loop(session, ups, seconds=30):
    """x on a loop row: Down to the last row, `ups` rows back (loops after
    it), and x in one write, so a fire adding a row cannot shift the
    selection in between. A miss (a subagent row) is retried."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.write(b'\x1b[B' * 60 + b'\x1b[A' * ups + b'x')
        end = time.monotonic() + 3
        while time.monotonic() < end:
            session.pump(0.2)
            if 'deleted; a fire already running still reports' in session.visible():
                return session.visible()
    raise AssertionError(f'{session.name}: delete not confirmed\n{session.visible()}')


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-scheduler-restart-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-scheduler-restart-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        base.WORKSPACE = cwd
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        trace = output / 'trace.jsonl'
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': screen.NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'scheduler',
            'CODSH_TEST_SCHEDULER_TIME_SCALE': '20',
            'CODSH_TEST_SCHEDULER_EPOCH': str(int(time.time() * 1000)),
            'CODSH_REVIEW_TRACE': str(trace),
        }
        approve = ['--fullscreen', '--always-approve']

        # 1. A /loop is saved with its session.
        first = Session('restart-a', LAUNCHER, cwd, env, output, extra=approve, cols=160, rows=50)
        try:
            first.wait_visible('Connected to dsh ACP', 30)
            first.send_slash('/loop 1m LOOP_PROBE restart probe')
            first.wait_visible('LOOP_SCHEDULED ok', 30)
            wait_until(first, lambda s: 'LOOP_STATUS n=1' in s, 'first fire status', 30)
            session_id = first.session_id()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not saved_tasks(home, session_id):
                first.pump(0.1)
            tasks = saved_tasks(home, session_id)
            assert len(tasks) == 1 and tasks[0]['prompt'] == 'LOOP_PROBE restart probe', tasks
            shown = open_pane(first, 'Scheduled (1 active this session)')
            assert '[every 1 minute] LOOP_PROBE restart probe' in shown and '· saved' in shown, shown
            first.write(b'\x1b')
            first.pump(0.3)
            results['saved'] = first.finish(expect_alt_leave=True)['exit']
        finally:
            first.close()
        base.wait_no_leftovers()
        assert len(saved_tasks(home, session_id)) == 1, 'quitting must keep the saved loop'
        before = fires(trace)

        # 2. Ten minutes later (ten missed fires) --continue restores it and
        #    fires it once promptly.
        launched = time.monotonic()
        second = Session('restart-b', LAUNCHER, cwd, {**env, 'CODSH_TEST_SCHEDULER_OFFSET_MS': '600000'}, output,
                         extra=[*approve, '--continue'], cols=160, rows=50)
        try:
            second.wait_visible('Connected to dsh ACP', 30)
            drawn(second, 'Restored 1 saved loop(s) for this session')
            assert second.session_id() == session_id
            wait_until(second, lambda s: fires(trace) >= before + 1, 'catch-up fire', 15)
            settle(second, 1.0)
            # Ten intervals were missed. The catch-up is one fire; after it
            # the loop keeps its 3 s cadence (a 1m loop at 20x), so the count
            # is bounded by the time since the restart, not by the downtime.
            elapsed = time.monotonic() - launched
            added = fires(trace) - before
            assert 1 <= added <= 1 + int(elapsed / 3) + 1, f'{added} fires {elapsed:.1f}s after a restart that missed 10'
            results['fires_after_restart'] = {'added': added, 'seconds': round(elapsed, 1)}
            open_pane(second, 'Scheduled (1 active this session)')
            shown = select_loop(second, 'LOOP_PROBE restart probe')
            assert 'restored from the saved session' in shown and '· saved' in shown, shown
            second.write(b'\x1b')
            second.pump(0.3)

            # 3. A second client on the same session is refused and adds no fires.
            rival = Session('restart-rival', LAUNCHER, cwd, env, output, extra=[*approve, '--resume', session_id], cols=160, rows=50)
            try:
                counted = fires(trace)
                started = time.monotonic()
                shown = None
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    second.pump(0.05)
                    rival.pump(0.05)
                    if 'Write owner refused' in rival.visible():
                        shown = rival.visible()
                        break
                assert shown is not None, rival.visible()
                assert 'Restored' not in shown, shown
                deadline = time.monotonic() + 6
                while time.monotonic() < deadline:
                    second.pump(0.05)
                    rival.pump(0.05)
                elapsed = time.monotonic() - started
                extra_fires = fires(trace) - counted
                # One 1m loop at 20x fires every 3 s; a doubled owner would fire twice as often.
                assert extra_fires <= elapsed / 3 + 1, f'{extra_fires} fires in {elapsed:.1f}s'
                results['rival_refused'] = rival.finish()['exit']
            finally:
                rival.close()

            # 4. A slow fire is in flight when the client is killed.
            prompt(second, 'SCHED_CALL {"interval":"1m","prompt":"LOOP_SLOW crash probe","fire_immediately":true}')
            second.wait_visible('SCHED_RESULT ok', 30)
            deadline = time.monotonic() + 20
            slow = None
            while time.monotonic() < deadline:
                second.pump(0.1)
                slow = next((task for task in saved_tasks(home, session_id) if task['prompt'] == 'LOOP_SLOW crash probe'), None)
                if slow and slow.get('inFlight') and len(child_prompts(trace, 'LOOP_SLOW crash probe')) == 1:
                    break
            assert slow and slow['inFlight']['fire'] == 1, slow
            os.killpg(second.process.pid, signal.SIGKILL)
            second.process.wait(10)
        finally:
            second.close()
        base.wait_no_leftovers(15)
        results['no_leftovers_after_kill'] = True

        # 5. The slow fire comes back as unknown and is not run again; the
        #    next fire is told it was interrupted. A pane delete persists.
        third = Session('restart-c', LAUNCHER, cwd, env, output, extra=[*approve, '--continue'], cols=160, rows=50)
        try:
            third.wait_visible('Connected to dsh ACP', 30)
            drawn(third, 'Restored 2 saved loop(s) for this session')
            open_pane(third, 'Scheduled (2 active this session)')
            shown = select_loop(third, 'LOOP_SLOW crash probe')
            assert 'fire 1 outcome unknown' in selected_row(shown), shown
            assert 'the dsh process or session ended while fire 1 ran' in shown, shown
            third.write(b'\x1b')
            # The next slow fire's prompt (in the trace) carries the notice;
            # its status may wait behind dsh's wake budget, so the screen is
            # not the evidence here.
            wait_until(third, lambda s: len(child_prompts(trace, 'LOOP_SLOW crash probe')) >= 2, 'fire after the interrupted one', 30)
            slow_prompts = child_prompts(trace, 'LOOP_SLOW crash probe')
            assert len(slow_prompts) >= 2, len(slow_prompts)
            assert 'The previous iteration (fire 1) was interrupted' in slow_prompts[1], slow_prompts[1]
            assert 'The previous iteration (fire 1) was interrupted' not in slow_prompts[0]
            results['unknown_not_replayed'] = True
            open_pane(third, 'Scheduled (2 active this session)')
            # LOOP_PROBE is the first of the two loops: one row above the last.
            delete_loop(third, 1)
            wait_until(third, lambda s: 'Scheduled (1 active this session)' in s, 'one loop left', 10)
            prompts = [task['prompt'] for task in saved_tasks(home, session_id)]
            assert prompts == ['LOOP_SLOW crash probe'], prompts
            third.write(b'\x1b')
            third.pump(0.3)
            results['pane_delete_saved'] = third.finish(expect_alt_leave=True)['exit']
        finally:
            third.close()
        base.wait_no_leftovers()

        # 6. Subagents off: the saved loop is listed as paused and nothing
        #    fires. Started without --always-approve, it shows the changed mode.
        nosub = Session('restart-nosub', LAUNCHER, cwd, env, output, extra=['--fullscreen', '--continue', '--no-subagents'], cols=160, rows=50)
        try:
            nosub.wait_visible('Connected to dsh ACP', 30)
            drawn(nosub, 'Restored 1 saved loop(s) for this session')
            counted = fires(trace)
            shown = open_pane(nosub, 'Scheduled (1 paused this session)')
            assert 'LOOP_PROBE' not in shown, 'a deleted loop came back'
            assert '· paused' in shown and 'permissions changed' in shown, shown
            settle(nosub, 4)
            assert fires(trace) == counted, 'a paused loop fired'
            nosub.write(b'\x1b')
            nosub.pump(0.3)
            results['nosub_paused'] = nosub.finish(expect_alt_leave=True)['exit']
        finally:
            nosub.close()
        base.wait_no_leftovers()

        # 7. Eight days later the loop has expired: removed, never fired.
        counted = fires(trace)
        late = Session('restart-expired', LAUNCHER, cwd, {**env, 'CODSH_TEST_SCHEDULER_OFFSET_MS': str(8 * 86_400_000)}, output,
                       extra=[*approve, '--continue'], cols=160, rows=50)
        try:
            late.wait_visible('Connected to dsh ACP', 30)
            drawn(late, 'Loop expired after 7 days: LOOP_SLOW crash probe')
            settle(late, 2)
            assert fires(trace) == counted, 'an expired loop fired'
            assert saved_file(home, session_id) is None, 'the expired loop is still saved'
            results['expired_unfired'] = late.finish(expect_alt_leave=True)['exit']
        finally:
            late.close()
        base.wait_no_leftovers()
        results['no_leftovers'] = True
    print(json.dumps({'ok': True, 'output': str(output), **results}))


if __name__ == '__main__':
    main()
