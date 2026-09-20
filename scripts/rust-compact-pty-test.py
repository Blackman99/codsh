#!/usr/bin/env python3
"""Installed-product PTY: /context occupancy and dsh-driven /compact continue."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
SESSION_RE = re.compile(r'session ([0-9a-f-]{36})', re.I)


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


class Session:
    def __init__(self, name, launcher, cwd, env, output, extra=None, cols=100, rows=48):
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

    def wait_answer_contains(self, token, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump()
            shown = self.visible()
            before_draft = shown.split('┌Draft')[0]
            marker = f'> {token}'
            idx = before_draft.rfind(marker)
            if idx >= 0 and 'RUST_ACP_ANSWER' in before_draft[idx:] and 'Streaming turn' not in shown:
                return shown
            if self.process.poll() is not None:
                break
        raise AssertionError(f'{self.name}: missing answer {token!r}\n{self.visible()}\nraw={bytes(self.data)[-2500:]!r}')

    def write(self, data):
        os.write(self.master, data if isinstance(data, bytes) else data.encode())

    def session_id(self):
        shown = self.visible()
        match = SESSION_RE.search(shown)
        if match is None:
            raise AssertionError(f'{self.name}: missing session id\n{shown}')
        return match.group(1)

    def finish(self):
        shown = self.visible()
        self.write(b'\x11')
        self.process.wait(timeout=20)
        self.pump()
        os.write(self.master, b'AFTER_EXIT_CANONICAL\n')
        assert select.select([self.slave], [], [], 2)[0]
        assert os.read(self.slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
        after = termios.tcgetattr(self.slave)
        (self.output / f'{self.name}.ansi').write_bytes(self.data)
        (self.output / f'{self.name}.txt').write_text(shown)
        assert self.original == after, f'{self.name}: terminal modes were not restored'
        assert b'\x1b[?1049l' in self.data
        return {'name': self.name, 'exit': self.process.returncode, 'screen': shown}

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()
        os.close(self.master)
        os.close(self.slave)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-compact-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-compact-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
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
        grok = home / '.codsh-rust' / '.grok'
        grok.mkdir(parents=True)
        (grok / 'config.toml').write_text("""
[model.chat]
name = "Chat"
model = "cli-mock"
base_url = "http://127.0.0.1:1/v1"
env_key = "XAI_API_KEY"
api_backend = "chat_completions"
context_window = 128000

[model.narrow]
name = "Narrow"
model = "narrow"
base_url = "http://127.0.0.1:1/v1"
env_key = "XAI_API_KEY"
api_backend = "chat_completions"
context_window = 64000

[models]
default = "chat"
""")
        base_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'DSH_CODE_CLI_MOCK_CONTEXT_WINDOW': '128000',
            'XAI_API_KEY': 'test-key',
        }
        results = {}

        inspect = subprocess.run([NODE, str(launcher), '--rust', 'inspect', '--json'], cwd=cwd, env=base_env,
                                 capture_output=True, text=True, timeout=20)
        assert inspect.returncode == 0, inspect.stderr + inspect.stdout
        payload = json.loads(inspect.stdout)
        assert payload.get('compactThresholdPercent') == 80
        results['inspect'] = payload.get('compactThresholdPercent')

        session = Session('compact', launcher, cwd, base_env, output)
        try:
            session.wait_visible('Connected to dsh ACP', 25)
            session_id = session.session_id()
            for token in ['TOKEN_OLD_ONE TODO_KEEP', 'TOKEN_OLD_TWO', 'TOKEN_OLD_THREE', 'TOKEN_OLD_FOUR']:
                session.write(token + '\r')
                session.wait_visible('RUST_ACP_ANSWER', 20)
            session.write('/context\r')
            shown = session.wait_visible('Context (dsh facts only', 15)
            assert 'occupancy=' in shown
            assert 'advertised_context=128000 (config' in shown
            assert 'occupancy=0' not in shown
            assert 'breakdown=unknown' in shown
            session.write('/model narrow\r')
            session.wait_visible('Selected narrow /', 15)
            session.write('/context\r')
            shown = session.wait_visible('advertised_context=64000 (config', 15)
            assert 'advertised_context=128000 (config' not in shown.split('Context (dsh facts only')[-1]
            session.write('/compact keep the auth plan\r')
            shown = session.wait_visible('purpose=compaction', 40)
            assert 'narrow' in shown or 'cli-mock' in shown
            assert 'compacted' in shown.lower()
            assert '> TOKEN_OLD_ONE' not in shown
            results['compact'] = True
            results['session'] = session.session_id()
            results['screen'] = session.finish()
            helper = run([
                NODE, str(ROOT / 'packages/cli/bin/rust-acp-session-read.mjs'),
                '--session-id', results['session'],
            ], env={**os.environ, 'DSH_HOME': str(home / '.codsh-rust' / 'dsh'), 'DSH_BIN': dsh})
            projected = json.loads(helper.stdout)
            summary = (projected.get('compaction') or [{}])[-1].get('summary') or ''
            assert 'keep the auth plan' in summary, summary
            assert not any('keep the auth plan' in (turn.get('user') or '') for turn in projected.get('turns') or [])
            assert 'TOKEN_OLD_ONE' not in json.dumps(projected.get('turns'))
        finally:
            session.close()

        resumed = Session('resume-compact', launcher, cwd, base_env, output, extra=['--resume', results['session']])
        try:
            shown = resumed.wait_visible('resumed', 25)
            assert 'purpose=compaction' in shown or 'compaction summary' in shown
            assert '> TOKEN_OLD_ONE' not in shown
            resumed.wait_visible('Draft (not sent)', 10)
            resumed.write('TOKEN_AFTER_COMPACT')
            resumed.wait_visible('TOKEN_AFTER_COMPACT', 10)
            resumed.write(b'\r')
            shown = resumed.wait_answer_contains('TOKEN_AFTER_COMPACT', 25)
            assert 'purpose=compaction' in shown or 'compaction summary' in shown
            results['resume'] = resumed.finish()
        finally:
            resumed.close()

        failing = Session('compact-fail', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'compact-fail',
        }, output)
        try:
            failing.wait_visible('Connected to dsh ACP', 25)
            failing.write('TOKEN_KEEP_ORIGINAL\r')
            failing.wait_visible('RUST_ACP_ANSWER', 20)
            failing.write('TOKEN_KEEP_SECOND\r')
            failing.wait_visible('RUST_ACP_ANSWER', 20)
            failing.write('/compact\r')
            shown = failing.wait_visible('Original dsh records were not discarded', 30)
            assert 'Connected to dsh ACP' in shown
            assert 'ACP connection ended' not in shown
            assert 'Execution unavailable' not in shown
            assert 'TOKEN_KEEP_ORIGINAL' in shown
            assert 'TOKEN_KEEP_SECOND' in shown
            assert 'Compaction failed' in shown or 'summarizer failed' in shown
            failing.write('TOKEN_AFTER_FAIL\r')
            shown = failing.wait_answer_contains('TOKEN_AFTER_FAIL', 25)
            assert 'TOKEN_KEEP_ORIGINAL' in shown
            results['failure'] = failing.finish()
        finally:
            failing.close()

        cancelling = Session('compact-cancel', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_DELAY_MS': '6000',
        }, output)
        try:
            cancelling.wait_visible('Connected to dsh ACP', 25)
            cancelling.write('TOKEN_CANCEL_ONE\r')
            cancelling.wait_visible('RUST_ACP_ANSWER', 20)
            cancelling.wait_visible('Enter submits a prompt', 10)
            cancelling.write('TOKEN_CANCEL_TWO\r')
            cancelling.wait_visible('RUST_ACP_ANSWER', 20)
            cancelling.wait_visible('Enter submits a prompt', 10)
            cancelling.write('/compact\r')
            cancelling.wait_visible('compacting history', 15)
            cancelling.write(b'\x03')
            shown = cancelling.wait_visible('Compaction cancelled.', 25)
            assert 'TOKEN_CANCEL_ONE' in shown
            assert 'TOKEN_CANCEL_TWO' in shown
            assert 'ACP connection ended' not in shown
            cancelling.write('TOKEN_AFTER_CANCEL\r')
            shown = cancelling.wait_answer_contains('TOKEN_AFTER_CANCEL', 25)
            assert 'TOKEN_CANCEL_ONE' in shown
            results['cancel'] = cancelling.finish()
        finally:
            cancelling.close()

        (output / 'result.json').write_text(json.dumps({k: v if k != 'screen' else True for k, v in results.items()}, indent=2))
        print(json.dumps({'ok': True, 'output': str(output), 'session': results.get('session')}))


if __name__ == '__main__':
    main()
