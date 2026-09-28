#!/usr/bin/env python3
"""Concurrency and long-run resource stress against the frozen reference (#209).

One `bench` run on one machine (Linux, macOS or Windows):

1. measures the pinned reference (Grok 1.0.34 for this platform, SHA-256
   checked, never redistributed) under one fixed load, several times;
2. freezes per-platform thresholds from those samples with the method below,
   writes thresholds.json and logs its SHA-256 *before* any candidate process
   starts;
3. measures the installed candidate (`codsh --rust` from the packed tarball,
   dsh from the registry) under the same load, terminal and fixture, and
   judges it against the frozen file only;
4. checks both products for leftover processes and model traffic after a
   quit and after a crash (SIGKILL / TerminateProcess of the client) under
   load, and what a resumed session shows about work that was running.

The load (one fullscreen session per run, 100x32 terminal):

- fanout: one prompt makes the model start 4 background subagents (each
  streams 150 lines at 10/s) and 1 background command (400 lines at 20/s);
  typing and scrolling are probed while they run;
- workflow: an inline Rhai workflow with 3 streaming children; typing is
  probed, then `/workflow pause stress`, `/workflow resume stress` and
  `/workflow stop stress` from the prompt;
- long session: 30 short turns in a row; process-tree and client memory
  after turn 5 and turn 30, typing after the last turn;
- quit under load: a second fanout, then quit while it runs.

Both products talk to one loopback OpenAI-compatible model fixture that
scripts the tool calls with each product's own tool names (spawn_subagent /
run_terminal_command / workflow for the reference, subagent / bash /
workflow for the candidate). Nothing reaches the network.

Threshold method (fixed before any candidate measurement; same as #202 for
latency):

- latency ceiling = max(reference p95 x 1.20, reference p95 + 16.7 ms);
- memory-growth ceiling = max(reference p95 x 1.20, reference p95 + 32 MiB);
- a metric the reference did not produce in every valid run is
  not-applicable;
- the candidate passes a metric when its p95 over the valid runs is at or
  under the ceiling;
- hard requirements, not derived from the reference: no process of the
  session tree is left 5 s after a quit or 10 s after a crash, and the model
  fixture sees no request and no open stream from 2 s after the client is
  gone; a resumed session does not claim that the killed work still runs.

Absolute process-tree memory is reported, not judged here: the candidate's
Node launcher + dsh tree was accepted as an architecture gap in #202.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time

import psutil
import pyte

WINDOWS = sys.platform == 'win32'
REFERENCE_VERSION = '1.0.34 (3736acbc8658)'
REFERENCE = {
    ('darwin', 'arm64'): ('grok-1.0.34-macos-aarch64',
                          '9cd26b579840f0f5c9148a8059ad651904c08b41b7f2ef0b4ec04b9ba898844e'),
    ('linux', 'x64'): ('grok-1.0.34-linux-x86_64',
                       'be5905e107d2b8b5f3c142d21ecfe4c8fd32a913d2fd551b788707930c4dc80d'),
    ('linux', 'arm64'): ('grok-1.0.34-linux-aarch64',
                         '39ab87666877d64ef3a40aa60fbe0c3b6a6acd7001b78fe60e2c76bb6cfc4a94'),
    ('win32', 'x64'): ('grok-1.0.34-windows-x86_64.exe',
                       '021d8f7f6bdf9db48b6c87e799cd99130a76c463e6e6a3161510839aed016d94'),
}
REFERENCE_URL = 'https://storage.googleapis.com/grok-build-public-artifacts/cli/'
MODEL = 'perf-fixture'
ROWS, COLS = 32, 100
CHILDREN = 4
CHILD_LINES, CHILD_INTERVAL = 150, 0.1
TASK_LINES, TASK_INTERVAL = 400, 0.05
WORKFLOW_CHILD_LINES = 200
TURNS, TURN_EARLY = 30, 5
TURN_LINES = 8
LOAD_SECONDS = 10.0
PROBE_GAP = 0.3
MIB = 1024

LATENCY = ['idle:input', 'load:input', 'load:scroll', 'workflow:input', 'workflow:pause', 'workflow:resume',
           'long:turn', 'long:input', 'quit:under-load']
GROWTH = ['rss:load-growth', 'rss:long-growth', 'rss:client-long-growth']
REPORTED = ['rss:tree-peak', 'rss:client-peak', 'processes:peak']
OPTIONAL = {'load:scroll'}

# Sequences pyte does not model (kitty keyboard, modifyOtherKeys, OSC).
UNMODELED = re.compile(r'\x1b\[[<>=?][0-9;]*u|\x1b\[[<>=][0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')


def now_ms():
    return time.perf_counter_ns() / 1e6


def p95(values):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(round(0.95 * len(ordered) + 0.5)) - 1))]


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def platform_key():
    system = 'win32' if WINDOWS else ('darwin' if sys.platform == 'darwin' else 'linux')
    machine = platform.machine().lower()
    arch = {'x86_64': 'x64', 'amd64': 'x64', 'arm64': 'arm64', 'aarch64': 'arm64'}.get(machine, machine)
    return system, arch


# --------------------------------------------------------------------------- fixture

class Fixture:
    """Loopback model; scripts tool calls per product and records every request."""

    def __init__(self, task_command, workflow_child_lines=WORKFLOW_CHILD_LINES):
        self.requests = []
        self.active = {}
        self.lock = threading.Lock()
        self.task_command = task_command
        self.workflow_child_lines = workflow_child_lines
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
                plan = fixture.plan(body)
                record = {'receivedMs': received, 'kind': plan['kind'], 'tag': plan.get('tag')}
                with fixture.lock:
                    fixture.requests.append(record)
                if not body.get('stream'):
                    self.reply_json({'id': 'stress', 'object': 'chat.completion', 'created': 0, 'model': MODEL,
                                     'choices': [{'index': 0, 'finish_reason': 'stop', 'message': {
                                         'role': 'assistant', 'content': ''.join(plan.get('pieces') or ['OK'])}}],
                                     'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}})
                    record['endMs'] = now_ms()
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Connection', 'close')
                self.end_headers()

                def event(delta, finish=None, usage=None):
                    chunk = {'id': 'stress', 'object': 'chat.completion.chunk', 'created': 0, 'model': MODEL,
                             'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                    if usage:
                        chunk['usage'] = usage
                    self.wfile.write(f'data: {json.dumps(chunk)}\n\n'.encode())
                    self.wfile.flush()

                key = id(record)
                with fixture.lock:
                    fixture.active[key] = record
                try:
                    event({'role': 'assistant', 'content': ''})
                    if plan.get('calls'):
                        for index, (name, args) in enumerate(plan['calls']):
                            event({'tool_calls': [{'index': index, 'id': f'call_{int(received)}_{index}',
                                                   'type': 'function',
                                                   'function': {'name': name, 'arguments': json.dumps(args)}}]})
                        event({}, 'tool_calls', {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2})
                    else:
                        for piece in plan['pieces']:
                            event({'content': piece})
                            if plan.get('interval'):
                                time.sleep(plan['interval'])
                        event({}, 'stop', {'prompt_tokens': 1, 'completion_tokens': len(plan['pieces']),
                                           'total_tokens': 1 + len(plan['pieces'])})
                    self.wfile.write(b'data: [DONE]\n\n')
                    self.wfile.flush()
                except OSError:
                    record['aborted'] = True
                finally:
                    with fixture.lock:
                        fixture.active.pop(key, None)
                record['endMs'] = now_ms()
                self.close_connection = True

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @staticmethod
    def text_of(content):
        if isinstance(content, list):
            return ' '.join(part.get('text', '') for part in content if isinstance(part, dict))
        return str(content or '')

    def plan(self, body):
        messages = [message for message in (body.get('messages') or []) if isinstance(message, dict)]
        tools = [(tool.get('function') or tool).get('name') for tool in (body.get('tools') or [])]
        reference = 'spawn_subagent' in tools
        system = '\n'.join(self.text_of(m.get('content')) for m in messages if m.get('role') in ('system', 'developer'))
        if not tools or 'session title' in system:
            return {'kind': 'aux', 'pieces': ['Stress session']}

        def meta(text):
            text = text.strip()
            return text.startswith(('<system-reminder>', 'Current runtime context', '<user_info>',
                                    '<task-notification', '<system'))
        last_assistant = max((i for i, m in enumerate(messages) if m.get('role') == 'assistant'), default=-1)
        tail = messages[last_assistant + 1:]
        after_tools = any(m.get('role') == 'tool' for m in tail)
        first_user = next((self.text_of(m.get('content')) for m in messages if m.get('role') == 'user'), '')
        queries = [i for i, m in enumerate(messages) if m.get('role') == 'user' and not meta(self.text_of(m.get('content')))]
        query_index = queries[-1] if queries else -1
        query = self.text_of(messages[query_index].get('content')) if query_index >= 0 else ''
        reminders = ' '.join(self.text_of(m.get('content')) for m in tail if m.get('role') == 'user')
        if 'STRESS_CHILD ' in first_user:
            tag = first_user.split('STRESS_CHILD ', 1)[1].split()[0]
            if last_assistant >= 0:
                return {'kind': 'child-final', 'tag': tag, 'pieces': [f'STRESS_CHILD_DONE {tag}']}
            count = self.workflow_child_lines if tag.startswith('w') else CHILD_LINES
            lines = [f'child {tag} line {i:04d} lorem ipsum dolor sit amet\n' for i in range(count)]
            return {'kind': 'child', 'tag': tag, 'pieces': lines + [f'STRESS_CHILD_DONE {tag}\n'],
                    'interval': CHILD_INTERVAL}
        if after_tools:
            return {'kind': 'after-tools', 'pieces': ['STRESS_TOOLS_STARTED']}
        if query_index < last_assistant:
            if 'dashboard line' in reminders:
                return {'kind': 'aux', 'pieces': ['stress']}
            return {'kind': 'notice', 'pieces': ['STRESS_ACK']}
        if 'STRESS_FANOUT' in query:
            calls = []
            for k in range(CHILDREN):
                args = {'subagent_type': 'general-purpose', 'description': f'stress child {k}',
                        'prompt': f'STRESS_CHILD c{k} stream your answer'}
                args['background' if reference else 'run_in_background'] = True
                calls.append(('spawn_subagent' if reference else 'subagent', args))
            task = {'command': self.task_command, 'description': 'stress task output'}
            task['background' if reference else 'run_in_background'] = True
            calls.append(('run_terminal_command' if reference else 'bash', task))
            return {'kind': 'fanout', 'calls': calls}
        if 'STRESS_WORKFLOW' in query:
            script = ('let meta = #{ name: "stress", description: "Three streaming children for the #209 stress load" };\n'
                      'phase("Stream");\n'
                      'let r = parallel([0, 1, 2].map(|n| #{ prompt: "STRESS_CHILD w" + n.to_string() + '
                      '" stream your answer", label: "stress-" + n.to_string() }));\n'
                      'r.len()\n')
            return {'kind': 'workflow', 'calls': [('workflow', {'source': {'type': 'script', 'script': script}})]}
        if 'STRESS_TURN ' in query:
            number = query.split('STRESS_TURN ', 1)[1].split()[0]
            return {'kind': 'turn', 'tag': number,
                    'pieces': [f'turn {number} line {i} the quick brown fox\n' for i in range(TURN_LINES)]
                    + [f'END_T{number}\n']}
        return {'kind': 'other', 'pieces': ['STRESS_OK']}

    def count(self, kind, since=0, tag_prefix=None):
        with self.lock:
            return sum(1 for r in self.requests[since:] if r['kind'] == kind
                       and (tag_prefix is None or str(r.get('tag') or '').startswith(tag_prefix)))

    def active_count(self, kind=None, tag_prefix=None):
        with self.lock:
            return sum(1 for r in self.active.values() if (kind is None or r['kind'] == kind)
                       and (tag_prefix is None or str(r.get('tag') or '').startswith(tag_prefix)))

    def mark(self):
        with self.lock:
            return len(self.requests)

    def since(self, at_ms):
        with self.lock:
            return [r for r in self.requests if r['receivedMs'] >= at_ms]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


# --------------------------------------------------------------------------- terminal

class Terminal:
    """A product in a PTY (Unix) or ConPTY (Windows) rendered by pyte."""

    def __init__(self, argv, env, cwd, rows=ROWS, cols=COLS):
        self.started = now_ms()
        self.rows, self.cols = rows, cols
        self.chunks = []
        self.lock = threading.Lock()
        self.alive = True
        self.status = None
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.Stream(self.screen)
        self.fed = 0
        if WINDOWS:
            from winpty import PtyProcess
            self.proc = PtyProcess.spawn(argv, cwd=str(cwd), env=env, dimensions=(rows, cols))
            self.pid = self.proc.pid
        else:
            import pty
            self.pid, self.fd = pty.fork()
            if self.pid == 0:
                try:
                    os.chdir(cwd)
                    os.execve(argv[0], argv, env)
                finally:
                    os._exit(127)
            import fcntl
            import struct
            import termios
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        import codecs
        decoder = codecs.getincrementaldecoder('utf-8')('replace')
        while self.alive:
            try:
                if WINDOWS:
                    chunk = self.proc.read(65536)
                    if not chunk:
                        if not self.proc.isalive():
                            return
                        time.sleep(0.005)
                        continue
                else:
                    import select
                    if not select.select([self.fd], [], [], 0.05)[0]:
                        continue
                    data = os.read(self.fd, 65536)
                    if not data:
                        return
                    chunk = decoder.decode(data)
            except (OSError, EOFError, ValueError):
                return
            at = now_ms()
            for query, reply in (('\x1b[6n', '\x1b[1;1R'), ('\x1b[c', '\x1b[?1;2c'), ('\x1b[?u', '\x1b[?0u')):
                if query in chunk:
                    try:
                        self._write(reply)
                    except OSError:
                        pass
            with self.lock:
                self.chunks.append((at, chunk))

    def _write(self, text):
        if WINDOWS:
            self.proc.write(text)
        else:
            data = text.encode()
            while data:
                written = os.write(self.fd, data[:4096])
                data = data[written:]

    def send(self, text):
        at = now_ms()
        self._write(text)
        return at

    def text(self):
        return '\n'.join(self.screen.display)

    def wait_all(self, predicates, seconds, since=None):
        deadline = time.monotonic() + seconds
        found = {}
        while True:
            with self.lock:
                pending = self.chunks[self.fed:]
            for at, chunk in pending:
                self.stream.feed(UNMODELED.sub('', chunk))
                self.fed += 1
                if since is None or at >= since:
                    text = self.text()
                    for name, predicate in predicates.items():
                        if name not in found and predicate(text):
                            found[name] = at - self.started
                    if len(found) == len(predicates):
                        return found
            if time.monotonic() > deadline or (not pending and self.exited()):
                return found
            if not pending:
                time.sleep(0.005)

    def wait(self, predicate, seconds, since=None):
        return self.wait_all({'hit': predicate}, seconds, since).get('hit')

    def drain(self, seconds):
        time.sleep(seconds)
        self.wait(lambda _: False, 0)

    def next_change(self, action, seconds=2.0):
        self.wait(lambda _: False, 0)
        before = self.text()
        sent = action()
        seen = self.wait(lambda text: text != before, seconds, since=sent)
        return None if seen is None else seen - (sent - self.started)

    def exited(self):
        if self.status is not None:
            return True
        if WINDOWS:
            if self.proc.isalive():
                return False
            self.status = self.proc.exitstatus
            return True
        waited, status = os.waitpid(self.pid, os.WNOHANG)
        if waited:
            self.status = status
            return True
        return False

    def close(self):
        if not self.exited():
            try:
                if WINDOWS:
                    self.proc.terminate(force=True)
                else:
                    import signal
                    os.kill(self.pid, signal.SIGKILL)
                    _, self.status = os.waitpid(self.pid, 0)
            except (OSError, ChildProcessError):
                pass
        self.alive = False
        self.reader.join(timeout=1)
        if not WINDOWS:
            try:
                os.close(self.fd)
            except OSError:
                pass


# --------------------------------------------------------------------------- process tree

class Tree:
    """Every process seen under the session root, with its create time."""

    def __init__(self, root_pid, client_names):
        self.root_pid = root_pid
        self.client_names = client_names
        self.seen = {}
        self.samples = []

    def walk(self):
        try:
            root = psutil.Process(self.root_pid)
            procs = [root] + root.children(recursive=True)
        except psutil.Error:
            return []
        for proc in procs:
            try:
                self.seen.setdefault(proc.pid, (proc.create_time(), proc.name()))
            except psutil.Error:
                pass
        return procs

    def sample(self, label=None):
        tree = client = count = 0
        for proc in self.walk():
            try:
                rss = proc.memory_info().rss // 1024
                name = proc.name()
            except psutil.Error:
                continue
            tree += rss
            count += 1
            if any(name == n or name.startswith(n) for n in self.client_names):
                client += rss
        item = {'tree': tree, 'client': client, 'processes': count, 'label': label}
        self.samples.append(item)
        return item

    def alive(self, exclude=()):
        left = []
        for pid, (created, name) in self.seen.items():
            if pid in exclude:
                continue
            try:
                proc = psutil.Process(pid)
                if abs(proc.create_time() - created) < 0.01 and proc.status() != psutil.STATUS_ZOMBIE:
                    left.append({'pid': pid, 'name': name})
            except psutil.Error:
                pass
        return left

    def kill_left(self):
        for item in self.alive():
            try:
                psutil.Process(item['pid']).kill()
            except psutil.Error:
                pass


# --------------------------------------------------------------------------- products

def base_env(extra):
    keep = ('SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS',
            'PROCESSOR_ARCHITECTURE', 'PROGRAMFILES', 'PROGRAMDATA', 'LOCALAPPDATA', 'APPDATA', 'OS')
    env = {k: v for k, v in os.environ.items() if k.upper() in keep} if WINDOWS else {}
    env.update(extra)
    return env


class Reference:
    name = 'reference'
    ready_mark = MODEL
    quit_keys = '/quit\r'
    scroll_prefix = ''

    def __init__(self, binary):
        self.binary = Path(binary).resolve(strict=True)
        key = platform_key()
        if key not in REFERENCE:
            raise SystemExit(f'no pinned reference for {key}')
        expected = REFERENCE[key][1]
        digest = sha256_file(self.binary)
        if digest != expected:
            raise SystemExit(f'reference SHA-256 {digest} is not the pinned {expected} for {key}')
        self.sha256 = digest
        self.client_names = {self.binary.name}

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
        path = os.environ.get('PATH', '') if WINDOWS else '/usr/bin:/bin:/usr/sbin:/sbin'
        return base_env({
            'PATH': path, 'HOME': str(home), 'USERPROFILE': str(home), 'GROK_HOME': str(home / '.grok'),
            'TMPDIR': str(root), 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8',
            'GROK_DISABLE_AUTOUPDATER': '1', 'GROK_TELEMETRY_ENABLED': '0', 'GROK_TELEMETRY_TRACE_UPLOAD': '0',
            'GROK_REMOTE_FETCH': '0', 'GROK_USE_LEADER': '0', 'GROK_MANAGED_MCPS_ENABLED': '0',
            'XAI_API_KEY': 'synthetic-perf-key',
        })

    def argv(self, resume=False):
        return [str(self.binary), '--fullscreen', '--always-approve'] + (['--continue'] if resume else [])

    def client_pid(self, terminal):
        return terminal.pid


class Candidate:
    name = 'candidate'
    ready_mark = 'Draft (not sent)'
    quit_keys = '\x11'
    # Tab focuses the transcript so PageUp / PageDown scroll it.
    scroll_prefix = '\t'

    def __init__(self, launcher, dsh, node):
        self.launcher = Path(launcher).resolve(strict=True)
        self.dsh = dsh
        self.node = node
        self.client_names = {'codsh-rust'}

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
        sep = ';' if WINDOWS else ':'
        system_path = os.environ.get('PATH', '') if WINDOWS else '/usr/bin:/bin:/usr/sbin:/sbin'
        env = base_env({
            'PATH': f'{Path(self.node).parent}{sep}{system_path}', 'HOME': str(home), 'USERPROFILE': str(home),
            'TMPDIR': str(root), 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8', 'PERF_API_KEY': 'synthetic-perf-key',
            'CODSH_UPDATE_CHECK': 'off', 'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
        })
        if self.dsh:
            env['DSH_BIN'] = self.dsh
        return env

    def argv(self, resume=False):
        return [self.node, str(self.launcher), '--rust', '--fullscreen', '--always-approve'] + (
            ['--continue'] if resume else [])

    def client_pid(self, terminal):
        try:
            for proc in psutil.Process(terminal.pid).children(recursive=True):
                if proc.name().startswith('codsh-rust'):
                    return proc.pid
        except psutil.Error:
            pass
        return None


# --------------------------------------------------------------------------- the load

def task_files(workspace):
    (workspace / 'stress-task.sh').write_text(
        f'i=0\nwhile [ $i -lt {TASK_LINES} ]; do i=$((i+1)); echo STRESS_TASK_$i; sleep {TASK_INTERVAL}; done\n')
    (workspace / 'stress_task.py').write_text(
        f'import time\nfor i in range({TASK_LINES}):\n    print(f"STRESS_TASK_{{i + 1}}", flush=True)\n'
        f'    time.sleep({TASK_INTERVAL})\n')


def task_command():
    return 'python stress_task.py' if WINDOWS else 'sh ./stress-task.sh'


class Probe:
    def __init__(self, terminal):
        self.terminal = terminal
        self.number = 0

    def input(self):
        """Type a unique 4-character token, time until it shows, then erase it."""
        self.number += 1
        token = f'Q{self.number:03d}'
        sent = self.terminal.send(token)
        seen = self.terminal.wait(lambda text: token in text, 5, since=sent)
        self.terminal.send('\x7f' * len(token))
        self.terminal.wait(lambda text: token not in text, 3)
        return None if seen is None else seen - (sent - self.terminal.started)


TURN_MARK = re.compile(r'END_T(\d+)')


def scroll_probe(terminal, key):
    """PageUp / PageDown: time until the set of visible turn marks changes.

    The load keeps repainting status rows, so "the screen changed" is not a
    scroll; the long session's turn marks moving is.
    """
    terminal.wait(lambda _: False, 0)
    before = set(TURN_MARK.findall(terminal.text()))
    sent = terminal.send(key)
    seen = terminal.wait(lambda text: set(TURN_MARK.findall(text)) != before, 2.0, since=sent)
    return None if seen is None else seen - (sent - terminal.started)


def wait_quiet(fixture, terminal, seconds, idle=3.0):
    """Until the fixture has no open stream and no new request for `idle` seconds."""
    deadline = time.monotonic() + seconds
    last = fixture.mark()
    quiet_since = time.monotonic()
    while time.monotonic() < deadline:
        if terminal is None:
            time.sleep(0.25)
        else:
            terminal.drain(0.25)
        mark = fixture.mark()
        if mark != last or fixture.active_count():
            last = mark
            quiet_since = time.monotonic()
        elif time.monotonic() - quiet_since >= idle:
            return True
    return False


def wait_for(condition, seconds, terminal):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        terminal.drain(0.05)
    return condition()


def stress_run(subject, env, cwd, fixture, log):
    run = {'subject': subject.name, 'missing': [], 'unobserved': []}

    def record(key, value):
        run[key] = value
        if value is None:
            run['unobserved' if key in OPTIONAL else 'missing'].append(key)

    terminal = Terminal(subject.argv(), env, cwd)
    tree = Tree(terminal.pid, subject.client_names)
    probe = Probe(terminal)
    try:
        if terminal.wait(lambda t: subject.ready_mark in t, 40) is None:
            run['missing'].append('ready')
            run['screen'] = terminal.text()
            return run
        if subject.name == 'candidate':
            terminal.wait(lambda t: 'Connected to dsh ACP' in t, 40)
        terminal.drain(1.0)

        # Idle.
        values = [probe.input() for _ in range(5)]
        values = [v for v in values if v is not None]
        record('idle:input', statistics.median(values) if values else None)
        baseline = tree.sample('idle')

        # Long session.
        turn_times = []
        early = None
        for number in range(1, TURNS + 1):
            text = f'STRESS_TURN {number} go'
            terminal.send(text)
            terminal.wait(lambda t: text in t, 5)
            sent = terminal.send('\r')
            end = f'END_T{number}'
            seen = terminal.wait(lambda t: end in t, 60, since=sent)
            if seen is None:
                run['missing'].append(f'turn-{number}')
                run['turnScreen'] = terminal.text()
                break
            turn_times.append(seen - (sent - terminal.started))
            terminal.drain(0.2)
            if number == TURN_EARLY:
                wait_quiet(fixture, terminal, 20, idle=1.0)
                early = tree.sample('turn-early')
        wait_quiet(fixture, terminal, 20, idle=1.0)
        late = tree.sample('turn-late')
        record('long:turn', statistics.median(turn_times[-5:]) if len(turn_times) == TURNS else None)
        run['long:turn-first5'] = statistics.median(turn_times[:5]) if len(turn_times) >= 5 else None
        if early and len(turn_times) == TURNS:
            record('rss:long-growth', late['tree'] - early['tree'])
            record('rss:client-long-growth', late['client'] - early['client'])
        else:
            record('rss:long-growth', None)
            record('rss:client-long-growth', None)
        inputs = [v for v in (probe.input() for _ in range(5)) if v is not None]
        record('long:input', p95(inputs) if inputs else None)

        # Fanout load.
        baseline = tree.sample('before-fanout')
        start = fixture.mark()
        terminal.send('STRESS_FANOUT')
        terminal.drain(0.3)
        terminal.send('\r')
        started = wait_for(lambda: fixture.count('child', start, 'c') >= CHILDREN, 60, terminal)
        run['fanout:children-started'] = fixture.count('child', start, 'c')
        if not started:
            run['missing'].append('fanout')
        terminal.drain(0.5)
        inputs, scrolls, peak = [], [], baseline['tree']
        load_end = time.monotonic() + LOAD_SECONDS
        while time.monotonic() < load_end:
            value = probe.input()
            if value is not None:
                inputs.append(value)
            peak = max(peak, tree.sample('load')['tree'])
            terminal.drain(PROBE_GAP)
        record('load:input', p95(inputs) if inputs else None)
        if subject.scroll_prefix:
            terminal.send(subject.scroll_prefix)
            terminal.drain(0.4)
        for key in ('\x1b[5~', '\x1b[6~', '\x1b[5~', '\x1b[6~'):
            value = scroll_probe(terminal, key)
            if value is not None:
                scrolls.append(value)
            terminal.drain(0.3)
        if subject.scroll_prefix:
            terminal.send('\x1b')
            terminal.drain(0.3)
        record('load:scroll', statistics.median(scrolls) if scrolls else None)
        peak = max(peak, tree.sample('load')['tree'])
        record('rss:load-growth', peak - baseline['tree'])
        run['fanout:quiet'] = wait_quiet(fixture, terminal, 90)
        tree.sample('after-fanout')

        # Workflow with pause / resume / stop.
        start = fixture.mark()
        terminal.send('STRESS_WORKFLOW')
        terminal.drain(0.3)
        terminal.send('\r')
        if wait_for(lambda: fixture.active_count('child', 'w') >= 3, 60, terminal):
            terminal.drain(0.5)
            inputs = []
            for _ in range(8):
                value = probe.input()
                if value is not None:
                    inputs.append(value)
                terminal.drain(PROBE_GAP)
            record('workflow:input', p95(inputs) if inputs else None)
            terminal.send('/workflow pause stress')
            terminal.drain(0.3)
            sent = terminal.send('\r')
            paused = wait_for(lambda: fixture.active_count('child', 'w') == 0, 20, terminal)
            record('workflow:pause', now_ms() - sent if paused else None)
            if not paused:
                run['pauseScreen'] = terminal.text()
            terminal.drain(1.5)
            before = fixture.count('child', start, 'w')
            terminal.send('/workflow resume stress')
            terminal.drain(0.3)
            sent = terminal.send('\r')
            resumed = wait_for(lambda: fixture.count('child', start, 'w') >= before + 3, 30, terminal)
            record('workflow:resume', now_ms() - sent if resumed else None)
            if not resumed:
                run['resumeScreen'] = terminal.text()
            terminal.drain(1.0)
            terminal.send('/workflow stop stress')
            terminal.drain(0.3)
            terminal.send('\r')
            run['workflow:stopped'] = wait_for(lambda: fixture.active_count('child', 'w') == 0, 20, terminal)
        else:
            for key in ('workflow:input', 'workflow:pause', 'workflow:resume'):
                record(key, None)
        run['workflow:quiet'] = wait_quiet(fixture, terminal, 60)

        # Quit under load.
        start = fixture.mark()
        terminal.send('STRESS_FANOUT')
        terminal.drain(0.3)
        terminal.send('\r')
        wait_for(lambda: fixture.active_count('child', 'c') >= CHILDREN, 60, terminal)
        terminal.drain(1.0)
        tree.sample('quit-load')
        sent = terminal.send(subject.quit_keys)
        exited = wait_for(terminal.exited, 20, terminal)
        gone_at = now_ms()
        record('quit:under-load', gone_at - sent if exited else None)
        if not exited:
            run['quitScreen'] = terminal.text()
        time.sleep(5.0)
        run['quit:leftovers'] = tree.alive()
        run['quit:requests-after'] = len(fixture.since(gone_at + 2000))
        run['quit:open-streams'] = fixture.active_count()
        tree.kill_left()
        run['rss:tree-peak'] = max(s['tree'] for s in tree.samples)
        run['rss:client-peak'] = max(s['client'] for s in tree.samples)
        run['processes:peak'] = max(s['processes'] for s in tree.samples)
        run['samples'] = tree.samples
        if run['missing'] or run['unobserved']:
            run['screen'] = terminal.text()
    finally:
        terminal.close()
        tree.kill_left()
    # A run that started is valid; each metric is judged on the runs that
    # produced it (freeze and judge below), so one missing measurement does
    # not silently drop the whole run.
    run['valid'] = 'ready' not in run['missing']
    return run


def crash_run(subject, env, cwd, fixture, log):
    """SIGKILL / TerminateProcess the client under load, then resume the session."""
    run = {'subject': subject.name, 'kind': 'crash', 'missing': []}
    terminal = Terminal(subject.argv(), env, cwd)
    tree = Tree(terminal.pid, subject.client_names)
    try:
        if terminal.wait(lambda t: subject.ready_mark in t, 40) is None:
            run['missing'].append('ready')
            return run
        if subject.name == 'candidate':
            terminal.wait(lambda t: 'Connected to dsh ACP' in t, 40)
        terminal.drain(1.0)
        terminal.send('STRESS_FANOUT')
        terminal.drain(0.3)
        terminal.send('\r')
        wait_for(lambda: fixture.active_count('child', 'c') >= CHILDREN, 60, terminal)
        terminal.drain(1.5)
        tree.sample('before-crash')
        client = subject.client_pid(terminal)
        run['crash:client'] = client
        if client is None:
            run['missing'].append('client-pid')
            return run
        psutil.Process(client).kill()
        crashed = now_ms()
        wait_for(terminal.exited, 10, terminal)
        time.sleep(10.0)
        run['crash:orphans'] = tree.alive()
        run['crash:requests-after'] = len(fixture.since(crashed + 2000))
        run['crash:open-streams'] = fixture.active_count()
        tree.kill_left()
    finally:
        terminal.close()
        tree.kill_left()
    wait_quiet(fixture, None, 30, idle=2.0)
    # Resume the killed session: what does it say about the work that was running?
    terminal = Terminal(subject.argv(resume=True), env, cwd)
    tree = Tree(terminal.pid, subject.client_names)
    try:
        terminal.wait(lambda t: subject.ready_mark in t, 40)
        if subject.name == 'candidate':
            terminal.wait(lambda t: 'Connected to dsh ACP' in t, 40)
        terminal.drain(6.0)
        shown = terminal.text()
        run['resume:screen'] = shown
        flat = shown.replace('\n', ' ').lower()
        run['resume:claims-running'] = 'still running' in flat
        run['resume:requests'] = len(fixture.since(now_ms() - 6000))
        terminal.send(subject.quit_keys)
        wait_for(terminal.exited, 20, terminal)
    finally:
        terminal.close()
        tree.kill_left()
    # A run that started is valid; each metric is judged on the runs that
    # produced it (freeze and judge below), so one missing measurement does
    # not silently drop the whole run.
    run['valid'] = 'ready' not in run['missing']
    return run


# --------------------------------------------------------------------------- freeze / judge

def series(runs, metric):
    return [run[metric] for run in runs if not run.get('warmup') and run.get('valid') and run.get(metric) is not None]


def freeze(reference_runs):
    thresholds = {}
    for metric in LATENCY + GROWTH:
        relevant = [run for run in reference_runs if not run.get('warmup') and run.get('valid')]
        values = [run[metric] for run in relevant if run.get(metric) is not None]
        if not relevant or len(values) != len(relevant):
            thresholds[metric] = {'kind': 'not-applicable', 'reason': 'the reference did not produce it in every valid run',
                                  'observedRuns': len(values), 'validRuns': len(relevant)}
            continue
        entry = {'samples': len(values), 'median': statistics.median(values), 'p95': p95(values)}
        if metric in LATENCY:
            entry.update(kind='latency', unit='ms', ceiling=max(entry['p95'] * 1.2, entry['p95'] + 16.7))
        else:
            entry.update(kind='growth', unit='KiB', ceiling=max(entry['p95'] * 1.2, entry['p95'] + 32 * MIB))
        thresholds[metric] = entry
    return thresholds


def judge(thresholds, candidate_runs):
    verdicts = {}
    for metric, entry in thresholds.items():
        if entry['kind'] == 'not-applicable':
            verdicts[metric] = {'verdict': 'not-applicable'}
            continue
        values = series(candidate_runs, metric)
        valid = [run for run in candidate_runs if not run.get('warmup') and run.get('valid')]
        if not values or len(values) != len(valid):
            verdicts[metric] = {'verdict': 'fail', 'samples': len(values), 'validRuns': len(valid),
                                'reason': 'the candidate did not produce this measurement in every valid run'}
            continue
        verdicts[metric] = {'samples': len(values), 'median': statistics.median(values), 'p95': p95(values),
                            'verdict': 'pass' if p95(values) <= entry['ceiling'] else 'fail'}
    return verdicts


def hard_checks(runs, crashes):
    """Requirements that do not depend on the reference."""
    checks = {}
    measured = [run for run in runs if not run.get('warmup')]
    checks['quit:no-leftover-process'] = all(not run.get('quit:leftovers') for run in measured if 'quit:leftovers' in run)
    checks['quit:no-model-traffic-after-exit'] = all(
        run.get('quit:requests-after', 0) == 0 and run.get('quit:open-streams', 0) == 0
        for run in measured if 'quit:leftovers' in run)
    checks['crash:no-orphan-process'] = all(not run.get('crash:orphans') for run in crashes if 'crash:orphans' in run)
    checks['crash:no-model-traffic-after-crash'] = all(
        run.get('crash:requests-after', 0) == 0 and run.get('crash:open-streams', 0) == 0
        for run in crashes if 'crash:orphans' in run)
    checks['resume:does-not-claim-killed-work-runs'] = all(
        not run.get('resume:claims-running') for run in crashes if 'resume:claims-running' in run)
    checks['measured'] = bool(measured) and bool(crashes)
    return checks


def summary(values):
    return {'median': statistics.median(values), 'p95': p95(values), 'samples': len(values)} if values else None


def render(key, thresholds, verdicts, hard, reference_hard, runs):
    lines = [f'# Stress bench ({key[0]}-{key[1]})', '', '| metric | reference p95 | ceiling | candidate p50 / p95 | verdict |',
             '| --- | --- | --- | --- | --- |']
    for metric, entry in thresholds.items():
        verdict = verdicts.get(metric, {})
        if entry['kind'] == 'not-applicable':
            lines.append(f'| {metric} | - | - | - | not-applicable |')
            continue
        unit = 'ms' if entry['kind'] == 'latency' else 'KiB'
        cand = '-' if 'p95' not in verdict else f"{verdict['median']:.0f} / {verdict['p95']:.0f}"
        lines.append(f"| {metric} | {entry['p95']:.0f} {unit} | {entry['ceiling']:.0f} {unit} | {cand} | {verdict.get('verdict')} |")
    lines += ['', '| requirement | candidate | reference (reported) |', '| --- | --- | --- |']
    for name, value in hard.items():
        lines.append(f'| {name} | {"pass" if value else "FAIL"} | {reference_hard.get(name)} |')
    lines += ['', '| reported | reference median | candidate median |', '| --- | --- | --- |']
    for metric in REPORTED + ['long:turn-first5']:
        ref = [r[metric] for r in runs['reference'] if not r.get('warmup') and r.get(metric) is not None]
        can = [r[metric] for r in runs['candidate'] if not r.get('warmup') and r.get(metric) is not None]
        lines.append(f'| {metric} | {statistics.median(ref) if ref else "-"} | {statistics.median(can) if can else "-"} |')
    return '\n'.join(lines) + '\n'


def environment():
    info = {'platform': sys.platform, 'machine': platform.machine(), 'release': platform.release(),
            'python': platform.python_version(), 'cpus': os.cpu_count(),
            'memoryKiB': psutil.virtual_memory().total // 1024}
    if sys.platform == 'darwin':
        info['os'] = subprocess.run(['sw_vers', '-productVersion'], capture_output=True, text=True).stdout.strip()
    elif WINDOWS:
        info['os'] = platform.version()
    elif Path('/etc/os-release').exists():
        for line in Path('/etc/os-release').read_text().splitlines():
            if line.startswith('PRETTY_NAME='):
                info['os'] = line.split('=', 1)[1].strip('"')
    return info


# --------------------------------------------------------------------------- main

def fetch_reference(directory):
    """Download this platform's pinned reference into `directory`, check its
    SHA-256 and print the path. The file is only used locally, never uploaded."""
    import urllib.request
    key = platform_key()
    if key not in REFERENCE:
        raise SystemExit(f'no pinned reference for {key}')
    name, expected = REFERENCE[key]
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / name
    if not target.exists() or sha256_file(target) != expected:
        with urllib.request.urlopen(REFERENCE_URL + name, timeout=300) as response, open(target, 'wb') as out:
            shutil.copyfileobj(response, out)
    digest = sha256_file(target)
    if digest != expected:
        target.unlink()
        raise SystemExit(f'reference SHA-256 {digest} is not the pinned {expected} for {key}')
    if not WINDOWS:
        target.chmod(0o755)
    print(target)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--fetch-reference':
        fetch_reference(sys.argv[2])
        return
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--reference', help='pinned Grok 1.0.34 binary for this platform (SHA-256 checked)')
    parser.add_argument('--launcher', help='installed codsh launcher (codsh-cli/bin/codsh.mjs)')
    parser.add_argument('--dsh', help='DSH_BIN for the candidate (default: what the launcher finds)')
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--runs', type=int, default=5)
    parser.add_argument('--crash-runs', type=int, default=2)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--only', choices=('reference', 'candidate'), help='measure one product, no judging (development)')
    args = parser.parse_args()

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    log_path = output / 'bench.log'

    def log(message):
        line = f'[{time.strftime("%H:%M:%S")}] {message}'
        print(line, flush=True)
        with open(log_path, 'a', encoding='utf-8') as handle:
            handle.write(line + '\n')

    key = platform_key()
    subjects = {}
    if args.only != 'candidate':
        if not args.reference:
            raise SystemExit('--reference is required (or --only candidate)')
        subjects['reference'] = Reference(args.reference)
    if args.only != 'reference':
        if not args.launcher:
            raise SystemExit('--launcher is required (or --only reference)')
        subjects['candidate'] = Candidate(args.launcher, args.dsh, args.node)
    fixture = Fixture(task_command())
    root = Path(tempfile.mkdtemp(prefix='codsh-stress-'))
    report = {'platform': f'{key[0]}-{key[1]}', 'environment': environment(), 'terminal': {'rows': ROWS, 'cols': COLS},
              'load': {'children': CHILDREN, 'childLines': CHILD_LINES, 'childInterval': CHILD_INTERVAL,
                       'taskLines': TASK_LINES, 'taskInterval': TASK_INTERVAL, 'workflowChildren': 3,
                       'workflowChildLines': WORKFLOW_CHILD_LINES, 'turns': TURNS, 'turnLines': TURN_LINES,
                       'loadSeconds': LOAD_SECONDS},
              'runs': args.runs, 'crashRuns': args.crash_runs}
    if 'reference' in subjects:
        report['reference'] = {'version': REFERENCE_VERSION, 'sha256': subjects['reference'].sha256,
                               'file': REFERENCE[key][0]}
    runs = {'reference': [], 'candidate': []}
    crashes = {'reference': [], 'candidate': []}
    try:
        for name in ('reference', 'candidate'):
            if name not in subjects:
                continue
            subject = subjects[name]
            if name == 'candidate' and 'reference' in subjects:
                thresholds = freeze(runs['reference'])
                frozen = json.dumps(thresholds, indent=2, sort_keys=True)
                (output / 'thresholds.json').write_text(frozen + '\n')
                digest = hashlib.sha256((frozen + '\n').encode()).hexdigest()
                report['thresholdsSha256'] = digest
                log(f'thresholds frozen before any candidate process: sha256 {digest}')
            for number in range(args.runs + 1):
                home = root / f'{name}-{number}'
                (home / 'workspace').mkdir(parents=True)
                task_files(home / 'workspace')
                env = subject.prepare(home, fixture.port)
                run = stress_run(subject, env, home / 'workspace', fixture, log)
                run['run'] = number
                run['warmup'] = number == 0
                runs[name].append(run)
                log(f'{name} run {number}{" (warm-up)" if number == 0 else ""}: ' + ' '.join(
                    f'{m}={run.get(m):.0f}' if isinstance(run.get(m), (int, float)) else f'{m}={run.get(m)}'
                    for m in LATENCY + GROWTH) + f' leftovers={run.get("quit:leftovers")} '
                    f'after={run.get("quit:requests-after")} missing={run["missing"]}')
                shutil.rmtree(home, ignore_errors=True)
            for number in range(args.crash_runs):
                home = root / f'{name}-crash-{number}'
                (home / 'workspace').mkdir(parents=True)
                task_files(home / 'workspace')
                env = subject.prepare(home, fixture.port)
                crash = crash_run(subject, env, home / 'workspace', fixture, log)
                crash['run'] = number
                crashes[name].append(crash)
                log(f'{name} crash {number}: orphans={crash.get("crash:orphans")} after={crash.get("crash:requests-after")} '
                    f'streams={crash.get("crash:open-streams")} claims-running={crash.get("resume:claims-running")} '
                    f'missing={crash["missing"]}')
                shutil.rmtree(home, ignore_errors=True)
    finally:
        fixture.close()
        (output / 'runs.json').write_text(json.dumps({'runs': runs, 'crashes': crashes}, indent=1, default=str))
    if 'reference' in subjects and 'candidate' in subjects:
        thresholds = json.loads((output / 'thresholds.json').read_text())
        verdicts = judge(thresholds, runs['candidate'])
        hard = hard_checks(runs['candidate'], crashes['candidate'])
        reference_hard = hard_checks(runs['reference'], crashes['reference'])
        failed = sorted([m for m, v in verdicts.items() if v['verdict'] == 'fail'] +
                        [m for m, v in hard.items() if not v])
        # A metric the reference could not produce is not a pass: the run is
        # incomplete until the harness measures it on this platform.
        not_judged = sorted(m for m, v in verdicts.items() if v['verdict'] == 'not-applicable')
        report.update(verdicts=verdicts, hard=hard, referenceHard=reference_hard, failed=failed, notJudged=not_judged)
        for name in ('reference', 'candidate'):
            report[f'{name}Reported'] = {m: summary([r[m] for r in runs[name] if not r.get('warmup') and r.get(m) is not None])
                                         for m in REPORTED + ['long:turn-first5']}
        (output / 'report.md').write_text(render(key, thresholds, verdicts, hard, reference_hard, runs))
        log(f'failed: {failed or "none"}; not judged: {not_judged or "none"}')
    else:
        report['measured'] = {name: {m: summary(series(runs[name], m)) for m in LATENCY + GROWTH} for name in subjects}
        report['hard'] = {name: hard_checks(runs[name], crashes[name]) for name in subjects}
    (output / 'report.json').write_text(json.dumps(report, indent=2, default=str))
    shutil.rmtree(root, ignore_errors=True)
    if report.get('failed') or report.get('notJudged'):
        sys.exit(1)


if __name__ == '__main__':
    main()
