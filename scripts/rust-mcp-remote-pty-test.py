#!/usr/bin/env python3
"""Real-terminal remote MCP (ticket 168).

A keyless loopback MCP server with its own OAuth authorization server
(e2e/fixtures/rust-mcp-remote-fixture.mjs --oauth) is configured as a
remote server. Inside one interactive session: /mcps shows it failed with
"authentication required"; `/mcps auth rem` signs in through $BROWSER (a
script that fetches the authorization URL and follows the redirect to the
loopback callback) and restarts the MCP servers; the next prompt has the
tools. A real tool call asks for approval, then the server's form
elicitation opens the MCP card: an enum choice and a typed name are
submitted and reach the server. A second call is declined with `d`. A URL
elicitation opens the URL through $BROWSER on Accept and the card closes
when the server reports completion. `/mcps logout rem` signs out. Uses the
repo launcher and the native binary from `pnpm run build:rust`; Linux and
macOS. All homes are temp dirs.
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
FIXTURE = ROOT / 'e2e/fixtures/rust-mcp-remote-fixture.mjs'
DOWN, RIGHT = '\x1b[B', '\x1b[C'


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


def start_fixture(work):
    fixture_dir = work / 'fixture'
    fixture_dir.mkdir()
    process = subprocess.Popen([NODE, str(FIXTURE), '--oauth'], env={**os.environ, 'MCP_REMOTE_DIR': str(fixture_dir)},
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    line = process.stdout.readline()
    assert line.startswith('LISTENING '), line
    return process, f"http://127.0.0.1:{line.split()[1]}", fixture_dir


def log_lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line] if path.exists() else []


def main():
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-mcp-remote-', dir='/tmp'))
    dsh = dsh_bin()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-mcp-remote-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        (home / 'dsh').mkdir(parents=True)
        cwd = work / 'workspace'
        (cwd / '.git').mkdir(parents=True)
        patch = work / 'overlay.yml'
        patch.write_text(overlay_text())
        browser = work / 'browser.mjs'
        browsed = work / 'browsed.log'
        browser.write_text(
            "import { appendFileSync } from 'node:fs'\n"
            f"const log = {json.dumps(str(browsed))}\n"
            "appendFileSync(log, process.argv[2] + '\\n')\n"
            "const res = await fetch(process.argv[2], { redirect: 'follow' })\n"
            "appendFileSync(log, 'status ' + res.status + '\\n')\n")
        fixture, base, fixture_dir = start_fixture(work)
        # The launcher keeps the Rust client's own Grok home under HOME.
        rust_home = home / '.codsh-rust' / '.grok'
        rust_home.mkdir(parents=True)
        (rust_home / 'config.toml').write_text(f'[mcp_servers.rem]\nurl = "{base}/mcp"\n')
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_HOME': str(home / 'dsh'),
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'mcp',
            'BROWSER': f'{NODE} {browser}',
        }
        term = Session('mcp-remote', cwd, env, output)
        try:
            term.wait('Connected to dsh ACP')
            term.type('/mcps\r')
            term.wait('authentication required')
            term.type('\x1b')

            term.type('/mcps auth rem\r')
            term.wait("Signed in to MCP server 'rem'", seconds=60)
            term.wait('MCP servers restarted', seconds=60)
            term.type('/mcps\r')
            term.wait('connected · 7 tools · OAuth signed in')
            term.type('\x1b')
            assert f'{base}/authorize?' in browsed.read_text(), browsed.read_text()
            store = rust_home / 'mcp_credentials.json'
            assert store.stat().st_mode & 0o777 == 0o600

            term.type('MCP_TOOLS\r')
            shown = term.wait('RUST_ACP_MCP_TOOLS')
            assert 'mcp__rem__ask_name' in tail_after(shown, 'RUST_ACP_MCP_TOOLS'), shown

            # Form elicitation: type a name, choose "blue", Accept.
            term.type('MCP_CALL mcp__rem__ask_name {}\r')
            term.wait('y=allow once')
            term.type('y')
            term.wait('Who is asking?')
            term.type('\r')
            term.type('Pty')
            term.type('\r')
            term.wait('Name*: Pty')
            term.type(DOWN)
            term.type(RIGHT)
            term.type(' ')
            term.wait('(•) blue')
            term.type(DOWN)
            term.type('\r')
            term.wait('OK:hello Pty (blue)', seconds=60)

            # Declined with d.
            term.type('MCP_CALL mcp__rem__ask_name {}\r')
            term.wait('y=allow once')
            term.type('y')
            term.wait('Who is asking?', count=1)
            term.type('d')
            term.wait('OK:declined', seconds=60)

            # URL elicitation: Accept opens the URL; completion closes the card.
            term.type('MCP_CALL mcp__rem__open_link {}\r')
            term.wait('y=allow once')
            term.type('y')
            term.wait('Confirm on the fixture page')
            term.type('\r')
            term.wait('OK:url accepted', seconds=60)
            deadline = time.monotonic() + 10
            while '/confirm/' not in browsed.read_text() and time.monotonic() < deadline:
                time.sleep(0.2)
            assert '/confirm/' in browsed.read_text(), browsed.read_text()
            answers = [entry['elicitation'] for entry in log_lines(fixture_dir / 'calls.log') if 'elicitation' in entry]
            assert answers[0] == {'action': 'accept', 'content': {'color': 'blue', 'name': 'Pty'}}, answers
            assert answers[1] == {'action': 'decline'}, answers
            assert answers[2] == {'action': 'accept'}, answers

            term.type('/mcps logout rem\r')
            term.wait("Removed stored OAuth credentials for MCP server 'rem'", seconds=30)
            assert any(entry['event'] == 'revoke' for entry in log_lines(fixture_dir / 'oauth.log'))
        finally:
            code = term.close()
            for name in ('calls.log', 'oauth.log', 'capabilities.log', 'requests.log'):
                if (fixture_dir / name).exists():
                    (output / f'fixture-{name}').write_text((fixture_dir / name).read_text())
            fixture.terminate()
            fixture.wait(timeout=10)
        assert code == 0, code
        print(json.dumps({'output': str(output), 'remoteMcp': True}, indent=2))


if __name__ == '__main__':
    main()
