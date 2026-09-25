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

Ticket 183 makes every interactive run a background run: the tool call
returns at once, the run's completion arrives as its own notice turn, and
/workflow runs, /workflow pause|resume|stop <name> and the tasks pane's
Workflows section show and control it. A plain -p prompt still waits for its
run and prints the run's result block.

Ticket 184 adds the saved catalog: a project workflow in <root>/.grok/workflows
(trusted folder) shadows a personal one of the same name in
$GROK_HOME/workflows, /workflows lists both scopes with what is hidden or
invalid, the slash menu completes `/<name>`, `/<name> args` runs real dsh
children and reports into the session, /workflow save writes a finished run
into the project catalog, and -p runs a workflow by name.

Ticket 205 installs a real plugin (`plugin install --trust`, `plugin enable`)
that ships workflows/: /workflows lists them with the plugin, /<name> runs
the free bare name and /<plugin>:<name> the one a project workflow owns, both
with real dsh children, and after `plugin disable` -p by the qualified name is
refused with the plugin's state.

Ticket 206 adds the built-in deep-research workflow, pinned byte for byte from
grok-build: /workflows shows it first with its pin and hides a same-named
project file, the slash menu offers /deep-research, and a run against a
keyless fake SearXNG and page server (config.toml, loopback only) plans,
searches, fetches to verify, and reports a cited, verified result; a plain
-p run by name reports a rate-limited branch and a contradicted claim as
partial.

Runs on Linux and macOS against the repo launcher and the staged native
binary (run `pnpm run build:rust` first); the binary is also the workflow
engine. It reuses the Session harness of rust-screen-pty-test.py.
"""
import http.server
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

DIGEST = '''let meta = #{ name: "digest", description: "Project digest of one topic", when_to_use: "Ticket 184 PTY probe" };
phase("Digest");
let topic = if type_of(args) == "map" { args.objective } else { "nothing" };
agent("CHILD_SAY project digest of " + topic, #{ label: "digester" }).output
'''

PERSONAL_DIGEST = '''let meta = #{ name: "digest", description: "Personal digest (shadowed)" };
agent("CHILD_SAY personal digest").output
'''

KEEP = '''let meta = #{ name: "keeper", description: "A run worth keeping" };
agent("CHILD_SAY kept answer", #{ label: "keeper" }).output
'''

PLUGIN_LINT = '''let meta = #{ name: "lint", description: "Plugin lint of one topic" };
let topic = if type_of(args) == "map" { args.objective } else { "nothing" };
agent("CHILD_SAY plugin lint of " + topic, #{ label: "linter" }).output
'''

PLUGIN_DIGEST = '''let meta = #{ name: "digest", description: "Plugin digest (the project owns /digest)" };
agent("CHILD_SAY plugin digest", #{ label: "plugin-digester" }).output
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


class FakeWeb(http.server.BaseHTTPRequestHandler):
    """A keyless fake SearXNG (/search?format=json) and the pages it points at."""
    base = ''
    searches = []
    pages = []
    RESULTS = {
        'alpha': ('Alpha Notes', '/alpha', 'Alpha ships with 3 engines.'),
        'beta': ('Beta Notes', '/beta', 'Beta was released in 2021.'),
        'gamma': ('Gamma Notes', '/gamma', 'Gamma supports 9 languages.'),
    }
    BODIES = {
        '/alpha': 'Alpha Notes\n\nAlpha ships with 3 engines. Each engine is documented separately.',
        '/beta': 'Beta Notes\n\nBeta was released in 2021. It followed a long preview.',
        '/gamma': 'Gamma Notes\n\nGamma supports 2 languages today.',
    }

    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        from urllib.parse import parse_qs, urlsplit
        parts = urlsplit(self.path)
        if parts.path == '/search':
            query = parse_qs(parts.query).get('q', [''])[0]
            FakeWeb.searches.append(query)
            if 'RATELIMIT' in query:
                self.send_response(429)
                self.end_headers()
                self.wfile.write(b'slow down')
                return
            hits = [{'title': title, 'url': FakeWeb.base + path, 'content': content}
                    for key, (title, path, content) in FakeWeb.RESULTS.items() if key in query.lower()]
            body = json.dumps({'query': query, 'results': hits}).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
            return
        FakeWeb.pages.append(parts.path)
        body = FakeWeb.BODIES.get(parts.path)
        self.send_response(200 if body else 404)
        self.send_header('content-type', 'text/plain; charset=utf-8')
        self.end_headers()
        self.wfile.write((body or 'not found').encode())


def deep_research(work, cwd, home, grok_home, project_workflows, env, output, plain):
    import threading
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeWeb)
    port = server.server_address[1]
    FakeWeb.base = f'http://127.0.0.1:{port}'
    threading.Thread(target=server.serve_forever, daemon=True).start()
    result = {}
    try:
        (grok_home / 'config.toml').write_text('\n'.join([
            '[models]', 'web_search = "searx"', '',
            '[model.searx]', 'model = "searx"', f'base_url = "http://127.0.0.1:{port}"', 'protocol = "searxng"',
            'supports_backend_search = true', '',
            '[features]', 'web_fetch = true', '',
            '[toolset.web_fetch]', f'allowed_domains = ["127.0.0.1:{port}"]', 'allow_local = true', '',
        ]))
        # The test overlay mirrors what the client enables from config.toml.
        saved = {key: os.environ.get(key) for key in ('CODSH_WEB_SEARCH', 'CODSH_WEB_FETCH')}
        os.environ['CODSH_WEB_SEARCH'] = '1'
        os.environ['CODSH_WEB_FETCH'] = '1'
        try:
            patch = work / 'overlay-web.yml'
            patch.write_text(screen.overlay_text())
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        web_env = {**env, 'CODSH_ACP_PATCH': str(patch)}
        fake = project_workflows / 'deep-research.rhai'
        fake.write_text('let meta = #{ name: "deep-research", description: "a simplified copy" };\n"FAKE_REPORT"\n')
        session = Session('research', LAUNCHER, cwd, web_env, output,
                          extra=['--fullscreen', '--always-approve', '--trust'], cols=150, rows=46)
        try:
            session.wait_visible('Connected to dsh ACP', 30)
            prompt(session, '/workflows')
            shown = wait_until(session, lambda s: 'Built in (first): /deep-research.' in s.replace('\n', ''), '/workflows with the built-in', 15)
            flat = shown.replace('\n', '')
            assert 'Hidden: deep-research [project] (a built-in workflow of the same name takes precedence)' in flat, shown
            prompt(session, '/workflows deep-research')
            shown = wait_until(session, lambda s: 'Built in: pinned byte for byte from grok-build a28ee2b' in s.replace('\n', ''),
                               '/workflows deep-research', 15)
            flat = shown.replace('\n', '')
            assert 'Run: /deep-research <query> or /workflow deep-research [args]' in flat, shown
            assert '[project] — the built-in workflow takes precedence.' in flat, shown
            # The slash menu row is the reference command; Tab inserts it for the query.
            session.write('/deep')
            shown = session.wait_visible('built-in workflow · <query>', 10)
            assert '/deep-research' in shown, shown
            session.write(b'\t')
            session.write('alpha engines | beta release')
            session.wait_visible('/deep-research alpha engines | beta release', 10)
            session.write(b'\r')
            wait_until(session, lambda s: "Deep research 'deep-research' started in the background." in s.replace('\n', ''),
                       'deep research launch reply', 20)
            shown = wait_until(session, lambda s: 'RESEARCH_SYNTHESIZED answer from 2 verified finding(s).' in s
                               and 'Result status: verified' in s, 'deep research completion', 120)
            assert 'FAKE_REPORT' not in shown, shown
            assert sorted(FakeWeb.searches) == ['alpha engines', 'beta release'], FakeWeb.searches
            assert sorted(FakeWeb.pages) == ['/alpha', '/beta'], FakeWeb.pages
            prompt(session, '/workflow runs')
            shown = wait_until(session, lambda s: 'Source: built in, pinned from grok-build a28ee2b' in s, 'runs source line', 15)
            prompt(session, '/workflow save deep-research')
            wait_until(session, lambda s: "Save is disabled for built-in workflow 'deep-research'" in s.replace('\n', ''),
                       'save refusal', 15)
            result['session'] = True
            result['screen'] = session.finish(expect_alt_leave=True)['exit']
        finally:
            session.close()
        reports = sorted((grok_home / 'sessions').glob('*/*/workflows/*/scratch/report.md'))
        assert len(reports) == 1, reports
        report = reports[0].read_text()
        assert '**Status: Verified**' in report and f'- [S1] "Alpha Notes" — "{FakeWeb.base}/alpha"' in report, report

        # -p by name through the plain workflow path: a rate-limited branch and
        # a contradicted claim leave nothing verified, and the result says so.
        FakeWeb.pages.clear()
        ran = subprocess.run([NODE, str(LAUNCHER), '--rust', '--always-approve', '-p',
                              call({'source': {'type': 'name', 'name': 'deep-research'}, 'args': {'query': 'gamma languages | RATELIMIT epsilon'}})],
                             cwd=cwd, env=web_env, capture_output=True, text=True, timeout=180)
        assert ran.returncode == 0, ran.stderr
        assert "Workflow 'deep-research' ended;" in ran.stdout and '— status: complete' in ran.stdout, ran.stdout
        assert 'Result status: partial' in ran.stdout, ran.stdout
        assert 'None of the candidate claims survived independent source verification.' in ran.stdout, ran.stdout
        assert 'SearXNG rate limited the query' in ran.stdout, ran.stdout
        assert FakeWeb.pages == ['/gamma'], FakeWeb.pages
        result['headless_partial'] = True
    finally:
        server.shutdown()
        fake = project_workflows / 'deep-research.rhai'
        if fake.exists():
            fake.unlink()
    return result


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
        project_workflows = cwd / '.grok' / 'workflows'
        project_workflows.mkdir(parents=True)
        (project_workflows / 'digest.rhai').write_text(DIGEST)
        user_workflows = home / '.codsh-rust' / '.grok' / 'workflows'
        user_workflows.mkdir(parents=True)
        (user_workflows / 'digest.rhai').write_text(PERSONAL_DIGEST)
        (user_workflows / 'mangled.rhai').write_text(BROKEN.replace('broken', 'mangled'))
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
            #    summary agent, phases and a structured result. The call
            #    returns at once; the completion arrives as a notice turn.
            prompt(session, call({'script_path': 'triage.rhai', 'args': {'areas': ['docs', 'api', 'tests']}}))
            shown = session.wait_visible("PARENT_WORKFLOW ok: Workflow 'triage' started in the background.", 60)
            shown = wait_until(session, lambda s: 'PARENT_WORKFLOW_NOTICE' in s and 'CHILD_SAID summary of 3 reviews' in s,
                               'completion notice not shown', 60)
            assert "Workflow 'triage' (run id wf_" in shown and '— status: complete' in shown, shown
            for area in ('docs', 'api', 'tests'):
                assert f'CHILD_SAID reviewed {area}' in shown, (area, shown)
            shown = wait_until(session, lambda s: "Workflow complete in" in s and "'triage' · Summary · 4 agents" in s,
                               'workflow block title', 10)
            assert 'still running' not in shown, shown
            results['triage'] = True

            # 2. /workflow runs: phases, agents and the objective by display name.
            prompt(session, '/workflow runs')
            shown = wait_until(session, lambda s: "- 'triage' — complete" in s, 'runs overview', 15)
            assert 'Phase: Summary (2/2)' in shown and 'Agents: 4 done' in shown, shown
            assert 'Manage with /workflow pause|resume|stop|save <name>.' in shown, shown
            results['overview'] = True

            # 3. /tasks lists the four children, tagged with the workflow, and
            #    the session's runs.
            session.write(b'\x07')  # Ctrl+G
            shown = session.wait_visible('Subagents (0 running, 4 total', 10)
            assert shown.count('· workflow triage') == 4, shown
            assert 'review-api' in shown and 'summarise' in shown, shown
            assert 'Workflows (0 active, 1 total)' in shown, shown
            assert "'triage' — complete · Summary · 4 agents" in shown, shown
            session.write(b'\x1b')
            wait_until(session, lambda s: 'Subagents (' not in s, 'modal did not close', 10)
            results['tasks'] = True

            # 4. Pause by name stops the real child and the engine; resume
            #    continues from the journal (the cancelled step runs again);
            #    stop ends it and the completion notice says so.
            prompt(session, call({'script_path': 'slow.rhai'}))
            session.wait_visible("PARENT_WORKFLOW ok: Workflow 'slow' started in the background.", 40)
            shown = wait_until(session, lambda s: "Workflow running: 'slow' · Wait · 1 agent (1 running)" in s,
                               'running workflow title', 40)
            shown = wait_until(session, lambda s: '1 subagent · 1 workflow still running' in s, 'status line', 10)
            live = engines(work)
            assert live, 'no workflow engine process found while running'
            prompt(session, '/workflow pause slow')
            shown = wait_until(session, lambda s: 'Paused slow. /workflow resume slow to continue.' in s, 'pause reply', 15)
            shown = wait_until(session, lambda s: "Workflow user paused in" in s and "'slow' · Wait · 1 agent" in s,
                               'paused workflow title', 20)
            deadline = time.monotonic() + 10
            while engines(work) and time.monotonic() < deadline:
                time.sleep(0.2)
            assert not engines(work), engines(work)
            wait_until(session, lambda s: 'still running' not in s, 'child still running after pause', 15)
            prompt(session, '/workflow slow resume')
            shown = wait_until(session, lambda s: 'Resumed slow from its journal.' in s, 'resume reply', 20)
            shown = wait_until(session, lambda s: "Workflow running: 'slow' · Wait · 2 agents (1 running)" in s,
                               'resumed workflow title', 30)
            assert engines(work), 'no engine after resume'
            prompt(session, '/workflow stop slow')
            wait_until(session, lambda s: 'Stopped slow.' in s, 'stop reply', 15)
            shown = wait_until(session, lambda s: "Workflow 'slow' (run id wf_" in s and '— status: cancelled' in s,
                               'stop notice', 40)
            deadline = time.monotonic() + 10
            while engines(work) and time.monotonic() < deadline:
                time.sleep(0.2)
            assert not engines(work), engines(work)
            shown = wait_until(session, lambda s: 'still running' not in s, 'child still running after stop', 15)
            session.write(b'\x07')
            shown = session.wait_visible('Subagents (0 running, 6 total', 10)
            assert shown.count('[cancelled] waiter') == 2 and '· workflow slow' in shown, shown
            assert "'slow' — cancelled · Wait · 2 agents" in shown, shown
            session.write(b'\x1b')
            wait_until(session, lambda s: 'Subagents (' not in s, 'modal did not close', 10)
            assert session.process.poll() is None
            results['pause_resume_stop'] = {'engines_while_running': len(live)}

            # 5. A syntax error is reported to the model and the user; no run starts.
            prompt(session, call({'script_path': 'broken.rhai'}))
            shown = session.wait_visible('PARENT_WORKFLOW error:', 40)
            shown = wait_until(session, lambda s: 'workflow_resolve_failed' in s, 'syntax error not shown', 10)
            assert 'script failed to parse' in shown, shown
            results['syntax_error'] = True

            results['session_id'] = session.session_id()
            results['screen'] = session.finish(expect_alt_leave=True)['exit']
        finally:
            session.close()

        # Ticket 184 runs in a second PTY session (same folder and homes), so
        # neither session's screen log grows past what the emulator replays.
        session = Session('saved', LAUNCHER, cwd, env, output,
                          extra=['--fullscreen', '--always-approve', '--trust'], cols=150, rows=46)
        try:
            session.wait_visible('Connected to dsh ACP', 30)

            # 6. Ticket 184: /workflows lists the catalog with its scopes, the
            #    shadowed personal copy and the invalid file, in lines that fit
            #    the status area; /workflows <name> gives details or the reason.
            prompt(session, '/workflows')
            shown = wait_until(session, lambda s: 'Saved workflows (1): /digest [project].' in s, '/workflows overview', 15)
            flat = shown.replace('\n', '')
            assert 'Hidden: digest [user] (a project workflow of the same name takes precedence)' in flat, shown
            assert 'Not loaded (invalid, never run): mangled.rhai [user]' in flat, shown
            assert 'Built in (first): /deep-research. Folders: ' in flat, shown
            assert 'details: /workflows <name>' in flat, shown
            prompt(session, '/workflows digest')
            shown = wait_until(session, lambda s: 'digest [project] — Project digest of one topic' in s, '/workflows digest', 15)
            flat = shown.replace('\n', '')
            assert 'Use when: Ticket 184 PTY probe' in flat and 'Run: /digest [args] or /workflow digest [args]' in flat, shown
            assert '[user] — the project workflow takes precedence.' in flat, shown
            prompt(session, '/workflows mangled')
            shown = wait_until(session, lambda s: 'Not loaded: ' in s and 'script failed to parse' in s.replace('\n', ''), '/workflows mangled', 15)
            results['catalog_overview'] = True

            # 7. The slash menu completes /digest; Tab inserts it for arguments,
            #    and the run's real child answers into the session.
            session.write('/dig')
            shown = session.wait_visible('workflow · project', 10)
            assert '/digest' in shown, shown
            session.write(b'\t')
            session.write('the release notes')
            session.wait_visible('/digest the release notes', 10)
            session.write(b'\r')
            shown = wait_until(session, lambda s: "Workflow 'digest' started in the background." in s, 'slash launch reply', 20)
            shown = wait_until(session, lambda s: 'CHILD_SAID project digest of the release notes' in s and "Workflow 'digest' (run id wf_" in s,
                               'slash launch completion', 60)
            assert 'personal digest' not in shown, shown
            session.write(b'\x07')  # Ctrl+G: the run and its child in the tasks pane
            shown = session.wait_visible('Workflows (0 active, 1 total)', 10)
            assert "'digest' — complete · Digest · 1 agent" in shown and 'digester' in shown, shown
            session.write(b'\x1b')
            wait_until(session, lambda s: 'Subagents (' not in s, 'modal did not close', 10)
            # An invalid file named by /<name> says why instead of running.
            prompt(session, '/mangled now')
            shown = wait_until(session, lambda s: "Workflow 'mangled' unavailable: workflow 'mangled' is not loaded:" in s,
                               'invalid workflow reply', 15)
            results['slash_launch'] = True

            # 8. /workflow save keeps a finished inline run as a project workflow.
            prompt(session, call({'script': KEEP}))
            session.wait_visible("PARENT_WORKFLOW ok: Workflow 'keeper' started in the background.", 40)
            wait_until(session, lambda s: 'CHILD_SAID kept answer' in s and "Workflow 'keeper' (run id wf_" in s, 'keeper completion', 60)
            prompt(session, '/workflow save keeper')
            shown = wait_until(session, lambda s: "Saved workflow 'keeper' to" in s, 'save reply', 15)
            assert (project_workflows / 'keeper.rhai').read_text() == KEEP
            prompt(session, '/workflow save keeper')
            shown = wait_until(session, lambda s: 'saving never replaces a workflow file' in s.replace('\n', ''), 'save refusal', 15)
            session.write('/kee')
            shown = session.wait_visible('/keeper', 10)
            session.write('\x03')
            results['save'] = True
            results['saved_screen'] = session.finish(expect_alt_leave=True)['exit']
        finally:
            session.close()

        # Ticket 205: a real plugin with workflows, in a third PTY session.
        plugin_src = work / 'src-demo'
        (plugin_src / 'workflows').mkdir(parents=True)
        (plugin_src / 'plugin.json').write_text(json.dumps({'name': 'demo', 'version': '1.0.0', 'license': 'MIT', 'description': 'PTY plugin'}))
        (plugin_src / 'workflows' / 'lint.rhai').write_text(PLUGIN_LINT)
        (plugin_src / 'workflows' / 'digest.rhai').write_text(PLUGIN_DIGEST)

        def cli(*args):
            ran = subprocess.run([NODE, str(LAUNCHER), '--rust', *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
            assert ran.returncode == 0, (args, ran.stdout, ran.stderr)
            return ran.stdout
        cli('plugin', 'install', str(plugin_src), '--trust')
        listed = json.loads(cli('plugin', 'list', '--json'))
        assert listed[0]['state'] == 'disabled' and listed[0]['contributions']['workflows'] == ['demo:digest', 'demo:lint'], listed
        cli('plugin', 'enable', 'demo')
        session = Session('plugin', LAUNCHER, cwd, env, output,
                          extra=['--fullscreen', '--always-approve', '--trust'], cols=150, rows=46)
        try:
            session.wait_visible('Connected to dsh ACP', 30)
            prompt(session, '/workflows')
            shown = wait_until(session, lambda s: '/demo:digest [plugin demo]' in s.replace('\n', ''), '/workflows with plugin', 15)
            flat = shown.replace('\n', '')
            assert '/lint [plugin demo]' in flat and '/digest [project]' in flat, shown
            assert 'Qualified only: demo:digest' in flat, shown
            prompt(session, '/workflows demo:digest')
            shown = wait_until(session, lambda s: 'Plugin: demo 1.0.0 · license MIT · user plugin · trusted' in s.replace('\n', ''), '/workflows demo:digest', 15)
            prompt(session, '/lint the api')
            shown = wait_until(session, lambda s: "Workflow 'lint' started in the background." in s, 'plugin slash launch', 20)
            shown = wait_until(session, lambda s: 'CHILD_SAID plugin lint of the api' in s and "Workflow 'lint' (run id wf_" in s,
                               'plugin lint completion', 60)
            prompt(session, '/demo:digest please')
            shown = wait_until(session, lambda s: 'CHILD_SAID plugin digest' in s and "Workflow 'digest' (run id wf_" in s,
                               'qualified plugin completion', 60)
            prompt(session, '/workflow runs')
            shown = wait_until(session, lambda s: 'Source: plugin demo 1.0.0' in s, 'runs source line', 15)
            results['plugin_session'] = True
            results['plugin_screen'] = session.finish(expect_alt_leave=True)['exit']
        finally:
            session.close()

        # 6. Headless: the same saved script from -p (a plain prompt waits for
        #    its run and prints its block), and none with --no-subagents.
        def plain(*args):
            return subprocess.run([NODE, str(LAUNCHER), '--rust', '--always-approve', '-p', *args], cwd=cwd, env=env,
                                  capture_output=True, text=True, timeout=120)
        ran = plain(call({'script_path': 'triage.rhai', 'args': {'areas': ['cli']}}))
        assert ran.returncode == 0, ran.stderr
        assert "PARENT_WORKFLOW ok: Workflow 'triage' ended; a plain prompt waits for its workflow runs." in ran.stdout, ran.stdout
        assert "- Workflow 'triage' (run id wf_" in ran.stdout and '— status: complete' in ran.stdout, ran.stdout
        assert 'CHILD_SAID reviewed cli' in ran.stdout and 'CHILD_SAID summary of 1 reviews' in ran.stdout, ran.stdout
        # A personal script under the isolated $GROK_HOME/workflows.
        personal = user_workflows / 'personal-note.rhai'
        personal.write_text('let meta = #{ name: "personal-note", description: "A saved personal workflow" };\n'
                            'agent("CHILD_SAY from " + args.where).output\n')
        mine = plain(call({'script_path': str(personal), 'args': {'where': 'grok-home'}}))
        assert mine.returncode == 0, mine.stderr
        assert "Workflow 'personal-note' ended;" in mine.stdout and '— status: complete' in mine.stdout, mine.stdout
        assert 'CHILD_SAID from grok-home' in mine.stdout, mine.stdout
        off = plain(call({'script_path': 'triage.rhai'}), '--no-subagents')
        assert off.returncode == 0, off.stderr
        assert 'PARENT_WORKFLOW error:' in off.stdout and 'subagents are disabled' in off.stdout, off.stdout
        assert 'CHILD_SAID' not in off.stdout, off.stdout
        # Ticket 184: -p runs a saved workflow by name (the project copy).
        named = plain(call({'source': {'type': 'name', 'name': 'digest'}, 'args': {'objective': 'headless'}}))
        assert named.returncode == 0, named.stderr
        assert "Workflow 'digest' ended;" in named.stdout and '— status: complete' in named.stdout, named.stdout
        assert 'CHILD_SAID project digest of headless' in named.stdout, named.stdout
        # Ticket 205: -p by the plugin's qualified name, then refused once disabled.
        qualified = plain(call({'source': {'type': 'name', 'name': 'demo:lint'}, 'args': {'objective': 'headless'}}))
        assert qualified.returncode == 0, qualified.stderr
        assert 'CHILD_SAID plugin lint of headless' in qualified.stdout, qualified.stdout
        cli('plugin', 'disable', 'demo')
        refused = plain(call({'source': {'type': 'name', 'name': 'demo:lint'}}))
        assert "workflow 'demo:lint' is not available: plugin 'demo' is disabled" in refused.stdout, refused.stdout
        assert 'CHILD_SAID plugin lint' not in refused.stdout, refused.stdout
        results['headless'] = True

        # 7. Ticket 182: six held children under a cap of 2 from config.toml,
        #    then 3 from the environment over it; a schema answer fixed by one
        #    retry; the scratch note under the session directory.
        grok_home = home / '.codsh-rust' / '.grok'
        (grok_home / 'config.toml').write_text('[subagents]\nworkflow_max_concurrent = 2\n')

        def panel(extra_env=None):
            ran = subprocess.run([NODE, str(LAUNCHER), '--rust', '--always-approve', '-p', call({'script_path': 'panel.rhai', 'agent_budget': 7})],
                                 cwd=cwd, env={**env, **(extra_env or {})}, capture_output=True, text=True, timeout=120)
            assert ran.returncode == 0, ran.stderr
            assert "PARENT_WORKFLOW ok: Workflow 'panel' ended;" in ran.stdout and '— status: complete' in ran.stdout, ran.stdout
            body = ran.stdout[ran.stdout.index('Result:') + len('Result:'):].strip().splitlines()[0]
            return json.loads(body)
        capped = panel()
        peaks = [int(text.split('peak=')[1]) for text in capped['peaks']]
        assert max(peaks) == 2, capped
        assert capped['held'] == 6 and capped['note'] == 'scratch/panel.md', capped
        notes = list((grok_home / 'sessions').glob('*/*/workflows/*/scratch/panel.md'))
        assert len(notes) == 1 and notes[0].read_text() == 'held 6', notes
        state = json.loads((notes[0].parent.parent / 'run.json').read_text())
        assert state['status'] == 'complete' and state['agentsUsed'] == 7 and state['agentBudget'] == 7, state
        wider = panel({'GROK_WORKFLOW_MAX_CONCURRENT_AGENTS': '3'})
        assert max(int(text.split('peak=')[1]) for text in wider['peaks']) == 3, wider
        results['cap'] = {'config': max(peaks), 'env': 3}

        # 8. Ticket 206: the built-in deep-research workflow against keyless
        #    fake web services on loopback, in a fourth PTY session.
        results['deep_research'] = deep_research(work, cwd, home, grok_home, project_workflows, env, output, plain)
    print(json.dumps({'ok': True, 'output': str(output), **results}))


if __name__ == '__main__':
    main()
