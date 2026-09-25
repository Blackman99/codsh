#!/usr/bin/env python3
"""PTY: plan mode, the question card, and todos through the Rust client (ticket 179).

Real dsh runs every turn; the keyless mock LLM
(e2e/fixtures/rust-acp-mock-llm.mjs, mode `interaction`) scripts the model.
Fullscreen covers /plan and the status flag, the plan gate refusing an
out-of-plan edit, the plan review (a approves), /view-plan, the question
card (a digit picks and submits), the todos pane and Ctrl+T, Shift+Tab
cycling normal → plan → always-approve → normal, and enter_plan_mode asking
through the ordinary approval prompt. Minimal covers the plan printed to
scrollback with the review strip, q abandoning the plan, and a multi-select
card with a typed answer. Headless covers the no-operator answer and
--no-ask-user.

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
SHIFT_TAB = b'\x1b[Z'
CTRL_T = b'\x14'


def wait_until(session, predicate, what, seconds=30, whole=False):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump()
        shown = session.current_text() if whole else session.visible()
        if predicate(shown):
            return shown
        if session.process.poll() is not None:
            break
    raise AssertionError(f'{session.name}: {what}\n{session.current_text() if whole else session.visible()}')


def prompt(session, text):
    session.write(text)
    session.wait_visible(text[:20], 10)
    session.write(b'\r')


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-plan-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-plan-home-', dir='/tmp') as temporary:
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
            'DSH_CODE_CLI_MOCK_TOOL': 'interaction',
        }

        full = Session('plan-fullscreen', LAUNCHER, cwd, env, output, extra=['--fullscreen'], cols=140, rows=44)
        try:
            full.wait_visible('Connected to dsh ACP', 30)
            prompt(full, 'STATUS')
            full.wait_visible('RUST_INTERACTION STATUS plan=off', 30)

            # 1. /plan: dsh confirms, the status line leads with the flag.
            full.send_slash('/plan')
            shown = full.wait_visible('plan | ', 15)
            results['plan_flag'] = True

            # 2. The plan gate refuses an edit outside the plan file.
            prompt(full, 'PLAN_EDIT_OTHER')
            wait_until(full, lambda s: 'Plan mode is read-only' in s, 'plan gate refusal')
            assert not (cwd / 'other.txt').exists()
            results['plan_gate'] = True

            # 3. exit_plan_mode opens the review; a approves and plan mode ends.
            prompt(full, 'PLAN_EXIT')
            shown = full.wait_visible('Plan review: Mock plan', 30)
            assert 'first step' in shown, shown
            full.write('a')
            full.wait_visible('plan approved', 10)
            shown = wait_until(full, lambda s: 'RUST_INTERACTION PLAN_EXIT' in s and '[0:ok]' in s, 'approved plan result')
            wait_until(full, lambda s: 'plan | ' not in s, 'plan flag did not clear', 15)
            results['review_approve'] = True

            # 4. /view-plan shows the saved plan read-only.
            full.send_slash('/view-plan')
            shown = full.wait_visible('Plan: Mock plan', 10)
            full.write(b'\x1b')
            wait_until(full, lambda s: 'Plan: Mock plan' not in s, 'plan viewer did not close', 10)
            results['view_plan'] = True

            # 5. The question card: 2 picks Blue and submits.
            prompt(full, 'ASK_ONE')
            shown = full.wait_visible('Which color?', 30)
            assert '1. ( ) Red' in shown and '2. ( ) Blue' in shown, shown
            full.write('2')
            wait_until(full, lambda s: 'RUST_INTERACTION ASK_ONE' in s and 'Blue' in s, 'card answer result')
            results['card_answer'] = True

            # 6. Todos pane; Ctrl+T hides it.
            prompt(full, 'TODOS')
            shown = wait_until(full, lambda s: 'TODO_A' in s and 'RUST_INTERACTION TODOS' in s, 'todos pane')
            full.write(CTRL_T)
            full.wait_visible('todos hidden', 10)
            results['todos'] = True

            # 7. Shift+Tab: plan → always-approve → normal.
            full.write(SHIFT_TAB)
            full.wait_visible('plan | ', 15)
            full.write(SHIFT_TAB)
            full.wait_visible('always-approve', 15)
            wait_until(full, lambda s: 'plan | ' not in s, 'plan flag after cycling', 15)
            full.write(SHIFT_TAB)
            full.wait_visible('Normal mode', 15)
            results['shift_tab'] = True

            # 8. enter_plan_mode asks through the approval prompt.
            prompt(full, 'PLAN_ENTER')
            wait_until(full, lambda s: 'y=' in s or 'Allow' in s, 'enter_plan_mode approval', 30)
            full.write('y')
            wait_until(full, lambda s: 'RUST_INTERACTION PLAN_ENTER plan=on' in s, 'plan entered', 30)
            full.wait_visible('plan | ', 15)
            results['enter_plan_mode'] = True
            results['fullscreen'] = full.finish(expect_alt_leave=True)['exit']
        finally:
            full.close()

        mini = Session('plan-minimal', LAUNCHER, cwd, env, output, extra=['--minimal'], cols=120, rows=36)
        try:
            mini.wait_visible('Connected to dsh ACP', 30)
            mini.send_slash('/plan')
            mini.wait_visible('plan | ', 15)
            prompt(mini, 'PLAN_EXIT')
            wait_until(mini, lambda s: '# Mock plan' in s and 'Plan review' in s, 'minimal plan in scrollback', 30, whole=True)
            mini.write('q')
            wait_until(mini, lambda s: 'RUST_INTERACTION PLAN_EXIT' in s and 'abandoned' in s, 'quit result', 30, whole=True)
            wait_until(mini, lambda s: 'plan | ' not in s, 'plan flag after quit', 15)
            results['minimal_quit'] = True

            prompt(mini, 'ASK_MULTI')
            mini.wait_visible('Which languages?', 30)
            mini.write(' ')          # toggle Rust
            mini.write('j')
            mini.write('j')
            mini.write(' ')          # toggle TS
            mini.write(b'\r')        # next question
            mini.wait_visible('Project name?', 10)
            mini.write('z')
            mini.write('codsh')
            mini.write(b'\r')
            wait_until(mini, lambda s: 'RUST_INTERACTION ASK_MULTI' in s and 'codsh' in s, 'multi answer', 30, whole=True)
            results['minimal_multi'] = True
            results['minimal'] = mini.finish(expect_alt_leave=False)['exit']
        finally:
            mini.close()

        def plain(*args):
            return subprocess.run([NODE, str(LAUNCHER), '--rust', '-p', *args], cwd=cwd, env=env,
                                  capture_output=True, text=True, timeout=90)
        headless = plain('ASK_ONE')
        assert headless.returncode == 0, headless.stderr
        assert 'No user is available to answer questions' in headless.stdout, headless.stdout
        hidden = plain('STATUS', '--no-ask-user', '--no-plan')
        assert 'ask_user_question=no enter_plan_mode=no exit_plan_mode=no' in hidden.stdout, hidden.stdout
        gated = plain('TODOS', '--todo-gate')
        assert 'gate=2' in gated.stdout, gated.stdout
        results['headless'] = True
    (output / 'results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))
    print(f'evidence: {output}')


if __name__ == '__main__':
    main()
