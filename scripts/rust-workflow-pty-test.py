#!/usr/bin/env python3
"""PTY: Rhai workflows run dsh subagents through the Rust client (ticket 181).

Real dsh runs the parent and every child turn; the keyless mock LLM
(e2e/fixtures/rust-acp-mock-llm.mjs, mode `subagents`) scripts the model.
A typed prompt makes the model call the `workflow` tool with a saved
reference-format script (`triage.rhai` in the trusted project). The test
checks the user-visible result: the workflow block title with its name,
phase and agent count, the children's answers in the reply, the /tasks
rows tagged with the workflow, Ctrl+C cancelling a running workflow and
its child (no engine process left behind), a syntax error, and the
headless (-p) path, including a personal script under $GROK_HOME/workflows
and --no-subagents. Ticket 182 adds a headless panel under the configured
concurrency cap ([subagents] workflow_max_concurrent in config.toml, then
GROK_WORKFLOW_MAX_CONCURRENT_AGENTS over it), an output_schema answer
corrected by one retry of the same child, and a scratch file kept under the
session directory.

Runs on Linux and macOS against the repo launcher and the staged native
binary (run `pnpm run build:rust` first); the binary is also the workflow
engine. It reuses the Session harness of rust-screen-pty-test.py.
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

TRIAGE = '''let meta = #{
    name: "triage",
    description: "Review each area in parallel, then summarise the answers",
    when_to_use: "Ticket 181 PTY probe",
    phases: [
        #{ title: "Review", detail: "one read-only reviewer per area" },
        #{ title: "Summary", detail: "one agent joins the answers" },
    ],
};

let areas = ["docs"];
if args != () && args.areas != () {
    areas = args.areas;
}

phase("Review");
let jobs = [];
for area in areas {
    jobs.push(#{
        prompt: "CHILD_SAY reviewed " + area,
        label: "review-" + area,
        capability_mode: "read-only",
    });
}
let answers = [];
for r in parallel(jobs) {
    answers.push(r.output);
}
log("reviewed " + answers.len().to_string() + " areas");

phase("Summary");
let summary = agent("CHILD_SAY summary of " + answers.len().to_string() + " reviews", #{ label: "summarise" });
#{ answers: answers, summary: summary.output }
'''

SLOW = '''let meta = #{ name: "slow", description: "One child that waits until it is cancelled" };
phase("Wait");
agent("CHILD_SLOW wait", #{ label: "waiter" }).output
'''

PANEL = '''let meta = #{ name: "panel", description: "Held children under the concurrency cap, a schema answer and a scratch note" };
let held = parallel([1, 2, 3, 4, 5, 6].map(|n| #{ prompt: "CHILD_HOLD 600 item " + n, label: "hold-" + n }));
let peaks = held.map(|r| r.output);
let counted = agent("CHILD_JSON FIRST<<counted them>> RETRY<<```json {\\"held\\": 6} ```>>", #{
    label: "count",
    output_schema: #{ type: "object", required: ["held"], properties: #{ held: #{ type: "integer" } } },
});
let note = write_scratch_file("panel.md", "held " + counted.output.held.to_string());
#{ peaks: peaks, held: counted.output.held, note: note }
'''

BROKEN = '''let meta = #{ name: "broken", description: "A script with a syntax error" };
let x = ;
'''


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


def call(payload):
    return 'WORKFLOW_CALL ' + json.dumps(payload, separators=(',', ':'))


def engines(root):
    """Workflow engine processes whose working directory is under root."""
    found = []
    for proc in Path('/proc').iterdir() if Path('/proc').is_dir() else []:
        if not proc.name.isdigit():
            continue
        try:
            cmdline = (proc / 'cmdline').read_bytes().split(b'\0')
            if b'__workflow-engine' not in cmdline:
                continue
            if os.readlink(proc / 'cwd').startswith(str(root)):
                found.append(int(proc.name))
        except OSError:
            continue
    return found


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-workflow-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-workflow-home-', dir='/tmp') as temporary:
        work = Path(temporary).resolve()
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        (cwd / 'triage.rhai').write_text(TRIAGE)
        (cwd / 'slow.rhai').write_text(SLOW)
        (cwd / 'broken.rhai').write_text(BROKEN)
        (cwd / 'panel.rhai').write_text(PANEL)
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'subagents',
        }
        session = Session('workflow', LAUNCHER, cwd, env, output,
                          extra=['--fullscreen', '--always-approve', '--trust'], cols=150, rows=46)
        try:
            session.wait_visible('Connected to dsh ACP', 30)

            # 1. A saved reference-format script: parallel reviewers, a
            #    summary agent, phases, a log line and a structured result.
            prompt(session, call({'script_path': 'triage.rhai', 'args': {'areas': ['docs', 'api', 'tests']}}))
            shown = session.wait_visible('PARENT_WORKFLOW ok:', 60)
            shown = wait_until(session, lambda s: 'CHILD_SAID summary of 3 reviews' in s, 'summary answer not shown', 20)
            assert "Workflow 'triage' completed (4 agent calls of budget 128)." in shown, shown
            assert 'Phases: Review → Summary' in shown, shown
            assert '- reviewed 3 areas' in shown, shown
            for area in ('docs', 'api', 'tests'):
                assert f'CHILD_SAID reviewed {area}' in shown, (area, shown)
            shown = wait_until(session, lambda s: "Workflow completed in" in s and "'triage' · Summary · 4 agents" in s,
                               'workflow block title', 10)
            assert 'still running' not in shown, shown
            results['triage'] = True

            # 2. /tasks lists the four children, tagged with the workflow.
            session.write(b'\x07')  # Ctrl+G
            shown = session.wait_visible('Subagents (0 running, 4 total', 10)
            assert shown.count('· workflow triage') == 4, shown
            assert 'review-api' in shown and 'summarise' in shown, shown
            session.write(b'\x1b')
            wait_until(session, lambda s: 'Subagents (' not in s, 'modal did not close', 10)
            results['tasks'] = True

            # 3. Ctrl+C on the parent turn cancels the running workflow, its
            #    child and its engine process.
            prompt(session, call({'script_path': 'slow.rhai'}))
            shown = wait_until(session, lambda s: "Workflow running: 'slow' · Wait · 1 agent (1 running)" in s,
                               'running workflow title', 40)
            assert '1 subagent still running' in shown, shown
            live = engines(work)
            assert live, 'no workflow engine process found while running'
            session.write(b'\x03')
            shown = wait_until(session, lambda s: "Workflow cancelled in" in s and "'slow' · Wait · 1 agent" in s,
                               'cancelled workflow title', 30)
            deadline = time.monotonic() + 10
            while engines(work) and time.monotonic() < deadline:
                time.sleep(0.2)
            assert not engines(work), engines(work)
            shown = wait_until(session, lambda s: 'still running' not in s, 'child still running', 15)
            session.write(b'\x07')
            shown = session.wait_visible('Subagents (0 running, 5 total', 10)
            assert '[cancelled] waiter' in shown and '· workflow slow' in shown, shown
            session.write(b'\x1b')
            wait_until(session, lambda s: 'Subagents (' not in s, 'modal did not close', 10)
            assert session.process.poll() is None
            results['cancel'] = {'engines_while_running': len(live)}

            # 4. A syntax error is reported to the model and the user.
            prompt(session, call({'script_path': 'broken.rhai'}))
            shown = session.wait_visible('PARENT_WORKFLOW error:', 40)
            shown = wait_until(session, lambda s: 'workflow_resolve_failed' in s, 'syntax error not shown', 10)
            assert 'script failed to parse' in shown, shown
            wait_until(session, lambda s: 'Workflow failed in' in s, 'failed workflow title', 10)
            results['syntax_error'] = True
            results['session_id'] = session.session_id()
            results['screen'] = session.finish(expect_alt_leave=True)['exit']
        finally:
            session.close()

        # 5. Headless: the same saved script from -p, and none with
        #    --no-subagents.
        def plain(*args):
            return subprocess.run([NODE, str(LAUNCHER), '--rust', '--always-approve', '-p', *args], cwd=cwd, env=env,
                                  capture_output=True, text=True, timeout=120)
        ran = plain(call({'script_path': 'triage.rhai', 'args': {'areas': ['cli']}}))
        assert ran.returncode == 0, ran.stderr
        assert "PARENT_WORKFLOW ok: Workflow 'triage' completed (2 agent calls of budget 128)." in ran.stdout, ran.stdout
        assert 'CHILD_SAID reviewed cli' in ran.stdout and 'CHILD_SAID summary of 1 reviews' in ran.stdout, ran.stdout
        # A personal script under the isolated $GROK_HOME/workflows.
        personal = home / '.codsh-rust' / '.grok' / 'workflows' / 'personal-note.rhai'
        personal.parent.mkdir(parents=True, exist_ok=True)
        personal.write_text('let meta = #{ name: "personal-note", description: "A saved personal workflow" };\n'
                            'agent("CHILD_SAY from " + args.where).output\n')
        mine = plain(call({'script_path': str(personal), 'args': {'where': 'grok-home'}}))
        assert mine.returncode == 0, mine.stderr
        assert "Workflow 'personal-note' completed (1 agent call of budget 128)." in mine.stdout, mine.stdout
        assert 'CHILD_SAID from grok-home' in mine.stdout, mine.stdout
        off = plain(call({'script_path': 'triage.rhai'}), '--no-subagents')
        assert off.returncode == 0, off.stderr
        assert 'PARENT_WORKFLOW error:' in off.stdout and 'subagents are disabled' in off.stdout, off.stdout
        assert 'CHILD_SAID' not in off.stdout, off.stdout
        results['headless'] = True

        # 6. Ticket 182: six held children under a cap of 2 from config.toml,
        #    then 3 from the environment over it; a schema answer fixed by one
        #    retry; the scratch note under the session directory.
        grok_home = home / '.codsh-rust' / '.grok'
        (grok_home / 'config.toml').write_text('[subagents]\nworkflow_max_concurrent = 2\n')

        def panel(extra_env=None):
            ran = subprocess.run([NODE, str(LAUNCHER), '--rust', '--always-approve', '-p', call({'script_path': 'panel.rhai', 'agent_budget': 7})],
                                 cwd=cwd, env={**env, **(extra_env or {})}, capture_output=True, text=True, timeout=120)
            assert ran.returncode == 0, ran.stderr
            assert "PARENT_WORKFLOW ok: Workflow 'panel' completed (7 agent calls of budget 7)." in ran.stdout, ran.stdout
            body = ran.stdout[ran.stdout.index('Result:') + len('Result:'):].strip().splitlines()[0]
            return json.loads(body)
        capped = panel()
        peaks = [int(text.split('peak=')[1]) for text in capped['peaks']]
        assert max(peaks) == 2, capped
        assert capped['held'] == 6 and capped['note'] == 'scratch/panel.md', capped
        notes = list((grok_home / 'sessions').glob('*/*/workflows/*/scratch/panel.md'))
        assert len(notes) == 1 and notes[0].read_text() == 'held 6', notes
        wider = panel({'GROK_WORKFLOW_MAX_CONCURRENT_AGENTS': '3'})
        assert max(int(text.split('peak=')[1]) for text in wider['peaks']) == 3, wider
        results['cap'] = {'config': max(peaks), 'env': 3}
    print(json.dumps({'ok': True, 'output': str(output), **results}))


if __name__ == '__main__':
    main()
