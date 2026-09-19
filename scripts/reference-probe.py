"""Capture the pinned installed reference in a fresh, offline macOS sandbox."""
import argparse
import base64
import codecs
import hashlib
import json
import os
from pathlib import Path
import platform
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import fcntl
import time

VERSION = "1.0.34 (3736acbc8658)"
BINARY_SHA256 = '9cd26b579840f0f5c9148a8059ad651904c08b41b7f2ef0b4ec04b9ba898844e'
FIXTURE_CONFIG = '''[cli]
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
default = "reference-fixture"
[model.reference-fixture]
model = "reference-fixture"
base_url = "http://127.0.0.1:1/v1"
api_key = "synthetic-reference-key"
context_window = 128000
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_binary(binary):
    if platform.system() != 'Darwin' or not Path('/usr/bin/sandbox-exec').exists():
        raise RuntimeError('Reference probes require macOS sandbox-exec; unconfined fallback is forbidden.')
    if digest(binary.read_bytes()) != BINARY_SHA256:
        raise RuntimeError('Pinned reference binary SHA-256 mismatch')


def sandbox_profile(root, binary, personal_home, port=None):
    for path in (root, binary, personal_home):
        if any(char in str(path) for char in ['"', '\\', '\n']):
            raise ValueError("Unsupported sandbox path")
    local = f'(allow network-outbound (remote tcp "localhost:{port}"))' if port else ''
    return (f'(version 1)(allow default)(deny network*){local}'
            f'(deny file-write*)(allow file-write* (subpath "{root}") (literal "/dev/tty"))'
            f'(deny file-read* (subpath "{personal_home}") (subpath "/etc/grok") '
            '(subpath "/Library/Managed Preferences") '
            '(subpath "/Library/Application Support/ClaudeCode"))'
            f'(allow file-read* (literal "{binary}"))'
            '(deny mach-lookup (global-name "com.apple.securityd"))')


class Reference:
    def __init__(self, binary, root):
        self.binary = binary
        self.root = root
        self.home = root / 'home'
        self.grok = self.home / '.grok'
        self.work = root / 'workspace'
        self.grok.mkdir(parents=True)
        self.work.mkdir()
        (self.grok / 'config.toml').write_text(FIXTURE_CONFIG)
        self.env = {
            'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(self.home),
            'GROK_HOME': str(self.grok), 'TMPDIR': str(root), 'TERM': 'xterm-256color',
            'LANG': 'en_US.UTF-8', 'GROK_DISABLE_AUTOUPDATER': '1',
            'GROK_TELEMETRY_ENABLED': '0', 'GROK_TELEMETRY_TRACE_UPLOAD': '0',
            'GROK_REMOTE_FETCH': '0', 'GROK_USE_LEADER': '0',
            'GROK_MANAGED_MCPS_ENABLED': '0', 'XAI_API_KEY': 'synthetic-reference-key',
        }
        self.profile = sandbox_profile(root, binary, Path.home())

    def command(self, args, timeout=15, stdin=None):
        start = time.perf_counter_ns()
        process = subprocess.Popen(['/usr/bin/sandbox-exec', '-p', self.profile,
                                    str(self.binary), *args], env=self.env, cwd=self.work,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
        timed_out = False
        try:
            stdout, stderr = process.communicate(stdin, timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        return {'args': args, 'exit': process.returncode, 'timedOut': timed_out,
                'elapsedMs': (time.perf_counter_ns() - start) / 1e6,
                'stdout': stdout.decode(errors='replace'), 'stderr': stderr.decode(errors='replace')}

    def terminal(self, mode, environment=None, tutorial=False):
        env = {**self.env, **(environment or {})}
        start = time.perf_counter_ns()
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(self.work)
            os.execve('/usr/bin/sandbox-exec', ['sandbox-exec', '-p', self.profile,
                                               str(self.binary), '--' + mode], env)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 100, 0, 0))
        events, output, rss = [], bytearray(), []
        decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        status = None
        sync = b'\x1b[?2026l'

        def elapsed():
            return (time.perf_counter_ns() - start) / 1e6

        def read_for(seconds, marker=None, after=0):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if select.select([fd], [], [], 0.01)[0]:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError:
                        return False
                    if not chunk:
                        return False
                    output.extend(chunk)
                    events.append({'ms': elapsed(), 'output': decoder.decode(chunk), 'bytesBase64': base64.b64encode(chunk).decode()})
                    for query, reply in [(b'\x1b[6n', b'\x1b[1;1R'), (b'\x1b[c', b'\x1b[?1;2c')]:
                        if query in chunk:
                            os.write(fd, reply)
                            events.append({'ms': elapsed(), 'replyHex': reply.hex()})
                    if marker and marker in output[after:]:
                        return True
            return marker is None

        def send(name, payload, marker=None, resize=None):
            read_for(0.15)
            before = len(output)
            sent = elapsed()
            event = {'ms': sent, 'action': name, 'offset': before}
            if resize:
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', *resize, 0, 0))
                os.kill(pid, signal.SIGWINCH)
                event['size'] = list(resize)
            else:
                os.write(fd, payload)
                event['inputHex'] = payload.hex()
            events.append(event)
            found = read_for(4, marker, before) if marker else read_for(0.3)
            if marker and found:
                read_for(0.03)
            event['observedMs'] = elapsed()
            event['markerFound'] = found if marker else None
            event['endOffset'] = len(output)
            sample = subprocess.run(['/bin/ps', '-o', 'rss=', '-p', str(pid)], capture_output=True, text=True)
            if sample.stdout.strip().isdigit():
                rss.append({'action': name, 'ms': elapsed(), 'rssKiB': int(sample.stdout)})
            return event

        try:
            ready = read_for(8, sync if mode == 'fullscreen' else b'reference-fixture')
            first_frame = elapsed() if ready else None
            send('draft', b'REFERENCE133', b'REFERENCE133')
            send('clear-draft', b'\x03')
            if tutorial:
                marker = b'Welcome to Grok Build' if mode == 'fullscreen' else b"isn't available in minimal mode"
                send('tutorial-open', b'/tutorial\r', marker)
                if mode == 'fullscreen':
                    send('tutorial-topic', b'\r', b'Coming from')
                    send('tutorial-next', b'\x1b[C', sync)
                    send('tutorial-previous', b'\x1b[D', sync)
                    send('tutorial-list', b'\x1b', b'explored')
                    send('tutorial-dismiss', b'\x1b')
                for alias in ['tour', 'onboarding']:
                    send(f'{alias}-open', f'/{alias}\r'.encode(), marker)
                    if mode == 'fullscreen':
                        send(f'{alias}-dismiss', b'\x1b')
                send('after-tutorial-draft', b'AFTER_TUTORIAL', b'AFTER_TUTORIAL')
                send('after-tutorial-clear', b'\x03')
            else:
                send('settings-open', b'/settings\r', b'Compact mode')
                send('settings-scroll', b'\x1b[6~', sync)
                send('resize-narrow', b'', sync, (24, 80))
                send('settings-close', b'\x1b')
            send('quit', b'/quit\r')
            read_for(1)
            waited, value = os.waitpid(pid, os.WNOHANG)
            if waited:
                status = value
        finally:
            if status is None:
                os.kill(pid, signal.SIGKILL)
                _, status = os.waitpid(pid, 0)
            os.close(fd)
        return {'mode': mode, 'environment': environment or {}, 'initialSize': [32, 100], 'events': events,
                'firstFrameMs': first_frame, 'rss': rss,
                'exit': os.waitstatus_to_exitcode(status),
                'forcedCleanup': os.waitstatus_to_exitcode(status) == -signal.SIGKILL,
                'restoredAlternateScreen': b'\x1b[?1049l' in output,
                'outputBytes': len(output), 'outputSha256': digest(bytes(output))}


def help_commands(text):
    section = re.search(r'^Commands:\n(.*?)(?=\n[A-Z][^\n]*:|\Z)', text, re.M | re.S)
    if not section:
        return []
    return re.findall(r'^  ([a-z][a-z0-9-]*)\s{2,}', section[1], re.M)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=5)
    parser.add_argument('--source-evidence', type=Path, default=Path(__file__).parent.parent / 'docs/rewrite/reference/source-evidence.json')
    args = parser.parse_args()
    if platform.system() != 'Darwin' or not Path('/usr/bin/sandbox-exec').exists():
        parser.error('This driver requires macOS sandbox-exec; it never falls back to unconfined execution.')
    if args.samples < 3:
        parser.error('At least three raw samples are required.')
    binary = args.binary.resolve(strict=True)
    validate_binary(binary)
    args.output.mkdir(parents=True, exist_ok=False)
    result = {'schemaVersion': 1, 'reference': VERSION, 'binarySha256': digest(binary.read_bytes()),
              'capturedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'machine': {'system': platform.system(), 'release': platform.release(),
                          'architecture': platform.machine(),
                          'cpu': subprocess.check_output(['/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip()},
              'fixtureConfig': FIXTURE_CONFIG, 'network': 'deny all',
              'commands': [], 'terminals': [], 'baseline': []}
    with tempfile.TemporaryDirectory(prefix='codsh-reference-133-') as tmp:
        reference = Reference(binary, Path(tmp).resolve())
        result['environment'] = {k: v.replace(str(reference.root), '<ROOT>') for k, v in reference.env.items()}
        version = reference.command(['version', '--json'])
        result['commands'].append(version)
        if version['exit'] != 0 or json.loads(version['stdout'])['currentVersion'] != VERSION:
            raise RuntimeError('Reference version mismatch')
        source = json.loads(args.source_evidence.read_text())
        if source.get('sourceCommit') != 'a28ee2b2063426e8816e380ccea528b9de95e5da' or not source.get('commands'):
            raise RuntimeError('Pinned source command expectations are required')
        source_paths = [path for declaration in source['commands'] for path in declaration['commands']]
        if any(not path or any(not re.fullmatch(r'[a-z][a-z0-9-]*', part) for part in path) for path in source_paths):
            raise RuntimeError('Invalid source command path')
        pending, visited = [[], *source_paths], set()
        result['sourceCommandCommit'] = source['sourceCommit']
        while pending:
            command = pending.pop(0)
            key = tuple(command)
            if key in visited:
                continue
            visited.add(key)
            observation = reference.command([*command, '--help'])
            result['commands'].append(observation)
            if observation['exit'] != 0:
                if command not in source_paths:
                    raise RuntimeError(f'Help failed: {command}')
                observation['sourceAvailability'] = 'unverified-or-unavailable-in-frozen-binary'
                continue
            for child in help_commands(observation['stdout']):
                if child != 'help':
                    pending.append([*command, child])
            for line in observation['stdout'].splitlines():
                match = re.match(r'  ([a-z][a-z0-9-]*)\s{2,}.*\[aliases: ([^\]]+)\]', line)
                if match:
                    pending.extend([*command, alias.strip()] for alias in match[2].split(','))
        for command in [['inspect', '--json'], ['sessions', 'list'],
                        ['--not-a-real-option'], ['--output-format', 'not-a-format']]:
            result['commands'].append(reference.command(command))
        for flag in ['--allowedTools', '--disallowedTools', '--system-prompt', '--append-system-prompt', '--compaction-mode', '--compaction-detail']:
            observation = reference.command([flag])
            result['commands'].append(observation)
            if observation['exit'] != 2 or 'a value is required' not in observation['stderr'] or 'unexpected argument' in observation['stderr']:
                raise RuntimeError(f'Unrecognized compatibility syntax: {flag}')
        result['environmentProbes'] = [reference.terminal('fullscreen', {'GROK_FPS': '0'}),
                                       reference.terminal('fullscreen', {'GROK_FPS': '1'})]
        result['tutorialProbes'] = [reference.terminal(mode, tutorial=True) for mode in ['fullscreen', 'minimal']]
        for mode in ['fullscreen', 'minimal']:
            for index in range(args.samples):
                observation = reference.terminal(mode)
                observation['sample'] = index
                result['terminals'].append(observation)
        for index in range(args.samples):
            observation = reference.command(['version', '--json'])
            observation['sample'] = index
            result['baseline'].append(observation)
        guides = reference.grok / 'docs/user-guide'
        result['guides'] = [{'file': p.name, 'sha256': digest(p.read_bytes()), 'text': p.read_text()}
                            for p in sorted(guides.glob('*.md'))]
        result['sandboxProfile'] = reference.profile.replace(str(reference.root), '<ROOT>').replace(str(binary), '<BINARY>').replace(str(Path.home()), '<PERSONAL_HOME>')
        encoded = json.dumps(result, ensure_ascii=False, indent=2).replace(str(reference.root), '<ROOT>')
        (args.output / 'observations.json').write_text(encoded + '\n')
    if any(item['exit'] != 0 or item['forcedCleanup'] or item['firstFrameMs'] is None
           or any(event.get('markerFound') is False for event in item['events'])
           for item in result['terminals'] + result['environmentProbes'] + result['tutorialProbes']):
        raise SystemExit('Reference PTY assertion failed; raw observations were preserved.')
    fps = [any('fps' in event.get('output', '').lower() for event in terminal['events'])
           for terminal in result['environmentProbes']]
    if fps != [False, True]:
        raise SystemExit('GROK_FPS paired observation failed; raw evidence was preserved.')
    print(json.dumps({'commands': len(result['commands']), 'guides': len(result['guides']),
                      'terminals': len(result['terminals']), 'environmentProbes': len(result['environmentProbes']), 'tutorialProbes': len(result['tutorialProbes']), 'output': str(args.output)}))


if __name__ == '__main__':
    main()
