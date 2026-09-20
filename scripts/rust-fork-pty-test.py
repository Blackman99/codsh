#!/usr/bin/env python3
"""Installed-product PTY: fork/rewind conversation without restoring files."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    'rust_resume_pty_test', ROOT / 'scripts' / 'rust-resume-pty-test.py')
resume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resume)
NODE = resume.NODE
Session = resume.Session
dsh_bin = resume.dsh_bin
overlay_text = resume.overlay_text
run = resume.run


def wait_idle(session, marker, seconds=20):
    session.wait_visible(marker, seconds)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump()
        shown = session.visible()
        if 'Streaming turn' not in shown and 'Cancelling turn' not in shown:
            return shown
    raise AssertionError(f'{session.name}: still streaming after {marker!r}\n{session.visible()}')


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-fork-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-fork-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        (cwd / 'note.txt').write_text('alpha\n')
        pack_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'],
            'npm_config_cache': str(work / 'npm-cache'),
            'npm_config_userconfig': str(work / 'empty-user.npmrc'),
            'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
            'npm_config_update_notifier': 'false',
        }
        pack = json.loads(run(['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
                             cwd=ROOT / 'packages/cli', env=pack_env).stdout)[0]['filename']
        prefix = work / 'installed'
        run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
        launcher = prefix / 'node_modules/.bin/codsh'
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        rust_home = home / '.codsh-rust'
        rust_home.mkdir()
        (rust_home / 'config.toml').write_text(
            '[ui]\nconfirm_before_rewind = true\nfork_secondary_model = "cli-mock-fork"\n')
        base_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
        }

        refused = subprocess.run([NODE, str(launcher), '--rust', '--restore-code'],
                                 env=base_env, cwd=cwd, capture_output=True, text=True)
        assert refused.returncode != 0, refused.stdout + refused.stderr
        assert 'does not restore files' in (refused.stderr + refused.stdout)
        help_text = run([NODE, str(launcher), '--rust', '--help'], env=base_env, cwd=cwd).stdout
        assert '/rewind' in help_text
        assert '--fork-session' in help_text
        assert '--restore-code is refused' in help_text

        first = Session('rewind', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, cols=120, rows=48)
        try:
            first.wait_visible('Connected to dsh ACP', 25)
            parent = first.session_id()
            def submit(text, marker):
                first.write(text)
                first.wait_visible(text, 10)
                first.write('\r')
                wait_idle(first, marker)

            submit('TOKEN_KEEP', 'RUST_ACP_ANSWER turn=2')
            submit('TOKEN_MIDDLE', 'RUST_ACP_ANSWER turn=3')
            submit('TOKEN_DROP', 'RUST_ACP_ANSWER turn=4')
            (cwd / 'note.txt').write_text('BETA independently edited\n')
            first.write('/rewind 2')
            first.wait_visible('/rewind 2', 10)
            first.write('\r')
            first.wait_visible('Confirm rewind to turn 2', 20)
            first.write('n')
            shown = wait_idle(first, 'nothing rewound')
            assert 'TOKEN_DROP' in shown
            assert parent in shown
            first.write('/rewind 2')
            first.wait_visible('/rewind 2', 10)
            first.write('\r')
            first.wait_visible('Confirm rewind to turn 2', 20)
            first.write('a')
            shown = wait_idle(first, 'rewound to turn 2', 25)
            assert 'now on' in shown
            assert 'stays in /resume' in shown
            child = first.session_id()
            assert child != parent
            assert 'TOKEN_KEEP' in shown
            assert 'TOKEN_MIDDLE' in shown
            assert (cwd / 'note.txt').read_text() == 'BETA independently edited\n'
            assert 'confirm_before_rewind = false' in (rust_home / 'config.toml').read_text()
            first.write('TOKEN_AFTER_REWIND')
            first.wait_visible('TOKEN_AFTER_REWIND', 10)
            first.write('\r')
            shown = wait_idle(first, 'TOKEN_AFTER_REWIND')
            shown = first.wait_visible('RUST_ACP_ANSWER', 20)
            assert 'TOKEN_AFTER_REWIND' in shown
            assert 'TOKEN_DROP' not in shown
            first.write('/rewind 1')
            first.wait_visible('/rewind 1', 10)
            first.write('\r')
            shown = wait_idle(first, 'rewound to turn 1', 25)
            assert 'Confirm rewind' not in shown
            assert 'TOKEN_MIDDLE' not in shown
            assert 'TOKEN_KEEP' in shown
            assert (cwd / 'note.txt').read_text() == 'BETA independently edited\n'
            result = first.finish()
        finally:
            first.close()

        resumed = Session('resume-fork', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--resume', child], cols=120, rows=48)
        try:
            shown = resumed.wait_visible('resumed', 25)
            assert child in shown
            assert 'TOKEN_KEEP' in shown
            assert 'TOKEN_MIDDLE' in shown
            assert 'TOKEN_DROP' not in shown
            resumed.write('TOKEN_RESUME_FORK\r')
            shown = resumed.wait_visible('TOKEN_RESUME_FORK', 20)
            assert 'TOKEN_DROP' not in shown
            assert (cwd / 'note.txt').read_text() == 'BETA independently edited\n'
            resumed.finish()
        finally:
            resumed.close()

        parent_resume = Session('resume-parent', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--resume', parent], cols=120, rows=48)
        try:
            shown = parent_resume.wait_visible('resumed', 25)
            assert parent in shown
            assert 'TOKEN_DROP' in shown
            parent_resume.finish()
        finally:
            parent_resume.close()

        streaming = Session('running-rewind', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'DSH_CODE_CLI_MOCK_DELAY_MS': '8000',
        }, output, cols=120, rows=48)
        try:
            streaming.wait_visible('Connected to dsh ACP', 25)
            streaming.write('TOKEN_SLOW')
            streaming.wait_visible('TOKEN_SLOW', 10)
            streaming.write('\r')
            streaming.wait_visible('Streaming turn', 20)
            streaming.write('/rewind')
            streaming.wait_visible('/rewind', 10)
            streaming.write('\r')
            shown = streaming.wait_visible('a turn is running — interrupt it before rewinding', 20)
            assert 'Streaming turn' in shown
            assert 'rewound to turn' not in shown
            (output / 'running-rewind-live.txt').write_text(shown)
            streaming.write('\x03')
            wait_idle(streaming, '[cancelled]', 20)
            streaming.finish()
        finally:
            streaming.close()

        forker = Session('in-session-fork', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--resume', parent], cols=120, rows=48)
        try:
            shown = forker.wait_visible('resumed', 25)
            assert parent in shown
            assert 'TOKEN_DROP' in shown
            forker.write('/fork --worktree')
            forker.wait_visible('/fork --worktree', 10)
            forker.write('\r')
            shown = forker.wait_visible('omit --worktree', 20)
            assert forker.session_id() == parent
            assert 'forked · now on' not in shown
            forker.write('/fork --no-worktree')
            forker.wait_visible('/fork --no-worktree', 10)
            forker.write('\r')
            shown = wait_idle(forker, 'forked · now on', 25)
            fork_child = forker.session_id()
            assert fork_child != parent
            assert 'stays in /resume' in shown
            assert 'TOKEN_KEEP' in shown
            assert 'TOKEN_DROP' in shown
            forker.write('TOKEN_FORK_CHILD')
            forker.wait_visible('TOKEN_FORK_CHILD', 10)
            forker.write('\r')
            shown = wait_idle(forker, 'TOKEN_FORK_CHILD')
            shown = forker.wait_visible('model=cli-mock-fork', 20)
            assert 'TOKEN_DROP' in shown
            forker.finish()
        finally:
            forker.close()

        cli_fork = Session('cli-fork-session', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--fork-session', '--resume', parent], cols=120, rows=48)
        try:
            shown = cli_fork.wait_visible('resumed', 25)
            cli_id = cli_fork.session_id()
            assert cli_id != parent
            assert 'TOKEN_KEEP' in shown
            assert 'TOKEN_DROP' in shown
            cli_fork.write('TOKEN_FORK_SESSION')
            cli_fork.wait_visible('TOKEN_FORK_SESSION', 10)
            cli_fork.write('\r')
            shown = wait_idle(cli_fork, 'TOKEN_FORK_SESSION')
            shown = cli_fork.wait_visible('model=cli-mock-fork', 20)
            cli_fork.finish()
        finally:
            cli_fork.close()

        still_parent = Session('parent-after-forks', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--resume', parent], cols=120, rows=48)
        try:
            shown = still_parent.wait_visible('resumed', 25)
            assert still_parent.session_id() == parent
            assert 'TOKEN_DROP' in shown
            assert 'TOKEN_FORK_CHILD' not in shown
            still_parent.finish()
        finally:
            still_parent.close()

        (output / 'result.json').write_text(json.dumps({
            'parent': parent, 'child': child,
            'forkChild': fork_child, 'cliFork': cli_id,
            'note': (cwd / 'note.txt').read_text(),
            'exit': result['exit'],
            'config': (rust_home / 'config.toml').read_text(),
        }, indent=2) + '\n')
        assert (cwd / 'note.txt').read_text() == 'BETA independently edited\n'
    print(f'PASS: rust dsh fork/rewind PTY; evidence: {output}')


if __name__ == '__main__':
    main()
