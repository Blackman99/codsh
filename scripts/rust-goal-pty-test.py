#!/usr/bin/env python3
"""PTY: `/goal` through the Rust client (ticket 180).

Real dsh runs every goal round with its own goal driver; the keyless mock
LLM (e2e/fixtures/rust-acp-mock-llm.mjs, mode `goal`) scripts the model and
the verifier subagents. Covers a first completion claim that independent
verification refuses and a later one it accepts (the transcript names each
goal round, the status line shows the verified stop), `/goal` status text,
`/goal pause` during a round, a status line that survives quitting and
`--resume`, `/goal resume` and `/goal clear`, a token budget that stops the
goal as budget-limited and refuses `/goal resume`, Ctrl+C interrupting a
round (the goal pauses as interrupted), and GROK_GOAL=0 turning goal mode
off.

Runs on Linux and macOS against the repo launcher and the staged native
binary (run `pnpm run build:rust` first). It reuses the Session harness of
rust-screen-pty-test.py.
"""
import importlib.util
import json
import os
from pathlib import Path
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


def command(session, text):
    session.send_slash(text)


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-goal-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-goal-home-', dir='/tmp') as temporary:
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
            'DSH_CODE_CLI_MOCK_TOOL': 'goal',
        }
        extra = ['--fullscreen', '--always-approve']

        # A. Verification refuses the first claim and accepts the second.
        main_session = Session('goal-achieved', LAUNCHER, cwd, env, output, extra=extra, cols=160, rows=48)
        try:
            main_session.wait_visible('Connected to dsh ACP', 30)
            # The client needs a live session and the control channel.
            main_session.write('hello GOAL_WARMUP')
            main_session.wait_visible('GOAL_WARMUP', 10)
            main_session.write(b'\r')
            main_session.wait_visible('GOAL_HUMAN tools=', 30)
            command(main_session, '/goal status')
            main_session.wait_visible('No goal is currently set', 15)
            command(main_session, '/goal ship VERIFY_FILE WRITE_ROUND_2')
            seen = set()

            def track(shown):
                for marker in ('◎ Goal round 1/256', '◎ Goal round 2/256', 'claim=refused', 'verifying with 3 checkers'):
                    if marker in shown:
                        seen.add(marker)
                return 'goal complete · verified 3/3' in shown

            wait_until(main_session, track, 'verified completion', 90)
            assert {'◎ Goal round 1/256', '◎ Goal round 2/256', 'claim=refused'} <= seen, seen
            results['verifying_seen'] = 'verifying with 3 checkers' in seen
            assert (cwd / 'goal-done.txt').exists()
            command(main_session, '/goal status')
            shown = main_session.wait_visible('Goal complete', 15)
            results['achieved'] = True

            # B. Pause during a round; the paused goal survives a restart.
            command(main_session, '/goal slow SLOWROUND')
            main_session.wait_visible('◎ goal active · round 1/256', 30)
            command(main_session, '/goal pause')
            shown = wait_until(main_session, lambda s: '◎ goal paused · round 1/256' in s, 'paused status', 30)
            results['pause'] = True
            results['session_id'] = main_session.session_id()
            results['quit'] = main_session.finish(expect_alt_leave=True)['exit']
        finally:
            main_session.close()

        resumed = Session('goal-resume', LAUNCHER, cwd, env, output,
                          extra=[*extra, '--resume', results['session_id']], cols=160, rows=48)
        try:
            resumed.wait_visible('resumed', 30)
            wait_until(resumed, lambda s: '◎ goal paused' in s, 'paused goal after resume', 30)
            command(resumed, '/goal resume')
            wait_until(resumed, lambda s: '◎ goal active' in s, 'resumed goal', 30)
            command(resumed, '/goal clear')
            wait_until(resumed, lambda s: '◎ goal' not in s and 'Goal cleared' in s, 'cleared goal', 30)
            results['resume_clear'] = True

            # C. A token budget stops the goal; resume is refused.
            command(resumed, '/goal burn BURN --budget 12000')
            shown = wait_until(resumed, lambda s: 'goal stopped (budget-limited)' in s, 'budget stop', 60)
            assert '15.0k/12.0k tokens' in shown, shown
            command(resumed, '/goal resume')
            resumed.wait_visible('Goal is budget-limited', 15)
            command(resumed, '/goal clear')
            wait_until(resumed, lambda s: '◎ goal' not in s, 'budget goal cleared', 30)
            results['budget'] = True

            # D. Ctrl+C interrupts a round; the goal pauses as interrupted.
            command(resumed, '/goal interrupt SLOWROUND')
            resumed.wait_visible('◎ Goal round 1/256', 30)
            resumed.pump(0.5)
            resumed.write(b'\x03')
            shown = wait_until(resumed, lambda s: '◎ goal paused' in s, 'interrupted pause', 30)
            command(resumed, '/goal status')
            resumed.wait_visible('interrupted', 15)
            command(resumed, '/goal clear')
            wait_until(resumed, lambda s: '◎ goal' not in s, 'interrupted goal cleared', 30)
            results['interrupt'] = True
            results['resume_quit'] = resumed.finish(expect_alt_leave=True)['exit']
        finally:
            resumed.close()

        # E. GROK_GOAL=0 turns goal mode off.
        off = Session('goal-off', LAUNCHER, cwd, {**env, 'GROK_GOAL': '0'}, output, extra=extra, cols=160, rows=48)
        try:
            off.wait_visible('Connected to dsh ACP', 30)
            off.write('hello GOAL_OFF')
            off.wait_visible('GOAL_OFF', 10)
            off.write(b'\r')
            shown = off.wait_visible('GOAL_HUMAN tools=(none)', 30)
            command(off, '/goal ship VERIFY_PASS')
            off.wait_visible('Goal mode is off', 15)
            assert '◎ Goal round' not in off.visible()
            results['disabled'] = True
            results['off_quit'] = off.finish(expect_alt_leave=True)['exit']
        finally:
            off.close()
    print(json.dumps({'ok': True, 'output': str(output), **results}))


if __name__ == '__main__':
    main()
