#!/usr/bin/env python3
"""Installed-product PTY: paste an image, preview it, and send it on the declared route."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

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
attach_spec = importlib.util.spec_from_file_location(
    'rust_attach_pty_test', ROOT / 'scripts' / 'rust-attach-pty-test.py')
attach = importlib.util.module_from_spec(attach_spec)
attach_spec.loader.exec_module(attach)

Session = screen.Session
wait_answer = prompt.wait_answer
pack_install = prompt.pack_install
PASTE_OPEN = prompt.PASTE_OPEN
PASTE_CLOSE = prompt.PASTE_CLOSE

# 1x1 PNGs. The same bytes the Rust unit tests submit, and they differ.
TINY_PNG = bytes([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
    8, 2, 0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 120, 156, 99, 248, 207,
    192, 0, 0, 3, 1, 1, 0, 201, 254, 146, 239, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
])
GREEN_PNG = bytes([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 1,
    8, 2, 0, 0, 0, 123, 64, 232, 221, 0, 0, 0, 13, 73, 68, 65, 84, 120, 218, 99, 96, 248,
    207, 0, 68, 0, 7, 0, 1, 255, 191, 245, 82, 193, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
])


def config_text(vision, switchable=False):
    modalities = 'input_modalities = ["text", "image"]\n' if vision else 'input_modalities = ["text"]\n'
    # The packed mock advertises cli-mock-fork as text-only even when the
    # session starts on a vision model. That is the live switch target.
    # provider stays cli-mock: that is the provider the packed mock advertises.
    # The model id is the text-only fork on that same provider.
    fork = """
[model.fork]
name = "CLI Mock Fork"
provider = "cli-mock"
model = "cli-mock-fork"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
api_backend = "chat_completions"
supports_reasoning_effort = false
input_modalities = ["text"]
""" if switchable else ""
    return f"""
[models]
default = "cli-mock"

[model.cli-mock]
name = "CLI Mock"
model = "cli-mock"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
api_backend = "chat_completions"
supports_reasoning_effort = false
{modalities}{fork}"""





def image_mark(png, size):
    return f'mime=image/png bytes={len(png)} size={size}'


def assert_ordered_images(echo, shown, images):
    # The mock prints id= between size fields. Order is the sequence of sizes.
    latest = echo.split('latest=', 1)[-1]
    cursor = latest.find('images=')
    if cursor < 0:
        Path('/tmp/codsh-image-settings.txt').write_text(shown)
        raise AssertionError(f'vision route sent no image\n{echo}')
    for png, size in images:
        mark = image_mark(png, size)
        found = latest.find(mark, cursor)
        if found < 0:
            Path('/tmp/codsh-image-settings.txt').write_text(shown)
            raise AssertionError(f'vision route lost ordered image {mark}\n{echo}')
        cursor = found + len(mark)


def assert_text_only(echo, count):
    assert 'images=' not in echo, echo
    assert echo.count('<pasted-image ') >= count, echo
    assert 'mime=image/png' not in echo, echo


def paste_image(session, png):
    payload = b'codsh-image:' + base64.b64encode(png)
    session.write(PASTE_OPEN + payload + PASTE_CLOSE)


def terminal_paste(session, text=b''):
    # macOS terminals turn Cmd+V (and a Finder drop) into a bracketed paste.
    # An image-only clipboard arrives as an empty one.
    session.write(PASTE_OPEN + text + PASTE_CLOSE)


def quit_session(session):
    session.write(b'\x11')
    deadline = time.monotonic() + 12
    while session.process.poll() is None:
        if time.monotonic() > deadline:
            raise TimeoutError(f'{session.name}: quit hung after Ctrl+Q')
        session.pump(0.15)


def assert_no_draft_files(root):
    left = [str(path) for path in root.rglob('*')
            if path.name in ('image-draft.json', 'prompt-draft.txt')]
    assert not left, f'an unsent draft was written to disk: {left}'


def files_containing(root, *needles):
    hits = []
    for path in root.rglob('*'):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        hits.extend((str(path), needle[:24]) for needle in needles if needle in data)
    return hits


def wait_idle(session, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump(0.2)
        shown = session.visible()
        if 'Streaming turn' not in shown and 'Cancelling turn' not in shown:
            return shown
    raise AssertionError(f'{session.name}: turn did not finish\n{session.visible()}')


def last_turn(shown):
    turns = re.findall(r'RUST_ACP_ANSWER turn=(\d+)', shown)
    assert turns, shown
    return int(turns[-1])


def user_rows(shown):
    """Transcript rows that hold a user prompt.

    Rows carry a `> ` gutter (twice on the selected entry). A prompt row
    flattens newlines to spaces; the mock answer and its wrapped history
    spell them `⏎`, which keeps the echoed prompt text out of this list.
    """
    rows = []
    for line in shown.splitlines():
        body = line.strip()
        if not body.startswith('> '):
            continue
        while body.startswith('> '):
            body = body[2:]
        if 'RUST_ACP_ANSWER' in body or '⏎' in body:
            continue
        rows.append(body)
    return rows


def resume_shows_image_turns(launcher, cwd, env, output, name, session_id, vision, turn):
    """--resume shows the sent image turns as sent and sends nothing again."""
    resumed = Session(name, launcher, cwd, env, output, extra=['--fullscreen', '--resume', session_id],
                      cols=160, rows=64)
    try:
        shown = resumed.wait_visible('resumed', 25)
        shown = resumed.wait_visible('again', 10)
        (output / f'{name}.txt').write_text(shown)
        rows = [row for row in user_rows(shown) if row.startswith('[Image #')]
        assert any(row.startswith('[Image #1][Image #2][Image #3] look') for row in rows), rows
        assert any(row.startswith('[Image #4] again') for row in rows), rows
        # The live row showed the placeholders. The text-only fallback path
        # is model input, not what the user typed.
        assert not any('<pasted-image' in row for row in rows), rows
        assert 'Pasted image #' not in shown, shown
        assert 'Streaming turn' not in shown, shown
        answers = shown.count('RUST_ACP_ANSWER')
        resumed.write(b'\r')
        resumed.pump(2.0)
        shown = resumed.visible()
        assert 'Streaming turn' not in shown, shown
        assert shown.count('RUST_ACP_ANSWER') == answers, shown
        resumed.write(b'after resume\r')
        shown = wait_answer(resumed, 'latest=after resume', seconds=25)
        echo = attach.model_echo(shown)
        # The model history still holds the earlier turns, and nothing more.
        assert last_turn(shown) == turn + 1, shown
        if vision:
            assert 'images=4 ' in echo, echo
        else:
            assert 'images=' not in echo, echo
        quit_session(resumed)
    finally:
        close_session(resumed)


def run_case(name, vision, work, home, output, dsh, overlay):
    # launchRust sets HOME to <fixture>/.codsh-rust and GROK_HOME to its .grok.
    grok = home / '.codsh-rust' / '.grok'
    grok.mkdir(parents=True, exist_ok=True)
    (grok / 'config.toml').write_text(config_text(vision))
    cwd = work / name
    cwd.mkdir()
    (cwd / 'shot.png').write_bytes(TINY_PNG)
    launcher = pack_install(work / f'{name}-pack', home)
    patch = work / f'{name}-overlay.yml'
    patch.write_text(overlay)
    env = {
        'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
        'DSH_BIN': dsh, 'CODSH_NODE': resume.NODE, 'CODSH_ACP_PATCH': str(patch),
        'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
        'DEEPSEEK_API_KEY': '', 'XAI_API_KEY': 'test-key', 'CODSH_UPDATE_CHECK': 'off',
        'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        # Long enough that the Esc and Ctrl+C steps land while 'later' runs.
        'DSH_CODE_CLI_MOCK_DELAY_MS': '4000',
        'DSH_CODE_CLI_MOCK_IMAGE': '1' if vision else '0',
        'GROK_PROMPT_SUGGESTIONS': 'false',
        'GROK_CLIPBOARD_NO_NATIVE_READ': '0',
        'CODSH_CLIPBOARD_IMAGE': str(cwd / 'missing.png'),
    }
    session = Session(name, launcher, cwd, env, output, extra=['--fullscreen'])
    try:
        session.wait_visible('Connected to dsh ACP', 25)
        session_id = session.session_id()
        paste_image(session, TINY_PNG)
        shown = session.wait_visible('image #1 attached', 10)
        assert '[Image #1]' in shown, shown
        # A text-only route says so at attach time, not only after submit.
        if vision:
            assert 'cannot see images' not in shown, shown
        else:
            assert 'cannot see images' in shown and 'saved path' in shown, shown
        session.pump(0.4)
        shown = session.visible()
        assert 'Pasted image #1' in shown, shown
        session.write(b'\x16')
        shown = session.wait_visible('clipboard has no image', 10)
        assert '[Image #2]' not in shown, shown
        (cwd / 'missing.png').write_bytes(GREEN_PNG)
        session.write(b'\x16')
        shown = session.wait_visible('[Image #2]', 10)
        assert 'image #2 attached' in shown, shown
        (cwd / 'missing.png').write_bytes(b'not-an-image')
        session.write(b'\x16')
        shown = session.wait_visible('not a png', 10)
        assert '[Image #3]' not in shown, shown
        (cwd / 'missing.png').write_bytes(b'\x89PNG' + b'\x00' * (256 * 1024))
        session.write(b'\x16')
        shown = session.wait_visible('256 KiB', 10)
        assert '[Image #3]' not in shown, shown
        # Cmd+V on an image-only clipboard: the terminal sends an empty
        # bracketed paste. With no image it says so and inserts nothing.
        (cwd / 'missing.png').unlink()
        before = session.visible()
        terminal_paste(session)
        shown = session.wait_visible('clipboard has no image', 10)
        assert '[Image #3]' not in shown, shown
        (cwd / 'missing.png').write_bytes(TINY_PNG)
        terminal_paste(session)
        shown = session.wait_visible('[Image #3]', 10)
        assert 'image #3 attached' in shown, shown
        assert before.count('[Image #2]') == shown.count('[Image #2]'), shown
        session.write(b'/model')
        session.wait_visible('/model', 8)
        session.write(b'\r\r')
        shown = session.wait_visible('Model menu', 12)
        assert '[Image #1]' in shown and '[Image #3]' in shown, shown
        session.write(b'\x1b')
        shown = session.wait_visible('[Image #1]', 8)
        assert 'Model menu' not in shown, shown
        assert '[Image #3]' in shown, shown
        session.write(b'/minimal\r')
        shown = session.wait_visible('Switched to minimal', 12)
        assert '[Image #1]' in shown and '[Image #3]' in shown, shown
        session.write(b' look\r')
        needle = 'latest=' if vision else 'dimensions="2x1"'
        try:
            shown = session.wait_visible(needle, 25) if not vision else wait_answer(session, needle, seconds=25)
        except AssertionError:
            Path('/tmp/codsh-image-settings.txt').write_text(session.visible())
            raise
        echo = attach.model_echo(shown) if vision else shown
        if vision:
            assert_ordered_images(
                echo, shown,
                [(TINY_PNG, '1x1'), (GREEN_PNG, '2x1'), (TINY_PNG, '1x1')],
            )
        else:
            assert_text_only(echo, 2)
        session.write(b'later\r')
        shown = session.wait_visible('Streaming turn', 12)
        session.write(b'DRAFT_KEEP')
        shown = session.wait_visible('DRAFT_KEEP', 8)
        session.write(b'\x1b')
        session.pump(0.3)
        shown = session.visible()
        assert 'Press Ctrl+C to cancel the turn' in shown, shown
        assert 'DRAFT_KEEP' in shown, shown
        session.write(b'\x03')
        session.pump(0.4)
        shown = session.visible()
        assert 'DRAFT_KEEP' not in shown, shown
        session.write(b'\x03')
        shown = session.wait_visible('[cancelled]', 20)
        session.write(b'/fullscreen\r')
        shown = session.wait_visible('Switched to fullscreen', 12)
        # A Finder drop pastes the absolute path. An image file becomes an
        # image chip, not a binary @file mention.
        terminal_paste(session, str(cwd / 'shot.png').encode())
        shown = session.wait_visible('[Image #4]', 10)
        assert '@shot.png' not in shown, shown
        paste_image(session, GREEN_PNG)
        shown = session.wait_visible('[Image #5]', 10)
        session.write(b'\x7f')
        session.pump(0.4)
        shown = session.visible()
        assert '[Image #5]' not in shown, shown
        assert '[Image #4]' in shown, shown
        # Chips survive a round trip through minimal and back to fullscreen.
        session.write(b'/minimal\r')
        shown = session.wait_visible('Switched to minimal', 12)
        assert '[Image #4]' in shown, shown
        session.write(b'/fullscreen\r')
        shown = session.wait_visible('Switched to fullscreen', 12)
        assert '[Image #4]' in shown and '[Image #5]' not in shown, shown
        shown = session.wait_visible('Pasted image #4', 8)
        assert '1x1' in shown, shown
        session.write(b' again\r')
        needle = 'latest=' if vision else 'id="4"'
        try:
            shown = session.wait_visible(needle, 25) if not vision else wait_answer(session, needle, seconds=25)
        except AssertionError:
            settings = list(home.rglob('settings.yaml'))
            dumped = '\n'.join(f'{path}\n{path.read_text()[:1800]}' for path in settings)
            Path('/tmp/codsh-image-settings.txt').write_text(session.visible() + '\n\n' + dumped)
            raise
        echo = attach.model_echo(shown) if vision else shown
        if vision:
            assert_ordered_images(echo, shown, [(TINY_PNG, '1x1'), (GREEN_PNG, '2x1'), (TINY_PNG, '1x1'), (TINY_PNG, '1x1')])
        else:
            assert_text_only(echo, 1)
        shown = wait_idle(session)
        turn = last_turn(shown)
        quit_session(session)
    finally:
        close_session(session)
    resume_shows_image_turns(launcher, cwd, env, output, f'{name}-resume', session_id, vision, turn)


def close_session(session):
    # The launcher and dsh share the PTY session. Killing only the node
    # process leaves codsh-rust running after a restart case.
    session.kill_group()
    session.close()


def run_queue_only(work, output, dsh, overlay, launcher):
    """Queue an image under the vision model, then send it on the text-only fork."""
    home = work / 'queue-pack-home'
    grok = home / '.codsh-rust' / '.grok'
    grok.mkdir(parents=True, exist_ok=True)
    (grok / 'config.toml').write_text(config_text(True, switchable=True))
    cwd = work / 'queue-cwd'
    cwd.mkdir()
    patch = work / 'queue-overlay.yml'
    patch.write_text(overlay)
    env = {
        'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
        'DSH_BIN': dsh, 'CODSH_NODE': resume.NODE, 'CODSH_ACP_PATCH': str(patch),
        'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
        'DEEPSEEK_API_KEY': '', 'XAI_API_KEY': 'test-key', 'CODSH_UPDATE_CHECK': 'off',
        'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        'DSH_CODE_CLI_MOCK_DELAY_MS': '8000',
        'DSH_CODE_CLI_MOCK_IMAGE': '1',
        'GROK_PROMPT_SUGGESTIONS': 'false',
        'GROK_CLIPBOARD_NO_NATIVE_READ': '1',
        'CODSH_CLIPBOARD_IMAGE': str(cwd / 'clip.png'),
    }
    (cwd / 'clip.png').write_bytes(GREEN_PNG)
    queued = Session('queue-text', launcher, cwd, env, output, extra=['--fullscreen'])
    try:
        queued.wait_visible('Connected to dsh ACP', 25)
        queued.write(b'hold\r')
        queued.wait_visible('Streaming turn', 15)
        queued.write(b'\x16\r')
        shown = queued.wait_visible('queued', 12)
        assert '[Image #1]' not in shown.split('queued')[-1], shown
        queued.write(b'/model fork\r')
        shown = queued.wait_visible('vision=text-only', 15)
        assert 'Selected cli-mock / cli-mock-fork' in shown, shown
        assert 'did not advertise' not in shown, shown
        # A wrapped answer row hides the size from the last-line helper.
        # The visible screen still has the path and must not have an image block.
        try:
            shown = queued.wait_visible('dimensions="2x1"', 20)
        except AssertionError:
            Path('/tmp/codsh-132-01a0d1d6/157-grk-queue-after.txt').write_text(queued.visible())
            raise
        assert '<pasted-image ' in shown, shown
        assert 'images=' not in shown, shown
        assert 'mime=image/png' not in shown, shown
    finally:
        close_session(queued)


def run_restart_and_queue(work, home, output, dsh, overlay):
    """A composer draft lives in one process, like the reference.

    A sent prompt is not restored by the next launch in any project, and an
    unsent draft is not written to disk. A queued image follows the model
    selected at send.
    """
    grok = home / '.codsh-rust' / '.grok'
    grok.mkdir(parents=True, exist_ok=True)
    (grok / 'config.toml').write_text(config_text(True, switchable=True))
    cwd = work / 'restart'
    cwd.mkdir()
    other = work / 'restart-other'
    other.mkdir()
    launcher = pack_install(work / 'restart-pack', home)
    patch = work / 'restart-overlay.yml'
    patch.write_text(overlay)
    env = {
        'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
        'DSH_BIN': dsh, 'CODSH_NODE': resume.NODE, 'CODSH_ACP_PATCH': str(patch),
        'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
        'DEEPSEEK_API_KEY': '', 'XAI_API_KEY': 'test-key', 'CODSH_UPDATE_CHECK': 'off',
        'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        'DSH_CODE_CLI_MOCK_IMAGE': '1',
        'GROK_PROMPT_SUGGESTIONS': 'false',
        'GROK_CLIPBOARD_NO_NATIVE_READ': '1',
        'CODSH_CLIPBOARD_IMAGE': str(work / 'restart-clip.png'),
    }
    (work / 'restart-clip.png').write_bytes(GREEN_PNG)
    unsent_b64 = base64.b64encode(GREEN_PNG)
    session = Session('restart-send', launcher, cwd, env, output, extra=['--fullscreen'])
    try:
        session.wait_visible('Connected to dsh ACP', 25)
        sent_id = session.session_id()
        paste_image(session, TINY_PNG)
        shown = session.wait_visible('[Image #1]', 10)
        assert 'Pasted image #1' in shown, shown
        session.write(b' later')
        session.wait_visible('later', 8)
        session.write(b'\r')
        shown = wait_answer(session, 'latest=', seconds=25)
        echo = attach.model_echo(shown)
        assert_ordered_images(echo, shown, [(TINY_PNG, '1x1')])
        first_turn = last_turn(shown)
        # A draft that was never sent, with an image, when the process ends.
        session.write(b'UNSENT_DRAFT')
        session.wait_visible('UNSENT_DRAFT', 8)
        session.write(b'\x16')
        shown = session.wait_visible('[Image #2]', 10)
        quit_session(session)
    finally:
        close_session(session)
    assert_no_draft_files(home)
    assert files_containing(home, b'UNSENT_DRAFT', unsent_b64, GREEN_PNG) == [], \
        files_containing(home, b'UNSENT_DRAFT', unsent_b64, GREEN_PNG)

    for name, where in (('restart-same-project', cwd), ('restart-other-project', other)):
        fresh = Session(name, launcher, where, env, output, extra=['--fullscreen'])
        try:
            fresh.wait_visible('Connected to dsh ACP', 25)
            fresh.pump(0.6)
            shown = fresh.visible()
            assert 'UNSENT_DRAFT' not in shown, shown
            assert '[Image #' not in shown, shown
            assert 'later' not in shown, shown
            assert 'Pasted image' not in shown, shown
            # Enter on the empty composer sends nothing.
            fresh.write(b'\r')
            fresh.pump(2.0)
            shown = fresh.visible()
            assert 'Streaming turn' not in shown and 'RUST_ACP_ANSWER' not in shown, shown
            fresh.write(b'fresh start\r')
            shown = wait_answer(fresh, 'latest=fresh start', seconds=25)
            echo = attach.model_echo(shown)
            # Same history depth as the first prompt of a new session.
            assert last_turn(shown) == first_turn, shown
            assert 'images=' not in echo, echo
            quit_session(fresh)
        finally:
            close_session(fresh)
        assert_no_draft_files(home)

    resumed = Session('restart-resume', launcher, cwd, env, output, extra=['--fullscreen', '--resume', sent_id])
    try:
        shown = resumed.wait_visible('resumed', 25)
        shown = resumed.wait_visible('later', 10)
        assert '[Image #1] later' in user_rows(shown), shown
        assert 'UNSENT_DRAFT' not in shown, shown
        assert 'Pasted image' not in shown, shown
        resumed.write(b'after\r')
        shown = wait_answer(resumed, 'latest=after', seconds=25)
        echo = attach.model_echo(shown)
        # One image in the model history: the sent one. Nothing was resent.
        assert last_turn(shown) == first_turn + 1, shown
        assert 'images=1 ' in echo, echo
        assert_ordered_images(echo, shown, [(TINY_PNG, '1x1')])
        quit_session(resumed)
    finally:
        close_session(resumed)
    assert_no_draft_files(home)

    run_queue_only(work, output, dsh, overlay, launcher)
    text_env = dict(env)
    text_env['HOME'] = str(work / 'clip-home')
    text_env['DSH_CODE_CLI_MOCK_IMAGE'] = '0'
    text_env['CODSH_CLIPBOARD_IMAGE'] = str(cwd / 'clip.png')
    (work / 'clip-home').mkdir()

    # Empty, corrupt, and oversized fixtures never become a chip.
    (cwd / 'clip.png').write_bytes(b'')
    empty = Session('clip-empty', launcher, cwd, text_env, output, extra=['--fullscreen'])
    try:
        empty.wait_visible('Connected to dsh ACP', 25)
        empty.write(b'\x16')
        shown = empty.wait_visible('clipboard has no image', 10)
        assert '[Image #1]' not in shown, shown
    finally:
        close_session(empty)
    (cwd / 'clip.png').write_bytes(b'not-an-image')
    corrupt = Session('clip-corrupt', launcher, cwd, text_env, output, extra=['--fullscreen'])
    try:
        corrupt.wait_visible('Connected to dsh ACP', 25)
        corrupt.write(b'\x16')
        shown = corrupt.wait_visible('not a png', 10)
        assert '[Image #1]' not in shown, shown
    finally:
        close_session(corrupt)
    (cwd / 'clip.png').write_bytes(b'\x89PNG' + b'\x00' * (256 * 1024))
    huge = Session('clip-huge', launcher, cwd, text_env, output, extra=['--fullscreen'])
    try:
        huge.wait_visible('Connected to dsh ACP', 25)
        huge.write(b'\x16')
        shown = huge.wait_visible('256 KiB', 10)
        assert '[Image #1]' not in shown, shown
    finally:
        close_session(huge)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-image-', dir='/tmp'))
    dsh = resume.dsh_bin()
    overlay = resume.overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-image-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        vision_home = work / 'vision-home'
        text_home = work / 'text-home'
        vision_home.mkdir()
        text_home.mkdir()
        # CODSH_IMAGE_PTY_ONLY=vision,text-only,restart runs a subset while debugging.
        only = {item for item in os.environ.get('CODSH_IMAGE_PTY_ONLY', '').split(',') if item}
        if not only or 'vision' in only:
            run_case('vision', True, work, vision_home, output, dsh, overlay)
        if not only or 'text-only' in only:
            run_case('text-only', False, work, text_home, output, dsh, overlay)
        if not only or 'restart' in only:
            run_restart_and_queue(work, work / 'restart-home', output, dsh, overlay)
    print('image input pty ok')


if __name__ == '__main__':
    main()
