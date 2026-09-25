#!/usr/bin/env python3
"""PTY: clipboard delivery, terminal doctor, wrap and notifications (ticket 155 / #155).

Everything runs as real subprocesses on real pseudo-terminals:

* `codsh --rust wrap <cmd>`: a fake remote program (a Python script, the
  stand-in for `ssh host`) sees the sink markers and the PTY size, receives
  keyboard input and a forwarded resize, emits an OSC 52 copy split across
  writes (plus the tmux-passthrough duplicate), turns on the alternate
  screen, mouse, bracketed paste, a hidden cursor and the kitty keyboard
  protocol, and is then SIGKILLed like a dropped connection. The copy must
  reach the fake local clipboard tool once, the outer terminal must get
  the restore sequences, termios must be back to cooked, and the exit code
  must be 128+9. A missing command and a missing argument are refused.
* `codsh --rust doctor [--json]` inside a fake tmux (a `tmux` script on
  PATH answering show-options), and `doctor fix` against a temporary HOME's
  .tmux.conf: refused without --yes on a non-TTY, declined and accepted at
  the TTY prompt, applied with --yes (backup, mode and CRLF-free append,
  undo command, no `tmux source-file` run), and refused on a conflicting
  direct assignment.
* The TUI: DECSET 1004 focus reporting on and off, a turn that finishes
  while focused (no notification), one that finishes after focus is lost
  (OSC 9 after the idle threshold, plus the hook with GROK_EVENT), focus
  regained before the threshold (cancelled), /copy and /copy N path with a
  fake xclip, /doctor, and a second session where no clipboard route works:
  the hint names the backup file and never says "Copied!", no OSC 52 is
  written with GROK_CLIPBOARD_NO_OSC52, and the one-time SSH tip shows once.

No real clipboard, tmux server, SSH connection or user config is touched;
every HOME is a temporary directory. Runs on Linux and macOS against the
repo launcher and the staged native binary (run `pnpm run build:rust`
first). It reuses the Session harness of rust-screen-pty-test.py.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import signal
import stat
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

COPY_TEXT = 'wrapped copy ✓ 第二行\nline two'

FAKE_REMOTE = r'''
import base64, fcntl, os, signal, struct, sys, termios, time
def size():
    rows, cols = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8))[:2]
    return f'{rows}x{cols}'
winched = []
signal.signal(signal.SIGWINCH, lambda *_: winched.append(size()))
out = sys.stdout
out.write(f"REMOTE_READY sink={os.environ.get('LC_GROK_OSC52_SINK')}/{os.environ.get('GROK_OSC52_SINK')} size={size()}\r\n")
out.flush()
line = sys.stdin.readline().strip()
out.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[>1u')
payload = base64.b64encode(sys.argv[1].encode()).decode()
out.write('\x1b]5'); out.flush(); time.sleep(0.05)
out.write('2;c;' + payload[:7]); out.flush(); time.sleep(0.05)
out.write(payload[7:] + '\x07'); out.flush()
out.write('\x1bPtmux;\x1b\x1b]52;c;' + payload + '\x07\x1b\\')
out.write(f'GOT:{line}\r\n'); out.flush()
deadline = time.time() + 15
while not winched and time.time() < deadline:
    time.sleep(0.05)
out.write(f"WINCH:{winched[-1] if winched else 'none'}\r\n"); out.flush()
sys.stdin.readline()
os.kill(os.getpid(), signal.SIGKILL)
'''

FAKE_TMUX = '''#!/bin/sh
printf '%s\\n' "$*" >> "{log}"
case "$*" in
  "-V") echo "tmux 3.4" ;;
  "show-options -gv set-clipboard") echo "external" ;;
  "show-options -gwv allow-passthrough") echo "off" ;;
  "show-options -gv extended-keys") echo "off" ;;
  "show-options -gv terminal-features") echo "xterm*:clipboard:ccolour" ;;
  "show-options -gv terminal-overrides") echo "" ;;
  "load-buffer -") cat > "{buffer}" ;;
  *) exit 1 ;;
esac
'''

FAKE_CLIP = '''#!/bin/sh
printf '%s\\n' "$*" >> "{log}.args"
cat >> "{log}"
printf '\\n--END--\\n' >> "{log}"
exit {code}
'''

CONFIG = """
[model.chat]
name = "Chat"
model = "cli-mock"
base_url = "http://127.0.0.1:1/v1"
env_key = "XAI_API_KEY"
api_backend = "chat_completions"
context_window = 128000

[models]
default = "chat"

[ui.notifications]
method = "osc9"
condition = "unfocused"
idle_threshold_secs = 3
events = ["turn_complete", "approval_required"]

[[ui.notifications.hooks]]
command = "printf '%s|%s|%s\\\\n' \\"$GROK_EVENT\\" \\"$GROK_MESSAGE\\" \\"${{GROK_SESSION_ID:+sid}}\\" >> '{hooklog}'"
events = ["turn_complete"]
only_unfocused = true
"""

# OSC 9 (BEL-terminated) keeps e2e/vt.ts parsing; OSC 777/99 bytes are unit-tested.
NOTIFY = 'Turn complete · codsh'.join(['\x1b]9;', '\x07']).encode()


def executable(path, text):
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def clip_entries(log):
    if not log.exists():
        return []
    return [entry.strip('\n') for entry in log.read_text().split('\n--END--\n') if entry.strip('\n')]


def run_pty(argv, env, cwd, rows=30, cols=100):
    master, slave = pty.openpty()
    import fcntl
    import struct
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    original = termios.tcgetattr(slave)
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave,
                               start_new_session=True)
    return master, slave, original, process


class Raw:
    """Minimal PTY driver for non-TUI commands (wrap, doctor prompt)."""

    def __init__(self, name, argv, env, cwd, rows=30, cols=100):
        self.name = name
        self.master, self.slave, self.original, self.process = run_pty(argv, env, cwd, rows, cols)
        self.data = bytearray()

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

    def text(self):
        return bytes(self.data).decode('utf-8', 'replace')

    def wait(self, needle, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump()
            if needle in self.text():
                return self.text()
            if self.process.poll() is not None:
                self.pump(0.3)
                if needle in self.text():
                    return self.text()
                break
        raise AssertionError(f'{self.name}: missing {needle!r}\n{self.text()[-3000:]!r}')

    def write(self, data):
        os.write(self.master, data if isinstance(data, bytes) else data.encode())

    def exit_code(self, seconds=20):
        deadline = time.monotonic() + seconds
        while self.process.poll() is None:
            if time.monotonic() > deadline:
                raise AssertionError(f'{self.name}: did not exit\n{self.text()[-2000:]!r}')
            self.pump(0.1)
        self.pump(0.4)
        return self.process.returncode

    def close(self):
        if self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(5)
        for fd in (self.master, self.slave):
            try:
                os.close(fd)
            except OSError:
                pass


def check_wrap(env, cwd, work, isolated_grok, results):
    fake = work / 'fake-remote.py'
    fake.write_text(FAKE_REMOTE)
    clip = work / 'wrap-clip.log'
    fakebin = work / 'wrapbin'
    fakebin.mkdir()
    executable(fakebin / 'xclip', FAKE_CLIP.format(log=clip, code=0))
    wrap_env = {**env, 'PATH': f'{fakebin}:{env["PATH"]}', 'DISPLAY': ':155'}
    for key in ('GROK_OSC52_SINK', 'LC_GROK_OSC52_SINK', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'TMUX'):
        wrap_env.pop(key, None)
    raw = Raw('wrap-drop', [NODE, str(LAUNCHER), '--rust', 'wrap', sys.executable, str(fake), COPY_TEXT],
              wrap_env, cwd)
    try:
        shown = raw.wait('REMOTE_READY', 30)
        assert 'sink=1/1' in shown, shown
        assert 'size=30x100' in shown, shown
        results['wrap_child_env_and_size'] = True
        raw.write('hello-through-wrap\r')
        raw.wait('GOT:hello-through-wrap', 15)
        results['wrap_keyboard_input'] = True
        import fcntl
        import struct
        fcntl.ioctl(raw.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        # A real terminal signals its foreground process group; the launcher ignores it.
        os.killpg(raw.process.pid, signal.SIGWINCH)
        raw.wait('WINCH:40x120', 20)
        results['wrap_resize_forwarded'] = True
        raw.write('drop\r')
        code = raw.exit_code(20)
        text = raw.text()
        data = bytes(raw.data)
        assert code == 128 + 9, (code, text[-2000:])
        assert 'ended by signal 9' in text, text[-2000:]
        results['wrap_drop_exit_code'] = True
        entries = clip_entries(clip)
        assert entries == [COPY_TEXT], entries
        assert 'clipboard' in (clip.parent / 'wrap-clip.log.args').read_text()
        backup = isolated_grok / 'last-copy.txt'
        assert backup.read_text() == COPY_TEXT, backup
        assert 'forwarded 1 clipboard copy (last: confirmed)' in text, text[-2000:]
        # The remote's copy is not relayed raw; Linux also sends one local OSC 52 leg.
        encoded = base64.b64encode(COPY_TEXT.encode())
        assert data.count(b'\x1b]52;c;' + encoded + b'\x07') == 1, data[-3000:]
        assert b'\x1bPtmux;' not in data, data[-3000:]
        results['wrap_osc52_forwarded_once'] = True
        tail = data[data.rindex(b'GOT:hello-through-wrap'):]
        for sequence in (b'\x1b[<1u', b'\x1b[?1000l', b'\x1b[?1006l', b'\x1b[?2004l', b'\x1b[?25h', b'\x1b[?1049l'):
            assert sequence in tail, (sequence, tail[-600:])
        assert tail.rindex(b'\x1b[?1049l') > tail.rindex(b'\x1b[?2004l')
        assert 'restored terminal state left on by' in text and 'alternate screen' in text, text[-1500:]
        snap = screen.emulate(data, 40, 120)
        assert not snap['onAlternate'], 'still on the alternate screen after the drop'
        after = termios.tcgetattr(raw.slave)
        assert after == raw.original, 'wrap left the outer terminal in raw mode'
        os.write(raw.master, b'CANONICAL_AFTER_WRAP\n')
        assert select.select([raw.slave], [], [], 2)[0]
        assert os.read(raw.slave, 4096) == b'CANONICAL_AFTER_WRAP\n'
        results['wrap_restores_after_drop'] = True
    finally:
        raw.close()
    missing = subprocess.run([NODE, str(LAUNCHER), '--rust', 'wrap', 'codsh-155-no-such-command'],
                             cwd=cwd, env=wrap_env, capture_output=True, text=True, timeout=60)
    assert missing.returncode == 127, (missing.returncode, missing.stderr)
    assert 'cannot run codsh-155-no-such-command' in missing.stderr, missing.stderr
    usage = subprocess.run([NODE, str(LAUNCHER), '--rust', 'wrap'], cwd=cwd, env=wrap_env,
                           capture_output=True, text=True, timeout=60)
    assert usage.returncode == 2 and 'usage: codsh --rust wrap' in usage.stderr, usage
    results['wrap_refusals'] = True


def check_doctor(env, cwd, work, home, results):
    tmux_log = work / 'tmux.log'
    buffer = work / 'tmux-buffer.txt'
    fakebin = work / 'doctorbin'
    fakebin.mkdir()
    executable(fakebin / 'tmux', FAKE_TMUX.format(log=tmux_log, buffer=buffer))
    doctor_env = {**env, 'PATH': f'{fakebin}:{env["PATH"]}', 'TMUX': '/tmp/codsh-155-fake-tmux,1,0',
                  'TERM': 'tmux-256color', 'SSH_CONNECTION': '10.0.0.1 1 10.0.0.2 22',
                  'TERM_PROGRAM': 'vscode'}

    def cli(*args, extra=None):
        return subprocess.run([NODE, str(LAUNCHER), '--rust', *args], cwd=cwd,
                              env={**doctor_env, **(extra or {})}, capture_output=True, text=True, timeout=120)

    report = cli('doctor', '--json')
    assert report.returncode == 0, report.stderr
    parsed = json.loads(report.stdout)
    assert parsed['schema'] == 'codsh.doctor.v1'
    facts = parsed['facts']
    assert facts['multiplexer'] == 'tmux' and facts['remote'] is True, facts
    assert facts['terminalId'] == 'vscode', facts
    assert facts['tmuxVersion'] == 'tmux 3.4', facts
    assert facts['tmuxOptions']['set-clipboard'] == 'external', facts
    assert facts['clipboard']['tmux']['enabled'] is True, facts
    assert facts['clipboard']['osc52']['tmuxPassthrough'] is True, facts
    ids = {finding['id'] for finding in parsed['findings']}
    for expected in ('terminal.tmux-clipboard', 'terminal.dcs-passthrough', 'terminal.tmux-extended-keys',
                     'terminal.tmux-truecolor', 'terminal.ssh-wrap', 'terminal.newline-fallback'):
        assert expected in ids, (expected, ids)
    assert parsed['unverified'], parsed
    results['doctor_json'] = True
    text = cli('doctor')
    assert text.returncode == 0, text.stderr
    for needle in ('Detected:', 'Multiplexer', 'tmux set-clipboard', 'terminal.tmux-clipboard', 'Not verified by this build'):
        assert needle in text.stdout, (needle, text.stdout)
    results['doctor_text'] = True

    conf = home / '.tmux.conf'
    conf.write_text('set -g mouse on\n')
    conf.chmod(0o640)
    refused = cli('doctor', 'fix', 'terminal.tmux-clipboard')
    assert refused.returncode == 1, refused
    assert 'Not applied' in refused.stdout and '+ set -g set-clipboard on' in refused.stdout, refused.stdout
    assert conf.read_text() == 'set -g mouse on\n'
    results['doctor_fix_needs_confirmation'] = True

    prompt = Raw('doctor-prompt', [NODE, str(LAUNCHER), '--rust', 'doctor', 'fix', 'terminal.tmux-truecolor'],
                 doctor_env, cwd)
    try:
        prompt.wait('[y/N]', 30)
        prompt.write('n\r')
        assert prompt.exit_code() == 1
        assert 'Not applied' in prompt.text()
    finally:
        prompt.close()
    assert conf.read_text() == 'set -g mouse on\n'
    results['doctor_fix_prompt_declined'] = True

    applied = cli('doctor', 'fix', '--yes')
    assert applied.returncode == 0, (applied.stdout, applied.stderr)
    body = conf.read_text()
    assert body.startswith('set -g mouse on\n'), body
    for line in ('set -g set-clipboard on', 'set -wg allow-passthrough on', 'set -g extended-keys on',
                 'set -as terminal-features ",*:RGB"'):
        assert f'\n{line}\n' in body, (line, body)
    assert '\r' not in body
    assert stat.S_IMODE(conf.stat().st_mode) == 0o640
    backups = sorted(home.glob('.tmux.conf.codsh-backup-*'))
    assert len(backups) == 1 and backups[0].read_text() == 'set -g mouse on\n', backups
    assert f"Undo: cp '{backups[0]}' '{conf}'" in applied.stdout, applied.stdout
    assert 'tmux source-file' in applied.stdout and 'never runs this' in applied.stdout
    assert 'source-file' not in tmux_log.read_text(), tmux_log.read_text()
    again = cli('doctor', 'fix', '--yes')
    assert again.returncode == 0 and 'already set' in again.stdout, again.stdout
    assert len(sorted(home.glob('.tmux.conf.codsh-backup-*'))) == 1
    results['doctor_fix_applied_with_backup'] = True

    other = work / 'home-conflict'
    other.mkdir()
    (other / '.tmux.conf').write_text('set -g set-clipboard off\n')
    conflict = subprocess.run([NODE, str(LAUNCHER), '--rust', 'doctor', 'fix', 'terminal.tmux-clipboard', '--yes'],
                              cwd=cwd, env={**doctor_env, 'HOME': str(other)}, capture_output=True, text=True,
                              timeout=120)
    assert conflict.returncode == 1, conflict
    assert 'refused: line 1 already sets it to `off`' in conflict.stdout, conflict.stdout
    assert (other / '.tmux.conf').read_text() == 'set -g set-clipboard off\n'
    assert not list(other.glob('.tmux.conf.codsh-backup-*'))
    results['doctor_fix_refuses_conflict'] = True


def ask(session, marker, seconds=40):
    """Send a prompt and wait until the mock's answer echoes it back."""
    session.write(marker)
    session.wait_visible(marker, 10)
    session.write(b'\r')
    needle = f'latest={marker}'.encode()
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump()
        if needle in bytes(session.data):
            session.pump(0.5)
            return
    raise AssertionError(f'{session.name}: no answer to {marker}\n{session.visible()}')


def check_tui(env, cwd, work, isolated_grok, output, results):
    hooklog = work / 'hook.log'
    clip = work / 'tui-clip.log'
    fakebin = work / 'tuibin'
    fakebin.mkdir()
    executable(fakebin / 'xclip', FAKE_CLIP.format(log=clip, code=0))
    (isolated_grok / 'config.toml').write_text(CONFIG.format(hooklog=hooklog))
    tui_env = {**env, 'PATH': f'{fakebin}:{env["PATH"]}', 'DISPLAY': ':155', 'DSH_CODE_CLI_MOCK_TOOL': 'echo'}
    session = Session('terminal-tui', LAUNCHER, cwd, tui_env, output,
                      extra=['--fullscreen', '--trust'], cols=140, rows=40)
    try:
        session.wait_visible('Connected to dsh ACP', 30)
        assert b'\x1b[?1004h' in bytes(session.data), 'focus reporting was not enabled'
        results['tui_focus_reporting_enabled'] = True
        ask(session, 'FOCUSED_TURN')
        session.pump(3.5)
        assert NOTIFY not in bytes(session.data), 'notified while focused'
        assert not hooklog.exists(), 'only_unfocused hook ran while focused'
        results['tui_focused_turn_quiet'] = True

        session.write(b'\x1b[O')
        session.pump(0.3)
        ask(session, 'AWAY_TURN')
        deadline = time.monotonic() + 10
        while NOTIFY not in bytes(session.data) and time.monotonic() < deadline:
            session.pump(0.2)
        assert bytes(session.data).count(NOTIFY) == 1, bytes(session.data)[-2000:]
        deadline = time.monotonic() + 5
        while not hooklog.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        assert hooklog.read_text() == 'turn_complete|Turn complete|sid\n', hooklog.read_text()
        results['tui_unfocused_turn_notifies_and_runs_hook'] = True

        session.write(b'\x1b[I')
        session.pump(0.2)
        session.write(b'\x1b[O')
        lost = time.monotonic()
        session.pump(0.3)
        ask(session, 'CANCEL_TURN')
        session.write(b'\x1b[I')
        elapsed = time.monotonic() - lost
        session.pump(4)
        if elapsed < 2.5:
            assert bytes(session.data).count(NOTIFY) == 1, 'focus gain did not cancel the pending notification'
            results['tui_focus_gain_cancels_pending'] = True
        else:
            results['tui_focus_gain_cancels_pending'] = f'skipped: turn took {elapsed:.1f}s (unit-tested)'

        session.send_slash('/copy')
        shown = session.wait_visible('Copied!', 15)
        assert 'systemclipboard(xclip)' in ''.join(shown.split()), shown
        entries = clip_entries(clip)
        assert entries and entries[-1].startswith('RUST_ACP_ANSWER'), entries
        assert (isolated_grok / 'last-copy.txt').read_text() == entries[-1]
        results['tui_copy_latest'] = True
        target = work / 'copied' / 'second.md'
        session.send_slash(f'/copy 2 {target}')
        session.wait_visible('Wrote', 15)
        body = target.read_text()
        assert body.startswith('RUST_ACP_ANSWER') and body != entries[-1], body
        results['tui_copy_nth_to_file'] = True
        session.send_slash('/doctor')
        session.wait_visible('Not verified by this build', 15)
        # The report is taller than the 40-row screen; its tail is what stays visible.
        session.wait_visible('desktop notification display', 5)
        results['tui_doctor'] = True
        results['tui_exit'] = session.finish(expect_alt_leave=True)
        tail = bytes(session.data)
        assert tail.rindex(b'\x1b[?1004l') > tail.rindex(b'\x1b[?1004h'), 'focus reporting left on at exit'
        results['tui_focus_reporting_disabled_at_exit'] = True
    finally:
        session.close()

    # No working route: no DISPLAY, OSC 52 switched off, over SSH.
    (isolated_grok / 'config.toml').write_text(CONFIG.format(hooklog=hooklog))
    broken_env = {**tui_env, 'GROK_CLIPBOARD_NO_OSC52': '1', 'SSH_CONNECTION': '10.0.0.1 1 10.0.0.2 22'}
    broken_env.pop('DISPLAY')
    marker = isolated_grok / 'hints' / 'ssh_wrap.shown'
    assert not marker.exists()
    broken = Session('terminal-no-route', LAUNCHER, cwd, broken_env, output,
                     extra=['--fullscreen', '--trust'], cols=160, rows=40)
    try:
        broken.wait_visible('Connected to dsh ACP', 30)
        broken.wait_visible('SSH session: copies travel as OSC 52', 10)
        assert marker.exists()
        results['tui_ssh_tip_once'] = True
        ask(broken, 'NO_ROUTE_TURN')
        before = len(clip_entries(clip))
        broken.send_slash('/copy')
        shown = broken.wait_visible('Clipboard unreachable', 15)
        assert 'last-copy.txt' in shown.replace('\n', ''), shown
        assert 'Copied!' not in shown, shown
        assert b'\x1b]52;' not in bytes(broken.data), 'OSC 52 written despite GROK_CLIPBOARD_NO_OSC52'
        assert len(clip_entries(clip)) == before
        assert 'NO_ROUTE_TURN' in (isolated_grok / 'last-copy.txt').read_text()
        results['tui_copy_unreachable_is_honest'] = True
        results['tui_no_route_exit'] = broken.finish(expect_alt_leave=True)
    finally:
        broken.close()
    again = Session('terminal-tip-again', LAUNCHER, cwd, broken_env, output,
                    extra=['--fullscreen', '--trust'], cols=160, rows=40)
    try:
        again.wait_visible('Connected to dsh ACP', 30)
        again.pump(1)
        assert 'SSH session: copies travel' not in again.visible(), again.visible()
        results['tui_ssh_tip_not_repeated'] = again.finish(expect_alt_leave=True)
    finally:
        again.close()


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-terminal-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-terminal-home-', dir='/tmp') as temporary:
        work = Path(temporary).resolve()
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        isolated_grok = home / '.codsh-rust' / '.grok'
        isolated_grok.mkdir(parents=True)
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off', 'LANG': 'C.UTF-8',
        }
        check_wrap(env, cwd, work, isolated_grok, results)
        check_doctor(env, cwd, work, home, results)
        check_tui(env, cwd, work, isolated_grok, output, results)
    print(json.dumps({'output': str(output), 'results': results}, indent=2, default=str))


if __name__ == '__main__':
    main()
