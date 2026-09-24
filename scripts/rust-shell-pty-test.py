#!/usr/bin/env python3
"""Installed-product PTY: a real dsh bash command, its output, and a stop.

The mock model only chooses the tool call. dsh's bash tool runs the command.
A denied command must not run. A long command must stop when the session is
cancelled, including a grandchild. Interactive resize is not a dsh tool.
"""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


def dsh_bin():
    script = "import { createRequire } from 'node:module'; import { dirname, join } from 'node:path'; import { readFileSync } from 'node:fs'; const r=createRequire(process.argv[1]); const m=r.resolve('@deepseek-ai/dsh/package.json'); const bin=JSON.parse(readFileSync(m,'utf8')).bin; process.stdout.write(join(dirname(m), typeof bin==='string'?bin:bin.dsh))"
    return run([NODE, '--input-type=module', '-e', script, str(ROOT / 'package.json')], cwd=ROOT).stdout


def overlay_text():
    return run([NODE, '--input-type=module', '-e',
                "import { rustAcpOverlay } from './scripts/rust-acp-overlay.mjs'; process.stdout.write(rustAcpOverlay())"],
               cwd=ROOT).stdout


def pack(work):
    home = work / 'pack-home'
    home.mkdir()
    pack_env = {
        'HOME': str(home), 'PATH': os.environ['PATH'],
        'npm_config_cache': str(work / 'npm-cache'),
        'npm_config_userconfig': str(work / 'empty-user.npmrc'),
        'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
        'npm_config_update_notifier': 'false',
    }
    import json
    packed = json.loads(run(
        ['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
        cwd=ROOT / 'packages/cli', env=pack_env,
    ).stdout)[0]['filename']
    prefix = work / 'installed'
    run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', str(work / packed)], env=pack_env)
    return prefix / 'node_modules/.bin/codsh'


def session(name, launcher, cwd, env, output):
    from importlib.machinery import SourceFileLoader
    screen = SourceFileLoader('rust_screen_pty_test', str(ROOT / 'scripts/rust-screen-pty-test.py')).load_module()
    opened = screen.Session(name, launcher, cwd, env, output)
    opened.wait_visible('codsh')
    opened.wait_visible('Draft (not sent)')
    opened.wait_visible('Connected to dsh ACP', 25)
    return opened


def allow(opened):
    opened.wait_visible('Allow ', 30)
    opened.wait_visible('y=allow once', 10)
    opened.write(b'y')


def finish(opened):
    opened.write(b'\x11')
    opened.process.wait(timeout=12)
    opened.pump()
    opened.write(b'AFTER_EXIT_CANONICAL\n')
    import select
    assert select.select([opened.slave], [], [], 2)[0]
    assert os.read(opened.slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
    import termios
    after = termios.tcgetattr(opened.slave)
    (opened.output / f'{opened.name}.txt').write_text(opened.visible())
    assert opened.original == after, f'{opened.name}: terminal modes were not restored'
    assert b'\x1b[?1049l' in opened.data
    return opened.process.returncode


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required; Linux and Windows are unverified')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-shell-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-shell-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        nested = cwd / 'nested'
        nested.mkdir()
        launcher = pack(work)
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        base_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'CODSH_SHELL_MARKER': 'SHELL38',
            'CODSH_SHELL_WORKDIR': str(nested),
            'CODSH_TICKET38_SECRET': 'not-for-the-child',
        }
        policy = home / '.grok'
        policy.mkdir()
        (policy / 'sandbox.toml').write_text(
            '[shell_environment_policy]\ninherit = "all"\nexclude = ["CODSH_TICKET38_SECRET"]\n'
        )
        echo = session('echo', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'shell-echo'}, output)
        echo.write('TOKEN_SHELL_ECHO')
        echo.write(b'\r')
        allow(echo)
        echo.wait_visible('STDOUT_SHELL38', 30)
        echo.wait_visible('STDERR_SHELL38', 10)
        echo.wait_visible(str(nested), 10)
        echo.wait_visible('[exit code: 0]', 10)
        shown = echo.visible()
        assert 'not-for-the-child' not in shown
        assert 'RUST_ACP_SHELL_DONE' in shown
        code = finish(echo)
        assert code == 0

        fail = session('fail', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'shell-fail'}, output)
        fail.write('TOKEN_SHELL_FAIL')
        fail.write(b'\r')
        allow(fail)
        fail.wait_visible('STDOUT_SHELL38', 30)
        fail.wait_visible('STDERR_SHELL38', 10)
        fail.wait_visible('[exit code: 7]', 10)
        fail_screen = fail.visible()
        assert 'successfully' not in fail_screen.lower()
        assert finish(fail) == 0

        long_env = {key: value for key, value in base_env.items() if key != 'CODSH_SHELL_WORKDIR'}
        long_env['DSH_CODE_CLI_MOCK_TOOL'] = 'shell-long'
        started = cwd / 'shell-started.txt'
        long = session('long', launcher, cwd, long_env, output)
        long.write('TOKEN_SHELL_LONG')
        long.write(b'\r')
        allow(long)
        long.wait_visible('in_progress', 30)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline and not started.exists():
            time.sleep(0.1)
        assert started.exists(), f'the long command never started; files={list(cwd.iterdir())}'
        long.write(b'\x03')
        long.wait_visible('[exit failed]', 15)
        long.wait_visible('[cancelled]', 10)
        stopped = long.visible()
        assert 'tool call aborted' in stopped
        assert 'FINISHED_SHELL38' not in stopped
        assert 'successfully' not in stopped.lower()
        assert not (cwd / 'shell-finished.txt').exists()
        assert finish(long) == 0
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            leftover = subprocess.run(['pgrep', '-f', 'sleep 30'], capture_output=True, text=True)
            if leftover.returncode != 0:
                break
            time.sleep(0.1)
        else:
            raise AssertionError(f'shell grandchild still running:\n{leftover.stdout}')

        denied = session('deny', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'shell-deny', 'CODSH_HOOK_DENY': 'ticket 38 deny'}, output)
        denied.write('TOKEN_SHELL_DENY')
        denied.write(b'\r')
        filtered = session('env', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'shell-env', 'GROK_SANDBOX': 'workspace'}, output)
        filtered.write('TOKEN_SHELL_ENV')
        filtered.write(b'\r')
        allow(filtered)
        filtered.wait_visible('ENV_SHELL38_hidden', 30)
        filtered_screen = filtered.visible()
        assert 'not-for-the-child' not in filtered_screen
        assert finish(filtered) == 0

        denied.wait_visible('Denied by hook', 20)
        denied_screen = denied.visible()
        assert 'DENIED_RAN_SHELL38' not in denied_screen
        assert not (cwd / 'denied-ran.txt').exists()
        assert finish(denied) == 0
    print(f'PASS: rust dsh shell PTY; evidence: {output}')


if __name__ == '__main__':
    main()
