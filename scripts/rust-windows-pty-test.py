#!/usr/bin/env python3
"""Native Windows ConPTY run of the installed Rust client (#200).

Every scenario runs inside `cmd.exe` hosted by a ConPTY (pywinpty), so the
client sees a real Windows console, not a POSIX PTY or WSL. dsh answers from
the repository's mocked model (no network, no paid model). The console input
mode is read before the client starts and after it quits in the same console:
the client must hand it back unchanged, and the shell must still take a line.

Scenarios: install-check, headless turn, interactive turn with Unicode,
file tool with approval in a workspace path with spaces and CJK, the
PowerShell (pwsh) shell tool, cancel of a running shell (the whole process
tree must end), resume with --continue, a sandbox profile refusal, key
editing and history, `/copy` read back with Get-Clipboard (CJK included),
the clipboard-image notice on Ctrl+V / empty paste, voice doctor without a
device fixture, and install / update / refused broken installs / rollback of
the packed product with the Rust Home kept and the legacy Homes untouched.

Usage (Windows, from the repository after `pnpm install` and `npm pack`):
    python scripts/rust-windows-pty-test.py --package <codsh-cli-*.tgz> --output <dir>
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import traceback

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
    if os.environ.get('DSH_BIN'):
        return os.environ['DSH_BIN']
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
        raise AssertionError(f'{self.name}: missing {text!r}\n{self.visible()}\nraw(tail)={self.raw()[-1200:]!r}')

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
        # Keep what the screen showed, pass or fail, for the evidence artifact.
        try:
            (self.output / f'{self.name}.ansi').write_bytes(self.raw())
            (self.output / f'{self.name}-screen.txt').write_text(self.visible(), encoding='utf-8')
        except Exception:
            pass
        try:
            if self.proc.isalive():
                self.proc.terminate(force=True)
        except Exception:
            pass


def tree_pids(root_pid):
    """PIDs of `root_pid` and all its descendants (CIM).

    The CIM query can stall for a while on a busy runner; bound it and retry
    so one slow query does not hang the step.
    """
    argv = ['powershell', '-NoProfile', '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }']
    table = None
    for attempt in range(3):
        try:
            table = run(argv, timeout=60).stdout
            break
        except subprocess.TimeoutExpired:
            if attempt == 2:
                raise
            time.sleep(1)
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


def tree_digest(path):
    digest = hashlib.sha256()
    for item in sorted(Path(path).rglob('*')):
        digest.update(str(item.relative_to(path)).encode())
        if item.is_file() and not item.is_symlink():
            digest.update(item.read_bytes())
    return digest.hexdigest()


class Registry(http.server.BaseHTTPRequestHandler):
    """dist-tags for `codsh --rust update --check`."""
    latest = None

    def log_message(self, *_):
        pass

    def do_GET(self):
        body = json.dumps({'latest': Registry.latest}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    # The runner's console code page is cp1252; screen text is Unicode.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8', errors='replace')
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
            message = f'{error!r}\n{traceback.format_exc()}'
            text = f'{message[:5000]}\n{dsh_log()}'
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
            pwd = re.search(r'PWD<([^>]*)>', ''.join(shown.split('\n')))
            result = console.finish()
            assert result['exit'] == 0, result
            return {'pwsh': shutil.which('pwsh'), 'powershell': shutil.which('powershell'),
                    'workingDirectory': pwd.group(1) if pwd else None, 'workspace': str(cwd)}
        finally:
            console.close()

    def cancel_tree():
        # dsh 0.1.5-rc.3 confines pwsh with its Windows ACL sandbox
        # (workspace-write by default). That restricted token cannot enter a
        # workspace inside the user profile (the shell step records pwsh
        # starting in its own install directory, and writes there are denied),
        # so this step uses a workspace outside the profile.
        cwd = Path(os.environ.get('SystemDrive', 'C:') + '\\') / f'codsh-win-cancel-{os.getpid()}' / '工作 区'
        cwd.mkdir(parents=True, exist_ok=True)
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
            before = [p for p in tree_pids(console.proc.pid) if p[1].lower() in ('pwsh.exe', 'powershell.exe')]
            assert before, 'no PowerShell under the console while the shell ran'
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

    def install_update_rollback():
        """The packed product updated in place, broken installs refused, rolled back (#198 flow on Windows)."""
        tarball = Path(args.package).resolve()
        version = json.loads((package / 'package.json').read_text(encoding='utf-8'))['version']
        key = 'win32-x64'
        for name, body in (('.dsh/settings.yaml', 'agent-default-model:\n  provider: legacy\n'),
                           ('.grok/config.toml', '[models]\ndefault = "legacy"\n'),
                           ('.grok/sessions/keep.jsonl', '{"legacy":true}\n')):
            (home / name).parent.mkdir(parents=True, exist_ok=True)
            (home / name).write_text(body, encoding='utf-8')
        legacy_before = {name: tree_digest(home / name) for name in ('.dsh', '.grok')}
        source = work / 'pkg-src'
        with tarfile.open(tarball) as archive:
            archive.extractall(source, filter='data')

        result = {}

        def variant(new_version, drop_native=False):
            copy = work / f'pkg-{new_version}'
            shutil.copytree(source / 'package', copy)
            manifest = json.loads((copy / 'package.json').read_text(encoding='utf-8'))
            manifest['version'] = new_version
            (copy / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
            if drop_native:
                shutil.rmtree(copy / 'native' / key)
            else:
                artifact = json.loads((copy / 'native' / key / 'artifact.json').read_text(encoding='utf-8'))
                artifact['version'] = new_version
                (copy / 'native' / key / 'artifact.json').write_text(json.dumps(artifact, indent=2) + '\n', encoding='utf-8')
            out = work / f'tarballs-{new_version}'
            out.mkdir()
            name = json.loads(run([NPM, 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(out)],
                                  cwd=copy, env=npm_env).stdout)[0]['filename']
            return out / name

        def install(tar):
            # A file under the prefix can stay busy for a moment after a launch
            # (EBUSY while an antivirus scan or an exiting process holds it).
            argv = [NPM, 'install', '-g', '--prefix', str(prefix), '--offline', '--ignore-scripts', '--no-audit', '--no-fund', str(tar)]
            for attempt in range(6):
                done = subprocess.run(argv, env=npm_env, cwd=work, capture_output=True, text=True, encoding='utf-8')
                if done.returncode == 0:
                    result.setdefault('installRetries', []).append(attempt)
                    return
                holders = subprocess.run(
                    ['powershell', '-NoProfile', '-Command',
                     f"Get-Process | Where-Object {{ $_.Path -like '{prefix}*' }} | ForEach-Object {{ \"$($_.Id) $($_.Path)\" }}"],
                    capture_output=True, text=True, encoding='utf-8').stdout.strip()
                print(f'npm install {tar.name} attempt {attempt + 1} failed ({done.returncode}); holders: {holders or "none"}\n'
                      f'{done.stderr[-1500:]}', flush=True)
                time.sleep(5)
            raise AssertionError(f'npm install {tar.name} kept failing: {done.stderr[-3000:]}')

        def turn(prompt):
            return subprocess.run(client('-p', prompt), env={**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo'}, cwd=cwd,
                                  capture_output=True, text=True, encoding='utf-8', timeout=180)

        def refused(result, *needles):
            assert result.returncode == 1, (result.returncode, result.stdout, result.stderr)
            for needle in needles:
                assert needle in result.stderr, (needle, result.stderr)
            return result.stderr.strip().splitlines()[0]

        def session_ids():
            listed = subprocess.run(client('sessions', 'list'), env=base_env, cwd=cwd, capture_output=True, text=True,
                                    encoding='utf-8', timeout=120)
            assert listed.returncode == 0, listed.stdout + listed.stderr
            return set(SESSION_RE.findall(listed.stdout))

        newer, broken = '99.0.1', '99.0.2'
        tar_newer, tar_broken = variant(newer), variant(broken, drop_native=True)
        isolated = home / '.codsh-rust'
        result.update(version=version)
        first = turn('TOKEN_BEFORE_UPDATE')
        assert first.returncode == 0 and 'RUST_ACP_ANSWER' in first.stdout, first.stdout + first.stderr
        assert json.loads((isolated / 'codsh-version.json').read_text(encoding='utf-8'))['lastVersion'] == version
        before = session_ids()
        assert before, 'no durable session before the update'
        # Update in place: announced once, sessions kept.
        install(tar_newer)
        updated = turn('TOKEN_AFTER_UPDATE')
        assert updated.returncode == 0 and 'RUST_ACP_ANSWER' in updated.stdout, updated.stdout + updated.stderr
        assert f'Rust client updated {version} → {newer}' in updated.stderr, updated.stderr
        again = turn('TOKEN_QUIET')
        assert 'updated' not in again.stderr, again.stderr
        assert before <= session_ids()
        result['update'] = updated.stderr.strip()
        # Broken installs are refused before the Rust Home or dsh is touched.
        home_before = tree_digest(isolated)
        installed = prefix / 'node_modules/codsh-cli'
        artifact_file = installed / 'native' / key / 'artifact.json'
        exe = installed / 'native' / key / 'codsh-rust.exe'
        original_artifact, original_exe = artifact_file.read_text(encoding='utf-8'), exe.read_bytes()
        stale = json.loads(original_artifact)
        stale['version'] = version
        artifact_file.write_text(json.dumps(stale), encoding='utf-8')
        refusals = [refused(turn('x'), f'Rust client {version} does not match this codsh-cli {newer}: an update did not finish.',
                            f'npm install -g codsh-cli@{newer}')]
        artifact_file.write_text(original_artifact, encoding='utf-8')
        damaged = bytearray(original_exe)
        damaged[len(damaged) // 2] ^= 0xFF
        exe.write_bytes(bytes(damaged))
        refusals.append(refused(turn('x'), 'damaged or incomplete download', f'npm install -g codsh-cli@{newer}'))
        exe.write_bytes(original_exe)
        assert tree_digest(isolated) == home_before, 'a refused launch wrote to the Rust Home'
        # A package without this platform's client, then back to the version before.
        install(tar_broken)
        refusals.append(refused(turn('x'), f'Rust client artifact is not installed for {key}', 'ordinary codsh remains available'))
        install(tarball)
        rolled = turn('TOKEN_AFTER_ROLLBACK')
        assert rolled.returncode == 0 and 'RUST_ACP_ANSWER' in rolled.stdout, rolled.stdout + rolled.stderr
        assert f'last used by codsh {newer}; now running {version} (an earlier version)' in rolled.stderr, rolled.stderr
        assert before <= session_ids()
        stamp = json.loads((isolated / 'codsh-version.json').read_text(encoding='utf-8'))
        assert stamp['lastVersion'] == version and stamp['newestVersion'] == newer, stamp
        result['refusals'] = refusals
        result['rollback'] = rolled.stderr.strip()
        # `codsh --rust update --check` names the installer that owns this install.
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Registry)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            Registry.latest = newer
            planned = subprocess.run(client('update', '--check', '--json'), cwd=cwd, capture_output=True, text=True, encoding='utf-8',
                                     timeout=120, env={**base_env, 'CODSH_UPDATE_REGISTRY': f'http://127.0.0.1:{server.server_address[1]}'})
        finally:
            server.shutdown()
        assert planned.returncode == 0, planned.stdout + planned.stderr
        plan = json.loads(planned.stdout)
        assert plan['action'] == 'install' and plan['installer'] == 'npm' and plan['command'][-1] == f'codsh-cli@{newer}', plan
        result['plan'] = plan
        for name, digest in legacy_before.items():
            assert tree_digest(home / name) == digest, f'legacy {name} changed'
        result['legacyUntouched'] = True
        return result

    def get_clipboard():
        return run(['powershell', '-NoProfile', '-Command',
                    # UTF-8 without a preamble, so a BOM in the result is the clipboard's own.
                    '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; Get-Clipboard -Raw'],
                   timeout=60).stdout

    def keys_history():
        console = Console('keys', cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo'}, output)
        try:
            console.start(client())
            console.wait_visible('Connected to dsh ACP', 90)
            console.write('TOKEN_KEY_ABC')
            console.wait_visible('TOKEN_KEY_ABC', 20)
            console.write('\x7f\x7f\x7f')
            time.sleep(0.5)
            console.write('XYZ 中文')
            console.wait_visible('TOKEN_KEY_XYZ 中文', 20)
            console.write('\r')
            shown = console.wait_visible('latest=TOKEN_KEY_XYZ', 60)
            assert 'TOKEN_KEY_ABC' not in shown.split('latest=')[-1], shown
            console.write('\x1b[A')
            shown = console.wait_visible('history browse', 20)
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert 'TOKEN_KEY_XYZ' in draft, shown
            console.write('\x03')
            time.sleep(0.3)
            result = console.finish()
            assert result['exit'] == 0, result
            return {'backspace': 'ABC -> XYZ', 'history': 'Up recalled TOKEN_KEY_XYZ 中文'}
        finally:
            console.close()

    def clipboard():
        console = Console('clipboard', cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo'}, output)
        try:
            console.start(client())
            console.wait_visible('Connected to dsh ACP', 90)
            console.write('TOKEN_CLIP 中文剪贴\r')
            console.wait_visible('latest=TOKEN_CLIP', 60)
            run(['powershell', '-NoProfile', '-Command', "Set-Clipboard -Value 'stale'"], timeout=60)
            console.write('/copy\r')
            deadline = time.monotonic() + 30
            copied = ''
            while time.monotonic() < deadline:
                copied = get_clipboard()
                if 'TOKEN_CLIP' in copied:
                    break
                time.sleep(0.5)
            assert 'TOKEN_CLIP' in copied, f'/copy did not reach the clipboard: {copied!r}\n{console.visible()}'
            # Get-Clipboard may surface the UTF-16 BOM clip.exe needs; strip it.
            copied = copied.lstrip('\ufeff')
            assert '中文剪贴' in copied, f'CJK was mangled on the way to clip.exe: {copied!r}'
            # An image paste cannot be read here yet: Ctrl+V and an empty
            # bracketed paste must both say so, and attach nothing.
            console.write('\x16')
            shown = console.wait_visible('not available on Windows', 20)
            assert '[Image #' not in shown, shown
            # The draft is empty: another Ctrl+C here would quit the client.
            console.write('\x1b[200~\x1b[201~')
            time.sleep(1.5)
            empty_paste = console.visible()
            result = console.finish()
            assert result['exit'] == 0, result
            return {
                'copied': copied.strip()[:200],
                'ctrl_v': 'clipboard image paste is not available on Windows in this client yet; nothing was attached',
                'empty_paste_attached_nothing': '[Image #' not in empty_paste,
            }
        finally:
            console.close()

    def voice_doctor():
        env = {k: v for k, v in base_env.items() if k not in ('CODSH_VOICE_DEVICES', 'CODSH_VOICE_FIXTURE')}
        done = run(client('voice', 'doctor', '--json'), env=env, cwd=cwd, timeout=120)
        report = json.loads(done.stdout)
        assert report['recording'] is False, report
        assert report['finding'] == 'voice.platform-unverified', report
        assert report['supported'] is False and not report['devices'], report
        return {k: report[k] for k in ('platform', 'finding', 'supported', 'permission', 'nextSteps')}

    for name, fn in (('install-check', install_check), ('headless', headless), ('turn', interactive_turn),
                     ('file-approval', file_approval), ('shell', shell_tool), ('cancel', cancel_tree),
                     ('resume', resume), ('sandbox-refused', sandbox_refused),
                     ('keys-history', keys_history), ('clipboard', clipboard), ('voice-doctor', voice_doctor),
                     ('install-update-rollback', install_update_rollback)):
        step(name, fn)
    report['ok'] = all(item['ok'] for item in report['steps'])
    # dsh's own logs from the isolated Home, for the evidence artifact.
    if dsh_home.exists():
        for log in dsh_home.rglob('*.log'):
            shutil.copy(log, output / f'dsh-{log.name}')
    report['untested'] = [
        'real terminal emulators other than the ConPTY harness (Windows Terminal, conhost window, VS Code) (#201)',
        'clipboard image read (Ctrl+V / empty paste say it is unavailable); desktop notifications',
        'microphone capture (voice doctor reports voice.platform-unverified)',
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
