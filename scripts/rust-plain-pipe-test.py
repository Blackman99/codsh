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
        assert 'later ticket' in help_run.stdout

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

        first = plain(launcher, project, env('echo'), ['-p', 'FIRST_PLAIN'])
        assert first.returncode == 0, first.stderr
        resumed = plain(launcher, project, env('echo'), ['-p', 'SECOND_PLAIN', '--continue'])
        assert resumed.returncode == 0, resumed.stderr
        assert 'FIRST_PLAIN' in resumed.stdout and 'SECOND_PLAIN' in resumed.stdout

        denied = plain(launcher, project, env('file-edit'),
                       ['-p', 'edit it', '--deny', 'Edit'])
        assert denied.returncode == 0, denied.stderr
        assert 'RUST_ACP_FILE_ERROR' in denied.stdout
        assert (project / 'note.txt').read_text() == 'PLAIN_NOTE\n'

        filtered = plain(launcher, project, env('file-edit'),
                         ['-p', 'edit it', '--disallowed-tools', 'edit'])
        assert filtered.returncode == 0, filtered.stderr
        assert 'plain tool filter removed edit' in filtered.stdout
        assert (project / 'note.txt').read_text() == 'PLAIN_NOTE\n'
        unknown_tool = plain(launcher, project, env('echo'),
                             ['-p', 'hello', '--disallowed-tools', 'not_a_dsh_tool'])
        assert unknown_tool.returncode != 0, unknown_tool.stdout
        assert 'unknown' in unknown_tool.stderr or 'refused' in unknown_tool.stderr

        bounded = plain(launcher, project, env('plain-steps'),
                        ['-p', 'keep reading', '--max-turns', '2'])
        assert bounded.returncode != 0, bounded.stdout
        assert 'RUST_ACP_STEPS_DONE' not in bounded.stdout
        assert 'max-turns' in bounded.stderr or 'cancelled' in bounded.stderr

        unknown = plain(launcher, project, env('echo'), ['--not-a-real-option'])
        assert unknown.returncode == 1
        assert unknown.stdout == ''
        assert 'unsupported' in unknown.stderr or 'not-a-real-option' in unknown.stderr

        missing_flag = plain(launcher, project, env('echo'), ['--allowedTools'])
        assert missing_flag.returncode == 1
        assert 'missing --allowedTools' in missing_flag.stderr
        missing_prompt = plain(launcher, project, env('echo'), ['--prompt-file'])
        assert missing_prompt.returncode == 1
        assert 'a value is required' in missing_prompt.stderr

        later = plain(launcher, project, env('echo'), ['-p', 'hello', '--output-format', 'json'])
        assert later.returncode == 1
        assert later.stdout == ''
        assert 'later ticket' in later.stderr

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

        (output / 'result.txt').write_text('plain pipe checks passed\n')
        print(output / 'result.txt')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'FAIL {error}', file=sys.stderr)
        raise
