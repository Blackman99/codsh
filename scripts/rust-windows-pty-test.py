#!/usr/bin/env python3
"""Native Windows ConPTY run of the installed Rust client (#200).

Every scenario runs inside `cmd.exe` hosted by a ConPTY (pywinpty), so the
client sees a real Windows console, not a POSIX PTY or WSL. dsh answers from
the repository's mocked model (no network, no paid model). The console input
mode is read before the client starts and after it quits in the same console:
the client must hand it back unchanged, and the shell must still take a line.

Scenarios: install-check, headless turn, interactive turn with Unicode,
file tool with approval in a workspace path with spaces and CJK, Git Bash
shell tool, cancel of a running shell (the whole process tree must end),
resume with --continue, and a sandbox profile refusal.

Usage (Windows, from the repository after `pnpm install` and `npm pack`):
    python scripts/rust-windows-pty-test.py --package <codsh-cli-*.tgz> --output <dir>
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')
NPM = shutil.which('npm.cmd') or shutil.which('npm')
MODE_PROBE = ('import ctypes,sys;k=ctypes.windll.kernel32;h=k.GetStdHandle(-10);m=ctypes.c_uint32();'
              "k.GetConsoleMode(h,ctypes.byref(m));print('CONSOLE_MODE=%08x' % m.value)")
MODE_RE = re.compile(r'CONSOLE_MODE=([0-9a-f]{8})')
SESSION_RE = re.compile(r'\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b')


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, encoding='utf-8', **kwargs)


def screen_text(data, rows, cols):
    emulator = ROOT / 'e2e/vt.ts'
    payload = json.dumps({'rows': rows, 'cols': cols, 'bytes': base64.b64encode(data).decode()})
    return run([NODE, '--import', 'tsx', '-e',
                f"import {{ Terminal }} from {json.dumps(emulator.as_uri())}; "
                "let input=''; for await (const chunk of process.stdin) input+=chunk; "
                "const spec=JSON.parse(input); const t=new Terminal(spec.rows,spec.cols); "
                "t.feed(Buffer.from(spec.bytes,'base64').toString()); console.log(t.text);"],
               input=payload, cwd=ROOT).stdout


def dsh_bin():
    script = ("import { createRequire } from 'node:module'; import { dirname, join } from 'node:path'; "
              "import { readFileSync } from 'node:fs'; const r=createRequire(process.argv[1]); "
              "const m=r.resolve('@deepseek-ai/dsh/package.json'); const bin=JSON.parse(readFileSync(m,'utf8')).bin; "
              "process.stdout.write(join(dirname(m), typeof bin==='string'?bin:bin.dsh))")
    return run([NODE, '--input-type=module', '-e', script, str(ROOT / 'package.json')], cwd=ROOT).stdout


def overlay_text():
    return run([NODE, '--input-type=module', '-e',
                "import { rustAcpOverlay } from './scripts/rust-acp-overlay.mjs'; process.stdout.write(rustAcpOverlay())"],
               cwd=ROOT).stdout


class Console:
    """cmd.exe in a ConPTY; the client is started from its prompt."""

    def __init__(self, name, cwd, env, output, rows=36, cols=110):
        from winpty import PtyProcess
        self.name, self.rows, self.cols, self.output = name, rows, cols, output
        self.proc = PtyProcess.spawn(['cmd.exe', '/d', '/q', '/k', 'prompt CMD$G'], cwd=str(cwd), env=env,
                                     dimensions=(rows, cols))
        self.data = bytearray()
        self.lock = threading.Lock()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.mark = 0

    def _read(self):
        while True:
            try:
                chunk = self.proc.read(65536)
            except EOFError:
                return
            except Exception:
                return
            if chunk:
                with self.lock:
                    self.data.extend(chunk.encode('utf-8', 'surrogatepass'))
            else:
                time.sleep(0.02)

    def raw(self):
        with self.lock:
            return bytes(self.data)

    def visible(self):
        return screen_text(self.raw(), self.rows, self.cols)

    def write(self, text):
        self.proc.write(text)

    def wait_visible(self, text, seconds=40):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            shown = self.visible()
            if text in shown:
                return shown
            time.sleep(0.25)
        raise AssertionError(f'{self.name}: missing {text!r}\n{self.visible()}\nraw={self.raw()[-2500:]!r}')

    def wait_raw(self, pattern, seconds=40, since=0):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            match = pattern.search(self.raw()[since:].decode('utf-8', 'replace'))
            if match:
                return match
            time.sleep(0.2)
        raise AssertionError(f'{self.name}: missing {pattern.pattern!r}\nraw={self.raw()[-2500:]!r}')

    def console_mode(self):
        since = len(self.raw())
        self.write(f'"{sys.executable}" -c "{MODE_PROBE}"\r')
        return self.wait_raw(MODE_RE, 30, since).group(1)

    def start(self, argv):
        self.mode_before = self.console_mode()
        self.mark = len(self.raw())
        line = ' '.join(f'"{arg}"' if (' ' in arg or not arg) else arg for arg in argv)
        # `call` and the caret delay %ERRORLEVEL% until the client has exited.
        self.write(line + ' & call echo CLIENT_EXIT_%^ERRORLEVEL%\r')

    def finish(self, quit_key='\x11'):
        shown = self.visible()
        self.write(quit_key)
        exit_code = int(self.wait_raw(re.compile(r'CLIENT_EXIT_(\d+)'), 20, self.mark).group(1))
        mode_after = self.console_mode()
        self.write('echo AFTER_EXIT_LINE\r')
        self.wait_raw(re.compile(r'AFTER_EXIT_LINE\r?\n'), 10, self.mark)
        (self.output / f'{self.name}.ansi').write_bytes(self.raw())
        (self.output / f'{self.name}.txt').write_text(shown, encoding='utf-8')
        assert mode_after == self.mode_before, f'{self.name}: console mode {self.mode_before} -> {mode_after}'
        return {'name': self.name, 'exit': exit_code, 'consoleMode': self.mode_before, 'screen': shown}

    def close(self):
        try:
            if self.proc.isalive():
                self.proc.terminate(force=True)
        except Exception:
            pass


def tree_pids(root_pid):
    """PIDs of `root_pid` and all its descendants (CIM)."""
    table = run(['powershell', '-NoProfile', '-Command',
                 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }']).stdout
    children = {}
    names = {}
    for line in table.splitlines():
        parts = line.split(None, 2)
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            children.setdefault(int(parts[1]), []).append(int(parts[0]))
            names[int(parts[0])] = parts[2] if len(parts) > 2 else ''
    out, todo = [], [root_pid]
    while todo:
        pid = todo.pop()
        for child in children.get(pid, []):
            out.append((child, names.get(child, '')))
            todo.append(child)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--package', required=True, help='packed codsh-cli tarball')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if sys.platform != 'win32':
        raise SystemExit('native Windows required (ConPTY); WSL does not count')
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    report = {'environment': {}, 'steps': []}
    ver = run(['cmd', '/c', 'ver']).stdout.strip()
    report['environment'] = {
        'windows': ver, 'python': sys.version.split()[0], 'node': run([NODE, '-p', 'process.version + " " + process.arch']).stdout.strip(),
        'bash': shutil.which('bash'), 'git': shutil.which('git'),
        'toolchain_on_path': {tool: shutil.which(tool) for tool in ('cargo', 'rustc', 'rustup')},
    }
    dsh = dsh_bin()
    overlay = overlay_text()
    work = Path(tempfile.mkdtemp(prefix='codsh-win-'))
    home = work / 'home'
    home.mkdir()
    cwd = work / '工作 区 dir'
    cwd.mkdir()
    prefix = work / 'prefix'
    npm_env = {**os.environ, 'npm_config_update_notifier': 'false', 'npm_config_cache': str(work / 'npm-cache')}
    run([NPM, 'install', '-g', '--prefix', str(prefix), '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
         str(Path(args.package).resolve())], env=npm_env, cwd=work)
    package = prefix / 'node_modules/codsh-cli'
    launcher = package / 'bin/codsh.mjs'
    binary = package / 'native/win32-x64/codsh-rust.exe'
    assert binary.exists(), f'no {binary}'
    patch = work / 'overlay.yml'
    patch.write_text(overlay, encoding='utf-8')
    base_env = {
        **{k: v for k, v in os.environ.items() if not k.upper().endswith('_API_KEY')},
        'HOME': str(home), 'USERPROFILE': str(home), 'TERM': 'xterm-256color',
        'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
        'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF', 'CODSH_UPDATE_CHECK': 'off',
        'DEEPSEEK_API_KEY': '',
    }
    for tool in ('cargo', 'rustc', 'rustup'):
        base_env.pop(tool.upper(), None)

    dsh_home = home / '.codsh-rust' / 'dsh'

    def dsh_log():
        log = dsh_home / 'acp-stderr.log'
        if not log.exists():
            return f'(no {log})'
        return f'--- {log} (tail) ---\n' + '\n'.join(log.read_text(encoding='utf-8', errors='replace').splitlines()[-80:])

    def step(name, fn):
        started = time.monotonic()
        try:
            detail = fn()
            report['steps'].append({'name': name, 'ok': True, 'seconds': round(time.monotonic() - started, 1), 'detail': detail})
            print(f'PASS {name} ({time.monotonic() - started:.1f}s)', flush=True)
        except Exception as error:  # noqa: BLE001 - recorded, then the run fails
            text = f'{str(error)[-6000:]}\n{dsh_log()}'
            report['steps'].append({'name': name, 'ok': False, 'seconds': round(time.monotonic() - started, 1), 'error': text})
            print(f'FAIL {name} ({time.monotonic() - started:.1f}s)\n{text}', flush=True)

    def client(*extra):
        return [NODE, str(launcher), '--rust', *extra]

    def install_check():
        check = run(client('install-check', '--json'), env=base_env, cwd=cwd)
        data = json.loads(check.stdout)
        assert data['ok'] and data['artifact']['key'] == 'win32-x64' and data['artifact']['format'] == 'pe', data
        version = run(client('--version'), env=base_env, cwd=cwd).stdout.strip()
        assert version.startswith(f"codsh-rust {data['launcher']['version']} "), version
        return {'artifact': data['artifact'], 'version': version}

    def headless():
        result = subprocess.run(client('-p', 'TOKEN_HEADLESS 你好'), env={**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo'}, cwd=cwd,
                                capture_output=True, text=True, encoding='utf-8', timeout=180)
        assert result.returncode == 0, result.stdout + result.stderr
        assert 'RUST_ACP_ANSWER' in result.stdout, result.stdout + result.stderr
        return result.stdout.strip()[-400:]

    def interactive_turn():
        console = Console('turn', cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo'}, output)
        try:
            console.start(client())
            console.wait_visible('Connected to dsh ACP', 90)
            console.write('TOKEN_TURN_ONE 中文 ✓')
            console.wait_visible('TOKEN_TURN_ONE 中文 ✓', 20)
            console.write('\r')
            console.wait_visible('RUST_ACP_ANSWER', 60)
            result = console.finish()
            assert result['exit'] == 0, result
            return {k: result[k] for k in ('exit', 'consoleMode')}
        finally:
            console.close()

    def file_approval():
        (cwd / 'note.txt').write_text('alpha\n', encoding='utf-8')
        console = Console('file-approval', cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'}, output)
        try:
            console.start(client())
            console.wait_visible('Connected to dsh ACP', 90)
            console.write('TOKEN_FILE_EDIT')
            console.wait_visible('TOKEN_FILE_EDIT', 20)
            console.write('\r')
            console.wait_visible('Allow ', 60)
            assert (cwd / 'note.txt').read_text(encoding='utf-8') == 'alpha\n', 'edited before approval'
            console.write('y')
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and (cwd / 'note.txt').read_text(encoding='utf-8') == 'alpha\n':
                time.sleep(0.3)
            edited = (cwd / 'note.txt').read_text(encoding='utf-8')
            assert edited != 'alpha\n', 'approved edit did not land'
            result = console.finish()
            assert result['exit'] == 0, result
            return {'note': edited, 'workspace': str(cwd)}
        finally:
            console.close()

    def shell_tool():
        console = Console('shell', cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'shell-echo', 'CODSH_SHELL_MARKER': 'WIN200'}, output)
        try:
            console.start(client())
            console.wait_visible('Connected to dsh ACP', 90)
            console.write('TOKEN_SHELL')
            console.wait_visible('TOKEN_SHELL', 20)
            console.write('\r')
            console.wait_visible('Allow ', 60)
            console.write('y')
            console.wait_visible('STDOUT_WIN200', 60)
            shown = console.wait_visible('RUST_ACP_SHELL_DONE', 60)
            assert 'STDERR_WIN200' in shown, shown
            result = console.finish()
            assert result['exit'] == 0, result
            return {'bash': shutil.which('bash')}
        finally:
            console.close()

    def cancel_tree():
        for name in ('shell-started.txt', 'shell-finished.txt'):
            (cwd / name).unlink(missing_ok=True)
        console = Console('cancel', cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'shell-long', 'CODSH_SHELL_MARKER': 'WIN200'}, output)
        try:
            console.start(client())
            console.wait_visible('Connected to dsh ACP', 90)
            console.write('TOKEN_SHELL_LONG')
            console.wait_visible('TOKEN_SHELL_LONG', 20)
            console.write('\r')
            console.wait_visible('Allow ', 60)
            console.write('y')
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and not (cwd / 'shell-started.txt').exists():
                time.sleep(0.3)
            assert (cwd / 'shell-started.txt').exists(), 'long shell never started'
            before = [p for p in tree_pids(console.proc.pid) if p[1].lower() in ('sleep.exe', 'bash.exe')]
            assert before, 'no bash/sleep under the console while the shell ran'
            console.write('\x03')
            time.sleep(0.4)
            console.write('\x03')
            console.wait_visible('[cancelled]', 30)
            deadline = time.monotonic() + 20
            left = before
            while time.monotonic() < deadline:
                alive = {pid for pid, _ in tree_pids(console.proc.pid)}
                left = [p for p in before if p[0] in alive]
                if not left:
                    break
                time.sleep(0.5)
            assert not left, f'shell processes survived the cancel: {left}'
            result = console.finish()
            assert result['exit'] == 0, result
            time.sleep(2)
            assert not (cwd / 'shell-finished.txt').exists(), 'cancelled shell finished anyway'
            return {'killed': before}
        finally:
            console.close()

    def resume():
        first = Console('resume-first', cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo'}, output)
        try:
            first.start(client())
            first.wait_visible('Connected to dsh ACP', 90)
            first.write('TOKEN_RESUME_ONE\r')
            first.wait_visible('RUST_ACP_ANSWER', 60)
            session = SESSION_RE.search(first.visible())
            assert first.finish()['exit'] == 0
        finally:
            first.close()
        again = Console('resume-continue', cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo'}, output)
        try:
            again.start(client('--continue'))
            shown = again.wait_visible('resumed', 90)
            assert 'TOKEN_RESUME_ONE' in shown, shown
            again.write('TOKEN_RESUME_TWO\r')
            again.wait_visible('TOKEN_RESUME_TWO', 30)
            again.wait_visible('turn=', 60)
            result = again.finish()
            assert result['exit'] == 0, result
            return {'session': session.group(1) if session else None}
        finally:
            again.close()

    def sandbox_refused():
        result = subprocess.run(client('-p', 'x'), env={**base_env, 'GROK_SANDBOX': 'workspace', 'DSH_CODE_CLI_MOCK_TOOL': 'echo'},
                                cwd=cwd, capture_output=True, text=True, encoding='utf-8', timeout=120)
        assert result.returncode != 0 and 'not implemented on Windows' in result.stderr, result.stdout + result.stderr
        return result.stderr.strip()[-300:]

    for name, fn in (('install-check', install_check), ('headless', headless), ('turn', interactive_turn),
                     ('file-approval', file_approval), ('shell', shell_tool), ('cancel', cancel_tree),
                     ('resume', resume), ('sandbox-refused', sandbox_refused)):
        step(name, fn)
    report['ok'] = all(item['ok'] for item in report['steps'])
    # dsh's own logs from the isolated Home, for the evidence artifact.
    if dsh_home.exists():
        for log in dsh_home.rglob('*.log'):
            shutil.copy(log, output / f'dsh-{log.name}')
    report['untested'] = [
        'real terminal emulators other than the ConPTY harness (Windows Terminal, conhost window, VS Code) (#201)',
        'clipboard, notifications, microphone (#201)',
        'filesystem/network sandbox profiles: refused on Windows, not implemented',
        'shared server, remote identity and wrap (Unix sockets / PTY): unavailable on Windows (#201)',
        'win32-arm64 (no prebuilt)',
    ]
    (output / 'windows-report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({k: report[k] for k in ('environment', 'ok')}, indent=2, ensure_ascii=False))
    if not report['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
