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


def model_echo(shown):
    """Join the latest mock answer, including rows wrapped under a new '>'.

    Picker preview and composer chrome are not part of the model echo.
    The returned string starts at `latest=`.
    """
    rows = []
    started = False
    for raw in shown.splitlines():
        line = raw.strip()
        if 'RUST_ACP_ANSWER' in line:
            rows = [line]
            started = True
            continue
        if not started:
            continue
        if not line or line.startswith(('┌', 'mode=', 'Draft', 'file picker', 'preview ')):
            break
        rows.append(line[1:].strip() if line.startswith('>') else line)
    echo = ''.join(rows)
    marker = echo.rfind('latest=')
    if marker < 0:
        raise AssertionError(f'model echo has no latest= field\n{echo}\n{shown}')
    return echo[marker:]


def latest_value(echo):
    """The `latest=` field. A following history copy is not this submission.

    The mock prints `latest=<last user text> <all user text>`. The last user
    text can itself contain `@`, so only a later duplicate is removed.
    `plain` is that submission only when the whole last text is that word.
    A file body that continues after the word stays in the value.
    """
    value = echo.split('latest=', 1)[1]
    if _submission_is(value, 'plain'):
        return 'plain'
    marker = value.find(' @src/main.rs:2 look')
    if marker > 0:
        return value[:marker]
    return value


def _submission_is(value, word):
    if value == word:
        return True
    prefix = f'{word} '
    if not value.startswith(prefix):
        return False
    history = value[len(prefix):]
    return history == word or history.endswith(f'⏎{word}')


def check_latest_value():
    assert latest_value('latest=plain') == 'plain'
    assert latest_value('latest=plain plain') == 'plain'
    assert latest_value('latest=plain earlier⏎plain') == 'plain'
    leaked = latest_value('latest=plain SECRET_BODY plain SECRET_BODY')
    assert leaked != 'plain' and 'SECRET_BODY' in leaked, leaked
    leaked = latest_value('latest=plain SECRET_BODY older⏎plain SECRET_BODY')
    assert 'SECRET_BODY' in leaked, leaked


def main():
    check_latest_value()
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
        (cwd / '.gitignore').write_text('**/*.log\n')
        (cwd / 'logs').mkdir()
        (cwd / 'logs' / 'nested.log').write_text('NESTED_PACKED_LOG\n')
        (cwd / 'src' / '.gitignore').write_text('secret.rs\n')
        (cwd / 'src' / 'gen').mkdir()
        (cwd / 'src' / 'gen' / '.gitignore').write_text('*\n')
        (cwd / 'src' / 'main.rs').write_text('ALPHA_LINE\nBETA_LINE\nGAMMA_LINE\n')
        (cwd / 'src' / 'secret.rs').write_text('NESTED_SECRET\n')
        (cwd / 'src' / 'gen' / 'out.rs').write_text('GENERATED_OUT\n')
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
            session.write('@')
            shown = session.wait_visible('file picker', 10)
            assert 'secret.log' not in shown and 'nested.log' not in shown, shown
            assert 'NESTED_PACKED_LOG' not in shown, shown
            session.write('\x1b')
            session.write('\x7f' * 8)
            session.write('@!.hidden/note')
            shown = session.wait_visible('.hidden/note.txt', 10)
            assert 'file picker' in shown
            session.write('\x1b')
            session.write('\x7f' * 20)
            session.write('@src/secret')
            shown = session.wait_visible('file picker', 10)
            assert 'secret.rs' not in shown and 'NESTED_SECRET' not in shown, shown
            session.write('\x1b')
            session.write('\x7f' * 16)
            session.write('@gen/out')
            session.pump(0.3)
            shown = session.visible()
            assert 'out.rs' not in shown and 'GENERATED_OUT' not in shown, shown
            session.write('\x1b')
            session.write('\x7f' * 24)
            session.write('@src/main.rs:2')
            shown = session.wait_visible('src/main.rs', 10)
            assert 'preview' in shown and 'BETA_LINE' in shown, shown
            assert 'ALPHA_LINE' not in shown and 'GAMMA_LINE' not in shown, shown
            session.write('\r')
            session.pump(0.3)
            session.write(' look\r')
            shown = wait_answer(session, 'latest=', seconds=25)
            echo = latest_value(model_echo(shown))
            assert 'BETA_LINE' in echo, echo
            assert 'ALPHA_LINE' not in echo and 'GAMMA_LINE' not in echo, echo
            assert 'HIDDEN_LOG' not in echo and 'DOT_SECRET' not in echo, echo
            assert 'NESTED_SECRET' not in echo and 'GENERATED_OUT' not in echo, echo
            assert '@src/main.rs:2' in echo, echo
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
            echo = latest_value(model_echo(shown))
            assert echo == 'plain', echo
            assert 'BETA_LINE' not in echo and 'Attached file' not in echo, echo
            assert len(prompt.answer_lines(shown)) == before + 1
            session.write('\x03')
            session.write(PASTE_OPEN + b'see src/main.rs in the note' + PASTE_CLOSE)
            session.pump(0.4)
            shown = session.visible()
            assert 'see src/main.rs in the note' in shown, shown
            assert 'attached @' not in shown.split('Draft')[-1], shown
            session.write('\x03')
            session.write(PASTE_OPEN + str(cwd / 'my file.rs').encode() + PASTE_CLOSE)
            shown = session.wait_visible('my file.rs', 10)
            session.write('\r')
            shown = wait_answer(session, 'turn=4', seconds=25)
            echo = latest_value(model_echo(shown))
            assert 'spaced line' in echo, echo
            assert 'see src/main.rs in the note' not in echo, echo
            session_id = session.session_id()
            session.write('\x11')
            session.process.wait(timeout=12)
        finally:
            session.close()

        resumed = Session('file-attach-resume', launcher, cwd, env, output,
                          extra=['--fullscreen', '--resume', session_id])
        try:
            shown = resumed.wait_visible('@src/main.rs:2', 25)
            assert 'look' in shown, shown
            assert 'my file.rs' in shown, shown
            assert '@src/main.rs:2' in shown, shown
        finally:
            resumed.finish(expect_alt_leave=True)
            resumed.close()
    print('file attachment pty ok')


if __name__ == '__main__':
    main()
