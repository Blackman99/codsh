#!/usr/bin/env python3
"""Installed-product PTY: permission modes, deny, remember, and restore."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
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


def screen_text(data, rows, cols):
    emulator = ROOT / 'e2e/vt.ts'
    payload = json.dumps({'rows': rows, 'cols': cols, 'bytes': __import__('base64').b64encode(data).decode()})
    return run([NODE, '--import', 'tsx', '-e',
                f"import {{ Terminal }} from {json.dumps(emulator.as_uri())}; "
                "let input=''; for await (const chunk of process.stdin) input+=chunk; "
                "const spec=JSON.parse(input); const t=new Terminal(spec.rows,spec.cols); "
                "t.feed(Buffer.from(spec.bytes,'base64').toString()); console.log(t.text);"],
               input=payload, cwd=ROOT).stdout


def exercise(name, launcher, cwd, env, output, typed, wait_for, extra=(), action='none', cols=100, rows=36):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    original = termios.tcgetattr(slave)
    process = subprocess.Popen([NODE, str(launcher), '--rust', *extra], cwd=cwd, env=env,
                               stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    data = bytearray()

    def pump(seconds=0.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.03)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                data.extend(chunk)

    def visible():
        return screen_text(bytes(data), rows, cols)

    def wait_visible(text, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            pump()
            shown = visible()
            if text in shown:
                return shown
            if process.poll() is not None:
                break
        raise AssertionError(f'{name}: missing {text!r}\n{visible()}\nraw={bytes(data)[-2500:]!r}')

    try:
        wait_visible('codsh')
        wait_visible('Draft (not sent)')
        wait_visible('Connected to dsh ACP', 25)
        os.write(master, typed.encode())
        wait_visible(typed.split('\r', 1)[0])
        if not typed.endswith('\r'):
            os.write(master, b'\r')
        if action in {'allow', 'remember', 'reject'}:
            key = {'allow': b'y', 'remember': b'a', 'reject': b'n'}[action]
            answered = 0
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and answered < (2 if action == 'remember' else 1):
                pump(0.05)
                shown = visible()
                if 'Allow ' in shown and 'y=allow once' in shown:
                    os.write(master, key)
                    answered += 1
                    cleared = time.monotonic() + 8
                    while time.monotonic() < cleared:
                        pump(0.05)
                        if 'Allow ' not in visible():
                            break
                    continue
                if action == 'remember' and answered and 'successfully.' in shown:
                    break
            if answered == 0:
                raise AssertionError(f'{name}: missing permission card\n{visible()}')
        for marker in wait_for:
            wait_visible(marker, 30)
        shown = visible()
        os.write(master, b'\x11')
        process.wait(timeout=12)
        pump()
        os.write(master, b'AFTER_EXIT_CANONICAL\n')
        assert select.select([slave], [], [], 2)[0]
        assert os.read(slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
        after = termios.tcgetattr(slave)
        (output / f'{name}.ansi').write_bytes(data)
        (output / f'{name}.txt').write_text(shown)
        assert original == after, f'{name}: terminal modes were not restored'
        assert b'\x1b[?1049l' in data
        return {'name': name, 'exit': process.returncode, 'screen': shown}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def spawn_inspect(launcher, cwd, env, extra):
    return subprocess.run([NODE, str(launcher), '--rust', *extra], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=20)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-permission-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-permission-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        (cwd / 'note.txt').write_text('alpha\n')
        pack_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'],
            'npm_config_cache': str(work / 'npm-cache'),
            'npm_config_userconfig': str(work / 'empty-user.npmrc'),
            'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
            'npm_config_update_notifier': 'false',
        }
        pack = json.loads(run(['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
                             cwd=ROOT / 'packages/cli', env=pack_env).stdout)[0]['filename']
        prefix = work / 'installed'
        run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
        launcher = prefix / 'node_modules/.bin/codsh'
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        base_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'XAI_API_KEY': 'test-key-not-a-secret-for-logs',
        }
        rust_root = home / '.codsh-rust'
        grok_home = rust_root / '.grok'
        grok_home.mkdir(parents=True)
        (grok_home / 'config.toml').write_text("""
[models]
default = "user-model"

[model.user-model]
name = "User model"
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"

[permission]
deny = ["Bash(rm -rf *)", "Read(secret/**)"]
allow = ["Bash(git *)"]
""")
        results = {}

        denied = exercise('deny-always-approve', launcher, cwd,
                          {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-rm'},
                          output, typed='TOKEN_PERM_DENY', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                          extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert denied['exit'] == 0
        assert 'Allow ' not in denied['screen'] or 'Denied by permission policy' in denied['screen']
        assert 'successfully.' not in denied['screen']
        results['deny'] = {'exit': denied['exit']}

        slash_modes = exercise('slash-shared-modes', launcher, cwd,
                               {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo'},
                               output, typed='/dontAsk',
                               wait_for=['Permission mode dontAsk'],
                               action='none')
        slash_modes = exercise('slash-shared-accept', launcher, cwd,
                               {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo'},
                               output, typed='/acceptEdits',
                               wait_for=['Permission mode acceptEdits'],
                               action='none')
        assert slash_modes['exit'] == 0
        mode_files = sorted(
            (home / '.codsh-rust' / 'dsh' / 'session-owners').glob('*.mode'),
            key=lambda path: path.stat().st_mtime,
        )
        assert mode_files, slash_modes['screen']
        assert mode_files[-1].read_text().strip() == 'acceptEdits', [
            (path.name, path.read_text().strip()) for path in mode_files
        ]
        results['slash_modes'] = {'exit': slash_modes['exit'], 'session': mode_files[-1].stem}

        advertised_home = work / 'advertised-home'
        advertised_home.mkdir()
        advertised_grok = advertised_home / '.codsh-rust' / '.grok'
        advertised_grok.mkdir(parents=True)
        (advertised_grok / 'config.toml').write_text("""
[model.cli-mock]
name = "CLI Mock"
provider = "cli-mock"
model = "cli-mock"
base_url = "http://127.0.0.1:9"
env_key = "DEEPSEEK_API_KEY"
api_backend = "openai"

[models]
default = "cli-mock"
""")
        (advertised_grok / 'model-selection.toml').write_text(
            'default = "cli-mock-fork"\neffort = "high"\nacp = "[\\"cli-mock\\",\\"cli-mock-fork\\"]"\n'
        )
        advertised_env = {
            **base_env,
            'HOME': str(advertised_home),
            'DEEPSEEK_API_KEY': 'test-not-a-secret',
            'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }
        seeded = exercise(
            'seed-advertised-session', launcher, cwd, advertised_env, output,
            typed='/dontAsk',
            wait_for=['Permission mode dontAsk'],
            action='none',
        )
        assert seeded['exit'] == 0
        resumed_model = exercise(
            'resume-advertised-model', launcher, cwd, advertised_env, output,
            typed='TOKEN_ADVERTISED_RESUME',
            wait_for=['model=cli-mock-fork', 'effort=high', 'TOKEN_ADVERTISED_RESUME'],
            extra=['--continue'],
        )
        assert resumed_model['exit'] == 0
        policy = advertised_home / '.codsh-rust' / 'dsh' / 'permission-policy.json'
        compact = policy.read_text().replace(' ', '')
        assert '"mode":"dontAsk"' in compact, compact
        results['advertised_resume'] = {'exit': resumed_model['exit']}

        wrapped = exercise('deny-timeout-wrapper', launcher, cwd,
                           {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-timeout-rm'},
                           output, typed='TOKEN_PERM_TIMEOUT', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                           extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert wrapped['exit'] == 0
        assert 'successfully.' not in wrapped['screen']
        results['deny_timeout'] = {'exit': wrapped['exit']}

        nice = exercise('deny-nice-wrapper', launcher, cwd,
                        {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-nice-rm'},
                        output, typed='TOKEN_PERM_NICE', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                        extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert nice['exit'] == 0
        assert 'successfully.' not in nice['screen']
        results['deny_nice'] = {'exit': nice['exit']}

        brace = exercise('deny-brace-group', launcher, cwd,
                         {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-brace-rm'},
                         output, typed='TOKEN_PERM_BRACE', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                         extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert brace['exit'] == 0
        assert 'successfully.' not in brace['screen']
        results['deny_brace'] = {'exit': brace['exit']}

        ansi = exercise('deny-ansi-c', launcher, cwd,
                        {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-ansi-c-rm'},
                        output, typed='TOKEN_PERM_ANSI', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                        extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert ansi['exit'] == 0
        assert 'successfully.' not in ansi['screen']
        results['deny_ansi_c'] = {'exit': ansi['exit']}

        quoted = exercise('deny-quoted-rm', launcher, cwd,
                          {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-quoted-rm'},
                          output, typed='TOKEN_PERM_QUOTED', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                          extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert quoted['exit'] == 0
        assert 'successfully.' not in quoted['screen']
        results['deny_quoted'] = {'exit': quoted['exit']}

        evaluated = exercise('deny-eval-rm', launcher, cwd,
                             {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-eval-rm'},
                             output, typed='TOKEN_PERM_EVAL', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                             extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert evaluated['exit'] == 0
        assert 'successfully.' not in evaluated['screen']
        results['deny_eval'] = {'exit': evaluated['exit']}

        path_rm = exercise('deny-path-rm', launcher, cwd,
                           {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-path-rm'},
                           output, typed='TOKEN_PERM_PATH', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                           extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert path_rm['exit'] == 0
        assert 'successfully.' not in path_rm['screen']
        results['deny_path_rm'] = {'exit': path_rm['exit']}

        sudo = exercise('deny-sudo-wrapper', launcher, cwd,
                        {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-sudo-rm'},
                        output, typed='TOKEN_PERM_SUDO', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                        extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert sudo['exit'] == 0
        assert 'successfully.' not in sudo['screen']
        results['deny_sudo'] = {'exit': sudo['exit']}

        nohup = exercise('deny-nohup-wrapper', launcher, cwd,
                         {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-nohup-rm'},
                         output, typed='TOKEN_PERM_NOHUP', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                         extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert nohup['exit'] == 0
        assert 'successfully.' not in nohup['screen']
        results['deny_nohup'] = {'exit': nohup['exit']}

        xargs = exercise('deny-xargs-wrapper', launcher, cwd,
                         {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-xargs-rm'},
                         output, typed='TOKEN_PERM_XARGS', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                         extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert xargs['exit'] == 0
        assert 'successfully.' not in xargs['screen']
        results['deny_xargs'] = {'exit': xargs['exit']}

        time_rm = exercise('deny-time-prefix', launcher, cwd,
                           {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-time-rm'},
                           output, typed='TOKEN_PERM_TIME', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                           extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert time_rm['exit'] == 0
        assert 'successfully.' not in time_rm['screen']
        results['deny_time'] = {'exit': time_rm['exit']}

        exec_rm = exercise('deny-exec-prefix', launcher, cwd,
                           {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-exec-rm'},
                           output, typed='TOKEN_PERM_EXEC', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                           extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert exec_rm['exit'] == 0
        assert 'successfully.' not in exec_rm['screen']
        results['deny_exec'] = {'exit': exec_rm['exit']}

        builtin_rm = exercise('deny-builtin-prefix', launcher, cwd,
                              {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-builtin-rm'},
                              output, typed='TOKEN_PERM_BUILTIN', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                              extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert builtin_rm['exit'] == 0
        assert 'successfully.' not in builtin_rm['screen']
        results['deny_builtin'] = {'exit': builtin_rm['exit']}

        expand = exercise('deny-parameter-expansion', launcher, cwd,
                          {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-expand-rm'},
                          output, typed='TOKEN_PERM_EXPAND', wait_for=['the user rejected', 'RUST_ACP_BASH_DENIED'],
                          extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='reject')
        assert expand['exit'] == 0
        assert 'successfully.' not in expand['screen']
        assert 'Allow bash' not in expand['screen']
        results['deny_expand'] = {'exit': expand['exit']}

        positional = exercise('deny-positional-expansion', launcher, cwd,
                              {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-positional-rm'},
                              output, typed='TOKEN_PERM_POSITIONAL', wait_for=['the user rejected', 'RUST_ACP_BASH_DENIED'],
                              extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='reject')
        assert positional['exit'] == 0
        assert 'successfully.' not in positional['screen']
        assert 'Allow bash' not in positional['screen']
        results['deny_positional'] = {'exit': positional['exit']}

        shell_option = exercise('deny-shell-option-script', launcher, cwd,
                                {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-shell-option-rm'},
                                output, typed='TOKEN_PERM_SHELLOPT', wait_for=['Denied by permission policy', 'RUST_ACP_BASH_DENIED'],
                                extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='none')
        assert shell_option['exit'] == 0
        assert 'successfully.' not in shell_option['screen']
        results['deny_shell_option'] = {'exit': shell_option['exit']}

        sort_prefix = exercise('sort-prefix-not-readonly', launcher, cwd,
                               {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-sort-prefix'},
                               output, typed='TOKEN_PERM_SORT', wait_for=['dontAsk blocked', 'RUST_ACP_BASH_DENIED'],
                               extra=['--permission-mode', 'dontAsk'], action='none')
        assert sort_prefix['exit'] == 0
        assert 'read-only shell command' not in sort_prefix['screen']
        results['sort_prefix'] = {'exit': sort_prefix['exit']}

        sort_output = exercise('sort-output-not-readonly', launcher, cwd,
                               {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-sort-output'},
                               output, typed='TOKEN_PERM_SORTO', wait_for=['dontAsk blocked', 'RUST_ACP_BASH_DENIED'],
                               extra=['--permission-mode', 'dontAsk'], action='none')
        assert sort_output['exit'] == 0
        assert 'read-only shell command' not in sort_output['screen']
        results['sort_output'] = {'exit': sort_output['exit']}

        quiet_config = grok_home / 'config.toml'
        quiet_saved = quiet_config.read_text()
        quiet_config.write_text(quiet_saved.replace('allow = ["Bash(git *)"]\n', ''))
        git_branch = exercise('git-branch-create-not-readonly', launcher, cwd,
                              {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-git-branch'},
                              output, typed='TOKEN_PERM_BRANCH', wait_for=['dontAsk blocked', 'RUST_ACP_BASH_DENIED'],
                              extra=['--permission-mode', 'dontAsk'], action='none')
        assert git_branch['exit'] == 0
        assert 'read-only shell command' not in git_branch['screen']
        results['git_branch_create'] = {'exit': git_branch['exit']}

        git_upstream = exercise('git-branch-attached-upstream-not-readonly', launcher, cwd,
                                {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-git-upstream'},
                                output, typed='TOKEN_PERM_UPSTREAM', wait_for=['dontAsk blocked', 'RUST_ACP_BASH_DENIED'],
                                extra=['--permission-mode', 'dontAsk'], action='none')
        assert git_upstream['exit'] == 0
        assert 'read-only shell command' not in git_upstream['screen']
        results['git_branch_attached_upstream'] = {'exit': git_upstream['exit']}

        glob_rm = exercise('deny-pathname-glob', launcher, cwd,
                           {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-glob-rm'},
                           output, typed='TOKEN_PERM_GLOB', wait_for=['the user rejected', 'RUST_ACP_BASH_DENIED'],
                           extra=['--always-approve', '--deny', 'Bash(rm -rf *)'], action='reject')
        assert glob_rm['exit'] == 0
        assert 'successfully.' not in glob_rm['screen']
        assert 'Allow bash' not in glob_rm['screen']
        results['deny_pathname_glob'] = {'exit': glob_rm['exit']}

        git_track = exercise('git-branch-bare-upstream-not-readonly', launcher, cwd,
                             {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-git-track'},
                             output, typed='TOKEN_PERM_TRACK', wait_for=['dontAsk blocked', 'RUST_ACP_BASH_DENIED'],
                             extra=['--permission-mode', 'dontAsk'], action='none')
        assert git_track['exit'] == 0
        assert 'read-only shell command' not in git_track['screen']
        results['git_branch_bare_upstream'] = {'exit': git_track['exit']}

        git_long_track = exercise('git-branch-long-track-not-readonly', launcher, cwd,
                                  {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-git-long-track'},
                                  output, typed='TOKEN_PERM_LONGTRACK', wait_for=['dontAsk blocked', 'RUST_ACP_BASH_DENIED'],
                                  extra=['--permission-mode', 'dontAsk'], action='none')
        assert git_long_track['exit'] == 0
        assert 'read-only shell command' not in git_long_track['screen']
        results['git_branch_long_track'] = {'exit': git_long_track['exit']}
        quiet_config.write_text(quiet_saved)

        git_cat = exercise('git-cat-file-readonly', launcher, cwd,
                           {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'bash-git-cat'},
                           output, typed='TOKEN_PERM_GITCAT', wait_for=['RUST_ACP_BASH_DONE'],
                           extra=['--permission-mode', 'dontAsk'], action='none')
        assert git_cat['exit'] == 0
        assert 'Denied by permission policy' not in git_cat['screen']
        results['git_cat_file'] = {'exit': git_cat['exit']}

        inspect = spawn_inspect(launcher, cwd, base_env, ['inspect', '--json'])
        assert inspect.returncode == 0, inspect.stderr + inspect.stdout
        payload = json.loads(inspect.stdout)
        settings = {row['key']: row for row in payload['settings']}
        assert settings['ui.permission_mode']['value'] in {'ask', 'always-approve', 'auto', 'dontAsk', 'acceptEdits'}
        assert int(settings['permission.rules']['value']) >= 2
        results['inspect'] = {
            'mode': settings['ui.permission_mode']['value'],
            'rules': settings['permission.rules']['value'],
        }

        (grok_home / 'requirements.toml').write_text('[ui]\ndisable_bypass_permissions_mode = true\n')
        locked = spawn_inspect(launcher, cwd, base_env, ['--always-approve', 'inspect'])
        combined = locked.stdout + locked.stderr
        assert locked.returncode != 0
        assert 'disable_bypass_permissions_mode' in combined
        results['locked'] = {'exit': locked.returncode}

        (grok_home / 'requirements.toml').unlink()
        once_only = exercise('allow-once', launcher, cwd,
                             {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'},
                             output, typed='TOKEN_PERM_ONCE',
                             wait_for=['not saved as a permanent rule', 'successfully.'],
                             action='allow')
        assert once_only['exit'] == 0
        assert (cwd / 'note.txt').read_text() == 'ALPHA\n'
        assert 'not saved as a permanent rule' in once_only['screen']
        assert not list((grok_home / 'sessions').rglob('permission.toml'))
        results['once'] = {'exit': once_only['exit'], 'durable': False}

        (cwd / 'note.txt').write_text('alpha\n')
        remembered = exercise('remember-always', launcher, cwd,
                              {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'},
                              output, typed='TOKEN_PERM_REMEMBER',
                              wait_for=['Remembered for this project only', 'successfully.'],
                              action='remember')
        assert remembered['exit'] == 0
        assert (cwd / 'note.txt').read_text() == 'ALPHA\n'
        assert 'Remembered for this project only' in remembered['screen']
        grants = list((grok_home / 'sessions').rglob('permission.toml'))
        assert grants, remembered['screen']
        grant_text = grants[0].read_text()
        assert 'note.txt' in grant_text
        assert 'allow_edits_for_session = true' not in grant_text
        results['remember'] = {'exit': remembered['exit'], 'grants': str(grants[0])}

        (cwd / 'note.txt').write_text('alpha\n')
        restored = exercise('remember-restored', launcher, cwd,
                            {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'},
                            output, typed='TOKEN_PERM_RESTORED', wait_for=['successfully.', 'RUST_ACP_FILE_DONE'], action='none')
        assert restored['exit'] == 0
        assert (cwd / 'note.txt').read_text() == 'ALPHA\n'
        results['restored'] = {'exit': restored['exit']}

        (cwd / 'note.txt').write_text('alpha\n')
        revoked_cmd = exercise('revoke-command', launcher, cwd,
                               {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'},
                               output, typed='/revoke-approvals',
                               wait_for=['Revoked remembered grants for this project'],
                               action='none')
        assert revoked_cmd['exit'] == 0
        remaining = list((grok_home / 'sessions').rglob('permission.toml'))
        assert not remaining or 'note.txt' not in remaining[0].read_text()
        results['revoked_cmd'] = {'exit': revoked_cmd['exit']}

        (cwd / 'note.txt').write_text('alpha\n')
        revoked = exercise('remember-revoked', launcher, cwd,
                           {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'},
                           output, typed='TOKEN_PERM_REVOKED',
                           wait_for=['the user rejected tool', 'RUST_ACP_FILE_ERROR'],
                           action='reject')
        assert revoked['exit'] == 0
        assert (cwd / 'note.txt').read_text() == 'alpha\n'
        results['revoked'] = {'exit': revoked['exit']}

        (cwd / 'note.txt').write_text('alpha\n')
        readonly_home = work / 'readonly-home'
        readonly_home.mkdir()
        readonly_env = {**base_env, 'HOME': str(readonly_home), 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit', 'CODSH_PERMISSION_REMEMBER': '1'}
        readonly_grok = readonly_home / '.codsh-rust' / '.grok'
        readonly_grok.mkdir(parents=True)
        (readonly_grok / 'config.toml').write_text((grok_home / 'config.toml').read_text())
        os.chmod(readonly_grok, 0o555)
        try:
            failed_save = exercise('remember-readonly', launcher, cwd, readonly_env, output,
                                   typed='TOKEN_PERM_READONLY',
                                   wait_for=['successfully.', "Couldn't save a permanent rule"],
                                   action='remember')
            assert failed_save['exit'] == 0
            assert (cwd / 'note.txt').read_text() == 'ALPHA\n'
            sessions = readonly_grok / 'sessions'
            assert not sessions.exists() or not list(sessions.rglob('permission.toml'))
            results['readonly'] = {'exit': failed_save['exit'], 'durable': False}
        finally:
            os.chmod(readonly_grok, 0o755)

        (output / 'result.json').write_text(json.dumps({
            'results': results,
            'dshBin': dsh,
        }, indent=2) + '\n')
        print(f'PASS: rust dsh permission PTY; evidence: {output}')


if __name__ == '__main__':
    main()
