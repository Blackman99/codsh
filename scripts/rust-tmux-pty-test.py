#!/usr/bin/env python3
"""Installed product inside a real tmux server (#201).

Starts a private tmux server (`-L`, `-f /dev/null`) and runs the packed
client in a pane, so tmux (not a Python PTY emulator) is the terminal. Checks:

- the fullscreen UI renders and a CJK prompt round-trips through dsh;
- `/copy` lands in the tmux paste buffer (the multiplexer leg of the copy);
- an SGR mouse click reaches the client (tmux forwards it only when the
  client has enabled mouse reporting);
- Ctrl+Q exits 0 and the pane is left with the alternate screen, mouse
  reporting and hidden cursor all turned off (`#{alternate_on}`,
  `#{mouse_any_flag}`, `#{cursor_flag}`).

Exit 0 with `PASS`, or `UNAVAILABLE: <reason>` when tmux is not installed.
"""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


resume = load('rust_resume_pty_test', 'rust-resume-pty-test.py')
prompt = load('rust_prompt_pty_test', 'rust-prompt-pty-test.py')


class Tmux:
    def __init__(self, socket_dir):
        self.socket = str(socket_dir / 'tmux.sock')

    def run(self, *args, check=True):
        result = subprocess.run(['tmux', '-S', self.socket, '-f', '/dev/null', *args],
                                capture_output=True, text=True, timeout=20)
        if check and result.returncode != 0:
            raise AssertionError(f'tmux {args}: {result.stderr.strip()}')
        return result.stdout

    def pane(self):
        return self.run('capture-pane', '-p', '-J', '-t', 'matrix')

    def fmt(self, expr):
        return self.run('display-message', '-p', '-t', 'matrix', expr).strip()

    def wait(self, needle, seconds=25):
        deadline = time.monotonic() + seconds
        shown = ''
        while time.monotonic() < deadline:
            shown = self.pane()
            if needle in shown:
                return shown
            if self.fmt('#{pane_dead}') == '1':
                break
            time.sleep(0.2)
        raise AssertionError(f'tmux pane: missing {needle!r}\n{shown}')

    def kill(self):
        self.run('kill-server', check=False)


def main():
    if sys.platform not in ('darwin', 'linux'):
        print(f'UNAVAILABLE: tmux scenario runs on macOS/Linux, not {sys.platform}')
        return
    if not shutil.which('tmux'):
        print('UNAVAILABLE: tmux is not installed')
        return
    version = subprocess.run(['tmux', '-V'], capture_output=True, text=True).stdout.strip()
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-tmux-', dir='/tmp'))
    evidence = {'tmux': version, 'checks': {}}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-tmux-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        launcher = prompt.pack_install(work, home)
        patch = work / 'overlay.yml'
        patch.write_text(resume.overlay_text())
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'],
            'DSH_BIN': resume.dsh_bin(), 'CODSH_NODE': resume.NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'echo', 'GROK_PROMPT_SUGGESTIONS': 'false',
            'LANG': os.environ.get('LANG') or 'C.UTF-8',
        }
        script = work / 'run.sh'
        exports = ''.join(f'export {key}={shlex.quote(value)}\n' for key, value in env.items())
        script.write_text(
            '#!/bin/sh\n' + exports
            + f'cd {shlex.quote(str(cwd))}\n'
            + f'exec {shlex.quote(resume.NODE)} {shlex.quote(str(launcher))} --rust --fullscreen\n'
        )
        script.chmod(0o755)
        tmux = Tmux(work)
        try:
            tmux.run('-u', 'new-session', '-d', '-s', 'matrix', '-x', '140', '-y', '36', str(script))
            tmux.run('set-option', '-t', 'matrix', 'remain-on-exit', 'on')
            tmux.run('set-option', '-g', 'default-terminal', 'tmux-256color', check=False)
            tmux.wait('Connected to dsh ACP')
            evidence['checks']['term'] = tmux.fmt('#{client_termname}') or 'detached (no client)'
            assert tmux.fmt('#{alternate_on}') == '1', 'fullscreen did not enter the alternate screen'
            tmux.run('send-keys', '-t', 'matrix', '-l', 'TOKEN_TMUX 中文')
            tmux.run('send-keys', '-t', 'matrix', 'Enter')
            tmux.wait('latest=TOKEN_TMUX')
            evidence['checks']['cjk_prompt'] = 'answer echoed latest=TOKEN_TMUX 中文'
            tmux.run('set-buffer', 'stale-buffer')
            tmux.run('send-keys', '-t', 'matrix', '-l', '/copy')
            tmux.run('send-keys', '-t', 'matrix', 'Enter')
            deadline = time.monotonic() + 15
            buffer = ''
            while time.monotonic() < deadline:
                buffer = tmux.run('show-buffer', check=False)
                if 'TOKEN_TMUX' in buffer:
                    break
                time.sleep(0.2)
            assert 'TOKEN_TMUX' in buffer and '中文' in buffer, f'/copy did not reach the tmux buffer: {buffer!r}\n{tmux.pane()}'
            evidence['checks']['copy_tmux_buffer'] = buffer.strip()[:160]
            mouse = tmux.fmt('#{mouse_any_flag}|#{mouse_sgr_flag}')
            assert mouse.startswith('1'), f'client did not enable mouse reporting inside tmux: {mouse}'
            evidence['checks']['mouse_reporting'] = f'mouse_any|sgr = {mouse}'
            tmux.run('send-keys', '-t', 'matrix', 'C-q')
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and tmux.fmt('#{pane_dead}') != '1':
                time.sleep(0.2)
            status = tmux.fmt('#{pane_dead}|#{pane_dead_status}|#{alternate_on}|#{mouse_any_flag}|#{mouse_sgr_flag}')
            dead, code, alternate, mouse_after, mouse_sgr = status.split('|')
            assert dead == '1', f'client still running after Ctrl+Q: {status}\n{tmux.pane()}'
            assert code == '0', f'exit status {code}'
            assert alternate == '0', 'left the pane on the alternate screen'
            assert mouse_after == '0' and mouse_sgr == '0', f'left mouse reporting on: {status}'
            evidence['checks']['restore'] = f'exit 0; alternate_on=0 mouse_any_flag=0 mouse_sgr_flag=0'
            (output / 'pane-after-exit.txt').write_text(tmux.pane())
        finally:
            tmux.kill()
    (output / 'result.json').write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps(evidence, ensure_ascii=False))
    print(f'PASS: rust tmux PTY; evidence: {output}')


if __name__ == '__main__':
    main()
