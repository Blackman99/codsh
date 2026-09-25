#!/usr/bin/env python3
"""Real-terminal plugin MCP servers (ticket 204).

A temp plugin that ships a keyless MCP server (`.mcp.json`, relative
`./bin/server`) is installed with --trust but left disabled. Inside one
interactive session: /plugins shows the server as not mounted; Space
enables it and the next prompt lists its tools; /mcps labels it
`[plugin: demo]`; a real tool call asks, `a` remembers the approval, and
the server's side effect lands in the plugin data directory. Space again
disables it: the overlay says the server is still mounted until the next
prompt, the remembered approval is forgotten, and the next prompt no
longer has the tools. Uses the repo launcher and the native binary from
`pnpm run build:rust`; Linux and macOS. All homes are temp dirs.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
LAUNCHER = ROOT / 'packages/cli/bin/codsh.mjs'
FIXTURE = ROOT / 'e2e/fixtures/rust-mcp-fixture.mjs'


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
    (root / 'bin').mkdir(parents=True, exist_ok=True)
    (root / 'server').mkdir(parents=True, exist_ok=True)
    (root / 'plugin.json').write_text(json.dumps({'name': 'demo', 'version': '1.0.0', 'license': 'MIT'}))
    shutil.copyfile(FIXTURE, root / 'server/fixture.mjs')
    server = root / 'bin/server'
    server.write_text(f"#!/bin/sh\nexec '{NODE}' \"$(dirname \"$0\")/../server/fixture.mjs\" \"$@\"\n")
    server.chmod(0o755)
    (root / '.mcp.json').write_text(json.dumps({'mcpServers': {'pfx': {
        'command': './bin/server', 'args': ['--tools=write_note,echo'],
        'env': {'MCP_FIXTURE_DIR': '${GROK_PLUGIN_DATA}', 'MCP_FIXTURE_LABEL': 'pfx'},
    }}}))


def grants_path(grok_home, cwd):
    encoded = ''.join(ch if ch.isascii() and (ch.isalnum() or ch in '._-') else f'%{ord(ch):02X}' for ch in str(cwd))
    return grok_home / 'sessions' / encoded / 'permission.toml'


def tail_after(screen, marker):
    """Screen text after the last line containing `marker`, inclusive."""
    lines = screen.split('\n')
    index = max(i for i, line in enumerate(lines) if marker in line)
    return '\n'.join(lines[index:])


class Session:
    def __init__(self, name, cwd, env, output, rows=40, cols=200):
        self.name, self.output, self.rows, self.cols = name, output, rows, cols
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.process = subprocess.Popen([NODE, str(LAUNCHER), '--rust', '--trust'],
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
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-plugin-mcp-', dir='/tmp'))
    dsh = dsh_bin()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-plugin-mcp-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        grok_home = home / '.grok'
        (home / 'dsh').mkdir(parents=True)
        grok_home.mkdir(parents=True)
        cwd = work / 'workspace'
        (cwd / '.git').mkdir(parents=True)
        source = work / 'src' / 'demo'
        write_plugin(source)
        patch = work / 'overlay.yml'
        patch.write_text(overlay_text())
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_HOME': str(home / 'dsh'), 'GROK_HOME': str(grok_home),
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'mcp',
        }
        run([NODE, str(LAUNCHER), '--rust', 'plugin', 'install', str(source), '--trust'], cwd=cwd, env=env)
        # The launcher keeps the Rust client's own Grok home under HOME.
        rust_home = home / '.codsh-rust' / '.grok'
        data = rust_home / 'plugin-data' / 'demo'
        grants = grants_path(rust_home, cwd)

        term = Session('plugin-mcp', cwd, env, output)
        try:
            term.wait('Connected to dsh ACP')
            term.type('MCP_TOOLS\r')
            shown = term.wait('RUST_ACP_MCP_TOOLS')
            assert 'mcp__pfx__' not in shown, 'a disabled plugin server mounted'

            # /plugins: the server is listed but not mounted; enabling says when it mounts.
            term.type('/plugins\r')
            term.wait('[disabled]')
            term.type('\r')
            term.wait('mcp pfx disabled (not mounted while the plugin is not active)')
            term.type(' ')
            shown = term.wait('[active]')
            term.wait('mcp pfx ready (mounts with the next prompt)')
            term.type('\x1b')
            term.type('\x1b')
            term.wait('Enabled plugin: demo [active]')

            term.type('MCP_TOOLS\r')
            shown = term.wait('RUST_ACP_MCP_TOOLS', count=2)
            assert 'mcp__pfx__write_note' in tail_after(shown, 'RUST_ACP_MCP_TOOLS'), shown
            term.type('/mcps\r')
            term.wait('pfx [plugin: demo] connected · 2 tools')

            # A real call asks first; `a` remembers it for this project.
            term.type('MCP_CALL mcp__pfx__write_note {"name":"t.txt","text":"from pty"}\r')
            term.wait('y=allow once')
            term.type('a')
            term.wait('OK:wrote t.txt')
            term.wait('Remembered for this project only')
            assert (data / 't.txt').read_text() == 'from pty'
            assert 'pfx__write_note' in grants.read_text(), grants.read_text()

            # The overlay shows the live state; disabling says it is still
            # mounted until the next prompt and forgets the approval.
            term.type('/plugins\r')
            term.wait('[active]')
            term.type('\r')
            term.wait('mcp pfx connected (2 tools)')
            term.type(' ')
            term.wait('mcp pfx disabled (still mounted; withdrawn with the next prompt)')
            term.type('\x1b')
            term.type('\x1b')
            term.wait('forgot 1 remembered approval(s) for their tools')
            assert 'pfx__write_note' not in grants.read_text(), grants.read_text()

            term.type('MCP_TOOLS\r')
            shown = term.wait('RUST_ACP_MCP_TOOLS', count=3)
            assert 'mcp__pfx__' not in tail_after(shown, 'RUST_ACP_MCP_TOOLS'), shown
            # Even approved by hand, the old tool name no longer reaches a server.
            term.type('MCP_CALL mcp__pfx__write_note {"name":"u.txt","text":"stale"}\r')
            term.wait('y=allow once')
            term.type('y')
            term.wait('RUST_ACP_MCP_DONE ERR:')
            assert not (data / 'u.txt').exists(), 'a withdrawn plugin tool ran'
        finally:
            assert term.close() == 0
        print(json.dumps({'output': str(output), 'pluginMcp': True}, indent=2))


if __name__ == '__main__':
    main()
