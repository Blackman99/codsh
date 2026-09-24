#!/usr/bin/env python3
"""Installed plain command: real dsh, no TTY, provider fixture only."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


def dsh_bin():
    located = subprocess.run(['node', '-e', "console.log(require('fs').realpathSync(require('child_process').execFileSync('which',['dsh']).toString().trim()))"], capture_output=True, text=True)
    if located.returncode == 0 and located.stdout.strip():
        return located.stdout.strip()
    script = "import { createRequire } from 'node:module'; import { dirname, join } from 'node:path'; import { readFileSync } from 'node:fs'; const r=createRequire(process.argv[1]); const m=r.resolve('@deepseek-ai/dsh/package.json'); const bin=JSON.parse(readFileSync(m,'utf8')).bin; process.stdout.write(join(dirname(m), typeof bin==='string'?bin:bin.dsh))"
    return run([NODE, '--input-type=module', '-e', script, str(ROOT / 'package.json')], cwd=ROOT).stdout


def overlay_text():
    return run([NODE, '--input-type=module', '-e',
                "import { rustAcpOverlay } from './scripts/rust-acp-overlay.mjs'; process.stdout.write(rustAcpOverlay())"],
               cwd=ROOT).stdout


def plain(launcher, cwd, env, args, stdin='', timeout=45):
    return subprocess.run(
        [NODE, str(launcher), '--rust', *args],
        cwd=cwd, env=env, input=stdin,
        capture_output=True, text=True, timeout=timeout,
    )


def start_plain(launcher, cwd, env, args):
    return subprocess.Popen(
        [NODE, str(launcher), '--rust', *args],
        cwd=cwd, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, text=True,
    )


def wait_for_grandchild(launcher_pid, seconds=20):
    """The dsh process under the native client: it exists while connect runs."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        native = subprocess.run(['pgrep', '-P', str(launcher_pid)], capture_output=True, text=True).stdout.split()
        for pid in native:
            dsh = subprocess.run(['pgrep', '-P', pid], capture_output=True, text=True).stdout.split()
            if dsh:
                return dsh[0]
        time.sleep(0.05)
    raise AssertionError('dsh child never started')


def outside_temp_root():
    """A scratch directory outside /tmp, /var/tmp, and TMPDIR, beside the repo
    or in HOME. Sandbox profiles write-allow the temp roots."""
    temp_roots = [Path(p).resolve() for p in ('/tmp', '/var/tmp', os.environ.get('TMPDIR') or '/tmp')]
    for candidate in (ROOT.parent, Path.home()):
        if not candidate.is_dir():
            continue
        try:
            path = Path(tempfile.mkdtemp(prefix='.codsh-145-plain-', dir=candidate)).resolve()
        except OSError:
            continue
        if any(path == root or root in path.parents for root in temp_roots):
            shutil.rmtree(path, ignore_errors=True)
            continue
        return path
    raise AssertionError('no scratch directory outside the temp roots')


def interactive_flags(launcher, project, web_env, web_trace, work, output):
    """Real PTY: --cwd and --disable-web-search reach the TUI session. The
    headless-only --max-turns and --tools print a warning and are ignored."""
    spec = importlib.util.spec_from_file_location(
        'rust_screen_pty_test', ROOT / 'scripts' / 'rust-screen-pty-test.py')
    screen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(screen)
    moved = work / 'interactive-cwd'
    moved.mkdir()
    (moved / 'note.txt').write_text('MOVED_NOTE\n')
    # A parent's plain mask and step bound must not reach the TUI session.
    tui_env = {**web_env, 'DSH_CODE_CLI_MOCK_TOOL': 'plain-steps',
               'TERM': 'xterm-256color', 'COLORTERM': 'truecolor',
               'CODSH_PLAIN_TOOLS': 'deny:edit', 'CODSH_PLAIN_MAX_TURNS': '1'}
    session = screen.Session(
        'plain-flags-tui', launcher, project, tui_env, output,
        extra=['--cwd', str(moved), '--disable-web-search', '--max-turns', '1',
               '--tools', 'read', '--always-approve'])
    try:
        session.wait_visible('Connected to dsh ACP', 30)
        session.write('INTERACTIVE_FLAGS_TOKEN\r')
        session.wait_visible('RUST_ACP_STEPS_DONE', 40)
        session.finish()
    finally:
        if session.process.poll() is None:
            session.kill_group()
    raw = bytes(session.data).decode(errors='replace')
    assert '--max-turns' in raw and '--tools' in raw and 'ignored' in raw, raw[:1500]
    rows = [json.loads(line) for line in web_trace.read_text().splitlines() if line.strip()]
    web_trace.unlink()
    assert len(rows) >= 5, rows
    tools = set(rows[0]['tools'])
    assert not {'web_search', 'web_fetch'} & tools, tools
    assert {'read', 'edit', 'subagent'} <= tools, tools
    context = '\n'.join(rows[0]['user'])
    assert os.path.realpath(moved) in context, context


def main():
    output = Path(tempfile.mkdtemp(prefix='codsh-145-plain-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-145-plain-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        project = work / 'project'
        other = work / 'other'
        project.mkdir()
        other.mkdir()
        (project / 'note.txt').write_text('PLAIN_NOTE\n')
        (other / 'note.txt').write_text('OTHER_NOTE\n')
        (project / 'prompt.txt').write_text('from-file\n')
        pack_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'],
            'npm_config_cache': str(work / 'npm-cache'),
            'npm_config_userconfig': str(work / 'empty-user.npmrc'),
            'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
            'npm_config_update_notifier': 'false',
        }
        pack = json.loads(run(
            ['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
            cwd=ROOT / 'packages/cli', env=pack_env,
        ).stdout)[0]['filename']
        prefix = work / 'installed'
        run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline',
             '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
        launcher = prefix / 'node_modules/.bin/codsh'
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        base = {
            'HOME': str(home), 'PATH': os.environ['PATH'],
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
        }

        def env(mode):
            return {**base, 'DSH_CODE_CLI_MOCK_TOOL': mode}

        help_run = plain(launcher, project, env('echo'), ['--help'])
        assert help_run.returncode == 0, help_run.stderr
        assert '-p/--single' in help_run.stdout
        assert '--max-turns' in help_run.stdout
        assert 'completions' in help_run.stdout
        assert 'later ticket' in help_run.stdout
        assert '--disable-web-search' in help_run.stdout and 'subagent_fork' in help_run.stdout
        short = plain(launcher, project, env('echo'), ['-h'])
        assert short.returncode == 0, short.stderr
        assert 'bash, elvish, fish, powershell, zsh' in short.stdout
        assert '-m/--model' in short.stdout and 'export' in short.stdout
        assert len(short.stdout) < len(help_run.stdout)
        bare_help = plain(launcher, project, env('echo'), ['help'])
        assert bare_help.returncode == 0 and 'Plain:' in bare_help.stdout
        for shell, marker in (
            ('bash', '_codsh_rust_complete'),
            ('zsh', '#compdef codsh'),
            ('fish', 'complete -c codsh'),
            ('powershell', 'Register-ArgumentCompleter'),
            ('elvish', 'edit:completion:arg-completer'),
        ):
            script = plain(launcher, project, env('echo'), ['completions', shell])
            assert script.returncode == 0, (shell, script.stderr)
            assert marker in script.stdout, shell
            assert 'help' not in script.stderr.lower() or marker in script.stdout
        completions_help = plain(launcher, project, env('echo'), ['completions', '--help'])
        assert completions_help.returncode == 0, completions_help.stderr
        assert '--leader-socket <PATH>' in completions_help.stdout
        assert 'dsh owns execution' in completions_help.stdout
        leader = plain(
            launcher, project, env('echo'),
            ['completions', '--leader-socket', '/tmp/unused.sock', 'bash'],
        )
        assert leader.returncode != 0
        assert 'completions --leader-socket' in leader.stderr
        assert 'dsh owns execution' in leader.stderr
        assert '_codsh_rust_complete' not in leader.stdout
        missing_shell = plain(launcher, project, env('echo'), ['completions'])
        assert missing_shell.returncode == 2
        assert 'completions <SHELL>' in missing_shell.stderr
        bad_shell = plain(launcher, project, env('echo'), ['completions', 'tcsh'])
        assert bad_shell.returncode == 2 and 'invalid value' in bad_shell.stderr

        normal = plain(launcher, project, env('echo'), ['-p', 'PLAIN_TOKEN'])
        assert normal.returncode == 0, normal.stderr
        assert 'RUST_ACP_ANSWER' in normal.stdout
        assert 'PLAIN_TOKEN' in normal.stdout
        assert '\x1b' not in normal.stdout
        assert 'Connecting' not in normal.stdout
        assert normal.stdout.endswith('\n')

        read_file = plain(launcher, project, env('plain-read'), ['--single', 'read the note'])
        assert read_file.returncode == 0, read_file.stderr
        assert 'RUST_ACP_HUGE_DONE' in read_file.stdout
        assert 'PLAIN_NOTE' not in read_file.stdout
        assert 'tool' not in read_file.stdout.lower()

        moved = plain(launcher, project, env('plain-read'),
                      ['-p', 'read other', '--cwd', str(other)])
        assert moved.returncode == 0, moved.stderr
        assert 'RUST_ACP_HUGE_DONE' in moved.stdout
        session_cwd = ''
        seen = []
        for path in (home / '.codsh-rust' / 'dsh').rglob('*'):
            if not path.is_file() or path.stat().st_size > 2_000_000:
                continue
            text = path.read_text(errors='replace')
            seen.append(f'{path.relative_to(home)}:{path.stat().st_size}')
            if str(other) in text or 'read other' in text:
                session_cwd = text
                break
        assert str(other) in session_cwd, f'cwd session did not record the other directory; files={seen[:40]}'

        first = plain(launcher, project, env('echo'), ['-p', 'FIRST_PLAIN'])
        assert first.returncode == 0, first.stderr
        resumed = plain(launcher, project, env('echo'), ['-p', 'SECOND_PLAIN', '--continue'])
        assert resumed.returncode == 0, resumed.stderr
        assert 'FIRST_PLAIN' in resumed.stdout and 'SECOND_PLAIN' in resumed.stdout
        titled = plain(launcher, project, env('echo'), ['-p', 'TITLE_RESUME_TOKEN', '--resume', 'FIRST_PLAIN'])
        assert titled.returncode == 0, titled.stderr
        assert 'FIRST_PLAIN' in titled.stdout and 'TITLE_RESUME_TOKEN' in titled.stdout

        denied = plain(launcher, project, env('file-edit'),
                       ['-p', 'edit it', '--deny', 'Edit', '--always-approve'])
        assert denied.returncode == 0, denied.stderr
        assert 'Denied by permission policy' in denied.stdout or 'RUST_ACP_FILE_ERROR' in denied.stdout
        assert (project / 'note.txt').read_text() == 'PLAIN_NOTE\n'

        trace = work / 'tool-trace.jsonl'
        masked_env = {**env('file-edit'), 'CODSH_REVIEW_TRACE': str(trace)}
        filtered = plain(launcher, project, masked_env,
                         ['-p', 'edit it', '--tools', 'read_file', '--disallowed-tools', 'edit'])
        assert filtered.returncode == 0, filtered.stderr
        assert 'plain tool filter removed edit' in filtered.stdout, (
            f'stdout={filtered.stdout!r}\nstderr={filtered.stderr!r}\n'
            f'trace={trace.read_text() if trace.exists() else ""}'
        )
        assert (project / 'note.txt').read_text() == 'PLAIN_NOTE\n'
        traced = [json.loads(line) for line in trace.read_text().splitlines() if line.strip()]
        assert traced, 'first model request was not traced'
        assert traced[0]['tools'] == ['read'], traced[0]
        trace.unlink()
        unknown_tool = plain(launcher, project, env('echo'),
                             ['-p', 'hello', '--disallowed-tools', 'not_a_dsh_tool'])
        assert unknown_tool.returncode != 0, unknown_tool.stdout
        assert 'unknown' in unknown_tool.stderr or 'refused' in unknown_tool.stderr

        bounded = plain(launcher, project, env('plain-steps'),
                        ['-p', 'keep reading', '--max-turns', '2'])
        assert bounded.returncode == 1, bounded.stdout
        assert 'RUST_ACP_STEPS_DONE' not in bounded.stdout
        assert '--max-turns 2' in bounded.stderr
        assert 'step 3' in bounded.stderr

        duplicate = plain(launcher, project, env('echo'), ['-p', 'FIRST_DUP', '-p', 'SECOND_DUP'])
        assert duplicate.returncode == 1 and duplicate.stdout == ''
        assert 'conflicting prompt' in duplicate.stderr
        assert 'SECOND_DUP' not in duplicate.stdout

        unknown = plain(launcher, project, env('echo'), ['--not-a-real-option'])
        assert unknown.returncode == 2
        assert unknown.stdout == ''
        assert "unexpected argument '--not-a-real-option'" in unknown.stderr
        assert 'Rust startup failed' not in unknown.stderr

        missing_flag = plain(launcher, project, env('echo'), ['--allowedTools'])
        assert missing_flag.returncode == 2
        assert "a value is required for '--allow <RULE>'" in missing_flag.stderr
        missing_deny = plain(launcher, project, env('echo'), ['--disallowedTools'])
        assert missing_deny.returncode == 2
        assert "a value is required for '--deny <RULE>'" in missing_deny.stderr
        missing_system = plain(launcher, project, env('echo'), ['--system-prompt'])
        assert missing_system.returncode == 2
        assert '--system-prompt-override <PROMPT>' in missing_system.stderr
        missing_rules = plain(launcher, project, env('echo'), ['--append-system-prompt'])
        assert missing_rules.returncode == 2
        assert '--rules <RULES>' in missing_rules.stderr
        missing_compact = plain(launcher, project, env('echo'), ['--compaction-mode'])
        assert missing_compact.returncode == 2
        assert '--compaction-mode <MODE>' in missing_compact.stderr
        missing_prompt = plain(launcher, project, env('echo'), ['--prompt-file'])
        assert missing_prompt.returncode == 2
        assert 'a value is required' in missing_prompt.stderr
        bad_format = plain(launcher, project, env('echo'), ['--output-format', 'not-a-format'])
        assert bad_format.returncode == 2
        assert "invalid value 'not-a-format'" in bad_format.stderr

        later = plain(launcher, project, env('echo'), ['-p', 'FORMAT_TOKEN', '--output-format', 'json'])
        assert later.returncode == 0, later.stderr
        formatted = json.loads(later.stdout)
        assert 'FORMAT_TOKEN' in formatted['text']
        assert formatted['stopReason'] == 'end_turn'
        assert formatted.get('usage_absent') is True
        assert 'usage' not in formatted and 'total_cost_usd' not in formatted
        verbatim = plain(launcher, project, env('echo'), ['-p', 'VERBATIM_TOKEN', '--verbatim'])
        assert verbatim.returncode == 0, verbatim.stderr
        assert 'VERBATIM_TOKEN' in verbatim.stdout
        alias_dir = work / 'alias-cwd'
        alias_dir.mkdir()
        named = plain(launcher, alias_dir, env('echo'), ['-p', 'ALIAS_TITLE'])
        assert named.returncode == 0, named.stderr
        short_continue = plain(launcher, alias_dir, env('echo'), ['-c', '-p', 'ALIAS_NEXT'])
        assert short_continue.returncode == 0, short_continue.stderr
        assert 'ALIAS_TITLE' in short_continue.stdout and 'ALIAS_NEXT' in short_continue.stdout
        listed = run([
            NODE, str(ROOT / 'packages/cli/bin/rust-acp-session-read.mjs'), '--list',
        ], env={
            'DSH_HOME': str(home / '.codsh-rust' / 'dsh'),
            'DSH_BIN': dsh,
            'PATH': os.environ['PATH'],
        })
        catalog = json.loads(listed.stdout)
        here = [
            session for session in catalog.get('sessions', [])
            if str(alias_dir) in str(session.get('cwd', ''))
        ]
        assert len(here) == 1, here
        assert 'ALIAS_TITLE' in here[0].get('prompts', []), here[0]
        short_resume = plain(launcher, alias_dir, env('echo'), ['-p', 'ALIAS_RESUME', '-r', here[0]['id']])
        assert short_resume.returncode == 0, short_resume.stderr
        assert 'ALIAS_TITLE' in short_resume.stdout and 'ALIAS_RESUME' in short_resume.stdout
        grok_home = home / '.codsh-rust' / '.grok'
        (grok_home / 'commands').mkdir(parents=True, exist_ok=True)
        (grok_home / 'rules').mkdir(parents=True, exist_ok=True)
        (grok_home / 'commands' / 'ship-note.md').write_text(
            '---\ndescription: note\n---\nSHIP_NOTE_BODY\n')
        (grok_home / 'rules' / 'home.md').write_text('HOME_RULE\n')
        wire = work / 'verbatim-trace.jsonl'
        wire_env = {**env('echo'), 'CODSH_REVIEW_TRACE': str(wire)}
        slash = '/ship-note  keep\nline'
        expanded = plain(launcher, project, wire_env, ['-p', slash, '--rules', 'SESSION_RULE_SENTINEL'])
        assert expanded.returncode == 0, expanded.stderr
        assert 'SHIP_NOTE_BODY' in expanded.stdout
        assert 'HOME_RULE' in expanded.stdout
        frozen = plain(launcher, project, wire_env, ['-p', slash, '--verbatim', '--rules', 'SESSION_RULE_SENTINEL'])
        assert frozen.returncode == 0, frozen.stderr
        rows = [json.loads(line) for line in wire.read_text().splitlines() if line.strip()]
        assert len(rows) >= 2, rows
        expanded_user = '\n'.join(rows[0]['user'])
        frozen_user = '\n'.join(rows[-1]['user'])
        assert 'SHIP_NOTE_BODY' in expanded_user and 'HOME_RULE' in expanded_user, expanded_user
        # --verbatim keeps the user's bytes exact and still applies rules.
        # The rules lead as their own ACP block; dsh joins adjacent text
        # blocks, so the model part is the rule block and then the exact bytes.
        frozen_first = rows[-1]['user'][0]
        assert frozen_first.startswith('<human_rules>'), frozen_first
        assert frozen_first.endswith('</human_rules>\n' + slash), frozen_first
        rule_block = frozen_first[:-len(slash)]
        assert 'SESSION_RULE_SENTINEL' in rule_block and 'HOME_RULE' in rule_block, rule_block
        assert 'SHIP_NOTE_BODY' not in frozen_user
        wire.unlink()
        replaced = plain(launcher, project, wire_env,
                         ['-p', slash, '--verbatim', '--system-prompt-override', 'OVERRIDE_SENTINEL'])
        assert replaced.returncode == 0, replaced.stderr
        replaced_first = [json.loads(line) for line in wire.read_text().splitlines() if line.strip()][0]['user'][0]
        assert replaced_first == 'OVERRIDE_SENTINEL\n' + slash, replaced_first
        (project / 'spaced.txt').write_text('  keep\nline')
        wire.unlink()
        spaced = plain(launcher, project, wire_env, ['--verbatim', '--prompt-file', 'spaced.txt'])
        assert spaced.returncode == 0, spaced.stderr
        spaced_rows = [json.loads(line) for line in wire.read_text().splitlines() if line.strip()]
        spaced_first = spaced_rows[0]['user'][0]
        assert spaced_first.endswith('</human_rules>\n  keep\nline'), spaced_first
        assert 'HOME_RULE' in spaced_first, spaced_first
        wire.unlink()
        agent_trace = work / 'agent-trace.jsonl'
        agent_env = {**env('echo'), 'CODSH_REVIEW_TRACE': str(agent_trace)}
        unfiltered = plain(launcher, project, agent_env, ['-p', 'hello'])
        assert unfiltered.returncode == 0, unfiltered.stderr
        offered = [json.loads(line) for line in agent_trace.read_text().splitlines() if line.strip()]
        assert {'subagent', 'subagent_fork'} <= set(offered[0]['tools']), offered[0]
        agent_trace.unlink()
        denied_agent = plain(launcher, project, agent_env,
                             ['-p', 'hello', '--disallowed-tools', 'Agent'])
        assert denied_agent.returncode == 0, denied_agent.stderr
        masked = [json.loads(line) for line in agent_trace.read_text().splitlines() if line.strip()]
        assert masked, 'Agent deny made no model request'
        for row in masked:
            assert 'subagent' not in row['tools'] and 'subagent_fork' not in row['tools'], row
            assert 'read' in row['tools'], row
        agent_trace.unlink()
        scoped_agent = plain(launcher, project, env('echo'),
                             ['-p', 'hello', '--disallowed-tools', 'Agent(explore),edit'])
        assert scoped_agent.returncode != 0, scoped_agent.stdout
        assert 'Agent(explore)' in scoped_agent.stderr
        assert 'later ticket' in scoped_agent.stderr
        # Every typed spelling is refused before a provider call, from the
        # flags and from a CODSH_PLAIN_TOOLS value inherited from a parent.
        for entry in ('Agent(explore, plan)', 'Agent()', 'agent(explore)'):
            named = entry.split(',')[0]
            for flag in ('--disallowed-tools', '--tools'):
                typed = plain(launcher, project, agent_env, ['-p', 'hello', flag, entry])
                assert typed.returncode == 1, (flag, entry, typed.stdout, typed.stderr)
                assert typed.stdout == '', (flag, entry, typed.stdout)
                assert named in typed.stderr and 'later ticket' in typed.stderr, (flag, entry, typed.stderr)
                assert not agent_trace.exists(), (flag, entry, agent_trace.read_text())
            inherited = plain(launcher, project, {**agent_env, 'CODSH_PLAIN_TOOLS': f'deny:{entry}'},
                              ['-p', 'hello'])
            assert inherited.returncode == 1, (entry, inherited.stdout, inherited.stderr)
            assert inherited.stdout == '', (entry, inherited.stdout)
            assert named in inherited.stderr and 'later ticket' in inherited.stderr, (entry, inherited.stderr)
            assert 'unknown global tool' not in inherited.stderr, (entry, inherited.stderr)
            assert not agent_trace.exists(), (entry, agent_trace.read_text())

        # Integrated flags run in plain mode instead of being refused.
        memory_trace = work / 'memory-trace.jsonl'
        (grok_home / 'memory').mkdir(parents=True, exist_ok=True)
        (grok_home / 'memory' / 'MEMORY.md').write_text('PLAIN_MEMORY_SENTINEL\n')
        memory_env = {**env('echo'), 'CODSH_REVIEW_TRACE': str(memory_trace), 'GROK_MEMORY': '1'}

        def memory_rows():
            rows = [json.loads(line) for line in memory_trace.read_text().splitlines() if line.strip()]
            memory_trace.unlink()
            return rows

        remembered_dir = work / 'memory-on'
        remembered_dir.mkdir()
        remembered = plain(launcher, remembered_dir, memory_env, ['-p', 'MEMORY_FIRST'])
        assert remembered.returncode == 0, remembered.stderr
        first_user = '\n'.join(memory_rows()[0]['user'])
        assert 'PLAIN_MEMORY_SENTINEL' in first_user and 'MEMORY_FIRST' in first_user, first_user
        again = plain(launcher, remembered_dir, memory_env, ['-c', '-p', 'MEMORY_AGAIN'])
        assert again.returncode == 0, again.stderr
        again_user = '\n'.join(memory_rows()[-1]['user'])
        assert 'MEMORY_AGAIN' in again_user, again_user
        assert again_user.count('PLAIN_MEMORY_SENTINEL') == 1, again_user
        forgotten_dir = work / 'memory-off'
        forgotten_dir.mkdir()
        forgotten = plain(launcher, forgotten_dir, memory_env, ['-p', 'MEMORY_OFF', '--no-memory'])
        assert forgotten.returncode == 0, forgotten.stderr
        forgotten_user = '\n'.join(memory_rows()[0]['user'])
        assert 'MEMORY_OFF' in forgotten_user and 'PLAIN_MEMORY_SENTINEL' not in forgotten_user, forgotten_user
        exact_dir = work / 'memory-verbatim'
        exact_dir.mkdir()
        exact = plain(launcher, exact_dir, memory_env, ['--verbatim', '-p', '  keep\nline'])
        assert exact.returncode == 0, exact.stderr
        # The ACP prompt carries memory as its own leading block and the user
        # block unchanged. dsh joins adjacent text blocks into one model part,
        # so the model sees the note first and then the exact bytes.
        exact_user = memory_rows()[0]['user'][0]
        assert exact_user.startswith('<local-memory>'), exact_user
        assert '</local-memory>\n<human_rules>' in exact_user, exact_user
        assert exact_user.endswith('</human_rules>\n  keep\nline'), exact_user
        assert 'PLAIN_MEMORY_SENTINEL' in exact_user and 'HOME_RULE' in exact_user, exact_user
        (grok_home / 'memory' / 'MEMORY.md').unlink()

        # Workspace and read-only profiles write-allow the temp roots, so the
        # write targets live outside /tmp and TMPDIR, as in the sandbox test.
        fixture = outside_temp_root()
        try:
            boxed_dir = fixture / 'boxed-cwd'
            boxed_dir.mkdir()
            report = work / 'sandbox-report.json'
            boxed = plain(launcher, project, env('file-write'),
                          ['-p', 'write it', '--cwd', str(boxed_dir), '--sandbox', 'workspace',
                           '--sandbox-report', str(report), '--always-approve'])
            assert boxed.returncode == 0, boxed.stderr
            assert (boxed_dir / 'created.txt').read_text() == 'RUST_ACP_CREATED\n', boxed.stdout
            assert not (project / 'created.txt').exists()
            applied = json.loads(report.read_text())
            assert applied['applied'] is True, applied
            roots = [os.path.realpath(root) for root in applied['writeRoots']]
            assert os.path.realpath(boxed_dir) in roots, roots
            assert os.path.realpath(project) not in roots, roots
            locked_dir = fixture / 'locked-cwd'
            locked_dir.mkdir()
            locked = plain(launcher, locked_dir, env('file-write'),
                           ['-p', 'write it', '--sandbox', 'read-only', '--always-approve'])
            assert locked.returncode == 0, locked.stderr
            assert 'RUST_ACP_FILE_ERROR' in locked.stdout, locked.stdout
            assert not (locked_dir / 'created.txt').exists()
        finally:
            shutil.rmtree(fixture, ignore_errors=True)

        web_patch = work / 'web-overlay.yml'
        web_patch.write_text(run([NODE, '--input-type=module', '-e',
                                  "import { rustAcpOverlay } from './scripts/rust-acp-overlay.mjs'; process.stdout.write(rustAcpOverlay())"],
                                 cwd=ROOT, env={**os.environ, 'CODSH_WEB_SEARCH': '1', 'CODSH_WEB_FETCH': '1'}).stdout)
        web_trace = work / 'web-trace.jsonl'
        web_env = {**env('echo'), 'CODSH_ACP_PATCH': str(web_patch), 'CODSH_REVIEW_TRACE': str(web_trace),
                   'GROK_WEB_FETCH': '1'}
        with_web = plain(launcher, project, web_env, ['-p', 'hello'])
        assert with_web.returncode == 0, with_web.stderr
        web_rows = [json.loads(line) for line in web_trace.read_text().splitlines() if line.strip()]
        assert {'web_search', 'web_fetch'} <= set(web_rows[0]['tools']), web_rows[0]
        web_trace.unlink()
        no_web = plain(launcher, project, web_env, ['-p', 'hello', '--disable-web-search'])
        assert no_web.returncode == 0, no_web.stderr
        web_rows = [json.loads(line) for line in web_trace.read_text().splitlines() if line.strip()]
        assert web_rows and not {'web_search', 'web_fetch'} & set(web_rows[0]['tools']), web_rows[0]
        assert 'read' in web_rows[0]['tools'], web_rows[0]
        web_trace.unlink()
        inspected = plain(launcher, project, web_env, ['--disable-web-search', 'inspect', '--json'])
        assert inspected.returncode == 0, inspected.stderr
        assert '"webFetchEnabled":false' in inspected.stdout.replace(' ', ''), inspected.stdout[-800:]

        warned = plain(launcher, project, env('echo'), ['--max-turns', '2', '--tools', 'read', '--version'])
        assert warned.returncode == 0, warned.stderr
        assert 'codsh-rust' in warned.stdout
        assert '--max-turns' in warned.stderr and '--tools' in warned.stderr, warned.stderr
        assert 'ignored' in warned.stderr, warned.stderr
        interactive_flags(launcher, project, web_env, web_trace, work, output)

        positional = plain(launcher, project, env('echo'), ['just words'])
        assert positional.returncode == 1
        assert 'positional prompt' in positional.stderr

        from_file = plain(launcher, project, env('echo'), ['--prompt-file', 'prompt.txt'])
        assert from_file.returncode == 0, from_file.stderr
        assert 'from-file' in from_file.stdout
        # Upstream apply_cwd changes directory, then reads --prompt-file.
        # A relative path is therefore inside --cwd, not beside the invocation.
        # The file here asks the model to read note.txt; only ../other has
        # OTHER_NOTE, so the answer proves both the file and the turn cwd.
        (other / 'prompt.txt').write_text('read the note\n')
        elsewhere = plain(launcher, project, env('plain-read'),
                          ['--prompt-file', 'prompt.txt', '--cwd', '../other'])
        assert elsewhere.returncode == 0, elsewhere.stderr
        assert 'RUST_ACP_HUGE_DONE' in elsewhere.stdout, elsewhere.stdout
        missing = plain(launcher, project, env('echo'),
                        ['--prompt-file', 'missing-prompt.txt', '--cwd', '../other'])
        assert missing.returncode != 0, missing.stdout
        assert 'missing-prompt.txt' in missing.stderr
        assert 'from-file' not in missing.stdout

        piped = plain(launcher, project, env('echo'), ['-p', 'VISIBLE'], stdin='NOT_THE_PROMPT\n')
        assert piped.returncode == 0, piped.stderr
        assert 'VISIBLE' in piped.stdout
        assert 'NOT_THE_PROMPT' not in piped.stdout

        slow_env = env('echo')
        slow_env['DSH_CODE_CLI_MOCK_DELAY_MS'] = '4000'
        # SIGHUP is not caught by the native client; the launcher reports the
        # signal death as 128+N instead of a generic 1.
        for sig, code in ((signal.SIGINT, 130), (signal.SIGTERM, 143), (signal.SIGHUP, 129)):
            child = start_plain(launcher, project, slow_env, ['-p', 'slow'])
            time.sleep(1.2)
            os.killpg(child.pid, sig)
            try:
                out, err = child.communicate(timeout=20)
            except subprocess.TimeoutExpired:
                child.kill()
                raise
            assert child.returncode == code, (sig, child.returncode, out, err)
            assert 'RUST_ACP_ANSWER' not in out
        # Ctrl+C that reaches only codsh while dsh is still connecting: the
        # prompt is never submitted, so no model request starts.
        connect_trace = work / 'connect-trace.jsonl'
        child = start_plain(launcher, project, {**slow_env, 'CODSH_REVIEW_TRACE': str(connect_trace)},
                            ['-p', 'CONNECT_CANCEL'])
        dsh_child = wait_for_grandchild(child.pid)
        os.kill(child.pid, signal.SIGINT)
        out, err = child.communicate(timeout=30)
        assert child.returncode == 130, (child.returncode, out, err, dsh_child)
        assert out == '', out
        assert not connect_trace.exists(), connect_trace.read_text()
        if os.environ.get('CODSH_PLAIN_LONG_TURN') == '1':
            # Opt-in: a turn longer than the old 180 s cap still completes.
            long_turn = plain(launcher, project, {**env('echo'), 'DSH_CODE_CLI_MOCK_DELAY_MS': '190000'},
                              ['-p', 'LONG_TURN_TOKEN'], timeout=400)
            assert long_turn.returncode == 0, (long_turn.stdout, long_turn.stderr)
            assert 'LONG_TURN_TOKEN' in long_turn.stdout

        grok = home / '.codsh-rust' / '.grok'
        grok.mkdir(parents=True, exist_ok=True)
        (grok / 'config.toml').write_text(
            '[models]\ndefault = "local"\n'
            '[model.local]\nmodel = "fixture-model"\n'
            'base_url = "http://127.0.0.1:9/v1"\n'
            'env_key = "CODSH_REVIEW_API_KEY"\n'
            'supports_reasoning_effort = true\n'
            'reasoning_efforts = ["high"]\n'
        )
        provider_env = {
            key: value for key, value in env('echo').items() if key != 'DSH_CODE_CLI_MOCK_TOOL'
        }
        provider_env.pop('CODSH_ACP_PATCH', None)
        provider_env['CODSH_REVIEW_API_KEY'] = 'synthetic'
        provider = plain(launcher, project, provider_env,
                         ['-p', 'ping', '--model', 'local', '--effort', 'high'], timeout=60)
        assert provider.returncode == 1, provider.stdout
        assert provider.stdout == '' or 'RUST_ACP_ANSWER' not in provider.stdout
        header = ''
        for path in (home / '.codsh-rust' / 'dsh').rglob('*'):
            if path.is_file() and path.stat().st_size < 2_000_000:
                chunk = path.read_text(errors='replace')
                if 'fixture-model' in chunk and 'reasoningEffort' in chunk:
                    header = chunk
                    break
        assert 'fixture-model' in header and 'high' in header, 'non-mock provider request was not recorded'

        (output / 'result.txt').write_text('plain pipe checks passed\n')
        print(output / 'result.txt')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'FAIL {error}', file=sys.stderr)
        raise
