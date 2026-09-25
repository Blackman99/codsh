#!/usr/bin/env python3
"""Real-terminal plugin contributions (ticket 166).

A temp plugin with a rule, a skill, a command, an agent, and a PreToolUse
hook is installed with --trust but left disabled. Inside one interactive
session, /plugins Space enables it: the next prompt sees the skill and the
live dsh child is replaced so the plugin hook blocks a real bash call.
Space again disables it and the hook is gone on the next prompt. Uses the
repo launcher and the native binary from `pnpm run build:rust`; runs on
Linux and macOS. All homes are temp dirs.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
LAUNCHER = ROOT / 'packages/cli/bin/codsh.mjs'


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


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


def screen_text(data, rows, cols):
    emulator = ROOT / 'e2e/vt.ts'
    payload = json.dumps({'rows': rows, 'cols': cols, 'bytes': base64.b64encode(data).decode()})
    return run([NODE, '--import', 'tsx', '-e',
                f"import {{ Terminal }} from {json.dumps(emulator.as_uri())}; "
                "let input=''; for await (const chunk of process.stdin) input+=chunk; "
                "const spec=JSON.parse(input); const t=new Terminal(spec.rows,spec.cols); "
                "t.feed(Buffer.from(spec.bytes,'base64').toString()); console.log(t.text);"],
               input=payload, cwd=ROOT).stdout


def write_plugin(root):
    for sub in ('rules', 'skills/greet', 'commands', 'agents', 'hooks', 'scripts'):
        (root / sub).mkdir(parents=True, exist_ok=True)
    (root / 'plugin.json').write_text(json.dumps({'name': 'demo', 'version': '1.0.0', 'license': 'MIT'}))
    (root / 'rules/style.md').write_text('Mention PLUGIN_RULE_BODY.\n')
    (root / 'skills/greet/SKILL.md').write_text('---\ndescription: greet\n---\nPLUGIN_SKILL_BODY greet\n')
    (root / 'commands/deploy.md').write_text('---\ndescription: deploy\n---\nPLUGIN_COMMAND_BODY deploy\n')
    (root / 'agents/reviewer.md').write_text('---\ndescription: reviews\n---\nPLUGIN_AGENT_BODY\n')
    guard = root / 'scripts/guard.sh'
    guard.write_text('#!/bin/sh\ncat >/dev/null\nprintf "GUARD %s\\n" "$GROK_PLUGIN_ROOT" >> "$PWD/plugin-hook.log"\n'
                     'printf \'{"decision":"deny","reason":"PLUGIN_HOOK_BLOCKED by demo"}\\n\'\nexit 2\n')
    guard.chmod(0o755)
    (root / 'hooks/hooks.json').write_text(json.dumps({'hooks': {'PreToolUse': [
        {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': '${GROK_PLUGIN_ROOT}/scripts/guard.sh', 'timeout': 5}]},
    ]}}))


class Session:
    def __init__(self, name, cwd, env, output, rows=40, cols=200):
        self.name, self.output, self.rows, self.cols = name, output, rows, cols
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.process = subprocess.Popen([NODE, str(LAUNCHER), '--rust', '--trust', '--always-approve'],
                                        cwd=cwd, env=env, stdin=self.slave, stdout=self.slave,
                                        stderr=self.slave, start_new_session=True)
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

    def screen(self):
        return screen_text(bytes(self.data), self.rows, self.cols)

    def wait(self, text, seconds=60, count=1):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump(0.3)
            shown = self.screen()
            if shown.count(text) >= count:
                return shown
            if self.process.poll() is not None:
                break
        raise AssertionError(f'{self.name}: missing {text!r} x{count}\n{self.screen()}\nraw={bytes(self.data)[-3000:]!r}')

    def type(self, text):
        os.write(self.master, text.encode())
        self.pump(0.3)

    def close(self):
        try:
            if self.process.poll() is None:
                os.write(self.master, b'\x11')
                try:
                    self.process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
            (self.output / f'{self.name}.txt').write_text(self.screen())
        finally:
            os.close(self.master)
            os.close(self.slave)
        return self.process.returncode


def main():
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-plugin-content-', dir='/tmp'))
    dsh = dsh_bin()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-plugin-content-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        (home / 'dsh').mkdir(parents=True)
        (home / '.grok').mkdir(parents=True)
        cwd = work / 'workspace'
        (cwd / '.git').mkdir(parents=True)
        source = work / 'src' / 'demo'
        write_plugin(source)
        patch = work / 'overlay.yml'
        patch.write_text(overlay_text())
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_HOME': str(home / 'dsh'), 'GROK_HOME': str(home / '.grok'),
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
        }
        cli = lambda *args: run([NODE, str(LAUNCHER), '--rust', *args], cwd=cwd, env=env)
        cli('plugin', 'install', str(source), '--trust')
        log = cwd / 'plugin-hook.log'

        # 1. Skills and rules: /plugins Space enables, the next prompt sees them.
        echo = Session('skill-toggle', cwd, {**env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo'}, output)
        try:
            echo.wait('Connected to dsh ACP')
            echo.type('/plugins\r')
            shown = echo.wait('[disabled]')
            assert 'demo' in shown and 'exec=false' in shown, shown
            echo.type('\r')
            shown = echo.wait('provides 1 rule · 1 skill · 1 command · 1 agent · 1 hook')
            assert '/demo:greet' in shown and 'PreToolUse(Bash)' in shown, shown
            echo.type(' ')
            shown = echo.wait('[active]')
            assert 'contributions load through normal discovery' in shown, shown
            echo.type('\x1b')
            echo.type('\x1b')
            echo.wait('Enabled plugin: demo [active]')
            echo.type('/demo:greet hi\r')
            shown = echo.wait('markers=PLUGIN_RULE_BODY,PLUGIN_SKILL_BODY')
            echo.type('/plugins\r')
            echo.wait('[active]')
            echo.type(' ')
            echo.wait('[disabled]')
            echo.type('\x1b')
            echo.wait('Disabled plugin: demo [disabled]')
            echo.type('/demo:greet again\r')
            # The latest user text reaches dsh bare: no rule block, no skill
            # body. (Earlier turns still hold the first expansion.)
            echo.wait('latest=/demo:greet again markers=')
        finally:
            assert echo.close() == 0

        # 2. Hooks: enabling mid-session replaces the dsh child; the hook blocks.
        hook = Session('hook-toggle', cwd, {**env, 'DSH_CODE_CLI_MOCK_TOOL': 'hook-bash'}, output)
        try:
            hook.wait('Connected to dsh ACP')
            hook.type('first run\r')
            hook.wait('RUST_ACP_HOOK_DONE')
            assert not log.exists(), 'a disabled plugin hook ran'
            hook.type('/plugins\r')
            hook.wait('[disabled]')
            hook.type(' ')
            hook.wait('[active]')
            hook.type('\x1b')
            hook.wait('Enabled plugin: demo [active]')
            hook.type('second run\r')
            hook.wait('Denied by hook: PLUGIN_HOOK_BLOCKED by demo')
            assert log.exists() and 'GUARD ' in log.read_text(), 'the plugin hook did not run'
            log.unlink()
            hook.type('/plugins\r')
            hook.wait('[active]')
            hook.type(' ')
            hook.wait('[disabled]')
            hook.type('\x1b')
            hook.wait('Disabled plugin: demo [disabled]')
            hook.type('third run\r')
            hook.wait('RUST_ACP_HOOK_DONE', count=2)
            assert not log.exists(), 'a disabled plugin hook still ran'
        finally:
            assert hook.close() == 0
        print(json.dumps({'output': str(output), 'skillToggle': True, 'hookToggle': True}, indent=2))


if __name__ == '__main__':
    main()
