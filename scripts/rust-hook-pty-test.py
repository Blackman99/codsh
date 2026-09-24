#!/usr/bin/env python3
"""Installed-product PTY: a temp-project hook blocks a real bash tool."""
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


def exercise(name, launcher, cwd, env, output, typed, wait_for, cols=100, rows=36, extra=('--trust',), trust_key=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
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

    def wait_visible(text, seconds=40):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            pump()
            shown = visible()
            if text in shown:
                return shown
            if process.poll() is not None:
                break
        raise AssertionError(f'{name}: missing {text!r}\n{visible()}\nraw={bytes(data)[-3000:]!r}')

    try:
        wait_visible('codsh')
        if trust_key:
            wait_visible('Trust this workspace?', 20)
            os.write(master, trust_key)
        wait_visible('Connected to dsh ACP', 30)
        os.write(master, typed.encode())
        if not typed.endswith('\r'):
            os.write(master, b'\r')
        shown = ''
        for marker in wait_for:
            shown = wait_visible(marker, 40)
        os.write(master, b'\x11')
        process.wait(timeout=12)
        (output / f'{name}.txt').write_text(shown)
        return {'name': name, 'exit': process.returncode, 'screen': shown}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-hooks-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-hooks-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        (cwd / '.git').mkdir()
        hooks = cwd / '.grok' / 'hooks'
        hooks.mkdir(parents=True)
        guard = hooks / 'guard.sh'
        prompt = hooks / 'prompt.sh'
        log = cwd / 'hook-ran.log'
        side = cwd / 'hook-side-effect.txt'
        prompt.write_text(
            '#!/bin/sh\n'
            'input=$(cat)\n'
            f'printf "PROMPT %s\\n" "$input" >> {log}\n'
            'printf "HOOK_PROMPT_STDERR seen\\n" >&2\n'
            'printf \'{"decision":"allow"}\\n\'\n'
            'exit 0\n'
        )
        prompt.chmod(0o755)
        guard.write_text(
            '#!/bin/sh\n'
            'input=$(cat)\n'
            f'printf "TOOL %s\\n" "$input" >> {log}\n'
            'printf "HOOK_STDERR deny\\n" >&2\n'
            'printf \'{"decision":"deny","reason":"HOOK_BLOCKED destructive command"}\\n\'\n'
            'exit 2\n'
        )
        guard.chmod(0o755)
        (hooks / 'guard.json').write_text(json.dumps({
            'hooks': {
                'SessionStart': [{'hooks': [{'type': 'command', 'command': f'{prompt}'}]}],
                'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': f'{prompt}'}]}],
                'PreToolUse': [{'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': f'{guard}', 'timeout': 5}]}],
            },
        }))
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
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'hook-bash',
            'XAI_API_KEY': 'test-key-not-a-secret-for-logs',
        }
        blocked = exercise('hook-blocks-tool', launcher, cwd, env, output,
                           typed='TOKEN_HOOK_BLOCK', wait_for=['HOOK_BLOCKED', 'RUST_ACP_HOOK_DENI'],
                           extra=('--trust', '--always-approve'))
        assert blocked['exit'] == 0, blocked
        assert 'RUST_ACP_HOOK_DONE' not in blocked['screen']
        assert 'HOOK_SIDE_EFFECT' not in blocked['screen']
        assert 'printf HOOK_SIDE_EFFECT' not in blocked['screen'] or 'failed' in blocked['screen']
        assert not side.exists(), 'a denied tool must not write its side effect'
        assert log.exists(), 'the hooks did not run'
        record = log.read_text()
        assert 'PROMPT' in record and 'TOOL' in record, record[:800]
        assert 'pre_tool_use' in record or 'PreToolUse' in record
        assert 'user_prompt_submit' in record or 'UserPromptSubmit' in record
        # Hook stderr is labeled hook output, not copied as the model answer.
        assert 'HOOK_STDERR deny' not in blocked['screen'].split('RUST_ACP_HOOK_DENIED')[-1]
        (output / 'hook-ran.log').write_text(record)

        # A failing hook is recorded and does not look like a deny or a success.
        # The deny script is removed first so a stale registration cannot block.
        guard.unlink()
        fail = hooks / 'fail.sh'
        fail.write_text(f'#!/bin/sh\nprintf FAIL_RAN >> {log}\necho fail-open\nexit 7\n')
        fail.chmod(0o755)
        (hooks / 'guard.json').write_text(json.dumps({
            'hooks': {
                'PreToolUse': [{'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': str(fail), 'timeout': 5}]}],
            },
        }))
        failed = exercise('hook-exit-nonzero', launcher, cwd, env, output,
                          typed='TOKEN_HOOK_FAIL', wait_for=['RUST_ACP_HOOK_DON', 'HOOK_SIDE_EFF'],
                          extra=('--trust', '--always-approve'))
        assert failed['exit'] == 0, failed
        assert 'Denied by hook' not in failed['screen']
        assert 'failed, ignored' in failed['screen'] or 'exit code 7' in failed['screen']
        assert 'FAIL_RAN' in log.read_text()

        # An untrusted project hook does not run, even with the same file present.
        other = work / 'untrusted-workspace'
        other.mkdir()
        (other / '.git').mkdir()
        other_hooks = other / '.grok' / 'hooks'
        other_hooks.mkdir(parents=True)
        other_log = other / 'untrusted-ran.log'
        other_hook = other_hooks / 'ran.sh'
        other_hook.write_text(f'#!/bin/sh\nprintf UNTRUSTED_RAN >> {other_log}\nexit 2\n')
        other_hook.chmod(0o755)
        (other_hooks / 'ran.json').write_text(json.dumps({
            'hooks': {'PreToolUse': [{'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': str(other_hook)}]}]},
        }))
        untrusted = exercise('hook-untrusted-skipped', launcher, other, env, output,
                             typed='TOKEN_HOOK_UNTRUSTED', wait_for=['RUST_ACP_HOOK_DON', 'HOOK_SIDE_EFF'],
                             extra=('--always-approve',), trust_key=b'n')
        assert 'Denied by hook' not in untrusted['screen']
        assert 'UNTRUSTED_RAN' not in untrusted['screen']
        assert not other_log.exists(), 'an untrusted project hook must not run'
        prompt_dir = work / 'prompt-block'
        prompt_dir.mkdir()
        (prompt_dir / '.git').mkdir()
        prompt_hooks = prompt_dir / '.grok' / 'hooks'
        prompt_hooks.mkdir(parents=True)
        prompt_script = prompt_hooks / 'block.sh'
        prompt_script.write_text(
            '#!/bin/sh\n'
            'cat >/dev/null\n'
            'printf \'{"decision":"deny","reason":"PROMPT_BLOCKED by hook"}\\n\'\n'
            'exit 2\n'
        )
        prompt_script.chmod(0o755)
        (prompt_hooks / 'block.json').write_text(json.dumps({
            'hooks': {'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': str(prompt_script), 'timeout': 5}]}]},
        }))
        prompt_blocked = exercise(
            'hook-blocks-prompt', launcher, prompt_dir,
            {**env, 'DSH_CODE_CLI_MOCK_TOOL': 'hook-prompt-block'}, output,
            typed='TOKEN_PROMPT_BLOCK', wait_for=['PROMPT_BLOCKED'],
            extra=('--trust', '--always-approve'),
        )
        assert 'RUST_ACP_HOOK_PROMPT_RAN' not in prompt_blocked['screen']
        assert prompt_blocked['exit'] == 0
        print(json.dumps({
            'output': str(output),
            'blocked': True,
            'events': ['session_start' in record or 'SessionStart' in record,
                       'user_prompt_submit' in record or 'UserPromptSubmit' in record,
                       'pre_tool_use' in record or 'PreToolUse' in record],
            'hookLog': record[:800],
        }, indent=2))


if __name__ == '__main__':
    main()
