#!/usr/bin/env python3
"""PTY: git worktree isolation through the Rust client (ticket 174).

Real dsh runs every turn; the keyless mock LLM
(e2e/fixtures/rust-acp-mock-llm.mjs, mode `subagents`) scripts the model.
Every repository is a temporary real git repo.

Covers: `-w NAME` in a dirty checkout (status line and notice name the
worktree; a child's edit lands only in the worktree; the checkout, index, and
branch stay), `/worktree list` and `/worktree apply` (merge into the
unchanged checkout), a subagent with `isolation: "worktree"` in a normal
session (kept worktree on the block and in /tasks; the checkout untouched),
`codsh --rust worktree apply` reporting a conflict and leaving the user's
file alone, `-w -r <id>` forking the session into a new worktree under a new
id, the launch-directory offset (`-w` from a subdirectory), a same-name label
getting a suffix, a non-git directory refused with nothing created,
`worktree rm` refusing uncommitted work until `-f`, and `worktree gc`
without --max-age.

Needs the staged native binary (`pnpm run build:rust`). Written for Linux
and macOS; the evidence for ticket 174 was collected on Linux only.
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


def git(cwd, *args):
    return subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', *args],
                          cwd=cwd, check=True, capture_output=True, text=True).stdout


def status(repo):
    return git(repo, 'status', '--porcelain=v1', '--untracked-files=all')


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-worktree-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-worktree-home-', dir='/tmp') as temporary:
        work = Path(temporary).resolve()
        home = work / 'home'
        home.mkdir()
        repo = work / 'src' / 'demo'
        (repo / 'sub').mkdir(parents=True)
        git(repo, 'init', '-q', '-b', 'main')
        (repo / 'shared.txt').write_text('base\n')
        (repo / 'sub' / 'keep.txt').write_text('keep\n')
        git(repo, 'add', '.')
        git(repo, 'commit', '-q', '-m', 'one')
        # The user's uncommitted work: carried into -w worktrees, never lost.
        (repo / 'shared.txt').write_text('user dirty\n')
        (repo / 'note.txt').write_text('untracked note\n')
        before = status(repo)
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'subagents',
        }

        def cli(*args, cwd=repo):
            return subprocess.run([NODE, str(LAUNCHER), '--rust', *args], cwd=cwd, env=env,
                                  capture_output=True, text=True, timeout=120)

        registry = Path(cli('worktree', 'db', 'path').stdout.strip())
        pool = registry.parent
        results['pool'] = str(pool)

        def records():
            listed = cli('worktree', 'list', '--all', '--json')
            assert listed.returncode == 0, listed.stderr
            return {item['id']: item for item in json.loads(listed.stdout)['worktrees']}

        # 1. -w feature: the session runs in the new worktree.
        session = Session('worktree-session', LAUNCHER, repo, env, output,
                          extra=['-w', 'feature', '--fullscreen', '--always-approve'], cols=160, rows=48)
        try:
            shown = session.wait_visible('Connected to dsh ACP', 30)
            shown = session.wait_visible('worktree feature (codsh/feature)', 10)
            assert 'Worktree feature (HEAD + 2 uncommitted path(s))' in shown, shown
            feature = records()['feature']
            path = Path(feature['path'])
            assert path == pool / 'src-demo' / 'feature', feature
            assert (path / 'shared.txt').read_text() == 'user dirty\n'
            assert (path / 'note.txt').read_text() == 'untracked note\n'
            prompt(session, 'SPAWN:general-purpose:EDIT')
            wait_until(session, lambda s: 'CHILD_EDIT_DONE ok' in s, 'edit child did not finish', 40)
            assert (path / 'shared.txt').read_text() == 'CHILD_EDIT_CONTENT\n'
            assert (repo / 'shared.txt').read_text() == 'user dirty\n'
            assert status(repo) == before, status(repo)
            assert git(repo, 'branch', '--show-current').strip() == 'main'
            results['session_isolated'] = True
            results['session_id'] = session.session_id()
            assert records()['feature']['sessionId'] == results['session_id']

            # 2. /worktree list and /worktree apply from inside the session.
            session.send_slash('/worktree list')
            shown = session.wait_visible('Worktrees in repository', 15)
            assert 'feature' in shown and 'session' in shown, shown
            session.send_slash('/worktree rm -f feature')
            session.wait_visible('this session runs in', 15)
            assert path.exists()
            session.send_slash('/worktree apply feature')
            shown = session.wait_visible('Applied worktree feature (merge)', 15)
            assert 'modified shared.txt' in shown, shown
            assert (repo / 'shared.txt').read_text() == 'CHILD_EDIT_CONTENT\n'
            assert git(repo, 'diff', '--cached', '--name-only') == ''
            results['slash_apply'] = True
            results['session_exit'] = session.finish(expect_alt_leave=True)['exit']
        finally:
            session.close()

        # 3. A subagent with isolation: "worktree" in a normal session.
        (repo / 'shared.txt').write_text('user dirty again\n')
        before = status(repo)
        plain_session = Session('worktree-subagent', LAUNCHER, repo, env, output,
                                extra=['--fullscreen', '--always-approve'], cols=160, rows=48)
        try:
            plain_session.wait_visible('Connected to dsh ACP', 30)
            shown = plain_session.visible()
            assert 'worktree feature' not in shown, shown
            prompt(plain_session, 'SPAWN:general-purpose:EDIT:wt')
            shown = wait_until(plain_session, lambda s: 'worktree kept:' in s, 'kept worktree not shown', 40)
            assert (repo / 'shared.txt').read_text() == 'user dirty again\n'
            assert status(repo) == before
            plain_session.send_slash('/tasks')
            shown = plain_session.wait_visible('Subagents (0 running', 10)
            assert 'worktree kept:' in shown, shown
            plain_session.write('q')
            wait_until(plain_session, lambda s: 'Subagents (' not in s, 'modal did not close', 10)
            subagent = [item for item in records().values() if item['type'] == 'subagent']
            assert len(subagent) == 1, subagent
            assert (Path(subagent[0]['path']) / 'shared.txt').read_text() == 'CHILD_EDIT_CONTENT\n'
            assert subagent[0]['parentSessionId'] == plain_session.session_id()
            results['subagent_kept'] = subagent[0]['id']
            plain_session.finish(expect_alt_leave=True)
        finally:
            plain_session.close()

        # 4. The user edits the checkout after the child ran: apply reports a
        #    conflict and leaves the user's file alone.
        (repo / 'shared.txt').write_text('user changed later\n')
        before = status(repo)
        conflict = cli('worktree', 'apply', results['subagent_kept'])
        assert conflict.returncode == 5, (conflict.returncode, conflict.stdout, conflict.stderr)
        assert 'conflict shared.txt: changed in the checkout since the worktree was created' in conflict.stdout, conflict.stdout
        assert (repo / 'shared.txt').read_text() == 'user changed later\n'
        results['conflict'] = True

        # 5. -w -r <id>: the session is copied under a new id into a new worktree.
        forked = cli('-w', '-r', results['session_id'], '--always-approve', '-p', 'SPAWN:general-purpose:PWD')
        assert forked.returncode == 0, forked.stderr
        assert 'Worktree ' in forked.stderr and 'working in' in forked.stderr, forked.stderr
        new = [item for item in records().values() if item['type'] == 'session' and item['id'] != 'feature']
        assert len(new) == 1, new
        assert new[0]['sessionId'] and new[0]['sessionId'] != results['session_id'], new
        assert f"CHILD_PWD_DONE ok:{new[0]['path']}" in forked.stdout, forked.stdout
        results['resume_fork'] = new[0]['sessionId']
        # dsh files a session under a key of its directory: the copy lives
        # under the new worktree, the original keeps the first worktree.
        dsh_home = home / '.codsh-rust' / 'dsh'
        where = {path.name: path.parent.name for path in (dsh_home / 'sessions').glob('*/*') if path.is_dir()}
        assert new[0]['id'] in where[new[0]['sessionId']], where
        assert 'feature' in where[results['session_id']], where
        assert new[0]['id'] not in where[results['session_id']], where

        # 6. -w from a subdirectory keeps the offset; a taken label gets -2.
        offset = cli('-w', 'feature', '--always-approve', '-p', 'SPAWN:general-purpose:PWD', cwd=repo / 'sub')
        assert offset.returncode == 0, offset.stderr
        second = records()['feature-2']
        assert f"CHILD_PWD_DONE ok:{second['path']}/sub" in offset.stdout, offset.stdout
        results['offset_and_suffix'] = True

        # 7. A directory outside git is refused and nothing is created.
        plain_dir = work / 'plain'
        plain_dir.mkdir()
        count = len(records())
        refused = cli('-w', '-p', 'hi', cwd=plain_dir)
        assert refused.returncode != 0, refused.stdout
        assert 'not inside a git repository' in refused.stderr, refused.stderr
        assert len(records()) == count
        results['non_git_refused'] = True

        # 8. rm refuses uncommitted work until -f; the branch with the
        #    carried snapshot stays. gc without --max-age expires nothing.
        removal = cli('worktree', 'rm', 'feature')
        assert removal.returncode == 4, (removal.returncode, removal.stdout)
        assert 'still holds work' in removal.stdout, removal.stdout
        assert (pool / 'src-demo' / 'feature').exists()
        forced = cli('worktree', 'rm', '-f', 'feature')
        assert forced.returncode == 0, forced.stdout
        assert not (pool / 'src-demo' / 'feature').exists()
        assert 'codsh/feature' in git(repo, 'branch', '--list', 'codsh/feature')
        gc = cli('worktree', 'gc')
        assert gc.returncode == 0 and 'nothing expires' in gc.stdout, gc.stdout
        refused_cmd = cli('worktree', 'create')
        assert refused_cmd.returncode == 2, refused_cmd.stdout
        results['rm_and_gc'] = True
        assert status(repo) == before
    print(json.dumps({'ok': True, 'output': str(output), **results}))


if __name__ == '__main__':
    main()
