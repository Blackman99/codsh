#!/usr/bin/env python3
"""Installed-product PTY: rendered content, tool cards, diffs, fold/expand, and pager."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
SESSION_RE = __import__('re').compile(r'session ([0-9a-f-]{8,})')


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


def dsh_bin():
    script = "import { createRequire } from 'node:module'; import { dirname, join } from 'node:path'; import { readFileSync } from 'node:fs'; const r=createRequire(process.argv[1]); const m=r.resolve('@deepseek-ai/dsh/package.json'); const bin=JSON.parse(readFileSync(m,'utf8')).bin; process.stdout.write(join(dirname(m), typeof bin==='string'?bin:bin.dsh))"
    return run([NODE, '--input-type=module', '-e', script, str(ROOT / 'package.json')], cwd=ROOT).stdout


def overlay_text():
    return run([NODE, '--input-type=module', '-e',
                "import { rustAcpOverlay } from './scripts/rust-acp-overlay.mjs'; process.stdout.write(rustAcpOverlay())"],
               cwd=ROOT).stdout


def emulate(data, rows, cols):
    emulator = ROOT / 'e2e/vt.ts'
    payload = json.dumps({'rows': rows, 'cols': cols, 'bytes': __import__('base64').b64encode(data).decode()})
    raw = run([NODE, '--import', 'tsx', '-e',
               f"import {{ Terminal }} from {json.dumps(emulator.as_uri())}; "
               "let input=''; for await (const chunk of process.stdin) input+=chunk; "
               "const spec=JSON.parse(input); const t=new Terminal(spec.rows,spec.cols); "
               "t.feed(Buffer.from(spec.bytes,'base64').toString()); "
               "console.log(JSON.stringify({"
               "text:t.text, primary:t.primary.join('\\n'), alternate:t.alternate.join('\\n'), "
               "onAlternate:t.onAlternate}));"],
              input=payload, cwd=ROOT).stdout
    return json.loads(raw)


def screen_text(data, rows, cols):
    return emulate(data, rows, cols)['text']


def unwrapped(shown):
    """Join rows the viewport wrapped. The transcript marks each row with `>`,
    so `Vec<T>` paints as `Vec<` then `> T>`."""
    rows = []
    for row in shown.split('\n'):
        if row.startswith('> '):
            row = row[2:]
        elif row == '>':
            row = ''
        rows.append(row)
    return ''.join(rows)


def sgr_codes(data):
    import re
    return sorted({
        match.group(1).decode()
        for match in re.finditer(rb'\x1b\[([0-9;]*)m', bytes(data))
    })


def alt_enter_count(data):
    return bytes(data).count(b'\x1b[?1049h')


def alt_leave_count(data):
    return bytes(data).count(b'\x1b[?1049l')


class Session:
    def __init__(self, name, launcher, cwd, env, output, extra=None, cols=100, rows=36):
        self.name = name
        self.cols = cols
        self.rows = rows
        self.output = output
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.original = termios.tcgetattr(self.slave)
        argv = [NODE, str(launcher), '--rust', *(extra or [])]
        self.process = subprocess.Popen(
            argv, cwd=cwd, env=env,
            stdin=self.slave, stdout=self.slave, stderr=self.slave, start_new_session=True)
        self.data = bytearray()
        self.cursor_replies = 0

    def answer_cursor(self):
        queries = bytes(self.data).count(b'\x1b[6n')
        while self.cursor_replies < queries:
            os.write(self.master, f'\x1b[{self.rows};1R'.encode())
            self.cursor_replies += 1

    def pump(self, seconds=0.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], 0.03)[0]:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.data.extend(chunk)
                self.answer_cursor()

    def visible(self):
        return screen_text(bytes(self.data), self.rows, self.cols)

    def wait_visible(self, text, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump()
            shown = self.visible()
            if text in shown:
                return shown
            if self.process.poll() is not None:
                break
        raise AssertionError(f'{self.name}: missing {text!r}\n{self.visible()}\nraw={bytes(self.data)[-2500:]!r}')

    def write(self, data):
        os.write(self.master, data if isinstance(data, bytes) else data.encode())

    def current_text(self):
        snap = self.snapshot()
        return '\n'.join([snap['text'], snap['primary']])

    def session_id(self):
        blob = self.current_text()
        match = SESSION_RE.search(blob)
        if match is None:
            raise AssertionError(f'{self.name}: missing session id\n{blob}')
        return match.group(1)

    def snapshot(self):
        emu = emulate(bytes(self.data), self.rows, self.cols)
        emu['entered'] = alt_enter_count(self.data)
        emu['left'] = alt_leave_count(self.data)
        return emu

    def resize(self, rows, cols):
        self.rows = rows
        self.cols = cols
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        os.kill(self.process.pid, signal.SIGWINCH)

    def finish(self, expect_alt_leave=None):
        shown = self.visible()
        self.write(b'\x11')
        deadline = time.monotonic() + 12
        while self.process.poll() is None:
            if time.monotonic() > deadline:
                self.kill_group()
                raise TimeoutError(f'{self.name}: quit hung after Ctrl+Q')
            self.pump(0.15)
        self.pump(0.2)
        os.write(self.master, b'AFTER_EXIT_CANONICAL\n')
        assert select.select([self.slave], [], [], 2)[0]
        assert os.read(self.slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
        after = termios.tcgetattr(self.slave)
        (self.output / f'{self.name}.ansi').write_bytes(self.data)
        (self.output / f'{self.name}.txt').write_text(shown)
        assert self.original == after, f'{self.name}: terminal modes were not restored'
        snap = emulate(bytes(self.data), self.rows, self.cols)
        entered = alt_enter_count(self.data)
        left = alt_leave_count(self.data)
        if expect_alt_leave is True:
            assert left, f'{self.name}: missing leave-alternate-screen'
            assert not snap['onAlternate'], f'{self.name}: still on alternate screen after exit'
        if expect_alt_leave is False:
            assert not entered, f'{self.name}: minimal must not enter alternate screen'
            assert not snap['onAlternate'], f'{self.name}: minimal painted the alternate screen'
        return {
            'name': self.name,
            'exit': self.process.returncode,
            'screen': shown,
            'primary': snap['primary'],
            'onAlternate': snap['onAlternate'],
        }

    def kill_group(self):
        if self.process.poll() is not None:
            return
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            self.process.terminate()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                self.process.kill()
            self.process.wait(timeout=2)

    def close(self):
        self.kill_group()
        for fd in (self.master, self.slave):
            try:
                os.close(fd)
            except OSError:
                pass


def pack_launcher(work, pack_env):
    pack = json.loads(run(['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
                         cwd=ROOT / 'packages/cli', env=pack_env).stdout)[0]['filename']
    prefix = work / 'installed'
    run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
    return prefix / 'node_modules/.bin/codsh'


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-content-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    pager_log = output / 'pager.log'
    pager = output / 'recording-pager.sh'
    pager.write_text(
        '#!/bin/sh\n'
        f'log={json.dumps(str(pager_log))}\n'
        'printf "PAGER_INVOKED argv=%s\\n" "$*" >> "$log"\n'
        'cat -- "$1" >> "$log"\n'
        'exit 0\n'
    )
    pager.chmod(0o755)
    with tempfile.TemporaryDirectory(prefix='codsh-rust-content-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        huge = '\n'.join(f'HUGE_LINE_{i:03d}_MARKER' for i in range(1, 81)) + '\n'
        (cwd / 'huge.txt').write_text(huge)
        (cwd / 'ctrl.txt').write_text('visible\x07\x1b[31mred\x1b[0m\n')
        (cwd / 'note.txt').write_text('alpha\n')
        pack_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'],
            'npm_config_cache': str(work / 'npm-cache'),
            'npm_config_userconfig': str(work / 'empty-user.npmrc'),
            'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
            'npm_config_update_notifier': 'false',
        }
        launcher = pack_launcher(work, pack_env)
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        base_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'PAGER': str(pager),
        }
        results = []
        isolated = home / '.codsh-rust'
        sessions_dir = isolated / 'dsh' / 'sessions'

        fullscreen = Session('fullscreen-markdown', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'markdown',
        }, output, extra=['--fullscreen'], cols=100, rows=36)
        try:
            fullscreen.wait_visible('Connected to dsh ACP', 25)
            assert fullscreen.snapshot()['onAlternate']
            fullscreen.write('TOKEN_CONTENT_MD\r')
            shown = fullscreen.wait_visible('RUST_MD_HEADING', 30)
            sid = fullscreen.session_id()
            assert 'TOKEN_CONTENT_MD' in shown
            assert '**bold**' not in shown, shown
            assert '`inline_code`' not in shown, shown
            assert '&amp;' not in shown, shown
            assert '你好' in shown and 'café' in shown, shown
            assert '👩\u200d💻' in shown, shown
            painted = unwrapped(shown)
            assert '<font' in painted and '<b>' in painted and 'RUST_MD_GAIN' in painted, shown
            assert 'Vec<T>' in painted, shown
            assert 'a < b && c > d' in painted, shown
            assert 'held' in painted, shown
            assert '维度' in shown, shown
            assert 'codsh' in shown, shown
            fullscreen.write('\t')
            fullscreen.pump(0.4)
            fullscreen.write('\r')
            shown = fullscreen.wait_visible('full content ·', 10)
            assert 'full content ·' in shown, shown
            assert 'Esc closes full content' in shown, shown
            for _ in range(8):
                fullscreen.write('\x1b[6~')
                fullscreen.pump(0.15)
            shown = fullscreen.wait_visible('Decision', 10)
            assert 'RUST_MD_STREAM_DONE' in shown, shown
            painted = unwrapped(shown)
            assert 'fn f<T>(v: Vec<T>)' in painted, shown
            assert 'a < b && c > d' in painted, shown
            assert painted.count('fn f<T>(v: Vec<T>)') == 1, shown
            assert shown.count('[unclosed code fence]') == 1, shown
            assert 'unclosed' in shown.lower() or 'const unclosed' in shown, shown
            fullscreen.write('\x1b')
            fullscreen.pump(0.4)
            closed = fullscreen.visible()
            (output / 'fullscreen-markdown-closed.txt').write_text(closed)
            assert 'Esc closes full content' not in closed, closed
            assert 'full content ·' not in closed, closed
            assert 'const unclosed' not in closed, closed
            assert 'RUST_MD_STREAM_DONE' not in closed, closed
            assert '29 more lines' in closed, closed
            codes = sgr_codes(fullscreen.data)
            (output / 'fullscreen-markdown-sgr.txt').write_text('\n'.join(codes) + '\n')
            assert any(code not in {'', '0', '1', '22', '39', '49', '59'} for code in codes), codes
            fullscreen.write('r')
            shown = fullscreen.wait_visible('graph TD', 10)
            assert 'graph TD' in shown
            fullscreen.write('r')
            fullscreen.pump(0.4)
            shown = fullscreen.visible()
            assert 'graph TD' not in shown, shown
            fullscreen.write('\r')
            shown = fullscreen.wait_visible('full content ·', 10)
            assert 'Esc closes full content' in shown, shown
            for _ in range(8):
                fullscreen.write('\x1b[6~')
                fullscreen.pump(0.15)
            shown = fullscreen.wait_visible('RUST_MD_STREAM_DONE', 10)
            assert 'RUST_MD_STREAM_DONE' in shown, shown
            overlay_before_esc = shown
            (output / 'fullscreen-markdown-overlay.txt').write_text(overlay_before_esc)
            fullscreen.write('\x1b')
            fullscreen.pump(0.4)
            results.append(fullscreen.finish(expect_alt_leave=True))
        finally:
            fullscreen.close()

        resume = Session('resume-markdown', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'markdown',
        }, output, extra=['--resume', sid, '--fullscreen'])
        try:
            shown = resume.wait_visible('RUST_MD_HEADING', 25)
            assert 'TOKEN_CONTENT_MD' in shown
            blob = shown + bytes(resume.data).decode('utf-8', 'replace')
            assert '你好' in shown and 'café' in shown, shown
            assert '👩\u200d💻' in shown, shown
            painted = unwrapped(shown)
            assert '<font' in painted and '<b>' in painted, shown
            assert 'Vec<T>' in painted, shown
            assert 'a < b && c > d' in painted, shown
            assert 'RUST_MD_GAIN' in painted and 'held' in painted, shown
            resume.write('\t')
            resume.pump(0.3)
            resume.write('\r')
            resume.wait_visible('full content ·', 10)
            for _ in range(8):
                resume.write('\x1b[6~')
                resume.pump(0.15)
            resume.wait_visible('Decision', 10)
            resume.write('\x1b')
            resume.pump(0.3)
            resume.write('r')
            shown = resume.wait_visible('graph TD', 10)
            assert '```mermaid' in shown or 'graph TD' in shown, shown
            assert '👩\u200d💻' in shown, shown
            results.append(resume.finish(expect_alt_leave=True))
        finally:
            resume.close()

        (cwd / 'note.txt').write_text('alpha\n')
        edit = Session('fullscreen-diff', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit',
        }, output, extra=['--fullscreen'])
        try:
            edit.wait_visible('Connected to dsh ACP', 25)
            edit.write('TOKEN_CONTENT_EDIT\r')
            edit.wait_visible('Allow ', 30)
            shown = edit.visible()
            assert 'edit note.txt' in shown
            assert '-alpha' in shown and '+ALPHA' in shown
            edit.write(b'y')
            shown = edit.wait_visible('successfully.', 30)
            assert (cwd / 'note.txt').read_text() == 'ALPHA\n'
            blob = shown + bytes(edit.data).decode('utf-8', 'replace')
            assert 'successfully.' in shown or 'successfully.' in blob, blob[-2000:]
            assert 'RUST_ACP_FILE_DONE' in shown
            assert 'failed' not in shown.lower() or 'successfully.' in shown.lower()
            results.append(edit.finish(expect_alt_leave=True))
        finally:
            edit.close()

        huge_session = Session('fullscreen-huge', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'huge-read',
        }, output, extra=['--fullscreen'], cols=100, rows=36)
        try:
            huge_session.wait_visible('Connected to dsh ACP', 25)
            huge_session.write('TOKEN_CONTENT_HUGE\r')
            shown = huge_session.wait_visible('HUGE_LINE_001_MARKER', 30)
            huge_session.wait_visible('[tool read]', 10)
            shown = huge_session.visible()
            assert 'read huge.txt' in shown or '[tool read' in shown
            assert 'HUGE_LINE_080_MARKER' not in shown, shown
            huge_session.write('\t')
            huge_session.pump(0.3)
            huge_session.write('\x1b[C')
            huge_session.pump(0.4)
            huge_session.write('\r')
            shown = huge_session.wait_visible('full content ·', 10)
            assert 'full content ·' in shown
            assert 'Esc closes full content' in shown, shown
            assert 'HUGE_LINE_001_MARKER' in shown
            for _ in range(12):
                huge_session.write('\x1b[6~')
                huge_session.pump(0.1)
            shown = huge_session.wait_visible('HUGE_LINE_080_MARKER', 10)
            assert 'HUGE_LINE_080_MARKER' in shown
            huge_session.resize(20, 60)
            huge_session.pump(0.8)
            shown = huge_session.visible()
            assert 'HUGE_LINE' in shown, shown
            huge_session.write('\x1b')
            huge_session.pump(0.4)
            huge_session.write('\t')
            huge_session.pump(0.3)
            huge_session.write('/transcript\r')
            huge_session.wait_visible('opened in pager', 10)
            log = pager_log.read_text()
            assert 'PAGER_INVOKED' in log
            assert 'HUGE_LINE_080_MARKER' in log
            assert 'TOKEN_CONTENT_HUGE' in log
            results.append(huge_session.finish(expect_alt_leave=True))
        finally:
            huge_session.close()

        ctrl = Session('control-output', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'control-output',
        }, output, extra=['--fullscreen'])
        try:
            ctrl.wait_visible('Connected to dsh ACP', 25)
            ctrl.write('TOKEN_CONTENT_CTRL\r')
            shown = ctrl.wait_visible('visible', 30)
            ctrl.wait_visible('RUST_ACP_CTRL_DONE', 10)
            shown = ctrl.visible()
            assert 'visible' in shown
            assert '\x07' not in shown
            results.append(ctrl.finish(expect_alt_leave=True))
        finally:
            ctrl.close()

        missing = Session('failed-read', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-missing',
        }, output, extra=['--fullscreen'])
        try:
            missing.wait_visible('Connected to dsh ACP', 25)
            missing.write('TOKEN_CONTENT_MISS\r')
            shown = missing.wait_visible('cannot read', 30)
            assert 'successfully.' not in shown
            assert 'failed' in shown.lower(), shown
            assert '[error]' in shown, shown
            assert 'not found' in shown or 'cannot read' in shown
            results.append(missing.finish(expect_alt_leave=True))
        finally:
            missing.close()

        pager_log.write_text('')
        minimal = Session('minimal-expand', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'huge-read',
        }, output, extra=['--minimal'], cols=100, rows=36)
        try:
            shown = minimal.wait_visible('Connected to dsh ACP', 25)
            assert 'mode=minimal' in shown
            assert not minimal.snapshot()['onAlternate']
            minimal.write('TOKEN_CONTENT_MIN\r')
            shown = minimal.wait_visible('HUGE_LINE_080_MARKER', 30)
            native_head = shown + minimal.snapshot()['primary']
            assert 'HUGE_LINE_080_MARKER' in shown or 'HUGE_LINE_080_MARKER' in native_head
            minimal.write('/expand\r')
            shown = minimal.wait_visible('HUGE_LINE_080_MARKER', 15)
            snap = minimal.snapshot()
            native = '\n'.join([shown, snap['text'], snap['primary']])
            assert 'HUGE_LINE_080_MARKER' in native, native
            sessions_before = sorted(
                (str(path.relative_to(sessions_dir)), path.stat().st_mtime_ns, path.stat().st_size)
                for path in sessions_dir.rglob('*') if path.is_file()
            ) if sessions_dir.exists() else []
            minimal.write('/expand\r')
            minimal.pump(0.6)
            sessions_after = sorted(
                (str(path.relative_to(sessions_dir)), path.stat().st_mtime_ns, path.stat().st_size)
                for path in sessions_dir.rglob('*') if path.is_file()
            ) if sessions_dir.exists() else []
            assert sessions_before == sessions_after, (sessions_before, sessions_after)
            results.append(minimal.finish(expect_alt_leave=False))
        finally:
            minimal.close()

        stub_bin = output / 'bin'
        stub_bin.mkdir()
        less = stub_bin / 'less'
        less.write_text(
            '#!/bin/sh\n'
            f'log={json.dumps(str(pager_log))}\n'
            'printf "LESS_INVOKED argv=%s\\n" "$*" >> "$log"\n'
            'cat -- "$1" >> "$log"\n'
            'exit 0\n'
        )
        less.chmod(0o755)
        empty_pager = Session('empty-pager', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'markdown', 'PAGER': '',
            'PATH': f'{stub_bin}{os.pathsep}{os.environ["PATH"]}',
        }, output, extra=['--fullscreen'])
        try:
            empty_pager.wait_visible('Connected to dsh ACP', 25)
            empty_pager.write('TOKEN_CONTENT_PAGER\r')
            empty_pager.wait_visible('RUST_MD_HEADING', 30)
            empty_pager.write('/transcript\r')
            shown = empty_pager.wait_visible('opened in pager', 10)
            assert 'TOKEN_CONTENT_PAGER' in shown
            assert 'LESS_INVOKED' in pager_log.read_text()
            results.append(empty_pager.finish(expect_alt_leave=True))
        finally:
            empty_pager.close()

        bad_pager = Session('bad-pager', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'markdown',
            'PAGER': '/this/pager/does-not-exist',
        }, output, extra=['--fullscreen'])
        try:
            bad_pager.wait_visible('Connected to dsh ACP', 25)
            bad_pager.write('TOKEN_CONTENT_BADPAGER\r')
            bad_pager.wait_visible('RUST_MD_HEADING', 30)
            bad_pager.write('/transcript\r')
            shown = bad_pager.wait_visible('pager', 10)
            assert 'TOKEN_CONTENT_BADPAGER' in shown
            assert 'Draft (not sent)' in shown
            results.append(bad_pager.finish(expect_alt_leave=True))
        finally:
            bad_pager.close()

        pager_log.write_text('')
        minimal_md = Session('minimal-markdown', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'markdown',
        }, output, extra=['--minimal'], cols=100, rows=36)
        try:
            shown = minimal_md.wait_visible('Connected to dsh ACP', 25)
            assert 'mode=minimal' in shown
            assert not minimal_md.snapshot()['onAlternate']
            minimal_md.write('TOKEN_CONTENT_MINMD\r')
            shown = minimal_md.wait_visible('RUST_MD_STREAM_DONE', 30)
            blob = shown + bytes(minimal_md.data).decode('utf-8', 'replace')
            assert 'Decision' in shown or 'RUST_MD_STREAM_DONE' in shown, shown
            assert '👩' in blob and '\u200d' in blob and '💻' in blob, blob[-4000:]
            minimal_md.write('\t')
            minimal_md.pump(0.3)
            minimal_md.write('y')
            shown = minimal_md.wait_visible('copied original', 10)
            copied = isolated / '.grok' / 'tmp' / 'copied-block.md'
            assert copied.exists(), copied
            original = copied.read_text()
            assert '**bold**' in original
            assert 'graph TD' in original
            assert '👩' in original and '\u200d' in original and '💻' in original
            minimal_md.resize(20, 60)
            minimal_md.pump(0.8)
            shown = minimal_md.visible()
            assert 'copied original' in shown or 'RUST_MD' in shown or 'Decision' in shown, shown
            results.append(minimal_md.finish(expect_alt_leave=False))
        finally:
            minimal_md.close()

        thought = Session('fullscreen-thought', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'reasoning',
        }, output, extra=['--fullscreen'], cols=100, rows=36)
        try:
            thought.wait_visible('Connected to dsh ACP', 25)
            thought.write('TOKEN_CONTENT_THOUGHT\r')
            shown = thought.wait_visible('RUST_ACP_THOUGHT', 30)
            assert '[thought]' in shown, shown
            assert 'RUST_ACP_ANSWER' in shown
            thought.write('\t')
            thought.pump(0.3)
            thought.write('r')
            shown = thought.wait_visible('RUST_ACP_THOUGHT', 10)
            thought.write('\r')
            shown = thought.wait_visible('full content ·', 10)
            assert 'full content ·' in shown
            assert 'Esc closes full content' in shown, shown
            assert 'RUST_ACP_THOUGHT' in shown
            thought.write('\x1b')
            results.append(thought.finish(expect_alt_leave=True))
        finally:
            thought.close()

        (output / 'result.json').write_text(json.dumps({
            'results': [{'name': item['name'], 'exit': item['exit']} for item in results],
            'dshBin': dsh,
            'pagerLog': pager_log.read_text() if pager_log.exists() else '',
        }, indent=2) + '\n')
        assert all(item['exit'] == 0 for item in results), results
    print(f'PASS: rust dsh content/tool-card PTY; evidence: {output}')


if __name__ == '__main__':
    main()
