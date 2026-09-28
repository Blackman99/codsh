#!/usr/bin/env python3
"""Interaction performance of the installed Rust client against the frozen reference (#202).

One `bench` run on one machine:

1. measures the pinned reference (Grok 1.0.34, SHA-256 checked, never
   redistributed) in both screen modes: cold and warm start, typing, a large
   paste, a long streamed answer, scroll, resize, repeated open/close and
   process-tree memory;
2. freezes numeric thresholds from those samples with the method recorded in
   docs/rewrite/reference/baseline.json, writes thresholds.json and logs its
   SHA-256 *before* any candidate process is started;
3. measures the installed candidate (`codsh --rust` from the packed tarball,
   dsh from the registry) with the same terminal, fixture and data,
   alternating with reference control sessions, and judges it against the
   frozen file only.

Both products talk to one loopback model fixture, so model/network time (the
fixture's own request and stream timestamps) is reported apart from client
and adapter overhead. Everything runs in fresh temporary Homes; nothing
reaches the network.
"""
import argparse
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import pty
import select
import shutil
import signal
import statistics
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

import pyte

REFERENCE_VERSION = '1.0.34 (3736acbc8658)'
REFERENCE_SHA256 = '9cd26b579840f0f5c9148a8059ad651904c08b41b7f2ef0b4ec04b9ba898844e'
MODEL = 'perf-fixture'
ROWS, COLS = 32, 100
NARROW = (24, 80)
LONG_LINES = 1000
PASTE_LINES = 2000
DRAFT = 'PERFDRAFT7'
PASTE_MARK = 'PERFPASTE9'
LONG_PROMPT = 'PERF_LONG'
END_MARK = 'PERF_STREAM_END'
FRAME_WAIT = 2.0

# The frozen method from docs/rewrite/reference/baseline.json (thresholdPolicy).
METHOD = {
    'latency': 'ceiling = max(reference p95 * 1.20, reference p95 + 16.7 ms); candidate p95 must not exceed it',
    'throughput': 'floor = reference median * 0.90; candidate median must reach it',
    'resources': 'ceiling = reference p95 * 1.20; candidate p95 must not exceed it',
    'observed': 'a metric the reference produced in every valid run must be produced by the candidate too',
    'notApplicable': 'a metric the reference did not produce in every valid run gets no threshold',
}
LATENCY = ('start:first-output', 'start:ready', 'cold:first-output', 'cold:ready', 'input:draft',
           'input:paste', 'output:first-visible', 'output:end-after-model', 'scroll:page-up',
           'scroll:page-down', 'resize:narrow', 'resize:wide', 'quit:exit')
THROUGHPUT = ('output:throughput',)
RESOURCES = ('rss:tree-peak',)
# Reported, not judged: model-fixture time, or measurements only one product has.
BREAKDOWN = ('output:submit-to-request', 'output:model-stream', 'start:connected', 'rss:client-peak',
             'output:bytes', 'paste:bytes', 'outputBytes')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def p95(samples):
    ordered = sorted(samples)
    return ordered[max(0, -(-len(ordered) * 95 // 100) - 1)]


def now_ms():
    return time.perf_counter_ns() / 1e6


class Fixture:
    """Loopback OpenAI-compatible model; records when each answer was served."""

    def __init__(self):
        self.requests = []
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_):
                pass

            def reply_json(self, payload):
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                self.reply_json({'object': 'list', 'data': [{'id': MODEL, 'object': 'model'}]})

            def do_POST(self):
                received = now_ms()
                raw = self.rfile.read(int(self.headers.get('content-length', 0) or 0))
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = {}
                messages = body.get('messages') or []
                last = next((m for m in reversed(messages) if isinstance(m, dict) and m.get('role') == 'user'), {})
                content = last.get('content')
                if isinstance(content, list):
                    content = ' '.join(part.get('text', '') for part in content if isinstance(part, dict))
                # Only the agent's turn request (it carries tools) gets the long answer; a
                # title request for the same prompt gets a short one.
                long_answer = LONG_PROMPT in str(content or '') and bool(body.get('tools'))
                record = {'path': self.path, 'receivedMs': received, 'long': long_answer,
                          'stream': bool(body.get('stream')), 'tools': len(body.get('tools') or [])}
                pieces = ([f'PERF_LINE_{i:04d} lorem ipsum dolor sit amet, consectetur adipiscing elit\n\n'
                           for i in range(1, LONG_LINES + 1)] + [f'{END_MARK}\n'] if long_answer else ['PERF_OK'])
                record['contentBytes'] = sum(len(piece.encode()) for piece in pieces)
                if not body.get('stream'):
                    record['firstChunkMs'] = now_ms()
                    self.reply_json({'id': 'perf', 'object': 'chat.completion', 'created': 0, 'model': MODEL,
                                     'choices': [{'index': 0, 'finish_reason': 'stop',
                                                  'message': {'role': 'assistant', 'content': ''.join(pieces)}}],
                                     'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}})
                    record['lastChunkMs'] = now_ms()
                    fixture.requests.append(record)
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Connection', 'close')
                self.end_headers()

                def event(delta, finish=None, usage=None):
                    chunk = {'id': 'perf', 'object': 'chat.completion.chunk', 'created': 0, 'model': MODEL,
                             'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                    if usage:
                        chunk['usage'] = usage
                    self.wfile.write(f'data: {json.dumps(chunk)}\n\n'.encode())
                    self.wfile.flush()

                try:
                    event({'role': 'assistant', 'content': ''})
                    record['firstChunkMs'] = now_ms()
                    for piece in pieces:
                        event({'content': piece})
                    event({}, 'stop', {'prompt_tokens': 1, 'completion_tokens': len(pieces),
                                       'total_tokens': 1 + len(pieces)})
                    self.wfile.write(b'data: [DONE]\n\n')
                    self.wfile.flush()
                except OSError:
                    record['aborted'] = True
                record['lastChunkMs'] = now_ms()
                fixture.requests.append(record)
                self.close_connection = True

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Reference:
    name = 'reference'
    ready_mark = MODEL

    def __init__(self, binary):
        self.binary = Path(binary).resolve(strict=True)
        digest = sha256(self.binary.read_bytes())
        if digest != REFERENCE_SHA256:
            raise SystemExit(f'reference SHA-256 {digest} is not the pinned {REFERENCE_SHA256}')

    def prepare(self, root, port):
        home = root / 'home'
        (home / '.grok').mkdir(parents=True)
        (home / '.grok/config.toml').write_text(f'''[cli]
auto_update = false
use_leader = false
show_tips = false
[features]
remote_fetch = false
telemetry = false
managed_config = false
non_git_warning = false
[memory]
enabled = false
[models]
default = "{MODEL}"
[model.{MODEL}]
model = "{MODEL}"
base_url = "http://127.0.0.1:{port}/v1"
api_key = "synthetic-perf-key"
context_window = 128000
''')
        return {
            'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(home), 'GROK_HOME': str(home / '.grok'),
            'TMPDIR': str(root), 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8',
            'GROK_DISABLE_AUTOUPDATER': '1', 'GROK_TELEMETRY_ENABLED': '0', 'GROK_TELEMETRY_TRACE_UPLOAD': '0',
            'GROK_REMOTE_FETCH': '0', 'GROK_USE_LEADER': '0', 'GROK_MANAGED_MCPS_ENABLED': '0',
            'XAI_API_KEY': 'synthetic-perf-key',
        }

    def argv(self, mode):
        return [str(self.binary), f'--{mode}']

    def client_names(self):
        return {self.binary.name}


class Candidate:
    name = 'candidate'
    ready_mark = MODEL

    def __init__(self, launcher, dsh, node):
        self.launcher = Path(launcher).resolve(strict=True)
        self.dsh = dsh
        self.node = node

    def prepare(self, root, port):
        home = root / 'home'
        grok = home / '.codsh-rust/.grok'
        grok.mkdir(parents=True)
        (grok / 'config.toml').write_text(f'''[models]
default = "{MODEL}"

[model.{MODEL}]
name = "{MODEL}"
model = "{MODEL}"
base_url = "http://127.0.0.1:{port}/v1"
env_key = "PERF_API_KEY"
api_backend = "chat_completions"
''')
        env = {
            'PATH': f'{Path(self.node).parent}:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(home),
            'TMPDIR': str(root), 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8', 'PERF_API_KEY': 'synthetic-perf-key',
            'CODSH_UPDATE_CHECK': 'off', 'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
        }
        if self.dsh:
            env['DSH_BIN'] = self.dsh
        return env

    def argv(self, mode):
        return [self.node, str(self.launcher), '--rust', f'--{mode}']

    def client_names(self):
        return {'codsh-rust'}


def process_table():
    rows = subprocess.run(['ps', '-A', '-o', 'pid=,ppid=,rss=,comm='], capture_output=True, text=True).stdout
    table = {}
    for line in rows.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4 and parts[0].isdigit() and parts[1].isdigit() and parts[2].isdigit():
            table[int(parts[0])] = (int(parts[1]), int(parts[2]), os.path.basename(parts[3].strip()))
    return table


def tree(root_pid):
    table = process_table()
    children = {}
    for pid, (ppid, _, _) in table.items():
        children.setdefault(ppid, []).append(pid)
    found, todo = [], [root_pid]
    while todo:
        pid = todo.pop()
        if pid in table:
            found.append(pid)
        todo.extend(children.get(pid, []))
    return found, table


class Session:
    """One product in a PTY; a reader thread timestamps every chunk on arrival."""

    def __init__(self, argv, env, cwd, rows=ROWS, cols=COLS):
        self.started = now_ms()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                os.chdir(cwd)
                os.execve(argv[0], argv, env)
            finally:
                os._exit(127)
        self.resize_pty(rows, cols, signal_child=False)
        self.chunks = []
        self.lock = threading.Lock()
        self.alive = True
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.fed = 0
        self.status = None
        self.samples = []

    def _read(self):
        while self.alive:
            try:
                ready = select.select([self.fd], [], [], 0.05)[0]
            except (OSError, ValueError):
                return
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            at = now_ms()
            # Terminal queries the products send at startup.
            for query, reply in ((b'\x1b[6n', b'\x1b[1;1R'), (b'\x1b[c', b'\x1b[?1;2c'), (b'\x1b[?u', b'\x1b[?0u')):
                if query in chunk:
                    try:
                        os.write(self.fd, reply)
                    except OSError:
                        pass
            with self.lock:
                self.chunks.append((at, chunk))

    def resize_pty(self, rows, cols, signal_child=True):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        if signal_child:
            try:
                os.kill(self.pid, signal.SIGWINCH)
            except OSError:
                pass

    def text(self):
        return '\n'.join(self.screen.display)

    def wait(self, predicate, seconds, since=None):
        """Arrival time (ms since launch) of the chunk after which predicate(screen) first held."""
        deadline = time.monotonic() + seconds
        while True:
            with self.lock:
                pending = self.chunks[self.fed:]
            for at, chunk in pending:
                self.stream.feed(chunk)
                self.fed += 1
                if (since is None or at >= since) and predicate(self.text()):
                    return at - self.started
            if not pending and (time.monotonic() > deadline or self.exited()):
                return None
            if not pending:
                time.sleep(0.005)

    def next_output(self, since, seconds=FRAME_WAIT):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            with self.lock:
                later = [at for at, _ in self.chunks if at > since]
            if later:
                return later[0] - since
            time.sleep(0.005)
        return None

    def drain(self, seconds):
        time.sleep(seconds)
        self.wait(lambda _: False, 0)

    def send(self, data):
        at = now_ms()
        view = memoryview(data)
        while view:
            written = os.write(self.fd, view[:4096])
            view = view[written:]
        return at

    def output_bytes(self):
        with self.lock:
            return sum(len(chunk) for _, chunk in self.chunks)

    def raw(self):
        with self.lock:
            return b''.join(chunk for _, chunk in self.chunks)

    def sample(self, names):
        pids, table = tree(self.pid)
        self.samples.append({
            'tree': sum(table[pid][1] for pid in pids),
            'client': sum(table[pid][1] for pid in pids if table[pid][2] in names),
            'processes': len(pids),
        })

    def exited(self):
        if self.status is not None:
            return True
        waited, status = os.waitpid(self.pid, os.WNOHANG)
        if waited:
            self.status = status
            return True
        return False

    def close(self):
        if not self.exited():
            for target in (lambda: os.killpg(os.getpgid(self.pid), signal.SIGKILL), lambda: os.kill(self.pid, signal.SIGKILL)):
                try:
                    target()
                except OSError:
                    pass
            _, self.status = os.waitpid(self.pid, 0)
        self.alive = False
        self.reader.join(timeout=1)
        try:
            os.close(self.fd)
        except OSError:
            pass


def purge_caches(enabled):
    # Only on a disposable macOS runner: it drops the whole machine's file cache.
    if enabled and platform.system() == 'Darwin' and shutil.which('purge'):
        return subprocess.run(['sudo', '-n', 'purge'], capture_output=True).returncode == 0
    return False


def quit_session(session, run):
    before, _ = tree(session.pid)
    sent = session.send(b'/quit\r')
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and not session.exited():
        time.sleep(0.005)
    if session.exited():
        run['quit:exit'] = now_ms() - sent
    else:
        run.setdefault('missing', []).append('quit:exit')
    time.sleep(1.0)
    table = process_table()
    leftovers = [pid for pid in before if pid != session.pid and pid in table]
    run['leftoverProcesses'] = [table[pid][2] for pid in leftovers]
    for pid in leftovers:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def start_run(subject, mode, env, cwd, purge):
    """A cold start: fresh Home, file cache purged; first output, ready frame, quit."""
    run = {'subject': subject.name, 'mode': mode, 'kind': 'cold', 'cachesPurged': purge_caches(purge), 'missing': []}
    session = Session(subject.argv(mode), env, cwd)
    try:
        ready = session.wait(lambda text: subject.ready_mark in text, 30)
        with session.lock:
            first = session.chunks[0][0] - session.started if session.chunks else None
        run['cold:first-output'] = first
        run['cold:ready'] = ready
        for key in ('cold:first-output', 'cold:ready'):
            if run[key] is None:
                run['missing'].append(key)
        session.sample(subject.client_names())
        session.drain(0.3)
        quit_session(session, run)
    finally:
        session.close()
    run['valid'] = not run['missing']
    return run


def paste_payload():
    return '\n'.join(f'paste line {i:05d} the quick brown fox jumps over the lazy dog 0123456789'
                     for i in range(PASTE_LINES)).encode()


def session_run(subject, mode, env, cwd, fixture):
    run = {'subject': subject.name, 'mode': mode, 'kind': 'session', 'missing': []}
    names = subject.client_names()
    session = Session(subject.argv(mode), env, cwd)

    def record(key, value):
        run[key] = value
        if value is None:
            run['missing'].append(key)

    try:
        record('start:ready', session.wait(lambda text: subject.ready_mark in text, 30))
        with session.lock:
            record('start:first-output', session.chunks[0][0] - session.started if session.chunks else None)
        if subject.name == 'candidate':
            run['start:connected'] = session.wait(lambda text: 'Connected to dsh ACP' in text, 30)
        session.drain(0.5)
        session.sample(names)

        sent = session.send(DRAFT.encode())
        seen = session.wait(lambda text: DRAFT in text, 5, since=sent)
        record('input:draft', None if seen is None else seen - (sent - session.started))
        session.send(b'\x03')
        session.wait(lambda text: DRAFT not in text, 5)
        session.drain(0.3)
        session.sample(names)

        payload = paste_payload()
        run['paste:bytes'] = len(payload)
        sent = session.send(b'\x1b[200~' + payload + b'\x1b[201~' + PASTE_MARK.encode())
        seen = session.wait(lambda text: PASTE_MARK in text, 20, since=sent)
        record('input:paste', None if seen is None else seen - (sent - session.started))
        session.drain(0.3)
        session.sample(names)
        session.send(b'\x03')
        if session.wait(lambda text: PASTE_MARK not in text, 3) is None:
            session.send(b'\x03')
            session.wait(lambda text: PASTE_MARK not in text, 3)
        session.drain(0.5)

        before = len(fixture.requests)
        session.send(LONG_PROMPT.encode())
        session.wait(lambda text: LONG_PROMPT in text, 5)
        session.drain(0.2)
        sent = session.send(b'\r')
        base = sent - session.started
        first = session.wait(lambda text: 'PERF_LINE_0001' in text, 60, since=sent)
        end = session.wait(lambda text: END_MARK in text, 120, since=sent)
        record('output:first-visible', None if first is None else first - base)
        served = [item for item in fixture.requests[before:] if item['long']]
        if served and end is not None:
            model = served[0]
            run['output:submit-to-request'] = model['receivedMs'] - sent
            run['output:model-stream'] = model['lastChunkMs'] - model['firstChunkMs']
            run['output:bytes'] = model['contentBytes']
            record('output:end-after-model', (end + session.started) - model['lastChunkMs'])
            elapsed = (end + session.started) - model['firstChunkMs']
            record('output:throughput', model['contentBytes'] / (elapsed / 1000) if elapsed > 0 else None)
        else:
            record('output:end-after-model', None)
            record('output:throughput', None)
            run['fixtureRequests'] = fixture.requests[before:]
        session.drain(1.0)
        session.sample(names)

        for key, data in (('scroll:page-up', b'\x1b[5~'), ('scroll:page-down', b'\x1b[6~')):
            session.drain(0.4)
            record(key, session.next_output(session.send(data)))
        for key, size in (('resize:narrow', NARROW), ('resize:wide', (ROWS, COLS))):
            session.drain(0.4)
            session.screen.resize(*size)
            sent = now_ms()
            session.resize_pty(*size)
            record(key, session.next_output(sent))
        session.drain(0.5)
        session.sample(names)
        quit_session(session, run)
        raw = session.raw()
        run['outputBytes'] = len(raw)
        run['restoredAlternateScreen'] = (b'\x1b[?1049l' in raw) if mode == 'fullscreen' else None
        run['rss:tree-peak'] = max(item['tree'] for item in session.samples)
        run['rss:client-peak'] = max(item['client'] for item in session.samples)
        run['processes'] = max(item['processes'] for item in session.samples)
        if run['missing']:
            run['screen'] = session.text()
    finally:
        session.close()
    run['valid'] = not run['missing']
    return run


def fmt(value):
    return '-' if value is None else f'{value:.1f}'


def measure(subject, mode, fixture, root, runs, cold_runs, log, label, purge):
    """Warm sessions in one Home (the first is a recorded warm-up) plus cold starts in fresh Homes."""
    results = []
    if runs:
        home_root = root / f'{subject.name}-{mode}-{label}'
        home_root.mkdir(parents=True)
        (home_root / 'workspace').mkdir()
        env = subject.prepare(home_root, fixture.port)
        warm = session_run(subject, mode, env, home_root / 'workspace', fixture)
        warm['warmup'] = True
        results.append(warm)
        log(f'{subject.name} {mode} warm-up: missing={warm["missing"]}')
        for number in range(runs):
            run = session_run(subject, mode, env, home_root / 'workspace', fixture)
            run['run'] = number
            results.append(run)
            log(f'{subject.name} {mode} session {number + 1}/{runs}: ready={fmt(run.get("start:ready"))} '
                f'draft={fmt(run.get("input:draft"))} paste={fmt(run.get("input:paste"))} '
                f'first={fmt(run.get("output:first-visible"))} end-after-model={fmt(run.get("output:end-after-model"))} '
                f'up={fmt(run.get("scroll:page-up"))} narrow={fmt(run.get("resize:narrow"))} '
                f'quit={fmt(run.get("quit:exit"))} rss={run.get("rss:tree-peak")} missing={run["missing"]}')
        shutil.rmtree(home_root, ignore_errors=True)
    for number in range(cold_runs):
        cold_root = root / f'{subject.name}-{mode}-cold-{label}-{number}'
        cold_root.mkdir(parents=True)
        (cold_root / 'workspace').mkdir()
        run = start_run(subject, mode, subject.prepare(cold_root, fixture.port), cold_root / 'workspace', purge)
        run['run'] = number
        results.append(run)
        log(f'{subject.name} {mode} cold {number + 1}/{cold_runs}: first={fmt(run.get("cold:first-output"))} '
            f'ready={fmt(run.get("cold:ready"))} purged={run["cachesPurged"]} missing={run["missing"]}')
        shutil.rmtree(cold_root, ignore_errors=True)
    return results


def series(runs, mode, metric):
    return [run[metric] for run in runs if run['mode'] == mode and not run.get('warmup')
            and run.get('valid') and run.get(metric) is not None]


def freeze(reference_runs, modes):
    thresholds = {}
    for mode in modes:
        for metric in LATENCY + THROUGHPUT + RESOURCES:
            relevant = [run for run in reference_runs if run['mode'] == mode and not run.get('warmup')
                        and run.get('valid', True) and (metric in run or metric in run.get('missing', []))]
            if not relevant:
                continue
            values = [run[metric] for run in relevant if run.get(metric) is not None]
            key = f'{mode}:{metric}'
            if len(values) != len(relevant):
                thresholds[key] = {'kind': 'not-applicable', 'reason': 'the reference did not produce it in every valid run',
                                   'observedRuns': len(values), 'validRuns': len(relevant)}
                continue
            entry = {'samples': len(values), 'median': statistics.median(values), 'p95': p95(values)}
            if metric in LATENCY:
                entry.update(kind='latency', unit='ms', ceiling=max(entry['p95'] * 1.2, entry['p95'] + 16.7))
            elif metric in THROUGHPUT:
                entry.update(kind='throughput', unit='bytes/s', floor=entry['median'] * 0.9)
            else:
                entry.update(kind='resources', unit='KiB', ceiling=entry['p95'] * 1.2)
            thresholds[key] = entry
    return thresholds


def judge(thresholds, candidate_runs, control_runs):
    verdicts = {}
    for key, entry in thresholds.items():
        mode, metric = key.split(':', 1)
        if entry['kind'] == 'not-applicable':
            verdicts[key] = {'verdict': 'not-applicable'}
            continue
        values = series(candidate_runs, mode, metric)
        control = series(control_runs, mode, metric)
        result = {'samples': len(values)}
        if control:
            result['control'] = {'samples': len(control), 'median': statistics.median(control), 'p95': p95(control)}
        if not values:
            result.update(verdict='fail', reason='the candidate did not produce this measurement')
        elif entry['kind'] == 'throughput':
            result.update(median=statistics.median(values), p95=p95(values),
                          verdict='pass' if statistics.median(values) >= entry['floor'] else 'fail')
            if control:
                result['controlWithin'] = statistics.median(control) >= entry['floor']
        else:
            result.update(median=statistics.median(values), p95=p95(values),
                          verdict='pass' if p95(values) <= entry['ceiling'] else 'fail')
            if control:
                result['controlWithin'] = p95(control) <= entry['ceiling']
        verdicts[key] = result
    return verdicts


def summary(values):
    return {'samples': len(values), 'median': statistics.median(values), 'p95': p95(values)} if values else None


def render(thresholds, verdicts):
    lines = ['| metric | frozen limit | candidate p50 / p95 | reference control p95 | verdict |', '|---|---|---|---|---|']
    for key, entry in thresholds.items():
        verdict = verdicts.get(key, {})
        if entry['kind'] == 'not-applicable':
            lines.append(f'| {key} | n/a ({entry["observedRuns"]}/{entry["validRuns"]} reference runs) | - | - | not-applicable |')
            continue
        limit = f'>= {entry["floor"]:.0f}' if 'floor' in entry else f'<= {entry["ceiling"]:.1f}'
        control = verdict.get('control', {})
        control_value = control.get('median') if entry['kind'] == 'throughput' else control.get('p95')
        lines.append(f'| {key} | {limit} {entry["unit"]} | {fmt(verdict.get("median"))} / {fmt(verdict.get("p95"))} '
                     f'| {fmt(control_value)} | {verdict.get("verdict")} |')
    return '\n'.join(lines)


def environment():
    info = {'system': platform.system(), 'release': platform.release(), 'machine': platform.machine(),
            'python': platform.python_version(), 'ci': os.environ.get('GITHUB_ACTIONS') == 'true',
            'runner': os.environ.get('RUNNER_NAME'), 'image': os.environ.get('ImageOS'),
            'imageVersion': os.environ.get('ImageVersion')}
    if platform.system() == 'Darwin':
        def sysctl(name):
            return subprocess.run(['sysctl', '-n', name], capture_output=True, text=True).stdout.strip()
        info.update(os=subprocess.run(['sw_vers', '-productVersion'], capture_output=True, text=True).stdout.strip(),
                    cpu=sysctl('machdep.cpu.brand_string'), cpus=sysctl('hw.ncpu'), memoryBytes=sysctl('hw.memsize'))
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--reference', help='pinned Grok 1.0.34 binary (SHA-256 checked)')
    parser.add_argument('--launcher', help='installed codsh launcher (lib/node_modules/codsh-cli/bin/codsh.mjs)')
    parser.add_argument('--dsh', help='DSH_BIN for the candidate (default: what the launcher finds)')
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--modes', default='fullscreen,minimal')
    parser.add_argument('--runs', type=int, default=30)
    parser.add_argument('--cold-runs', type=int, default=30)
    parser.add_argument('--control-every', type=int, default=3,
                        help='one reference control session after every N candidate sessions')
    parser.add_argument('--purge', action='store_true', help='purge the file cache before cold starts (macOS runner)')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--only', choices=('reference', 'candidate'), help='measure one product, no judging (development)')
    args = parser.parse_args()
    if sys.platform not in ('darwin', 'linux'):
        raise SystemExit('POSIX PTY required')
    args.output.mkdir(parents=True, exist_ok=True)
    modes = args.modes.split(',')
    log_file = (args.output / 'bench.log').open('a', encoding='utf-8')

    def log(message):
        line = f'[{time.strftime("%H:%M:%S")}] {message}'
        print(line, flush=True)
        log_file.write(line + '\n')
        log_file.flush()

    reference = Reference(args.reference) if args.reference else None
    candidate = Candidate(args.launcher, args.dsh, args.node) if args.launcher else None
    fixture = Fixture()
    meta = {'reference': REFERENCE_VERSION, 'referenceSha256': REFERENCE_SHA256, 'environment': environment(),
            'terminal': {'rows': ROWS, 'cols': COLS, 'narrow': list(NARROW), 'term': 'xterm-256color',
                         'driver': 'POSIX PTY, pyte screen model, arrival-time stamps'},
            'fixture': {'longLines': LONG_LINES, 'pasteLines': PASTE_LINES, 'transport': 'loopback chat_completions SSE'},
            'runs': args.runs, 'coldRuns': args.cold_runs, 'modes': modes, 'purge': args.purge}
    try:
        with tempfile.TemporaryDirectory(prefix='codsh-perf-') as temporary:
            root = Path(temporary)
            if args.only:
                subject = reference if args.only == 'reference' else candidate
                runs = []
                for mode in modes:
                    runs += measure(subject, mode, fixture, root, args.runs, args.cold_runs, log, 'only', args.purge)
                (args.output / f'{args.only}-raw.json').write_text(json.dumps({**meta, 'runs': runs}, indent=1) + '\n')
                log(json.dumps(freeze(runs, modes), indent=1))
                return
            if not reference or not candidate:
                parser.error('--reference and --launcher are both required (or use --only)')
            # 1. Reference baseline.
            baseline = []
            for mode in modes:
                baseline += measure(reference, mode, fixture, root, args.runs, args.cold_runs, log, 'baseline', args.purge)
            raw = json.dumps({**meta, 'runs': baseline}, indent=1).encode() + b'\n'
            (args.output / 'reference-raw.json').write_bytes(raw)
            # 2. Freeze before any candidate process exists.
            frozen = {'schemaVersion': 1, 'reference': REFERENCE_VERSION, 'method': METHOD,
                      'referenceRawSha256': sha256(raw), 'frozenAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                      'environment': meta['environment'], 'terminal': meta['terminal'], 'fixture': meta['fixture'],
                      'thresholds': freeze(baseline, modes)}
            frozen_bytes = json.dumps(frozen, indent=1).encode() + b'\n'
            (args.output / 'thresholds.json').write_bytes(frozen_bytes)
            log(f'FROZEN thresholds.json sha256={sha256(frozen_bytes)} reference-raw.json sha256={sha256(raw)}; '
                'no candidate process has been started yet')
            # 3. Candidate, alternating with reference control sessions.
            candidate_runs, control_runs = [], []
            for mode in modes:
                for block in range(0, args.runs, args.control_every):
                    count = min(args.control_every, args.runs - block)
                    candidate_runs += measure(candidate, mode, fixture, root, count, 0, log, f'c{block}', args.purge)
                    control_runs += measure(reference, mode, fixture, root, 1, 0, log, f'r{block}', args.purge)
                candidate_runs += measure(candidate, mode, fixture, root, 0, args.cold_runs, log, 'cold', args.purge)
            check = sha256((args.output / 'thresholds.json').read_bytes())
            assert check == sha256(frozen_bytes), 'thresholds.json changed after freezing'
            verdicts = judge(frozen['thresholds'], candidate_runs, control_runs)
            leftovers = sorted({name for run in candidate_runs for name in run.get('leftoverProcesses', [])})
            report = {**meta, 'thresholdsSha256': check, 'verdicts': verdicts,
                      'failed': sorted(key for key, value in verdicts.items() if value['verdict'] == 'fail'),
                      'controlDrift': sorted(key for key, value in verdicts.items() if value.get('controlWithin') is False),
                      'candidateLeftoverProcesses': leftovers,
                      'invalidRuns': {'candidate': sum(1 for r in candidate_runs if not r['valid']),
                                      'control': sum(1 for r in control_runs if not r['valid'])},
                      'breakdown': {mode: {metric: {'candidate': summary(series(candidate_runs, mode, metric)),
                                                    'reference': summary(series(baseline, mode, metric))}
                                           for metric in BREAKDOWN} for mode in modes}}
            (args.output / 'candidate-raw.json').write_text(json.dumps({**meta, 'runs': candidate_runs}, indent=1) + '\n')
            (args.output / 'control-raw.json').write_text(json.dumps({**meta, 'runs': control_runs}, indent=1) + '\n')
            (args.output / 'report.json').write_text(json.dumps(report, indent=1) + '\n')
            table = render(frozen['thresholds'], verdicts)
            (args.output / 'report.md').write_text(table + '\n')
            log('\n' + table)
            log(f'failed: {report["failed"] or "none"}; control drift: {report["controlDrift"] or "none"}; '
                f'candidate leftovers: {leftovers or "none"}')
            if report['failed'] or leftovers:
                raise SystemExit(1)
    finally:
        fixture.close()
        log_file.close()


if __name__ == '__main__':
    main()
