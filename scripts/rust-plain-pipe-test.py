#!/usr/bin/env python3
"""Installed plain command: real dsh, no TTY, provider fixture only."""
import json
import os
from pathlib import Path
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
        short = plain(launcher, project, env('echo'), ['-h'])
        assert short.returncode == 0, short.stderr
        assert 'bash, elvish, fish, powershell, zsh' in short.stdout
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

        later = plain(launcher, project, env('echo'), ['-p', 'hello', '--output-format', 'json'])
        assert later.returncode == 1
        assert later.stdout == ''
        assert '--output-format' in later.stderr
        assert 'later ticket' in later.stderr
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
        assert slash in frozen_user, frozen_user
        assert 'SHIP_NOTE_BODY' not in frozen_user
        assert 'SESSION_RULE_SENTINEL' not in frozen_user
        assert 'HOME_RULE' not in frozen_user
        (project / 'spaced.txt').write_text('  keep\nline')
        wire.unlink()
        spaced = plain(launcher, project, wire_env, ['--verbatim', '--prompt-file', 'spaced.txt'])
        assert spaced.returncode == 0, spaced.stderr
        spaced_rows = [json.loads(line) for line in wire.read_text().splitlines() if line.strip()]
        spaced_user = '\n'.join(spaced_rows[0]['user'])
        assert '  keep\nline' in spaced_user, spaced_user
        assert 'HOME_RULE' not in spaced_user
        wire.unlink()
        denied_agent = plain(launcher, project, env('echo'),
                             ['-p', 'hello', '--disallowed-tools', 'Agent'])
        assert denied_agent.returncode == 0, denied_agent.stderr
        scoped_agent = plain(launcher, project, env('echo'),
                             ['-p', 'hello', '--disallowed-tools', 'Agent(explore),edit'])
        assert scoped_agent.returncode != 0, scoped_agent.stdout
        assert 'Agent(explore)' in scoped_agent.stderr
        assert 'later ticket' in scoped_agent.stderr

        positional = plain(launcher, project, env('echo'), ['just words'])
        assert positional.returncode == 1
        assert 'positional prompt' in positional.stderr

        from_file = plain(launcher, project, env('echo'), ['--prompt-file', 'prompt.txt'])
        assert from_file.returncode == 0, from_file.stderr
        assert 'from-file' in from_file.stdout

        piped = plain(launcher, project, env('echo'), ['-p', 'VISIBLE'], stdin='NOT_THE_PROMPT\n')
        assert piped.returncode == 0, piped.stderr
        assert 'VISIBLE' in piped.stdout
        assert 'NOT_THE_PROMPT' not in piped.stdout

        slow_env = env('echo')
        slow_env['DSH_CODE_CLI_MOCK_DELAY_MS'] = '4000'
        for sig, code in ((signal.SIGINT, 130), (signal.SIGTERM, 143)):
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
