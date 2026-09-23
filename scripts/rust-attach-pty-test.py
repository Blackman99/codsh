#!/usr/bin/env python3
"""Installed-product PTY: attach a file, refuse a removed one, restore the mention."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    'rust_resume_pty_test', ROOT / 'scripts' / 'rust-resume-pty-test.py')
resume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resume)
screen_spec = importlib.util.spec_from_file_location(
    'rust_screen_pty_test', ROOT / 'scripts' / 'rust-screen-pty-test.py')
screen = importlib.util.module_from_spec(screen_spec)
screen_spec.loader.exec_module(screen)
prompt_spec = importlib.util.spec_from_file_location(
    'rust_prompt_pty_test', ROOT / 'scripts' / 'rust-prompt-pty-test.py')
prompt = importlib.util.module_from_spec(prompt_spec)
prompt_spec.loader.exec_module(prompt)

Session = screen.Session
wait_answer = prompt.wait_answer
latest_answer = prompt.latest_answer
pack_install = prompt.pack_install
PASTE_OPEN = prompt.PASTE_OPEN
PASTE_CLOSE = prompt.PASTE_CLOSE


def screen_answer(shown):
    """Join wrapped transcript rows so a file body can be checked as one string."""
    rows = []
    for raw in shown.splitlines():
        line = raw.strip()
        if line.startswith('>'):
            line = line[1:].strip()
        rows.append(line)
    return ''.join(rows)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-attach-', dir='/tmp'))
    dsh = resume.dsh_bin()
    overlay = resume.overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-attach-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        (cwd / 'src').mkdir(parents=True)
        (cwd / '.hidden').mkdir()
        (cwd / '.gitignore').write_text('secret.log\n')
        (cwd / 'src' / 'main.rs').write_text('one\ntwo\nthree\n')
        (cwd / 'secret.log').write_text('HIDDEN_LOG\n')
        (cwd / '.hidden' / 'note.txt').write_text('DOT_SECRET\n')
        (cwd / 'my file.rs').write_text('spaced line\n')
        launcher = pack_install(work, home)
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': resume.NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'GROK_PROMPT_SUGGESTIONS': 'false',
        }
        session = Session('file-attach', launcher, cwd, env, output, extra=['--fullscreen'])
        try:
            session.wait_visible('Connected to dsh ACP', 25)
            session.write('@secret')
            shown = session.wait_visible('file picker', 10)
            assert 'secret.log' not in shown, shown
            session.write('\x1b')
            session.write('\x7f' * 8)
            session.write('@!.hidden/note')
            shown = session.wait_visible('.hidden/note.txt', 10)
            assert 'file picker' in shown
            session.write('\x1b')
            session.write('\x7f' * 20)
            session.write('@src/main.rs:2-3')
            shown = session.wait_visible('src/main.rs', 10)
            assert 'preview' in shown and 'two' in shown, shown
            session.write('\r')
            session.pump(0.3)
            session.write(' look\r')
            shown = wait_answer(session, 'latest=', seconds=25)
            echo = screen_answer(shown)
            assert 'two' in echo and 'three' in echo, echo
            assert 'HIDDEN_LOG' not in echo and 'DOT_SECRET' not in echo, echo
            assert '@src/main.rs:2-3' in echo, echo
            session.write('@src/main.rs')
            session.wait_visible('src/main.rs', 10)
            session.write('\r')
            session.pump(0.2)
            session.write('\x7f')
            session.pump(0.2)
            shown = session.visible()
            assert 'src/main.rs' not in shown.split('Draft')[-1], shown
            before = len(prompt.answer_lines(shown))
            session.write('plain\r')
            shown = wait_answer(session, 'latest=plain', seconds=25)
            echo = latest_answer(shown)
            assert 'latest=plain' in echo, echo
            assert 'one' not in echo and 'two' not in echo and 'Attached file' not in echo, echo
            assert len(prompt.answer_lines(shown)) == before + 1
            session.write('\x03')
            session.write(PASTE_OPEN + str(cwd / 'my file.rs').encode() + PASTE_CLOSE)
            shown = session.wait_visible('my file.rs', 10)
            session.write('\r')
            shown = wait_answer(session, 'turn=4', seconds=25)
            echo = screen_answer(shown)
            assert 'spaced line' in echo, echo
            session_id = session.session_id()
            session.write('\x11')
            session.process.wait(timeout=12)
        finally:
            session.close()

        resumed = Session('file-attach-resume', launcher, cwd, env, output,
                          extra=['--fullscreen', '--resume', session_id])
        try:
            shown = resumed.wait_visible('@src/main.rs:2-3', 25)
            assert 'look' in shown, shown
            assert 'spaced line' not in shown or 'my file.rs' in shown
        finally:
            resumed.finish(expect_alt_leave=True)
            resumed.close()
    print('file attachment pty ok')


if __name__ == '__main__':
    main()
