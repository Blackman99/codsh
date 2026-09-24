#!/usr/bin/env python3
"""Installed-product PTY: queue, send-now, steer and /btw through real dsh.

Runs on any POSIX host with a staged native candidate (pnpm run build:rust).
Every scenario checks what the mock provider really received (the
CODSH_REVIEW_TRACE file), not only what the screen shows.
"""
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


class Session:
    def __init__(self, name, launcher, cwd, env, output, cols=100, rows=36):
        self.name = name
        self.cols = cols
        self.rows = rows
        self.output = output
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.original = termios.tcgetattr(self.slave)
        self.process = subprocess.Popen(
            [NODE, str(launcher), '--rust'], cwd=cwd, env=env,
            stdin=self.slave, stdout=self.slave, stderr=self.slave, start_new_session=True)
        self.data = bytearray()
        self.cursor_replies = 0

    def answer_cursor(self):
        # Minimal mode asks where the cursor is (CSI 6n); a real terminal answers.
        queries = bytes(self.data).count(b'\x1b[6n')
        while self.cursor_replies < queries:
            os.write(self.master, f'\x1b[{self.rows};1R'.encode())
            self.cursor_replies += 1

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
                self.answer_cursor()

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

    def write(self, data):
        os.write(self.master, data if isinstance(data, bytes) else data.encode())

    def finish(self):
        shown = self.visible()
        self.write(b'\x11')
        self.process.wait(timeout=12)
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



CTRL_ENTER = b'\x1b[13;5u'
UP = b'\x1b[A'
DOWN = b'\x1b[B'
ESC = b'\x1b'


def trace_rows(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def latest(row):
    marked = [text for text in row.get('user', []) if 'TOKEN_' in text]
    return marked[-1] if marked else ''


def turn_prompts(path):
    """Latest prompt of each main-turn model call, in call order."""
    return [latest(row) for row in trace_rows(path) if row.get('purpose') == 'turn']


def distinct(prompts, needles):
    """Which needle each call carried, collapsing tool steps of one turn."""
    order = []
    for prompt in prompts:
        hit = next((needle for needle in needles if needle in prompt), None)
        if hit and (not order or order[-1] != hit):
            order.append(hit)
    return order


def wait_trace(path, predicate, what, seconds=40):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        rows = trace_rows(path)
        if predicate(rows):
            return rows
        time.sleep(0.2)
    raise AssertionError(f'trace never showed {what}: {json.dumps(trace_rows(path), indent=1)[-4000:]}')


def type_line(session, text):
    session.write(text)
    session.wait_visible(text[-24:], 10)
    session.write(b'\r')


def main():
    if os.name != 'posix':
        raise SystemExit('POSIX PTY required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-queue-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-queue-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        cwd = work / 'workspace'
        cwd.mkdir()
        (cwd / 'note.txt').write_text('alpha\n')
        pack_home = work / 'pack-home'
        pack_home.mkdir()
        pack_env = {
            'HOME': str(pack_home), 'PATH': os.environ['PATH'],
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
        results = []
        only = set(sys.argv[1:])

        def want(name):
            return not only or name in only
        counter = [0]

        def start(name, extra, config=None):
            counter[0] += 1
            home = work / f'home-{counter[0]}'
            home.mkdir()
            if config is not None:
                grok = home / '.codsh-rust' / '.grok'
                grok.mkdir(parents=True)
                (grok / 'config.toml').write_text(config)
            trace = output / f'{name}.trace.jsonl'
            env = {
                'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
                'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
                'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
                'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
                'CODSH_REVIEW_TRACE': str(trace), **extra,
            }
            session = Session(name, launcher, cwd, env, output, cols=110, rows=40)
            session.wait_visible('Connected to dsh ACP', 40)
            return session, trace

        # 1. Queue while running; reorder, edit in place and delete in the
        # pane; the rows then run one per turn in the edited order.
        if want('queue-manage'):
            session, trace = start('queue-manage', {'DSH_CODE_CLI_MOCK_DELAY_MS': '3000'})
            try:
                type_line(session, 'TOKEN_QM_RUN')
                session.wait_visible('Streaming turn', 15)
                for text in ('TOKEN_QM_A', 'TOKEN_QM_B', 'TOKEN_QM_C'):
                    type_line(session, text)
                session.wait_visible('Queued 3', 10)
                session.write(UP)  # empty prompt: focus the last queued row
                session.wait_visible('Queue 3', 10)
                session.write('K')  # C above B
                session.write(DOWN)  # select B again
                session.write('e')
                session.wait_visible('editing queued row', 10)
                session.write('_EDITED')
                session.wait_visible('TOKEN_QM_B_EDITED', 10)
                session.write(b'\r')
                session.wait_visible('queued row updated in place', 10)
                session.write(UP)  # focus last row (B_EDITED)
                session.write('k')  # C
                session.write('x')
                session.wait_visible('queued row deleted', 10)
                session.write(ESC)
                needles = ['TOKEN_QM_RUN', 'TOKEN_QM_A', 'TOKEN_QM_B_EDITED', 'TOKEN_QM_C']
                wait_trace(trace, lambda rows: 'TOKEN_QM_B_EDITED' in ''.join(map(latest, rows)), 'the edited row')
                session.wait_visible('latest=TOKEN_QM_B_EDITED', 30)
                session.pump(1.5)
                order = distinct(turn_prompts(trace), needles)
                assert order == ['TOKEN_QM_RUN', 'TOKEN_QM_A', 'TOKEN_QM_B_EDITED'], order
                assert all('TOKEN_QM_C' not in prompt for prompt in turn_prompts(trace))
                shown = session.visible(); assert 'Queued' not in shown, shown
                results.append(session.finish())
            finally:
                session.close()

        # 2. Send-now: Ctrl+Enter cancels the running turn without a
        # "[cancelled]" marker and runs the draft before older rows; Enter on
        # an empty prompt sends the top row now.
        if want('send-now'):
            session, trace = start('send-now', {'DSH_CODE_CLI_MOCK_DELAY_MS': '4000'})
            try:
                type_line(session, 'TOKEN_SN_RUN')
                session.wait_visible('Streaming turn', 15)
                type_line(session, 'TOKEN_SN_LATER')
                session.wait_visible('Queued 1', 10)
                session.write('TOKEN_SN_URGENT')
                session.wait_visible('TOKEN_SN_URGENT', 10)
                session.write(CTRL_ENTER)
                session.wait_visible('latest=TOKEN_SN_URGENT', 30)
                assert '[cancelled]' not in session.visible()
                # LATER starts next; Enter on the empty prompt sends TOP now.
                wait_trace(trace, lambda rows: 'TOKEN_SN_LATER' in latest(rows[-1]) if rows else False, 'the later row')
                type_line(session, 'TOKEN_SN_TOP')
                session.wait_visible('Queued 1', 10)
                session.write(b'\r')
                session.wait_visible('latest=TOKEN_SN_TOP', 30)
                session.pump(1.0)
                shown = session.visible()
                assert '[cancelled]' not in shown
                prompts = turn_prompts(trace)
                order = distinct(prompts, ['TOKEN_SN_RUN', 'TOKEN_SN_LATER', 'TOKEN_SN_URGENT', 'TOKEN_SN_TOP'])
                assert order == ['TOKEN_SN_RUN', 'TOKEN_SN_URGENT', 'TOKEN_SN_LATER', 'TOKEN_SN_TOP'], order
                assert sum('TOKEN_SN_URGENT' in prompt and 'TOKEN_SN_LATER' not in prompt for prompt in prompts) == 1
                results.append(session.finish())
            finally:
                session.close()

        # 3. Steer mode: a follow-up typed during a tool loop is injected
        # into the same dsh turn and is not sent again as its own turn.
        if want('steer'):
            session, trace = start('steer', {
                'DSH_CODE_CLI_MOCK_TOOL': 'steer-probe', 'DSH_CODE_CLI_MOCK_DELAY_MS': '1500',
            }, config='[ui]\nfollow_up_behavior = "steer"\n')
            try:
                type_line(session, 'TOKEN_ST_MAIN')
                wait_trace(trace, lambda rows: len(rows) >= 1, 'the first model call')
                type_line(session, 'TOKEN_ST_STEER')
                session.wait_visible('RUST_ACP_STEER_DONE calls=3 latest=TOKEN_ST_STEER', 40)
                session.pump(4.0)
                rows = trace_rows(trace)
                assert len(rows) == 4, json.dumps(rows, indent=1)
                assert 'TOKEN_ST_MAIN' in ''.join(rows[0]['user'])
                assert any('TOKEN_ST_STEER' in ''.join(row['user']) for row in rows[1:])
                shown = session.visible(); assert 'Queued' not in shown, shown
                results.append(session.finish())
            finally:
                session.close()

        # 4. Ctrl+C cancels the turn; the front queued row runs exactly once.
        if want('cancel-drain'):
            session, trace = start('cancel-drain', {'DSH_CODE_CLI_MOCK_DELAY_MS': '4000'})
            try:
                type_line(session, 'TOKEN_CQ_RUN')
                session.wait_visible('Streaming turn', 15)
                type_line(session, 'TOKEN_CQ_NEXT')
                session.wait_visible('Queued 1', 10)
                session.write(b'\x03')
                session.wait_visible('[cancelled]', 20)
                session.wait_visible('latest=TOKEN_CQ_NEXT', 30)
                session.pump(3.0)
                prompts = turn_prompts(trace)
                assert sum('TOKEN_CQ_NEXT' in prompt for prompt in prompts) == 1, prompts
                shown = session.visible(); assert 'Queued' not in shown, shown
                results.append(session.finish())
            finally:
                session.close()

        # 5. A pending approval holds the queue; the row runs after the answer.
        if want('approval-hold'):
            session, trace = start('approval-hold', {'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'})
            try:
                type_line(session, 'TOKEN_AP_RUN')
                session.wait_visible('Allow ', 30)
                type_line(session, 'TOKEN_QUEUED_WHILE_PERM')
                session.wait_visible('Queued 1', 10)
                session.pump(2.5)
                assert all('TOKEN_QUEUED_WHILE_PERM' not in latest(row) for row in trace_rows(trace))
                assert 'Allow ' in session.visible()
                session.write('n')
                wait_trace(trace, lambda rows: any('TOKEN_QUEUED_WHILE_PERM' in latest(row) for row in rows), 'the held row')
                # The mock answers the queued turn from the rejected edit
                # already in history; no second approval is asked.
                session.pump(2.0)
                assert sum('TOKEN_QUEUED_WHILE_PERM' in latest(row) for row in trace_rows(trace)) == 1
                assert (cwd / 'note.txt').read_text() == 'alpha\n'
                results.append(session.finish())
            finally:
                session.close()

        # 6. /minimal while running keeps the queue; rapid lines keep order.
        if want('minimal-rapid'):
            session, trace = start('minimal-rapid', {'DSH_CODE_CLI_MOCK_DELAY_MS': '2500'})
            try:
                type_line(session, 'TOKEN_MR_RUN')
                session.wait_visible('Streaming turn', 15)
                session.write('TOKEN_MR_1\rTOKEN_MR_2\rTOKEN_MR_3\r')
                session.wait_visible('Queued 3', 10)
                type_line(session, '/minimal')
                session.wait_visible('Queued 3', 10)
                session.wait_visible('latest=TOKEN_MR_3', 60)
                session.pump(1.0)
                order = distinct(turn_prompts(trace), ['TOKEN_MR_RUN', 'TOKEN_MR_1', 'TOKEN_MR_2', 'TOKEN_MR_3'])
                assert order == ['TOKEN_MR_RUN', 'TOKEN_MR_1', 'TOKEN_MR_2', 'TOKEN_MR_3'], order
                results.append(session.finish())
            finally:
                session.close()

        # 7. /btw answers from the session context without joining it:
        # a separate model call, no main-turn row carries the question, and
        # the next main turn does not see it. Esc dismisses the panel.
        if want('btw'):
            session, trace = start('btw', {'DSH_CODE_CLI_MOCK_DELAY_MS': '2500'})
            try:
                type_line(session, 'TOKEN_BTW_FIRST')
                session.wait_visible('latest=TOKEN_BTW_FIRST', 20)
                type_line(session, 'TOKEN_BTW_MAIN')
                session.wait_visible('Streaming turn', 15)
                type_line(session, '/btw TOKEN_BTW_Q')
                session.wait_visible('btw ›', 10)
                session.wait_visible('RUST_BTW_ANSWER q=TOKEN_BTW_Q', 30)
                shown = session.visible()
                assert 'context=TOKEN_BTW_FIRST' in shown, shown
                session.wait_visible('latest=TOKEN_BTW_MAIN', 30)
                session.write(ESC)
                session.pump(0.6)
                assert 'RUST_BTW_ANSWER' not in session.visible()
                type_line(session, 'TOKEN_BTW_AFTER')
                session.wait_visible('latest=TOKEN_BTW_AFTER', 30)
                rows = trace_rows(trace)
                side = [row for row in rows if row.get('purpose') == 'btw']
                main_rows = [row for row in rows if row.get('purpose') == 'turn']
                assert len(side) == 1 and side[0]['tools'] == [], side
                assert 'TOKEN_BTW_Q' in ''.join(side[0]['user'])
                assert len(main_rows) == 3, [latest(row) for row in main_rows]
                assert all('TOKEN_BTW_Q' not in ''.join(row['user']) for row in main_rows)
                assert 'TOKEN_BTW_Q' not in session.visible().split('latest=TOKEN_BTW_AFTER', 1)[1]
                results.append(session.finish())
            finally:
                session.close()

        print(json.dumps({'output': str(output), 'sessions': [item['name'] for item in results]}, indent=2))


if __name__ == '__main__':
    main()
