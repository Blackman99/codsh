#!/usr/bin/env python3
"""Installed-product PTY against the platform's real clipboard (#201).

No CODSH_CLIPBOARD_IMAGE fixture and no fake helper: the image is put on the
system clipboard with the platform tool (osascript on macOS, xclip under an
X display on Linux), then Ctrl+V in the client must attach it. A text-only
clipboard must be refused with "clipboard has no image". `/copy` must place
the latest answer, CJK included, where pbpaste / xclip -o can read it.

Exit 0 with `PASS`, or exit 0 with `UNAVAILABLE: <reason>` when this host has
no clipboard to drive (Linux without DISPLAY/xclip). Never a silent pass.
Windows is covered by scripts/rust-windows-pty-test.py.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import zlib

ROOT = Path(__file__).resolve().parent.parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


resume = load('rust_resume_pty_test', 'rust-resume-pty-test.py')
screen = load('rust_screen_pty_test', 'rust-screen-pty-test.py')
prompt = load('rust_prompt_pty_test', 'rust-prompt-pty-test.py')

PASTE_OPEN = b'\x1b[200~'
PASTE_CLOSE = b'\x1b[201~'


def png(width=4, height=3):
    raw = b''.join(b'\x00' + bytes([30, 160, 60]) * width for _ in range(height))

    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


class MacClipboard:
    name = 'macOS pasteboard (osascript / pbcopy / pbpaste)'

    def set_image(self, path):
        script = f'set the clipboard to (read (POSIX file "{path}") as «class PNGf»)'
        subprocess.run(['osascript', '-e', script], check=True, timeout=20)

    # The harness reads and writes as UTF-8 itself. The client gets no LANG
    # from this harness, so a CJK /copy also proves it does not depend on one.
    UTF8 = {**os.environ, 'LC_ALL': 'en_US.UTF-8'}

    def set_text(self, text):
        subprocess.run(['pbcopy'], input=text.encode(), check=True, timeout=10, env=self.UTF8)

    def get_text(self):
        return subprocess.run(['pbpaste'], capture_output=True, timeout=10,
                              env=self.UTF8).stdout.decode(errors='replace')

    def env(self):
        return {}

    def close(self):
        pass


class XClipboard:
    name = 'X11 CLIPBOARD selection (xclip)'

    def __init__(self):
        self.owners = []

    def _own(self, argv, data):
        # Keep the xclip owner alive for the whole session so the client can
        # read the selection later. `-loops 0` never exits on its own.
        child = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if data is not None:
            child.stdin.write(data)
            child.stdin.close()
        time.sleep(0.35)
        self.owners.append(child)

    def set_image(self, path):
        data = Path(path).read_bytes()
        self._own(
            ['xclip', '-selection', 'clipboard', '-t', 'image/png', '-i', '-loops', '0'],
            data,
        )

    def set_text(self, text):
        self._own(
            ['xclip', '-selection', 'clipboard', '-i', '-loops', '0'],
            text.encode(),
        )

    def get_text(self):
        return subprocess.run(
            ['xclip', '-selection', 'clipboard', '-o'],
            capture_output=True,
            timeout=10,
        ).stdout.decode(errors='replace')

    def close(self):
        for child in self.owners:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)

    def env(self):
        out = {'DISPLAY': os.environ['DISPLAY']}
        if os.environ.get('XAUTHORITY'):
            out['XAUTHORITY'] = os.environ['XAUTHORITY']
        return out



def clipboard():
    if sys.platform == 'darwin':
        if not (shutil.which('osascript') and shutil.which('pbpaste')):
            return None, 'osascript/pbpaste missing'
        return MacClipboard(), None
    if sys.platform == 'linux':
        if os.environ.get('WAYLAND_DISPLAY'):
            return None, 'Wayland session: this harness drives X11 only (wl-copy/wl-paste untested)'
        if not os.environ.get('DISPLAY'):
            return None, 'no DISPLAY (run under xvfb-run to exercise the X11 clipboard)'
        if not shutil.which('xclip'):
            return None, 'xclip is not installed'
        return XClipboard(), None
    return None, f'{sys.platform}: use scripts/rust-windows-pty-test.py'


def wait_for(predicate, seconds, session):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump(0.1)
        value = predicate()
        if value:
            return value
    return None


def main():
    board, reason = clipboard()
    if board is None:
        print(f'UNAVAILABLE: {reason}')
        return
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-clipboard-', dir='/tmp'))
    evidence = {'clipboard': board.name, 'checks': {}}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-clipboard-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        image = work / 'clip.png'
        image.write_bytes(png())
        launcher = prompt.pack_install(work, home)
        patch = work / 'overlay.yml'
        patch.write_text(resume.overlay_text())
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': resume.dsh_bin(), 'CODSH_NODE': resume.NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'echo', 'GROK_PROMPT_SUGGESTIONS': 'false',
            **board.env(),
        }
        session = screen.Session('clipboard-real', launcher, cwd, env, output, extra=['--fullscreen'], cols=140)
        try:
            session.wait_visible('Connected to dsh ACP', 25)
            board.set_image(image)
            session.write('look ')
            session.wait_visible('look')
            session.write(b'\x16')
            shown = session.wait_visible('[Image #1]', 15)
            evidence['checks']['ctrl_v_image'] = 'attached [Image #1] from the system clipboard'
            if sys.platform == 'darwin':
                # Cmd+V on an image-only pasteboard arrives as an empty paste.
                session.write(PASTE_OPEN + PASTE_CLOSE)
                session.wait_visible('[Image #2]', 15)
                evidence['checks']['empty_paste_image'] = 'empty bracketed paste read the pasteboard ([Image #2])'
            else:
                session.write(PASTE_OPEN + PASTE_CLOSE)
                session.pump(1.0)
                shown = session.visible()
                assert '[Image #2]' not in shown, shown
                evidence['checks']['empty_paste_image'] = 'ignored on Linux like the reference (Ctrl+V is the image key)'
            session.write(b'\x03')
            session.pump(0.3)
            board.set_text('plain words only')
            session.write(b'\x16')
            session.wait_visible('clipboard has no image', 15)
            evidence['checks']['ctrl_v_text_only'] = 'refused: clipboard has no image'
            # The draft is empty now; another Ctrl+C would quit the client.
            session.write('TOKEN_CLIP 中文剪贴\r'.encode())
            prompt.wait_answer(session, 'latest=TOKEN_CLIP', count=1)
            board.set_text('stale')
            session.write('/copy\r')
            copied = wait_for(lambda: (lambda text: text if 'TOKEN_CLIP' in text else None)(board.get_text()), 15, session)
            assert copied, f'/copy did not reach the clipboard: {board.get_text()!r}\n{session.visible()}'
            assert '中文剪贴' in copied, copied
            evidence['checks']['copy_text_cjk'] = copied.strip()[:200]
        finally:
            result = session.finish(expect_alt_leave=True)
            session.close()
        assert result['exit'] == 0, result
        if isinstance(board, XClipboard) and os.environ.get('XAUTHORITY'):
            # Without the X cookie xclip cannot open the display. That must be
            # said as such, not reported as an empty clipboard.
            board.set_image(image)
            no_auth = {key: value for key, value in env.items() if key != 'XAUTHORITY'}
            blocked = screen.Session('clipboard-no-xauth', launcher, cwd, no_auth, output,
                                     extra=['--fullscreen'], cols=140)
            try:
                blocked.wait_visible('Connected to dsh ACP', 25)
                blocked.write(b'\x16')
                shown = blocked.wait_visible('cannot reach the display server', 15)
                assert '[Image #1]' not in shown, shown
                assert 'clipboard has no image' not in shown, shown
                evidence['checks']['display_unreachable'] = 'refused: xclip cannot reach the display server (no XAUTHORITY)'
            finally:
                blocked_result = blocked.finish(expect_alt_leave=True)
                blocked.close()
            assert blocked_result['exit'] == 0, blocked_result
    board.close()
    (output / 'result.json').write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps(evidence, ensure_ascii=False))
    print(f'PASS: rust real clipboard PTY; evidence: {output}')


if __name__ == '__main__':
    main()
