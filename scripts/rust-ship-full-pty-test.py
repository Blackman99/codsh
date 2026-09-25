#!/usr/bin/env python3
"""The whole /ship flow through the Ship extension in a real terminal (ticket 208).

Drives real dsh through the repo launcher with the rust-acp mock in
`ship-full` mode (keyless; no real model) in a real git repository:

1. Full flow: wayfinder (a human answer) → grill → to-spec with gate 1
   auto-Confirmed (Mission Contract sealed) → tickets with gate 2 → a
   landing wave of two parallel worktree children that edit the same line →
   one merge conflicts, the first conflict-resolution attempt fails the
   legacy validation and the retry passes → the dependent third ticket →
   the separate final verification turn → fast-forward Merge-back. The
   terminal notes, the git history, the spec and sidecars, the run state,
   and the browser graph (agent-browser at desktop 1440x900 and mobile
   390x844) must agree.
2. Cancellation and recovery: Ctrl+C during the wave (one child done in
   its worktree, one still running) merges and ticks nothing; a removed
   sealed Mission Contract stops the resumed run; a deleted run state
   resumes from the files alone (the claimed tickets are dispatched again
   with a notice, never assumed done), and the run completes.

Needs `pnpm run build:rust` (native binary + extension) and the
agent-browser CLI (AGENT_BROWSER or `agent-browser` on PATH; set
AGENT_BROWSER_EXECUTABLE_PATH to use a local Chrome). All homes are temp
dirs; screenshots land in the printed output directory.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import re
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
AGENT_BROWSER = os.environ.get('AGENT_BROWSER') or shutil.which('agent-browser')
IDEA = 'FULL_SHIP Greet people in two ways.'
LINE = re.compile(r'Shipgraph·(?P<where>.*?)·待认领(?P<unclaimed>\d+)·已认领(?P<claimed>\d+)·已关闭(?P<closed>\d+)·'
                  r'(?P<recorded>\d+)of(?P<total>\d+)decisionanswersrecorded·(?P<url>http://127\.0\.0\.1:\d+/[0-9a-f]{32}/)')


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


def git(cwd, *args):
    return run(['git', *args], cwd=cwd).stdout.strip()


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


def flat(text):
    return re.sub(r'\s+', '', text)


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
    """One codsh --rust process on a pty.

    The fullscreen viewport does not follow late transcript lines, so what
    the parent model received (every hook note and Stop continuation is
    injected into its context) is read from the mock's request trace, and
    what the terminal drew is read from the whole output stream.
    """

    def __init__(self, name, cwd, env, output, rows=100, cols=240):
        self.name, self.output, self.rows, self.cols = name, output, rows, cols
        self.trace = output / f'{name}.trace.jsonl'
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.process = subprocess.Popen([NODE, str(LAUNCHER), '--rust', '--trust', '--always-approve'],
                                        cwd=cwd, env={**env, 'CODSH_REVIEW_TRACE': str(self.trace)},
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

    def screen(self):
        return screen_text(bytes(self.data), self.rows, self.cols)

    def shown(self):
        # Transcript rows may carry a two-column gutter: match with and without it.
        screen = self.screen()
        return flat(screen) + '\n' + flat(''.join(line[2:] for line in screen.splitlines()))

    def records(self):
        if not self.trace.exists():
            return []
        return [json.loads(line) for line in self.trace.read_text().splitlines() if line.strip()]

    def heard(self, since=0):
        """Every user text and assistant reply the model saw, oldest first, each once, flattened."""
        out, known = [], set()
        for record in self.records()[since:]:
            for text in [*record.get('user', []), *record.get('assistant', [])]:
                if text not in known:
                    known.add(text)
                    out.append(flat(text))
        return out

    def results(self):
        """Every tool result text the model saw (subagent results carry the children's replies), flattened."""
        return '\n'.join(flat(result.get('text', '')) for record in self.records() for result in record.get('results', []))

    def mark(self):
        return len(self.records())

    def wait(self, text, seconds=90, since=0, screen=False):
        needle = flat(text)
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump(0.5)
            if screen and needle in self.shown():
                return
            if not screen and any(needle in item for item in self.heard(since)):
                return
            if self.process.poll() is not None:
                break
        raise AssertionError(f'{self.name}: missing {text!r}\n{self.screen()}')

    def printed(self, text, offset, seconds=30):
        """`text` was drawn to the terminal after byte `offset` (the viewport may not follow the transcript)."""
        needle = flat(text)
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump(0.5)
            drawn = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]', '', bytes(self.data[offset:]).decode('utf-8', 'replace'))
            if needle in flat(drawn):
                return
        raise AssertionError(f'{self.name}: {text!r} was never drawn\n{self.screen()}')

    def lines(self, since=0):
        return [match.groupdict() for item in self.heard(since) for match in LINE.finditer(item)]

    def type(self, text):
        os.write(self.master, text.encode())
        self.pump(0.3)

    def idle(self, seconds=4):
        """No further model request for `seconds`: no hook keeps the turn going."""
        before = len(self.records())
        self.pump(seconds)
        return len(self.records()) == before

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
            (self.output / f'{self.name}.raw').write_bytes(bytes(self.data))
        finally:
            os.close(self.master)
            os.close(self.slave)
        return self.process.returncode


STATE_JS = r"""JSON.stringify((() => {
  const text = sel => document.querySelector(sel)?.textContent?.trim() ?? null
  const count = sel => document.querySelectorAll(sel).length
  return {
    connection: text('.connection'),
    spec: text('.spec-name'),
    phase: text('.current-phase-badge'),
    answers: [...document.querySelectorAll('.context-nav p')].map(p => p.textContent.trim()).join(' '),
    unclaimed: count('.ticket-node.unclaimed'),
    claimed: count('.ticket-node.claimed'),
    closed: count('.ticket-node.closed'),
    body: document.body.innerText.slice(0, 4000),
    width: innerWidth,
  }
})())"""


class Browser:
    def __init__(self, name, width, height, output, env):
        self.name, self.width, self.height, self.output, self.env = name, width, height, output, env
        self.session = f'ship-full-{name}-{os.getpid()}'
        self.shots = []

    def cmd(self, *args, stdin=None, check=True):
        result = subprocess.run([AGENT_BROWSER, '--session', self.session, '--json', *args], input=stdin,
                                capture_output=True, text=True, timeout=120, env=self.env)
        lines = [line for line in result.stdout.splitlines() if line.strip().startswith('{')]
        data = json.loads(lines[-1]) if lines else {'success': False, 'error': result.stderr}
        if check and not data.get('success'):
            raise AssertionError(f'{self.name}: agent-browser {" ".join(args)} failed: {data.get("error")}\n{result.stderr}')
        return data

    def open(self, url):
        self.cmd('open', url)
        self.cmd('set', 'viewport', str(self.width), str(self.height))

    def expand(self):
        # Folded phases hide their tickets: count every node.
        self.cmd('find', 'role', 'button', 'click', '--name', 'Expand all', '--exact')
        time.sleep(0.5)

    def state(self):
        return json.loads(self.cmd('eval', '--stdin', stdin=STATE_JS)['data']['result'])

    def wait(self, predicate, what, seconds=30):
        deadline = time.monotonic() + seconds
        state = None
        while time.monotonic() < deadline:
            state = self.state()
            if predicate(state):
                return state
            time.sleep(0.4)
        raise AssertionError(f'{self.name}: page never showed {what}: {json.dumps(state, ensure_ascii=False)[:1500]}')

    def shot(self, label):
        path = self.output / f'{self.name}-{label}.png'
        self.cmd('screenshot', *(['--full'] if self.width < 800 else []), str(path))
        assert path.exists() and path.stat().st_size > 1000, path
        self.shots.append(str(path))
        return path

    def close(self):
        self.cmd('close', check=False)


def matches_terminal(state, line):
    return (state['connection'] == 'Live · local'
            and {key: state[key] for key in ('unclaimed', 'claimed', 'closed')} == {key: int(line[key]) for key in ('unclaimed', 'claimed', 'closed')}
            and f"{line['recorded']} of {line['total']} decision answers recorded" in state['answers'])


def repository(work, name):
    cwd = work / name
    (cwd / 'src').mkdir(parents=True)
    (cwd / 'src/greet.ts').write_text('export const greeting = "none"\n')
    git(cwd, 'init', '-q', '-b', 'main')
    git(cwd, 'config', 'user.name', 'Ship Host')
    git(cwd, 'config', 'user.email', 'host@example.com')
    git(cwd, 'config', 'commit.gpgsign', 'false')
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-q', '-m', 'init')
    return cwd


def run_state(plugin_data, cwd):
    for path in (plugin_data / 'runs').glob('*.json'):
        value = json.loads(path.read_text())
        if Path(value['cwd']).resolve() == cwd.resolve():
            return path, value
    return None, None


def assert_shipped(cwd, plugin_data, kept=()):
    """Everything the files say after a complete run."""
    spec = (cwd / 'docs/specs/greeting.md').read_text()
    assert git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') == 'main'
    assert git(cwd, 'status', '--porcelain') == '', git(cwd, 'status', '--porcelain')
    assert (cwd / 'src/greet.ts').read_text() == 'export const greeting = "hello and hi"\n'
    for name in ('src/hello.md', 'src/hi.md', 'NOTES.md'):
        assert (cwd / name).exists(), name
    assert 'Status: shipped' in spec and spec.count('- [x] Ticket') == 3, spec
    for issue in sorted((cwd / '.scratch/greeting/issues').glob('*.md')):
        body = issue.read_text()
        assert 'Claim: claimed' in body and 'Proof: green' in body, (issue, body)
    log = git(cwd, 'log', '--format=%s')
    for subject in ('ship: land Ticket 1 — Hello', 'ship: land Ticket 2 — Hi', 'ship: land Ticket 3 — Notes',
                    'ship: tick Ticket 3 — Notes', 'ship: claim landing:3'):
        assert subject in log, (subject, log)
    # Only the worktrees `kept` names (an unreported child's work) remain,
    # their changes still uncommitted there: never merged, never removed.
    trees = [tree for tree in git(cwd, 'worktree', 'list', '--porcelain').split('\n\n') if tree.strip()]
    paths = [re.search(r'^worktree (.+)$', tree, re.M).group(1) for tree in trees[1:]]
    assert sorted(paths) == sorted(str(path) for path in kept), trees
    for path in kept:
        assert git(path, 'status', '--porcelain') != '', path
    branches = git(cwd, 'branch', '--list', 'codsh/*').splitlines()
    assert len(branches) == len(kept), branches
    assert (cwd / '.scratch/greeting/mission.contract.json').exists()
    _, state = run_state(plugin_data, cwd)
    assert state['active'] is False and state['runner'].get('complete') is True, state
    return log


FLOW_NOTES = (
    'Ship · continuing: grill (Status: grilling)',
    'Ship · continuing: spec (Status: interviewing)',
    'Confirmed ship · gate 1/2 automatically; Status is now confirmed and the Mission Contract is sealed.',
    'Ship · continuing: tickets (Status: confirmed)',
    'Confirmed ship · gate 2/2 automatically; Status is now planned.',
    'Ship · landing: dispatching Ticket 1, Ticket 2',
    'conflict-resolution attempt 1/3 did not pass validation (leftover-markers)',
    'conflict resolved; landed and ticked.',
    'Ship · landed Ticket 3',
    'Ship · continuing: final verification (Status: planned)',
    'Ship · shipped: Merge back fast-forwarded main to ship/greeting.',
    'SHIP_COMPLETE_ACK',
)


def in_order(heard, notes):
    """Each note appears, in this order, in what the model heard."""
    joined = '\n'.join(heard)
    positions = [joined.find(flat(note)) for note in notes]
    missing = [note for note, at in zip(notes, positions) if at < 0]
    assert not missing, missing
    assert positions == sorted(positions), list(zip(notes, positions))
    return joined


def full_flow(work, env, plugin_data, output, browsers, results):
    cwd = repository(work, 'full')
    session = Session('full', cwd, env, output)
    try:
        session.wait('Connected to dsh ACP', screen=True)
        session.type(f'/ship {IDEA}\r')
        session.wait('Is the route clear?', screen=True)
        line = session.lines()[-1]
        assert line['where'] == 'WaitingforaShipspecification', line
        url = line['url']
        for browser in browsers:
            browser.open(url)
            browser.wait(lambda s: matches_terminal(s, line), 'the empty live graph')
            browser.shot('1-start')
        session.type('1')
        session.wait('SHIP_COMPLETE_ACK', seconds=300)
        assert session.idle(5), 'the turn kept going after /ship completed'
        # The terminal draws the replies of the phase turns a Stop hook
        # continued, not only the first one (their text lands in the running
        # turn). Past the preview length the client folds that answer block
        # (→ expands it), so the later replies are checked in the trace above.
        for drawn in ('WAYFINDER_DONE', 'GRILL_DONE'):
            session.printed(drawn, 0, seconds=5)
        heard = in_order(session.heard(), FLOW_NOTES)
        conflict = re.search(r'Ship·mergeconflictlandingTicket(\d)\(src/greet\.ts\)', heard)
        assert conflict, 'no merge conflict note'
        results['conflicted_ticket'] = conflict.group(1)
        assert heard.count(flat('SHIP_COMPLETE_ACK')) == 1
        for marker in ('WAYFINDER_DONE', 'GRILL_DONE', 'SPEC_DONEgate=auto', 'TICKETS_DONEgate=auto', 'VERIFIED'):
            assert marker in heard, marker
        children = session.results()
        for marker in ('TICKET_1_DONEerrors=0', 'TICKET_2_DONEerrors=0', 'TICKET_3_DONEerrors=0',
                       'RESOLVER_ATTEMPT_1errors=0', 'RESOLVER_ATTEMPT_2errors=0'):
            assert marker in children, marker
        log = assert_shipped(cwd, plugin_data)
        # Both first-wave children branched from the committed claims (parallel siblings).
        merges = git(cwd, 'log', '--merges', '--format=%H %s').splitlines()
        firsts = [sha for sha, _, subject in (row.partition(' ') for row in merges) if subject.startswith(('ship: land Ticket 1', 'ship: land Ticket 2'))]
        assert len(firsts) == 2, merges
        bases = {git(cwd, 'log', '-1', '--format=%s', f'{sha}^2^') for sha in firsts}
        assert bases == {'ship: claim landing:2'}, bases
        results['full_flow'] = True
        results['full_log'] = log.splitlines()[:40]
        final = session.lines()[-1]
        assert final['where'].startswith('greeting.md·Status:shipped'), final
        assert (final['unclaimed'], final['claimed'], final['closed']) == ('0', '0', '3'), final
        for browser in browsers:
            browser.expand()
            state = browser.wait(lambda s: matches_terminal(s, final) and s['spec'] == 'greeting.md' and s['phase'] == 'Done', 'the shipped graph')
            assert state['width'] == browser.width, state
            browser.shot('2-shipped')
        results['final_line'] = final
        results['browser_matches_terminal'] = True
    finally:
        assert session.close() == 0


def cancel_and_recover(work, env, plugin_data, output, browsers, results):
    cwd = repository(work, 'recover')
    slow = cwd / '.git' / 'codsh-ship-slow'
    slow.write_text('slow\n')
    spec = cwd / 'docs/specs/greeting.md'
    session = Session('recover', cwd, env, output)
    try:
        session.wait('Connected to dsh ACP', screen=True)
        session.type(f'/ship {IDEA}\r')
        session.wait('Is the route clear?', screen=True)
        session.type('1')
        session.wait('Ship · landing: dispatching Ticket 1, Ticket 2', seconds=120)
        # dsh reports a parallel batch only when every call returns: Ticket 2's
        # child finishes its work in its worktree while Ticket 1's child
        # sleeps, and Ctrl+C cancels the wave before any result returns.
        worktrees = work / 'home' / '.codsh-rust' / '.grok' / 'worktrees'
        deadline = time.monotonic() + 60
        while not list(worktrees.glob('*/ship-ticket-2-*/src/hi.md')) and time.monotonic() < deadline:
            session.pump(0.5)
        assert list(worktrees.glob('*/ship-ticket-2-*/src/hi.md')), 'Ticket 2 child never wrote its change'
        session.pump(1.0)
        offset = len(session.data)
        session.type('\x03')
        session.printed('Cancelling turn', offset)
        session.pump(2.0)
        # The finished-but-unreported Ticket 2 work is an unknown side effect: never merged or ticked.
        text = spec.read_text()
        assert '- [ ] Ticket 1: Hello' in text and '- [ ] Ticket 2: Hi' in text, text
        assert (cwd / 'src/greet.ts').read_text() == 'export const greeting = "none"\n'
        assert 'ship: land' not in git(cwd, 'log', '--format=%s')
        for pattern in ('01-*.md', '02-*.md'):
            issue = next((cwd / '.scratch/greeting/issues').glob(pattern)).read_text()
            assert 'Claim: claimed' in issue and 'Proof:' not in issue, issue
        assert session.idle(4), 'a hook continued a cancelled turn'
        left = [Path(path).parent.parent for path in worktrees.glob('*/ship-ticket-2-*/src/hi.md')]
        assert len(left) == 1, left
        results['cancel_merges_nothing'] = True

        # A sealed Mission Contract removed while stopped: the resumed run stops.
        slow.unlink()
        contract = cwd / '.scratch/greeting/mission.contract.json'
        contract.unlink()
        since = session.mark()
        session.type('/ship\r')
        session.wait('Resume docs/specs/greeting.md?', screen=True)
        session.type('1')
        session.wait('Ship · stopped: Sealed Mission Contract is missing or corrupt. Stopped; restore the approved contract.', since=since)
        session.wait('SHIP_STOPPED_ACK', since=since)
        session.printed('SHIP_STOPPED_ACK', 0, seconds=5)
        assert session.idle(4), 'the stopped run kept going'
        assert not contract.exists(), 'the runner recompiled a missing sealed contract'
        # The resumed /ship printed a fresh line: the stopped state as the files hold it.
        stopped = session.lines(since)[-1]
        assert stopped['where'].startswith('greeting.md·Status:planned') and (stopped['unclaimed'], stopped['claimed'], stopped['closed']) == ('1', '2', '0'), stopped
        for browser in browsers:
            browser.open(stopped['url'])
            browser.expand()
            browser.wait(lambda s: matches_terminal(s, stopped) and s['spec'] == 'greeting.md', 'the stopped graph')
            browser.shot('3-stopped')
        git(cwd, 'checkout', '--', '.scratch/greeting/mission.contract.json')
        results['missing_contract_stops'] = True

        # The run state lost as well: the files alone resume the run. The
        # claimed tickets are dispatched again with a notice, never assumed done.
        path, _ = run_state(plugin_data, cwd)
        path.unlink()
        since = session.mark()
        session.type('/ship\r')
        session.wait('Resume docs/specs/greeting.md?', screen=True)
        session.type('1')
        session.wait('Ship · landing: dispatching Ticket 1, Ticket 2', seconds=60, since=since)
        session.wait('SHIP_COMPLETE_ACK', seconds=240, since=since)
        heard = '\n'.join(session.heard(since))
        assert flat('Ticket 1 is claimed but this run has no record of its child; any worktree it left is not merged') in heard, 'no Ticket 1 notice'
        assert flat(f'Ticket 2 is claimed but this run has no record of its child; its earlier worktree {left[0].resolve()} is kept and not merged') in heard, 'no Ticket 2 notice'
        assert flat('Ship · shipped: Merge back fast-forwarded main to ship/greeting.') in heard
        assert session.idle(5)
        assert_shipped(cwd, plugin_data, kept=[left[0].resolve()])
        results['recovered_after_lost_state'] = True
        results['unreported_worktree_kept'] = str(left[0])
        final = session.lines(since)[-1]
        assert (final['unclaimed'], final['claimed'], final['closed']) == ('0', '0', '3'), final
        for browser in browsers:
            browser.expand()
            browser.wait(lambda s: matches_terminal(s, final) and s['phase'] == 'Done', 'the recovered graph')
            browser.shot('4-recovered')
        results['recovered_browser_matches_terminal'] = True
    finally:
        assert session.close() == 0


def main():
    assert AGENT_BROWSER, 'set AGENT_BROWSER to the agent-browser CLI or put agent-browser on PATH'
    assert (ROOT / 'packages/cli/extensions/ship/hooks/ship-hook.mjs').exists(), 'run pnpm run build:rust first'
    prefix = os.environ.get('CODSH_SHIP_FULL_TMP_PREFIX', 'codsh-rust-ship-full-')
    output = Path(tempfile.mkdtemp(prefix=prefix, dir='/tmp'))
    dsh = dsh_bin()
    browser_env = {**os.environ, 'AGENT_BROWSER_NAMESPACE': f'codsh-ship-full-{os.getpid()}', 'AGENT_BROWSER_IDLE_TIMEOUT': '15m'}
    browser_env.pop('AGENT_BROWSER_HEADED', None)
    desktop = Browser('desktop', 1440, 900, output, browser_env)
    mobile = Browser('mobile', 390, 844, output, browser_env)
    results = {}
    try:
        # CODSH_SHIP_FULL_KEEP=1 keeps the temp home (dsh logs, worktrees) for debugging.
        keep = os.environ.get('CODSH_SHIP_FULL_KEEP') == '1'
        with tempfile.TemporaryDirectory(prefix=f'{prefix}home-', dir='/tmp', delete=not keep) as temporary:
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
                'DSH_CODE_CLI_MOCK_TOOL': 'ship-full',
                'GIT_CONFIG_NOSYSTEM': '1',
            }
            plugin_data = home / '.codsh-rust' / '.grok' / 'plugin-data' / 'ship'
            cli = lambda *args: run([NODE, str(LAUNCHER), '--rust', *args], cwd=work, env=env).stdout
            assert 'Installed 1 plugin(s) from bundled:ship: ship' in cli('plugin', 'install', 'bundled:ship', '--trust')
            enabled = cli('plugin', 'enable', 'ship')
            assert 'Enabled plugin: ship [active]' in enabled and 'Provides 1 command · 7 hooks' in enabled, enabled
            only = os.environ.get('CODSH_SHIP_FULL_ONLY', '')
            if only in ('', 'full'):
                full_flow(work, env, plugin_data, output, (desktop, mobile), results)
            if only in ('', 'recover'):
                cancel_and_recover(work, env, plugin_data, output, (desktop, mobile), results)
    finally:
        for browser in (desktop, mobile):
            browser.close()
    print(json.dumps({'output': str(output), **results,
                      'screenshots': desktop.shots + mobile.shots}, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
