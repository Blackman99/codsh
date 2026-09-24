#!/usr/bin/env python3
"""Installed-product PTY: filesystem sandbox through a real dsh session.

Packs and installs `codsh`, then runs `codsh --rust --sandbox session` in a
real PTY with the keyless mock model. dsh's own tools act: `read`, `edit`, and
`write` in-process, `bash` children (`cat`, `mv`, `python3`), and a real
`subagent` child agent that repeats the attempts. Each attempt targets a
protected file inside the workspace, where dsh's own workspace-write policy
would allow it, so a denial comes from the kernel policy codsh applied. A
second run with `--sandbox off` is the control: the same tool calls succeed.
dsh's own per-call Seatbelt cannot nest inside the codsh policy, so the
confined run also proves bash now runs (and is kernel-denied) through the
overlay codsh writes to $DSH_HOME/codsh-kernel-sandbox.yml, and that the bash
approval card is still asked.

The fixture lives outside /tmp, /var/tmp, and TMPDIR, which are write roots.
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
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
RECORD = '.codsh-mock-record.jsonl'
SECRET = 'TOP_SECRET\n'
HOOK = 'guard\n'


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
    payload = json.dumps({'rows': rows, 'cols': cols, 'bytes': base64.b64encode(data).decode()})
    return run([NODE, '--import', 'tsx', '-e',
                f"import {{ Terminal }} from {json.dumps(emulator.as_uri())}; "
                "let input=''; for await (const chunk of process.stdin) input+=chunk; "
                "const spec=JSON.parse(input); const t=new Terminal(spec.rows,spec.cols); "
                "t.feed(Buffer.from(spec.bytes,'base64').toString()); console.log(t.text);"],
               input=payload, cwd=ROOT).stdout


def inside_temp(path):
    resolved = path.resolve()
    roots = [Path('/tmp'), Path('/private/tmp'), Path('/var/tmp'), Path('/private/var/tmp')]
    if os.environ.get('TMPDIR'):
        roots.append(Path(os.environ['TMPDIR']))
    for root in roots:
        try:
            root = root.resolve()
        except OSError:
            continue
        if resolved == root or root in resolved.parents:
            return True
    return False


def fixture_root():
    for candidate in (Path.home(), ROOT.parent):
        if not candidate.is_dir() or inside_temp(candidate):
            continue
        path = Path(tempfile.mkdtemp(prefix='.codsh-sandbox-pty-', dir=candidate))
        if not inside_temp(path):
            return path
        shutil.rmtree(path, ignore_errors=True)
    raise SystemExit('FAIL no fixture directory outside /tmp, /var/tmp, and TMPDIR')


def make_fixture(base):
    home = base / 'home'
    workspace = base / 'workspace'
    grok = home / '.codsh-rust' / '.grok'
    for path in (grok, workspace / 'hooks', workspace / 'certs'):
        path.mkdir(parents=True)
    (workspace / 'secret.txt').write_text(SECRET)
    (workspace / 'note.txt').write_text('alpha\n')
    (workspace / 'read_secret.py').write_text("open('secret.txt').read()\n")
    (workspace / 'hooks' / 'guard.sh').write_text(HOOK)
    (grok / 'config.toml').write_text('[ui]\npermission_mode = "ask"\n')
    (grok / 'hooks-paths').write_text(f"{workspace / 'hooks' / 'guard.sh'}\n")
    (grok / 'sandbox.toml').write_text(
        '[profiles.session]\nextends = "workspace"\n'
        'deny = ["secret.txt", "certs/**/*.pem"]\n'
    )
    return home, workspace, grok


def exercise(name, launcher, cwd, env, output, extra, cols=180, rows=60):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    original = termios.tcgetattr(slave)
    process = subprocess.Popen([NODE, str(launcher), '--rust', *extra], cwd=cwd, env=env,
                               stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    data = bytearray()

    def pump(seconds=0.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.03)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                data.extend(chunk)

    def visible():
        return screen_text(bytes(data), rows, cols)

    approvals = []

    def wait_visible(text, seconds=30, approve=False):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            pump(0.3)
            shown = visible()
            if text in shown:
                return shown
            if approve and 'Allow ' in shown and 'y=allow once' in shown:
                # The card is the status prompt; the pending tool is the
                # newest tool row in the transcript.
                tools = [line.strip() for line in shown.splitlines() if '[tool ' in line]
                approvals.append(tools[-1] if tools else '')
                os.write(master, b'y')
                cleared = time.monotonic() + 8
                while time.monotonic() < cleared:
                    pump(0.2)
                    if 'y=allow once' not in visible():
                        break
                continue
            if process.poll() is not None:
                break
        raise AssertionError(f'{name}: missing {text!r}\n{visible()}\nraw={bytes(data)[-2500:]!r}')

    try:
        wait_visible('codsh')
        wait_visible('Draft (not sent)')
        startup = wait_visible('Connected to dsh ACP', 30)
        typed = 'TOKEN_SANDBOX_SESSION'
        os.write(master, typed.encode())
        wait_visible(typed)
        os.write(master, b'\r')
        wait_visible('RUST_ACP_SANDBOX_DONE', 180, approve=True)
        shown = visible()
        os.write(master, b'\x11')
        process.wait(timeout=15)
        pump()
        os.write(master, b'AFTER_EXIT_CANONICAL\n')
        assert select.select([slave], [], [], 2)[0]
        assert os.read(slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
        after = termios.tcgetattr(slave)
        (output / f'{name}.ansi').write_bytes(data)
        (output / f'{name}.txt').write_text(shown)
        assert original == after, f'{name}: terminal modes were not restored'
        # The status line can wrap; compare it without layout whitespace.
        return {'name': name, 'exit': process.returncode, 'screen': shown,
                'status': ''.join(startup.split()), 'approvals': approvals}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def load_record(workspace):
    path = workspace / RECORD
    if not path.is_file():
        raise AssertionError(f'mock record missing at {path}')
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return {(row['agent'], row['step']): row for row in rows}


def kernel_denied(row):
    text = row['text'].lower()
    return row['isError'] and ('operation not permitted' in text or 'eperm' in text)


def markers(row, prefix):
    found = {}
    for line in row['text'].splitlines():
        line = line.strip()
        if line.startswith(f'{prefix}_') and '=' in line:
            key, value = line.split('=', 1)
            found[key] = value
    return found


def check_confined(record, workspace, grok):
    def step(agent, name):
        row = record.get((agent, name))
        assert row is not None, f'{agent} {name} did not run: {sorted(record)}'
        return row

    for agent, name in (('parent', 'read-secret'), ('parent', 'edit-hook'), ('parent', 'write-pem'),
                        ('child', 'child-read-secret'), ('child', 'child-write-pem')):
        row = step(agent, name)
        assert kernel_denied(row), f'{agent} {name} was not kernel-denied: {row}'
    assert not step('parent', 'read-hook')['isError'], step('parent', 'read-hook')
    # dsh's own per-call Seatbelt cannot nest inside the codsh policy, so
    # codsh sets dsh's per-call file mode off while a profile is applied.
    # bash then runs directly, and the kernel policy is what denies.
    row = step('parent', 'bash')
    assert not row['isError'] and 'sandbox_apply' not in row['text'], f'parent bash did not run: {row}'
    found = markers(row, 'PARENT')
    for key in ('CAT', 'WRITE', 'MV', 'PY', 'HOOK_MV', 'DIR_MV'):
        value = found.get(f'PARENT_{key}', '')
        assert value.startswith('denied') and 'not permitted' in value.lower(), \
            f'parent bash {key} was not kernel-denied: {found}\n{row}'
    assert found.get('PARENT_ALLOWED') == 'allowed', f'parent allowed bash write failed: {found}'
    row = step('child', 'child-bash')
    assert 'sandbox_apply' not in row['text'], f'child bash did not run: {row}'
    assert 'CHILD_BEGIN' in row['text'] and 'CHILD_END' in row['text'], f'child bash did not run: {row}'
    for needle in ('cat: secret.txt: Operation not permitted',
                   'mv: rename secret.txt to stolen-CHILD.txt: Operation not permitted',
                   "PermissionError: [Errno 1] Operation not permitted: 'secret.txt'",
                   'mv: rename hooks/guard.sh to hooks/moved-CHILD.sh: Operation not permitted',
                   'mv: rename hooks to hooks-moved-CHILD: Operation not permitted'):
        assert needle in row['text'], f'child bash missing kernel denial {needle!r}: {row}'
    # The redirection error is bash-localized; the errno text is not.
    assert row['text'].count('secret.txt: Operation not permitted') >= 2, row
    assert (workspace / 'child-allowed.txt').read_text() == 'ok', 'child allowed bash write failed'
    for name in ('read-note', 'edit-note', 'subagent'):
        assert not step('parent', name)['isError'], step('parent', name)
    assert (workspace / 'secret.txt').read_text() == SECRET, 'protected secret bytes changed'
    assert (workspace / 'hooks' / 'guard.sh').read_text() == HOOK, 'protected hook bytes changed'
    assert (workspace / 'note.txt').read_text() == 'ALPHA\n', 'allowed edit did not land'
    assert (workspace / 'parent-allowed.txt').read_text() == 'ok'
    for name in ('certs/new.pem', 'certs/child.pem', 'stolen-PARENT.txt', 'stolen-CHILD.txt',
                 'hooks-moved-PARENT', 'hooks-moved-CHILD', 'hooks/moved-PARENT.sh', 'hooks/moved-CHILD.sh'):
        assert not (workspace / name).exists(), f'{name} exists after a denied operation'
    assert '"ask"' in (grok / 'config.toml').read_text()


def check_control(record, workspace):
    for agent, name in (('parent', 'read-secret'), ('parent', 'edit-hook'), ('parent', 'write-pem'),
                        ('child', 'child-read-secret'), ('child', 'child-write-pem')):
        row = record.get((agent, name))
        assert row is not None and not row['isError'], f'control {agent} {name}: {row}'
    assert 'TOP_SECRET' in record[('parent', 'read-secret')]['text']
    bash = markers(record[('parent', 'bash')], 'PARENT')
    for key in ('CAT', 'WRITE', 'MV', 'PY', 'HOOK_MV', 'DIR_MV', 'ALLOWED'):
        assert bash.get(f'PARENT_{key}', '').startswith('allowed'), f'control bash {key}: {bash}'
    assert bash['PARENT_CAT'] == 'allowed:TOP_SECRET', bash
    child = record[('child', 'child-bash')]
    assert not child['isError'] and 'CHILD_END' in child['text'], child
    assert 'Operation not permitted' not in child['text'], child
    assert (workspace / 'certs' / 'new.pem').is_file() and (workspace / 'certs' / 'child.pem').is_file()
    assert (workspace / 'hooks' / 'guard.sh').read_text() == 'patched\n'


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required; Linux and Windows are not claimed')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-sandbox-', dir='/tmp'))
    base = fixture_root()
    try:
        dsh = dsh_bin()
        overlay = overlay_text()
        pack_home = base / 'pack-home'
        pack_home.mkdir()
        pack_env = {
            'HOME': str(pack_home), 'PATH': os.environ['PATH'],
            'npm_config_cache': str(base / 'npm-cache'),
            'npm_config_userconfig': str(base / 'empty-user.npmrc'),
            'npm_config_globalconfig': str(base / 'empty-global.npmrc'),
            'npm_config_update_notifier': 'false',
        }
        pack = json.loads(run(['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(base)],
                              cwd=ROOT / 'packages/cli', env=pack_env).stdout)[0]['filename']
        prefix = base / 'installed'
        run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline', '--no-audit', '--no-fund',
             str(base / pack)], env=pack_env)
        launcher = prefix / 'node_modules/.bin/codsh'
        patch = base / 'overlay.yml'
        patch.write_text(overlay)
        results = {}
        for label, profile in (('control-off', 'off'), ('confined', 'session')):
            run_root = base / label
            run_root.mkdir()
            home, workspace, grok = make_fixture(run_root)
            env = {
                'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
                'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
                'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
                'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
                'DSH_CODE_CLI_MOCK_TOOL': 'sandbox-session',
            }
            session = exercise(label, launcher, workspace, env, output,
                               ['--sandbox', profile, '--sandbox-report', str(run_root / 'report.json'),
                                '--trust', '--always-approve'])
            assert session['exit'] == 0, session
            # The report is written by the same packed process before it
            # applies the policy; the status line names the mechanism.
            report = json.loads((run_root / 'report.json').read_text())
            if profile == 'off':
                assert report['applied'] is False, report
                assert 'sandboxoff(nofilesystemconfinement)' in session['status'], session['status']
            else:
                assert report['applied'] is True and report['mechanism'] == 'Seatbelt', report
                assert any(str(path).endswith('/secret.txt') for path in report['readDenied']), report
                assert report['readDeniedGlobs'] == ['certs/**/*.pem'], report
                assert 'Seatbeltonmacos' in session['status'], session['status']
            (output / f'{label}-report.json').write_text(json.dumps(report, indent=2) + '\n')
            record = load_record(workspace)
            shutil.copy(workspace / RECORD, output / f'{label}-record.jsonl')
            if profile == 'off':
                check_control(record, workspace)
            else:
                check_confined(record, workspace, grok)
                # The dsh overlay changes the per-call file mode only: the
                # command the permission layer cannot split still asks.
                assert any('[tool bash]' in card and 'rust-acp-sandbox-bash' in card
                           for card in session['approvals']), session['approvals']
                overlay = (home / '.codsh-rust' / 'dsh' / 'codsh-kernel-sandbox.yml').read_text()
                assert 'mode: danger-full-access' in overlay and 'approval: ask' in overlay, overlay
                assert 'id: approval' not in overlay, overlay
            if profile == 'off':
                assert not (home / '.codsh-rust' / 'dsh' / 'codsh-kernel-sandbox.yml').exists()
            results[label] = {'exit': session['exit'], 'steps': len(record), 'approvals': session['approvals']}
        (output / 'result.json').write_text(json.dumps({'results': results, 'dshBin': dsh}, indent=2) + '\n')
    finally:
        shutil.rmtree(base, ignore_errors=True)
    print(f'PASS: rust sandbox dsh session PTY; evidence: {output}')


if __name__ == '__main__':
    main()
