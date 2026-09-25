#!/usr/bin/env python3
"""Ship extension browser graph in a real terminal and a real browser (ticket 196).

Drives real dsh through the repo launcher (the rust-acp mock replays the
ship-wayfinder scenario with a local wayfinder map) and, at each step, a
headless Chromium through agent-browser at a desktop (1440x900) and a mobile
(390x844) viewport, both left open on the same URL for the whole run:

- `/ship` prints one `Ship graph · ...` line with the loopback URL; the page
  at `/<token>/` and `/<token>/index.html` shows the same Status, 待认领 /
  已认领 / 已关闭 counts, and recorded answers as the terminal line, first
  empty (no spec yet), then live as the ledger, tickets, and answers land.
- Clicks: context and phase navigation, Expand all / Collapse all, a phase's
  own fold button, a ticket and its Blocked-by relation, a decision card;
  a long answer scrolls inside its card; an unanswered question and a ticket
  never asked read "No user answer recorded".
- Leaving the session closes the port and the pages keep the last graph
  ("Disconnected · retrying"); `--continue` reopens the same URL and both
  pages reconnect by themselves with every answer; a corrupt or deleted
  graph cache loses nothing and the next hook rewrites it; uninstalling the
  plugin stops the server.

Screenshots land in the printed output directory. Needs `pnpm run build:rust`
and the agent-browser CLI (not a repo dependency): set AGENT_BROWSER to its
binary or put `agent-browser` on PATH; it drives its own Chrome for Testing
or AGENT_BROWSER_EXECUTABLE_PATH. All homes are temp dirs; nothing touches
your desktop browser.
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
import socket
import struct
import subprocess
import tempfile
import termios
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
LAUNCHER = ROOT / 'packages/cli/bin/codsh.mjs'
AGENT_BROWSER = os.environ.get('AGENT_BROWSER') or shutil.which('agent-browser')
IDEA = 'MAP_WAYFINDER Build an offline-first field notes app'
LINE = re.compile(r'Shipgraph·(?P<where>.*?)·待认领(?P<unclaimed>\d+)·已认领(?P<claimed>\d+)·已关闭(?P<closed>\d+)·'
                  r'(?P<recorded>\d+)of(?P<total>\d+)decisionanswersrecorded·(?P<url>http://127\.0\.0\.1:\d+/[0-9a-f]{32}/)')


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


def flatten(shown):
    """The screen as one line: the two-column gutter and all whitespace gone, so wrapping is ignored."""
    return re.sub(r'\s+', '', ''.join(line[2:] for line in shown.splitlines()))


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
    def __init__(self, name, cwd, env, output, extra=(), rows=100, cols=240):
        self.name, self.output, self.rows, self.cols = name, output, rows, cols
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.process = subprocess.Popen([NODE, str(LAUNCHER), '--rust', '--trust', '--always-approve', *extra],
                                        cwd=cwd, env=env, stdin=self.slave, stdout=self.slave,
                                        stderr=self.slave, start_new_session=True)
        self.data = bytearray()
        # Every `Ship graph · ...` line seen on screen, oldest first. Hook
        # lines join the turn's answer block above its tool calls, so the
        # screen is tall enough to keep a whole turn in view.
        self.lines = []

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
        shown = screen_text(bytes(self.data), self.rows, self.cols)
        for match in LINE.finditer(flatten(shown)):
            line = match.groupdict()
            if not self.lines or self.lines[-1] != line:
                self.lines.append(line)
        return shown

    def wait(self, text, seconds=60):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump(0.3)
            shown = self.screen()
            # A marker may wrap: hook notes share the turn's answer paragraph.
            if text in shown or re.sub(r'\s+', '', text) in flatten(shown):
                return shown
            if self.process.poll() is not None:
                break
        raise AssertionError(f'{self.name}: missing {text!r}\n{self.screen()}')

    def wait_line(self, predicate, seconds=60):
        """The newest `Ship graph · ...` terminal line seen that matches predicate (wrapping ignored)."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump(0.3)
            self.screen()
            found = [line for line in self.lines if predicate(line)]
            if found:
                return found[-1]
            if self.process.poll() is not None:
                break
        raise AssertionError(f'{self.name}: no matching Ship graph line\n{self.screen()}')

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


STATE_JS = r"""JSON.stringify((() => {
  const text = sel => document.querySelector(sel)?.textContent?.trim() ?? null
  const count = sel => document.querySelectorAll(sel).length
  return {
    url: location.href,
    connection: text('.connection'),
    notice: text('.connection-notice'),
    spec: text('.spec-name'),
    phase: text('.current-phase-badge'),
    answers: [...document.querySelectorAll('.context-nav p')].map(p => p.textContent.trim()).join(' '),
    title: text('h1'),
    unclaimed: count('.ticket-node.decision.unclaimed'),
    claimed: count('.ticket-node.decision.claimed'),
    closed: count('.ticket-node.decision.closed'),
    folds: [...document.querySelectorAll('button.fold')].map(b => b.getAttribute('aria-expanded')),
    details: text('.details-section'),
    heading: text('.details-section h3'),
    width: innerWidth,
    height: innerHeight,
  }
})())"""


class Browser:
    """One agent-browser session (headless Chromium) at one viewport."""

    def __init__(self, name, width, height, output, env):
        self.name, self.width, self.height, self.output, self.env = name, width, height, output, env
        self.session = f'ship-web-{name}'
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

    def js(self, source):
        return json.loads(self.cmd('eval', '--stdin', stdin=source)['data']['result'])

    def state(self):
        return self.js(STATE_JS)

    def wait(self, predicate, what, seconds=30):
        deadline = time.monotonic() + seconds
        state = None
        while time.monotonic() < deadline:
            state = self.state()
            if predicate(state):
                return state
            time.sleep(0.4)
        raise AssertionError(f'{self.name}: page never showed {what}: {json.dumps(state, ensure_ascii=False)}')

    def button(self, name):
        self.cmd('find', 'role', 'button', 'click', '--name', name, '--exact')
        time.sleep(0.5)

    def click(self, selector):
        # Never scrollIntoView a node inside the canvas: that scrolls React
        # Flow's clipped pane under the pointer. Bring the canvas section into
        # the page view instead (the mobile page scrolls), then click.
        if self.js(f"JSON.stringify(!!document.querySelector({json.dumps(selector)})?.closest('.canvas-section'))"):
            self.cmd('scrollintoview', '.canvas-section')
        else:
            self.cmd('scrollintoview', selector)
        self.cmd('click', selector)
        time.sleep(0.5)

    def mark(self, selector, needle, name):
        """Tag the element matching selector whose text contains needle, for a real click."""
        found = self.js(f"JSON.stringify((() => {{ const n = [...document.querySelectorAll({json.dumps(selector)})]"
                        f".find(e => e.textContent.includes({json.dumps(needle)})); if (!n) return false; "
                        f"n.setAttribute('data-test', {json.dumps(name)}); return true }})())")
        assert found, f'{self.name}: no {selector} containing {needle!r}'
        return f'[data-test="{name}"]'

    def reveal_wayfinder(self):
        """Fit the canvas to the Wayfinder phase (its tickets and answer cards)."""
        self.button('01 Wayfinder')
        time.sleep(1.0)

    def shot(self, label):
        path = self.output / f'{self.name}-{label}.png'
        # The mobile page scrolls (node details sit below the graph): keep all of it.
        self.cmd('screenshot', *(['--full'] if self.width < 800 else []), str(path))
        assert path.exists() and path.stat().st_size > 1000, path
        self.shots.append(str(path))
        return path

    def close(self):
        self.cmd('close', check=False)


def http(url, host=None):
    request = urllib.request.Request(url, headers={'Host': host} if host else {})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, ''
    except (urllib.error.URLError, ConnectionError, socket.timeout):
        return 0, ''


def port_open(port):
    with socket.socket() as probe:
        probe.settimeout(1)
        return probe.connect_ex(('127.0.0.1', port)) == 0


def wait_closed(port, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not port_open(port):
            return True
        time.sleep(0.2)
    return False


def counts(line):
    return {key: int(line[key]) for key in ('unclaimed', 'claimed', 'closed')}


def matches_terminal(state, line):
    """The page shows what the terminal line says."""
    return (state['connection'] == 'Live · local'
            and {key: state[key] for key in ('unclaimed', 'claimed', 'closed')} == counts(line)
            and f"{line['recorded']} of {line['total']} decision answers recorded" in state['answers'])


def explore_map(browser, results):
    """Click through the mapped graph; the checks CONTRIBUTING lists for the Web panorama."""
    name = browser.name
    browser.button('Expand all')
    state = browser.state()
    assert state['folds'] and all(value == 'true' for value in state['folds']), state
    browser.shot('mapped')
    # Collapse all hides every ticket; a phase's own fold button reopens only that phase.
    browser.button('Collapse all')
    state = browser.wait(lambda s: all(v == 'false' for v in s['folds']) and s['unclaimed'] + s['claimed'] + s['closed'] == 0, 'all phases collapsed')
    # Fold buttons live on the canvas: fit every collapsed phase into view first.
    browser.button('Fit view')
    time.sleep(0.8)
    browser.shot('collapsed')
    browser.click('button.fold[aria-label="Expand Wayfinder"]')
    state = browser.wait(lambda s: s['folds'][0] == 'true' and s['closed'] == 2, 'Wayfinder reopened by its fold button')
    assert all(value == 'false' for value in state['folds'][1:]), state
    browser.click('button.fold[aria-label="Collapse Wayfinder"]')
    browser.wait(lambda s: s['folds'][0] == 'false', 'Wayfinder collapsed by its fold button')
    # Phase navigation expands a collapsed phase and selects it.
    browser.button('01 Wayfinder')
    browser.wait(lambda s: s['folds'][0] == 'true' and 'Wayfinder' in (s['details'] or ''), 'phase navigation')
    browser.button('Expand all')
    # Context navigation: the original requirement, verbatim.
    browser.button('Original requirement')
    browser.wait(lambda s: IDEA in (s['details'] or ''), 'the original requirement in node details')
    browser.button('Ship goal')
    browser.wait(lambda s: IDEA in (s['details'] or ''), 'the Ship goal in node details')
    # A ticket, its Blocked-by relations, and following one.
    browser.reveal_wayfinder()
    browser.click('.ticket-node[title="Sync policy"]')
    state = browser.wait(lambda s: s['heading'] == 'Sync policy', 'ticket details')
    relations = browser.js("JSON.stringify([...document.querySelectorAll('.details-section .relations button')].map(b => b.textContent.trim()))")
    # Blocked by 1 and 2; blocks 4 (the Blocked-by chain the tickets declare).
    assert relations == ['decision:local:1', 'decision:local:2', 'decision:local:4'], relations
    assert 'Blocked by' in (state['details'] or ''), state
    browser.shot('ticket')
    browser.click(browser.mark('.details-section .relations button', 'decision:local:2', 'relation'))
    browser.wait(lambda s: s['heading'] == 'Storage choice', 'relation navigation')
    # The long answer scrolls inside its card and reads in full in the details.
    browser.reveal_wayfinder()
    long_card = browser.mark('.answer-node.answered .node-content', 'Line 12:', 'long')
    browser.cmd('scrollintoview', '.canvas-section')
    sizes = browser.js(f"JSON.stringify((n => [n.scrollHeight, n.clientHeight, n.scrollTop])(document.querySelector({json.dumps(long_card)})))")
    assert sizes[0] > sizes[1] and sizes[2] == 0, sizes
    # The card is a focusable scroll area: keyboard scrolling reaches the rest.
    browser.cmd('focus', long_card)
    browser.cmd('press', 'PageDown')
    time.sleep(0.6)
    scrolled = browser.js(f"JSON.stringify(document.querySelector({json.dumps(long_card)}).scrollTop)")
    assert scrolled > 0, f'{name}: the long answer did not scroll ({scrolled})'
    browser.shot('long-answer')
    browser.click('[aria-label="Inspect decision: Which local store keeps field notes available offline?"]')
    browser.wait(lambda s: 'Line 12:' in (s['details'] or ''), 'the full long answer in node details')
    # A question with no answer, and a ticket never asked.
    missing = browser.js("JSON.stringify([...document.querySelectorAll('.answer-node.unanswered')].map(n => n.textContent))")
    assert any('How should conflicting offline edits be merged?' in item and 'No user answer recorded' in item for item in missing), missing
    assert any('Offline prototype' in item and 'No user answer recorded' in item for item in missing), missing
    browser.click('[aria-label="Inspect decision: How should conflicting offline edits be merged?"]')
    browser.wait(lambda s: 'No user answer recorded' in (s['details'] or ''), 'the unanswered question in node details')
    browser.shot('missing-answer')
    labels = browser.js("JSON.stringify(document.body.innerText)")
    for label in ('Expand all', 'Collapse all', 'Fit view', 'Ship context', 'Ship workflow', 'Node details', 'Current phase'):
        assert label in labels, label
    browser.button('Fit view')
    results[f'{name}_explored'] = True


def main():
    assert AGENT_BROWSER, 'set AGENT_BROWSER to the agent-browser CLI or put agent-browser on PATH'
    assert (ROOT / 'packages/cli/extensions/ship/hooks/ship-web.mjs').exists(), 'run pnpm run build:rust first'
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-ship-web-', dir='/tmp'))
    dsh = dsh_bin()
    browser_env = {**os.environ, 'AGENT_BROWSER_NAMESPACE': f'codsh-ship-web-{os.getpid()}', 'AGENT_BROWSER_IDLE_TIMEOUT': '15m'}
    browser_env.pop('AGENT_BROWSER_HEADED', None)
    desktop = Browser('desktop', 1440, 900, output, browser_env)
    mobile = Browser('mobile', 390, 844, output, browser_env)
    try:
        scenario(desktop, mobile, output, dsh)
    finally:
        for browser in (desktop, mobile):
            browser.close()


def scenario(desktop, mobile, output, dsh):
    browsers = (desktop, mobile)
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-ship-web-home-', dir='/tmp') as temporary:
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
        plugin_data = home / '.codsh-rust' / '.grok' / 'plugin-data' / 'ship'
        cwd = work / 'workspace'
        (cwd / '.git').mkdir(parents=True)
        spec = cwd / 'docs/specs/wayfinder-e2e.md'
        cache = spec.with_name('wayfinder-e2e.ship.graph.json')
        answers = spec.with_name('wayfinder-e2e.ship.answers.json')
        cli = lambda *args: run([NODE, str(LAUNCHER), '--rust', *args], cwd=cwd, env=env).stdout
        installed = cli('plugin', 'install', 'bundled:ship', '--trust')
        assert 'Installed 1 plugin(s) from bundled:ship: ship' in installed, installed
        enabled = cli('plugin', 'enable', 'ship')
        assert 'Enabled plugin: ship [active]' in enabled and 'Provides 1 command · 4 hooks' in enabled, enabled

        session = Session('ship', cwd, env, output)
        try:
            session.wait('Connected to dsh ACP')
            # 1. /ship: one terminal line with the URL; the page is empty but live.
            session.type(f'/ship {IDEA}\r')
            session.wait('Is the route clear?')
            line = session.wait_line(lambda l: l['where'] == 'WaitingforaShipspecification')
            url = line['url']
            port = int(url.split(':')[2].split('/')[0])
            token = url.rstrip('/').rsplit('/', 1)[1]
            results['url_printed'] = True
            assert http(url)[0] == 200 and http(f'{url}index.html')[0] == 200
            assert http(f'http://127.0.0.1:{port}/')[0] == 404
            assert http(f'http://127.0.0.1:{port}/graph.json')[0] == 404
            assert http(f'{url}graph.json', host=f'rebind.example:{port}')[0] == 421
            record = json.loads(next((plugin_data / 'web').glob('*.json')).read_text())
            assert record['token'] == token and oct(next((plugin_data / 'web').glob('*.json')).stat().st_mode & 0o777) == '0o600'
            server_pid = record['pid']
            results['access_boundary'] = True
            desktop.open(url)
            mobile.open(f'{url}index.html')
            for browser in browsers:
                state = browser.wait(lambda s: matches_terminal(s, line), 'the empty live graph')
                assert state['spec'] == 'Waiting for a Ship specification' and state['phase'] == 'Phase not recorded', state
                assert state['title'] == IDEA and state['width'] == browser.width, state
                browser.button('Original requirement')
                browser.wait(lambda s: IDEA in (s['details'] or ''), 'the typed original before the ledger')
                browser.button('02 Grill')
                browser.wait(lambda s: 'Grill' in (s['details'] or ''), 'an empty phase in node details')
                browser.shot('empty')
            results['empty_graph_matches_terminal'] = True

            # 2. Route answered: the ledger and a local map land while the next card waits.
            session.type('1')
            session.wait('Keep the append-only log?')
            line = session.wait_line(lambda l: l['total'] == '4' and l['unclaimed'] == '1')
            assert line['where'] == 'wayfinder-e2e.md·Status:wayfinding' and line['url'] == url, line
            assert counts(line) == {'unclaimed': 1, 'claimed': 1, 'closed': 2} and line['total'] == '4', line
            for browser in browsers:
                browser.button('Expand all')
                state = browser.wait(lambda s: matches_terminal(s, line), 'the live map (no reload)')
                # Two closed tickets do not make the phase complete: the ledger says wayfinding.
                assert state['spec'] == 'wayfinder-e2e.md' and state['phase'] == 'Wayfinder', state
                explore_map(browser, results)
            results['live_map_matches_terminal'] = True

            # 3. The next answer appears live in both pages.
            session.type('1')
            session.wait('WAYFINDER_MAPPED original=MAP_WAYFINDER')
            line = session.wait_line(lambda l: l['recorded'] == '3')
            assert line['total'] == '5', line
            for browser in browsers:
                browser.wait(lambda s: matches_terminal(s, line), 'the third answer, live')
            session_line = line
        finally:
            assert session.close() == 0

        # 4. Leaving the session closes the port; the pages keep the last graph.
        assert wait_closed(port), 'the browser graph server outlived its session'
        for browser in browsers:
            browser.wait(lambda s: s['connection'] == 'Disconnected · retrying'
                         and 'Showing the last received graph' in (s['notice'] or '')
                         and s['spec'] == 'wayfinder-e2e.md' and '3 of 5 decision answers recorded' in s['answers'],
                         'the disconnected page with the last graph')
            browser.shot('disconnected')
        results['session_exit_closes'] = True

        # 5. Resume: the same URL comes back and both open pages reconnect by themselves.
        resumed = Session('resumed', cwd, env, output, extra=['--continue'])
        try:
            resumed.wait('Connected to dsh ACP')
            line = resumed.wait_line(lambda l: l['url'] == url)
            assert counts(line) == counts(session_line) and line['recorded'] == '3', line
            for browser in browsers:
                state = browser.wait(lambda s: matches_terminal(s, line), 'the reconnected page')
                assert state['url'].startswith(url), state
                browser.shot('resumed')
            results['resume_reconnects_same_url'] = True

            # 6. A corrupt cache is not a source; the next hook rewrites it with every answer.
            cache.write_text('{ corrupt')
            time.sleep(2.5)
            for browser in browsers:
                assert matches_terminal(browser.state(), line), browser.state()
            resumed.type('/ship\r')
            resumed.wait('Resume the pending research?')
            resumed.type('1')
            resumed.wait('WAYFINDER_RESUMED original=MAP_WAYFINDER')
            line = resumed.wait_line(lambda l: l['recorded'] == '4')
            assert line['total'] == '6' and line['url'] == url, line
            rebuilt = json.loads(cache.read_text())
            ids = {row['id'] for row in rebuilt['answers']}
            assert {'route', 'storage', 'resume', 'decision:local:2', 'decision:local:3'} <= ids, ids
            assert rebuilt['status'] == 'wayfinding', rebuilt['status']
            recorded = {row['id'] for row in json.loads(answers.read_text())['answers']}
            assert {'route', 'storage', 'resume', 'decision:local:2'} <= recorded, recorded
            cache.unlink()
            time.sleep(2.5)
            for browser in browsers:
                browser.wait(lambda s: matches_terminal(s, line), 'every answer after the cache was deleted')
                browser.shot('rebuilt')
            results['cache_rebuild_keeps_answers'] = True

            # 7. Uninstalling the plugin (and its data) stops the server.
            record = json.loads(next((plugin_data / 'web').glob('*.json')).read_text())
            resumed_pid = record['pid']
            removed = cli('plugin', 'uninstall', 'ship', '--confirm')
            assert 'ship' in removed, removed
            assert not plugin_data.exists(), 'plugin data survived uninstall'
            assert wait_closed(port), 'the browser graph server outlived the uninstall'
            for browser in browsers:
                browser.wait(lambda s: s['connection'] == 'Disconnected · retrying', 'the page after uninstall')
                browser.shot('uninstalled')
            results['uninstall_stops_server'] = True
        finally:
            resumed.close()
        for pid in (server_pid, resumed_pid):
            try:
                os.kill(pid, 0)
                raise AssertionError(f'ship web server {pid} is still running')
            except ProcessLookupError:
                pass
        print(json.dumps({'output': str(output), **results,
                          'screenshots': [shot for browser in browsers for shot in browser.shots]}, indent=2))


if __name__ == '__main__':
    main()
