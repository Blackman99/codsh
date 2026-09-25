#!/usr/bin/env python3
"""PTY: messaging and continuing dsh subagents through the Rust client (ticket 173).

Real dsh runs every parent and child turn; the keyless mock LLM
(e2e/fixtures/rust-acp-mock-llm.mjs, mode `subagents`, `STEPS` prompts)
scripts the model. With GROK_ACTIVE_AGENT_MESSAGES=1 it covers, from the
parent view: a completed child woken by send_subagent_message (the Message
row, the board line `attempt 2`, one background end notice, the answer that
heard the message), a running child steered in place, a refused unknown id,
and a resume_from child that continues the first one; from the child view:
the relayed message shown as its own marked turn in the woken child's
transcript. Without the flag the tool does not exist.

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


def steps(items):
    return 'STEPS ' + json.dumps(items, separators=(',', ':'))


def spawn(kind, **extra):
    return ['subagent', {'description': f'{kind.lower()} probe', 'prompt': f'CHILD_{kind}', 'subagent_type': 'general-purpose', **extra}]


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-subagent-message-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-subagent-message-home-', dir='/tmp') as temporary:
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
        on = {**env, 'GROK_ACTIVE_AGENT_MESSAGES': '1'}
        main_session = Session('subagent-message', LAUNCHER, cwd, on, output,
                               extra=['--fullscreen', '--always-approve'], cols=160, rows=48)
        try:
            main_session.wait_visible('Connected to dsh ACP', 30)

            # 1. Wake a completed child, then continue it with resume_from.
            prompt(main_session, steps([
                spawn('WAITMSG 0'),
                ['send_subagent_message', {'subagent_id': '{{id:0}}', 'text': 'first follow-up'}],
                ['job_output', {'job_id': '{{job:1}}', 'wait': True, 'timeout_ms': 60000}],
                ['subagent', {'description': 'recall probe', 'prompt': 'CHILD_RECALL', 'resume_from': '{{id:0}}'}],
            ]))
            shown = wait_until(main_session, lambda s: 'PARENT_STEPS' in s, 'wake parent turn', 60)
            shown = wait_until(main_session, lambda s: 'CHILD_HEARD [first follow-up]' in s, 'woken answer', 20)
            assert 'Message sent to General-purpose \u201cwaitmsg 0 probe\u201d · resumed as' in shown, shown
            assert 'attempt 2' in shown, shown
            assert 'Subagent completed in' in shown and 'continues "waitmsg 0 probe"' in shown, shown
            assert 'CHILD_RECALLED kinds=[WAITMSG] heard=[first follow-up]' in shown, shown
            # The woken run reports its end once.
            main_session.pump(1.0)
            assert main_session.visible().count('(general-purpose · ') >= 2
            results['wake_and_resume'] = True

            # 2. Child view: the woken child's transcript shows the message as
            #    its own marked turn, then the answer to it.
            main_session.write(b'\x07')  # Ctrl+G
            shown = main_session.wait_visible('Subagents (0 running, 2 total', 10)
            if 'completed hidden' in shown:
                main_session.write('h')
                main_session.wait_visible('Subagents (0 running, 2 total)', 10)
            main_session.write(b'\r')
            main_session.wait_visible('read-only', 10)
            shown = wait_until(main_session, lambda s: '\u25ce Message from parent · first follow-up' in s, 'child view message turn', 15)
            assert 'CHILD_HEARD [first follow-up]' in shown, shown
            main_session.write(b'\x1b')
            main_session.wait_visible('Subagents (', 10)
            main_session.pump(0.3)
            main_session.write(b'\x1b')
            wait_until(main_session, lambda s: 'Subagents (' not in s, 'modal did not close', 10)
            results['child_view'] = True

            # 3. Steer a running child in place; refuse an unknown id.
            prompt(main_session, steps([
                spawn('WAITMSG 40', run_in_background=True),
                ['send_subagent_message', {'subagent_id': '{{id:0}}', 'text': 'look at b.rs too'}],
                ['job_output', {'job_id': '{{job:0}}', 'wait': True, 'timeout_ms': 60000}],
                ['send_subagent_message', {'subagent_id': 'no-such-child-1234', 'text': 'hello?'}],
            ]))
            # The first turn may have scrolled away; wait for this turn's report.
            shown = wait_until(main_session, lambda s: 'PARENT_STEPS [0:ok] started background' in s, 'steer parent turn', 60)
            shown = wait_until(main_session, lambda s: 'CHILD_HEARD [look at b.rs too]' in s, 'steered answer', 20)
            assert 'Message sent to General-purpose \u201cwaitmsg 40 probe\u201d' in shown, shown
            assert 'Message rejected · subagent …ild-1234' in shown, shown
            assert 'Subagent not found or not owned by this session.' in shown, shown
            results['steer_and_reject'] = True
            results['session_id'] = main_session.session_id()
            results['screen'] = main_session.finish(expect_alt_leave=True)['exit']
        finally:
            main_session.close()

        # 4. Off by default: the tool is not offered, so the call fails.
        plain = subprocess.run([NODE, str(LAUNCHER), '--rust', '--always-approve', '-p',
                                steps([['send_subagent_message', {'subagent_id': 'x', 'text': 'hi'}]])],
                               cwd=cwd, env=env, capture_output=True, text=True, timeout=90)
        assert plain.returncode == 0, plain.stderr
        assert '[0:error]' in plain.stdout, plain.stdout
        assert 'not found or not owned' not in plain.stdout, plain.stdout
        results['off_by_default'] = True
    print(json.dumps({'ok': True, 'output': str(output), **results}))


if __name__ == '__main__':
    main()
