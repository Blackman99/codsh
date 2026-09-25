#!/usr/bin/env python3
"""PTY: `codsh --rust clone` with git as the Grove substitute (ticket 191).

Real git clones a temporary local bare repository over file://; real dsh runs
the session; the keyless mock LLM (e2e/fixtures/rust-acp-mock-llm.mjs, mode
`file-edit`) scripts the model.

Covers: clone progress forwarded to a terminal and the summary (shallow depth,
partial clone, backend named as the Grove substitute), a TUI session started in
the fresh clone whose file tool edits the clone and whose status line names the
clone, Ctrl-C at the terminal while git is stuck in transport (the empty target
directory stays empty, no hidden staging directory is left, exit 130), and a
second clone into a finished clone reporting it without fetching.

Needs the staged native binary (`pnpm run build:rust`). Written for Linux and
macOS; the evidence for ticket 191 was collected on Linux only.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import struct
import subprocess
import sys
import tempfile
import termios
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('screen_pty', ROOT / 'scripts/rust-screen-pty-test.py')
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)
Session = screen.Session
NODE = screen.NODE
LAUNCHER = ROOT / 'packages/cli/bin/codsh.mjs'


class Terminal(Session):
    """A plain command on a PTY that is its controlling terminal, so Ctrl-C
    reaches the foreground process group as SIGINT, as in a real shell."""

    def __init__(self, name, cwd, env, output, args, cols=120, rows=30):
        self.name = name
        self.cols = cols
        self.rows = rows
        self.output = output
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.original = termios.tcgetattr(self.slave)

        def controlling():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.process = subprocess.Popen(
            [NODE, str(LAUNCHER), '--rust', *args], cwd=cwd, env=env,
            stdin=self.slave, stdout=self.slave, stderr=self.slave, preexec_fn=controlling)
        self.data = bytearray()
        self.cursor_replies = 0

    def wait_exit(self, seconds=60):
        deadline = time.monotonic() + seconds
        while self.process.poll() is None:
            if time.monotonic() > deadline:
                raise AssertionError(f'{self.name}: did not exit\n{self.visible()}')
            self.pump(0.1)
        self.pump(0.3)
        (self.output / f'{self.name}.ansi').write_bytes(self.data)
        return self.process.returncode


def git(cwd, *args):
    return subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', *args],
                          cwd=cwd, check=True, capture_output=True, text=True).stdout


def partials(directory):
    return [name for name in os.listdir(directory) if '.codsh-clone-' in name]


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-clone-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-clone-home-', dir='/tmp') as temporary:
        work = Path(temporary).resolve()
        home = work / 'home'
        (home / '.grok').mkdir(parents=True)
        cwd = work / 'here'
        cwd.mkdir()
        source = work / 'source'
        source.mkdir()
        git(source, 'init', '-q', '-b', 'main')
        (source / 'note.txt').write_text('alpha\n')
        (source / 'docs').mkdir()
        for index in range(400):
            (source / 'docs' / f'page-{index}.txt').write_text(f'page {index}\n' * 40)
        git(source, 'add', '.')
        git(source, 'commit', '-q', '-m', 'one')
        (source / 'docs' / 'page-0.txt').write_text('changed\n')
        git(source, 'commit', '-q', '-am', 'two')
        bare = work / 'repo.git'
        git(work, 'clone', '-q', '--bare', str(source), str(bare))
        git(bare, 'config', 'uploadpack.allowFilter', 'true')
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        stuck = work / 'stuck-ssh'
        stuck.write_text('#!/bin/sh\nexec sleep 60\n')
        stuck.chmod(0o755)
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'XDG_CONFIG_HOME': str(home / '.config'),
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'file-edit', 'GROK_CLONE': '1',
        }
        url = f'file://{bare}'

        # 1. Clone on a terminal: git's progress is forwarded, then the summary.
        clone = Terminal('clone', cwd, env, output, ['clone', url, 'proj'])
        try:
            assert clone.wait_exit(60) == 0, clone.visible()
            shown = clone.visible()
            raw = bytes(clone.data).decode('utf8', 'replace')
            assert 'Receiving objects' in raw or 'Updating files' in raw, raw[-2000:]
            assert 'history:     depth 1 (shallow' in shown, shown
            assert 'substitute for Grove' in shown, shown
            assert f'Next: cd {cwd / "proj"} && codsh --rust' in shown, shown
        finally:
            clone.close()
        proj = cwd / 'proj'
        assert git(proj, 'rev-parse', '--is-shallow-repository').strip() == 'true'
        assert git(proj, 'rev-list', '--count', 'HEAD').strip() == '1'
        results['clone'] = str(proj)

        # 2. A TUI session in the clone: the file tool edits the clone.
        session = Session('clone-session', LAUNCHER, proj, env, output,
                          extra=['--fullscreen', '--always-approve'], cols=140, rows=40)
        try:
            session.wait_visible('Connected to dsh ACP', 30)
            session.write('edit the note')
            session.wait_visible('edit the note', 10)
            session.write(b'\r')
            shown = session.wait_visible('RUST_ACP_FILE_DONE', 40)
            assert 'proj' in shown, shown
            assert (proj / 'note.txt').read_text() == 'ALPHA\n'
            assert git(proj, 'status', '--porcelain').strip() == 'M note.txt'
            results['session_edit'] = True
            results['session_exit'] = session.finish(expect_alt_leave=True)['exit']
        finally:
            session.close()

        # 3. Ctrl-C while git waits on its transport: nothing is left behind.
        target = cwd / 'target'
        target.mkdir()
        cancel = Terminal('clone-cancel', cwd, {**env, 'GIT_SSH_COMMAND': str(stuck)}, output,
                          ['clone', 'ssh://fixture.invalid/repo.git', 'target'])
        try:
            deadline = time.monotonic() + 20
            while not partials(cwd):
                assert time.monotonic() < deadline, cancel.visible()
                cancel.pump(0.1)
            cancel.pump(0.5)
            cancel.write(b'\x03')
            assert cancel.wait_exit(20) == 130, cancel.visible()
            shown = cancel.visible()
            assert 'Clone cancelled' in shown and 'is still empty' in shown, shown
        finally:
            cancel.close()
        assert target.is_dir() and os.listdir(target) == []
        assert partials(cwd) == []
        results['cancel'] = True

        # 4. Cloning again into the finished clone changes nothing.
        again = Terminal('clone-again', cwd, env, output, ['clone', url, 'proj'])
        try:
            assert again.wait_exit(30) == 0, again.visible()
            assert 'nothing was fetched or changed' in again.visible(), again.visible()
        finally:
            again.close()
        assert (proj / 'note.txt').read_text() == 'ALPHA\n'
        results['again'] = True
    print(json.dumps({'ok': True, 'output': str(output), **results}))


if __name__ == '__main__':
    main()
