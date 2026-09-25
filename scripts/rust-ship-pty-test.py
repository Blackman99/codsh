#!/usr/bin/env python3
"""Real-terminal Ship extension, first phase (ticket 195).

Without the extension the default interface has no /ship and writes no Ship
state. `plugin install bundled:ship --trust` then `plugin enable ship` adds
/ship; the rust-acp mock replays the legacy ship-wayfinder scenario through
real dsh: the question card answer lands in <spec>.ship.answers.json, the
ledger write seals <spec>.ship.json, a turn cancelled at the card records
nothing and a bare /ship resumes, a conflicting idea and a spec past
wayfinder are refused, and disabling the plugin removes /ship again. Uses the
repo launcher and the native binary plus extension from
`pnpm run build:rust`; runs on Linux and macOS. All homes are temp dirs.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import re
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

    def wait_flat(self, text, seconds=60):
        """Wait for text that the transcript may wrap: row prefixes and whitespace are ignored."""
        needle = re.sub(r'\s+', '', text)
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump(0.3)
            flat = re.sub(r'\s+', '', ''.join(line[2:] for line in self.screen().splitlines()))
            if needle in flat:
                return flat
            if self.process.poll() is not None:
                break
        raise AssertionError(f'{self.name}: missing {text!r}\n{self.screen()}')

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



def read_json(path):
    return json.loads(path.read_text())


def answers_of(spec):
    path = spec.with_name(spec.stem + '.ship.answers.json')
    if not path.exists():
        return []
    return [f"{row['phase']}:{row['id']}={row.get('answer', '')}" for row in read_json(path)['answers']]


def workspace(root, name):
    path = root / name
    (path / '.git').mkdir(parents=True)
    return path


def main():
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-ship-', dir='/tmp'))
    dsh = dsh_bin()
    assert (ROOT / 'packages/cli/extensions/ship/hooks/ship-hook.mjs').exists(), 'run pnpm run build:rust first'
    with tempfile.TemporaryDirectory(prefix='codsh-rust-ship-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        patch = work / 'overlay.yml'
        patch.write_text(overlay_text())
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'ship-wayfinder',
        }
        rust_home = home / '.codsh-rust'
        plugin_data = rust_home / '.grok' / 'plugin-data' / 'ship'
        main_cwd = workspace(work, 'workspace')
        cli = lambda *args, cwd=main_cwd: run([NODE, str(LAUNCHER), '--rust', *args], cwd=cwd, env=env).stdout
        results = {}

        # 0. Default interface: no /ship, no Ship state.
        plain = Session('no-extension', main_cwd, env, output)
        try:
            plain.wait('Connected to dsh ACP')
            plain.type('/shi')
            plain.pump(1.5)
            shown = plain.screen()
            assert '/ship' not in shown, shown
            plain.type('\x15')
            plain.type('/ship PENDING_WAYFINDER\r')
            shown = plain.wait('SHIP_NOT_WAYFINDER')
        finally:
            assert plain.close() == 0
        assert not (main_cwd / 'docs').exists(), 'Ship state appeared without the extension'
        assert not plugin_data.exists(), 'Ship plugin data appeared without the extension'
        assert 'ship' not in cli('plugin', 'list'), 'a plugin is listed before install'
        results['default_has_no_ship'] = True

        # 1. Explicit install: copied and trusted, still off; enable turns it on.
        installed = cli('plugin', 'install', 'bundled:ship', '--trust')
        assert 'Installed 1 plugin(s) from bundled:ship: ship' in installed, installed
        listed = cli('plugin', 'list')
        assert 'status=disabled' in listed, listed
        enabled = cli('plugin', 'enable', 'ship')
        assert 'Enabled plugin: ship [active]' in enabled and 'Provides 1 command · 2 hooks' in enabled, enabled
        results['install_enable'] = True

        spec = main_cwd / 'docs/specs/wayfinder-e2e.md'
        session = Session('wayfinder', main_cwd, env, output)
        try:
            session.wait('Connected to dsh ACP')
            session.type('/shi')
            session.wait('/ship')
            session.type('\x15')
            # 2. The first phase: the question card answer, then the ledger.
            session.type('/ship PENDING_WAYFINDER\r')
            shown = session.wait('Is the route clear?')
            assert 'ship · wayfinder' in shown, shown
            session.type('1')
            session.wait('WAYFINDER_WAITING original=PENDING_WAYFINDER')
            assert 'Status: wayfinding' in spec.read_text()
            snapshot = read_json(spec.with_name('wayfinder-e2e.ship.json'))
            assert snapshot['originalRequirement'] == 'PENDING_WAYFINDER' and snapshot['originalSealed'] is True, snapshot
            assert answers_of(spec) == ['wayfinder:route=Continue'], answers_of(spec)
            results['first_phase_records'] = True

            # 3. Cancel at the card: nothing is recorded; the ledger stays.
            session.type('/ship\r')
            session.wait('Resume the pending research?')
            session.type('\x03')
            session.wait('[cancelled]')
            assert answers_of(spec) == ['wayfinder:route=Continue'], answers_of(spec)
            assert 'Status: wayfinding' in spec.read_text()
            results['cancel_records_nothing'] = True

            # 4. A bare /ship resumes from the ledger and the answer is appended.
            session.type('/ship\r')
            session.wait('ship · wayfinder: Resume the pending research?')
            session.type('1')
            session.wait('WAYFINDER_RESUMED original=PENDING_WAYFINDER')
            assert answers_of(spec) == ['wayfinder:route=Continue', 'wayfinder:resume=Continue'], answers_of(spec)
            results['resume'] = True
        finally:
            assert session.close() == 0

        # 5. A different typed idea is refused with the legacy wording (the
        # records live on disk, so a fresh session sees the same run).
        conflict = Session('conflict', main_cwd, env, output)
        try:
            conflict.wait('Connected to dsh ACP')
            conflict.type('/ship SOMETHING_ELSE\r')
            conflict.wait_flat('Ship: Typed idea conflicts with the saved original requirement. Stopped;')
            assert 'SHIP_NOT_WAYFINDER' not in conflict.screen() and 'WAYFINDER_' not in conflict.screen()
        finally:
            assert conflict.close() == 0
        assert answers_of(spec) == ['wayfinder:route=Continue', 'wayfinder:resume=Continue']
        results['conflict_refused'] = True

        # 6. Wayfinder hands off to grill; the next /ship is refused, not faked.
        grill_cwd = workspace(work, 'grill')
        grill_spec = grill_cwd / 'docs/specs/wayfinder-e2e.md'
        grill = Session('handoff', grill_cwd, env, output)
        try:
            grill.wait('Connected to dsh ACP')
            grill.type('/ship SMALL_WAYFINDER\r')
            grill.wait('Is the route clear?')
            grill.type('1')
            grill.wait('WAYFINDER_READY original=SMALL_WAYFINDER')
            assert 'Status: grilling' in grill_spec.read_text()
        finally:
            assert grill.close() == 0
        later = Session('later-phase', grill_cwd, env, output)
        try:
            later.wait('Connected to dsh ACP')
            later.type('/ship\r')
            later.wait_flat('Ship in codsh --rust runs pre-flight and wayfinder only; '
                            'docs/specs/wayfinder-e2e.md is at Status: grilling. '
                            'Continue it with legacy codsh (/ship)')
            assert 'WAYFINDER_' not in later.screen()
        finally:
            assert later.close() == 0
        results['later_phase_refused'] = True

        # 7. Stop at the route question: no ledger, no records.
        stop_cwd = workspace(work, 'stop')
        stop = Session('stop', stop_cwd, env, output)
        try:
            stop.wait('Connected to dsh ACP')
            stop.type('/ship SMALL_WAYFINDER\r')
            stop.wait('Is the route clear?')
            stop.type('2')
            stop.wait('WAYFINDER_STOPPED')
        finally:
            assert stop.close() == 0
        assert not (stop_cwd / 'docs').exists()
        results['stop_writes_nothing'] = True

        # 8. Disabled: /ship is gone again and nothing more is recorded.
        disabled = cli('plugin', 'disable', 'ship')
        assert 'Disabled plugin: ship [disabled]' in disabled, disabled
        after = Session('disabled', main_cwd, env, output)
        try:
            after.wait('Connected to dsh ACP')
            after.type('/ship PENDING_WAYFINDER\r')
            after.wait('SHIP_NOT_WAYFINDER')
        finally:
            assert after.close() == 0
        assert answers_of(spec) == ['wayfinder:route=Continue', 'wayfinder:resume=Continue']
        results['disable_removes'] = True
        print(json.dumps({'output': str(output), **results}, indent=2))


if __name__ == '__main__':
    main()
