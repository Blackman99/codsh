#!/usr/bin/env python3
"""PTY: a remote workspace over SSH through the Rust client (ticket 190).

A local OpenSSH server on 127.0.0.1 (unprivileged, temp host key, one
authorized public key, no forwarding) stands in for the remote host. The
remote end runs `codsh-rust agent --leader stdio` with its own home, config,
and the keyless mock LLM; the terminal client connects with
`--remote ssh://…` using public-key auth and a pinned host key. Covers:

A. The remote policy asks; the approval card appears locally, `y` allows it,
   and the remote file changes while the same-named local file does not.
   Features that need this machine's dsh home are refused in the session.
B. The ssh connection is killed mid-turn: the turn shows as interrupted, a
   prompt is not sent while disconnected, `/reconnect` attaches to the turn
   still running there, and its command ran exactly once.
C. The remote leader restarts mid-turn: the client says the running turn has
   no result and unknown effects; `/reconnect` resumes the saved session and
   nothing is retried.

OpenSSH: CODSH_TEST_OPENSSH=<prefix> (a tree with usr/bin/ssh, usr/sbin/sshd)
or ssh/sshd on PATH (/usr/sbin included). Without them the script prints SKIP
with the reason and exits 0. Runs on Linux and macOS against the repo
launcher and the staged native binary (run `pnpm run build:rust` first).
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('screen_pty', ROOT / 'scripts/rust-screen-pty-test.py')
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)
Session = screen.Session
NODE = screen.NODE
LAUNCHER = ROOT / 'packages/cli/bin/codsh.mjs'


def native_binary():
    platform = 'darwin' if sys.platform == 'darwin' else 'linux'
    arch = {'x86_64': 'x64', 'amd64': 'x64', 'arm64': 'arm64', 'aarch64': 'arm64'}[os.uname().machine.lower()]
    path = ROOT / 'packages/cli/native' / f'{platform}-{arch}' / 'codsh-rust'
    if not path.exists():
        raise SystemExit(f'missing staged binary {path}; run pnpm run build:rust')
    return path


def openssh():
    prefix = os.environ.get('CODSH_TEST_OPENSSH')
    if prefix:
        base = Path(prefix)
        ssh, sshd = base / 'usr/bin/ssh', base / 'usr/sbin/sshd'
        keygen = base / 'usr/bin/ssh-keygen'
        libexec = base / 'usr/lib/openssh'
        libs = base / 'usr/lib/x86_64-linux-gnu'
        extra = {}
        if (libexec / 'sshd-session').exists():
            extra['SshdSessionPath'] = str(libexec / 'sshd-session')
        if (libexec / 'sshd-auth').exists():
            extra['SshdAuthPath'] = str(libexec / 'sshd-auth')
        return ssh, sshd, keygen, extra, (str(libs) if libs.exists() else None)
    search = os.environ.get('PATH', '') + ':/usr/sbin:/usr/local/sbin'
    found = [shutil.which(name, path=search) for name in ('ssh', 'sshd', 'ssh-keygen')]
    if not all(found):
        return None
    return Path(found[0]), Path(found[1]), Path(found[2]), {}, None


def free_port():
    import socket
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Sshd:
    def __init__(self, work, tools):
        ssh, sshd, keygen, extra, libs = tools
        self.ssh = ssh
        self.dir = work / 'ssh'
        self.dir.mkdir()
        for name in ('host_key', 'client_key'):
            subprocess.run([str(keygen), '-q', '-t', 'ed25519', '-N', '', '-f', str(self.dir / name)], check=True)
        (self.dir / 'authorized_keys').write_text((self.dir / 'client_key.pub').read_text())
        self.port = free_port()
        host_pub = ' '.join((self.dir / 'host_key.pub').read_text().split()[:2])
        (self.dir / 'known_hosts').write_text(f'[127.0.0.1]:{self.port} {host_pub}\n')
        lines = [
            f'Port {self.port}', 'ListenAddress 127.0.0.1', f'HostKey {self.dir / "host_key"}',
            f'PidFile {self.dir / "sshd.pid"}', f'AuthorizedKeysFile {self.dir / "authorized_keys"}',
            'StrictModes no', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
            'PubkeyAuthentication yes', 'AllowTcpForwarding no', 'AllowAgentForwarding no',
            'X11Forwarding no', 'PermitTunnel no',
            *[f'{key} {value}' for key, value in extra.items()],
        ]
        (self.dir / 'sshd_config').write_text('\n'.join(lines) + '\n')
        env = dict(os.environ)
        if libs:
            env['LD_LIBRARY_PATH'] = libs
        self.process = subprocess.Popen(
            [str(sshd), '-D', '-e', '-f', str(self.dir / 'sshd_config')],
            env=env, stdout=subprocess.DEVNULL, stderr=open(self.dir / 'sshd.log', 'wb'))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if 'Server listening' in (self.dir / 'sshd.log').read_text(errors='replace'):
                return
            if self.process.poll() is not None:
                break
            time.sleep(0.05)
        raise AssertionError('sshd did not start:\n' + (self.dir / 'sshd.log').read_text(errors='replace'))

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()


def remote_home(work, name, mode, policy, binary, dsh, patch, extra_env=None):
    home = work / name
    (home / 'dsh').mkdir(parents=True)
    (home / '.grok').mkdir()
    (home / '.grok' / 'config.toml').write_text(f'[ui]\npermission_mode = "{policy}"\n')
    ws = work / f'{name}-ws'
    ws.mkdir()
    (ws / 'note.txt').write_text('alpha\n')
    env = {
        'PATH': os.environ['PATH'], 'HOME': str(home), 'DSH_HOME': str(home / 'dsh'),
        'GROK_HOME': str(home / '.grok'), 'DSH_BIN': dsh, 'CODSH_NODE': NODE,
        'CODSH_ACP_PATCH': str(patch), 'DSH_CODE_CLI_MOCK_TOOL': mode,
        'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF', 'CODSH_UPDATE_CHECK': 'off',
        **(extra_env or {}),
    }
    # The login shell records what ssh delivered before the isolated env
    # replaces it, so the test can prove nothing local was forwarded.
    login_env = home / 'login-env.txt'
    command = f'env > {login_env}; env -i ' + ' '.join(f'{key}={value}' for key, value in env.items()) + f' {binary}'
    return home, ws, command, env


def remote_args(sshd, ws, command):
    return [
        '--remote', f'ssh://127.0.0.1:{sshd.port}{ws}',
        '--remote-identity', str(sshd.dir / 'client_key'),
        '--remote-known-hosts', str(sshd.dir / 'known_hosts'),
        '--remote-command', command,
        '--remote-ssh', str(sshd.ssh),
    ]


def wait_until(session, predicate, what, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump()
        shown = session.visible()
        if predicate(shown):
            return shown
        if session.process.poll() is not None:
            break
    (session.output / f'{session.name}-failed.ansi').write_bytes(session.data)
    raise AssertionError(f'{session.name}: {what}\n{session.visible()}')


def wait_file(path, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists() and path.read_text().strip():
            return path.read_text()
        time.sleep(0.1)
    raise AssertionError(f'missing {path}')


def ssh_children(known_hosts):
    found = subprocess.run(['pgrep', '-f', f'UserKnownHostsFile={known_hosts}'], capture_output=True, text=True)
    return [int(pid) for pid in found.stdout.split()]


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    tools = openssh()
    if tools is None:
        print('SKIP rust-remote-pty-test: no OpenSSH ssh/sshd/ssh-keygen found (set CODSH_TEST_OPENSSH=<prefix>)')
        return
    binary = native_binary()
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-remote-', dir='/tmp'))
    dsh = screen.dsh_bin()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-remote-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        patch = work / 'overlay.yml'
        patch.write_text(screen.overlay_text())
        sshd = Sshd(work, tools)
        local_home = work / 'local'
        local_home.mkdir()
        local_cwd = work / 'local-ws'
        local_cwd.mkdir()
        (local_cwd / 'note.txt').write_text('local alpha\n')
        env = {
            'HOME': str(local_home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF', 'CODSH_UPDATE_CHECK': 'off',
            # Local credentials that must never reach the remote.
            'DEEPSEEK_API_KEY': 'local-secret-190', 'XAI_API_KEY': 'local-xai-190',
            'GROK_CODE_XAI_API_KEY': 'local-grok-190',
        }
        sessions = []
        try:
            # A. Remote policy asks; the remote file changes, the local one does not.
            home_a, ws_a, command_a, remote_env_a = remote_home(work, 'remote-a', 'file-edit', 'ask', binary, dsh, patch)
            a = Session('remote-approve', LAUNCHER, local_cwd, env, output,
                        extra=['--fullscreen', *remote_args(sshd, ws_a, command_a)], cols=160, rows=48)
            sessions.append(a)
            shown = a.wait_visible('Connected to dsh ACP', 40)
            assert f'on remote ssh://127.0.0.1:{sshd.port}{ws_a}' in shown.replace('\n', ''), shown
            a.write('edit the note')
            a.wait_visible('edit the note', 10)
            a.write(b'\r')
            wait_until(a, lambda s: 'y=allow' in s or 'Allow' in s, 'remote approval card', 40)
            assert (ws_a / 'note.txt').read_text() == 'alpha\n'
            a.write('y')
            wait_until(a, lambda s: 'RUST_ACP_FILE_DONE' in s, 'remote edit done', 40)
            assert (ws_a / 'note.txt').read_text() == 'ALPHA\n'
            assert (local_cwd / 'note.txt').read_text() == 'local alpha\n'
            results['remote_policy_and_files'] = True
            a.send_slash('/memory')
            a.wait_visible('not available in a remote session', 15)
            a.send_slash('/remote')
            shown = a.wait_visible('reattach: yes', 15)
            assert 'transport=leader' in shown, shown
            results['capabilities'] = True
            login = (home_a / 'login-env.txt').read_text()
            for secret in ('local-secret-190', 'local-xai-190', 'local-grok-190', str(local_home)):
                assert secret not in login, (secret, login)
            results['nothing_forwarded'] = True
            a.finish(expect_alt_leave=True)

            # B. The connection drops mid-turn; /reconnect attaches, nothing reruns.
            home_b, ws_b, command_b, _ = remote_home(work, 'remote-b', 'shell-count', 'always-approve', binary, dsh, patch,
                                                     {'CODSH_SHELL_SLEEP': '6'})
            b = Session('remote-reconnect', LAUNCHER, local_cwd, env, output,
                        extra=['--fullscreen', *remote_args(sshd, ws_b, command_b)], cols=160, rows=48)
            sessions.append(b)
            b.wait_visible('Connected to dsh ACP', 40)
            b.write('count once')
            b.wait_visible('count once', 10)
            b.write(b'\r')
            wait_file(ws_b / 'shell-count.txt', 40)
            pids = ssh_children(sshd.dir / 'known_hosts')
            assert pids, 'no ssh child of the client'
            for pid in pids:
                os.kill(pid, signal.SIGKILL)
            wait_until(b, lambda s: 'Remote workspace disconnected' in s, 'disconnected status', 20)
            b.write('not while disconnected')
            b.write(b'\r')
            b.wait_visible('nothing was sent', 10)
            b.send_slash('/reconnect')
            wait_until(b, lambda s: 'still running there and was not sent again' in s or 'RUST_ACP_COUNT_DONE' in s,
                       'reattached', 40)
            wait_until(b, lambda s: 'RUST_ACP_COUNT_DONE' in s, 'reattached turn completes', 40)
            time.sleep(1)
            assert (ws_b / 'shell-count.txt').read_text() == 'RAN\n', (ws_b / 'shell-count.txt').read_text()
            assert (ws_b / 'shell-done.txt').read_text() == 'DONE\n'
            results['reconnect_no_duplicate'] = True
            b.finish(expect_alt_leave=True)

            # C. The remote leader restarts mid-turn: unknown effects, no retry.
            home_c, ws_c, command_c, remote_env_c = remote_home(work, 'remote-c', 'shell-count', 'always-approve', binary, dsh,
                                                                patch, {'CODSH_SHELL_SLEEP': '3'})
            c = Session('remote-restart', LAUNCHER, local_cwd, env, output,
                        extra=['--fullscreen', *remote_args(sshd, ws_c, command_c)], cols=160, rows=48)
            sessions.append(c)
            c.wait_visible('Connected to dsh ACP', 40)
            c.write('count then restart')
            c.wait_visible('count then restart', 10)
            c.write(b'\r')
            wait_file(ws_c / 'shell-count.txt', 40)
            listed = subprocess.run([str(binary), 'leader', 'list', '--json'], env=remote_env_c,
                                    capture_output=True, text=True, timeout=30)
            leaders = json.loads(listed.stdout)
            assert len(leaders) == 1, listed
            os.kill(leaders[0]['pid'], signal.SIGTERM)
            shown = wait_until(c, lambda s: 'Remote workspace disconnected' in s, 'restart disconnect', 30)
            flat = shown.replace('\n', '')
            assert 'unknown' in flat and 'not retried' in flat, shown
            results['restart_unknown'] = True
            time.sleep(4)
            c.send_slash('/reconnect')
            shown = wait_until(c, lambda s: 'resumed it from saved history' in s.replace('\n', ''), 'resume after restart', 40)
            assert 'unknown' in shown.replace('\n', ''), shown
            time.sleep(4)
            assert (ws_c / 'shell-count.txt').read_text() == 'RAN\n', (ws_c / 'shell-count.txt').read_text()
            results['restart_no_retry'] = True
            c.finish(expect_alt_leave=True)
        finally:
            for session in sessions:
                session.close()
            for name in ('remote-a', 'remote-b', 'remote-c'):
                home = work / name
                if home.exists():
                    subprocess.run([str(binary), 'leader', 'kill'], capture_output=True, timeout=30, env={
                        'PATH': os.environ['PATH'], 'HOME': str(home), 'GROK_HOME': str(home / '.grok'),
                        'DSH_HOME': str(home / 'dsh')})
            sshd.stop()
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
