#!/usr/bin/env python3
"""Three-platform capability matrix for the installed Rust client (#201).

Records the real OS and terminal, then runs the installed-product checks that
prove what this platform can and cannot do. A green cell is never invented:
missing devices, missing privileges and refused features are recorded as
`refused` or `unavailable` with the exact message, never as a silent pass.

Rows: keys (prompt PTY), mouse (nav), shell, cancel, screen modes, terminal
restore / hangup / early-quit, clipboard (real pasteboard / X11 / Windows),
voice doctor without fixtures, sandbox profiles, remote SSH, real tmux, and
the Windows ConPTY harness (including the #200 notes).

Usage (after packing or with CODSH_MATRIX_LAUNCHER pointing at an install):
    python3 scripts/rust-capability-matrix.py --output DIR
"""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node') or subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()


def capture(argv, timeout=20):
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def environment():
    info = {
        'platform': sys.platform,
        'machine': platform.machine(),
        'kernel': platform.release(),
        'python': platform.python_version(),
        'node': capture([NODE, '-p', "process.version + ' ' + process.platform + '-' + process.arch"]),
        'term': os.environ.get('TERM'),
        'term_program': os.environ.get('TERM_PROGRAM'),
        'tmux': bool(shutil.which('tmux')),
        'ssh': bool(shutil.which('ssh')),
        'sshd': bool(shutil.which('sshd') or Path('/usr/sbin/sshd').is_file()),
        'ci': os.environ.get('GITHUB_ACTIONS') == 'true',
        'runner': os.environ.get('RUNNER_NAME') or os.environ.get('ImageOS'),
        'matrix_launcher': os.environ.get('CODSH_MATRIX_LAUNCHER'),
    }
    if sys.platform == 'linux':
        release = Path('/etc/os-release')
        if release.exists():
            fields = dict(line.split('=', 1) for line in release.read_text().splitlines() if '=' in line)
            info['os'] = fields.get('PRETTY_NAME', '').strip('"')
        info['libc'] = capture([NODE, '-p', "process.report.getReport().header.glibcVersionRuntime || 'not glibc'"])
        info['bwrap'] = bool(shutil.which('bwrap'))
        info['xclip'] = bool(shutil.which('xclip'))
        info['wl_copy'] = bool(shutil.which('wl-copy'))
        info['display'] = os.environ.get('DISPLAY')
        info['xauthority'] = bool(os.environ.get('XAUTHORITY'))
    elif sys.platform == 'darwin':
        info['os'] = f"macOS {capture(['sw_vers', '-productVersion'])} ({capture(['sw_vers', '-buildVersion'])})"
        info['rosetta'] = capture(['sysctl', '-in', 'sysctl.proc_translated']) == '1'
        info['pbcopy'] = bool(shutil.which('pbcopy'))
    elif sys.platform == 'win32':
        info['os'] = capture(['cmd', '/c', 'ver'])
        info['pwsh'] = shutil.which('pwsh')
    return info


def cell(status, detail=None, seconds=None):
    row = {'status': status}
    if detail is not None:
        row['detail'] = detail
    if seconds is not None:
        row['seconds'] = round(seconds, 1)
    return row


def run_script(script, env=None, timeout=1800, argv=None):
    started = time.monotonic()
    cmd = [sys.executable, str(ROOT / 'scripts' / script), *(argv or [])]
    result = subprocess.run(
        cmd,
        cwd=ROOT,
        env={**os.environ, **(env or {})},
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    seconds = time.monotonic() - started
    combined = (result.stdout + result.stderr).strip()
    tail = combined.splitlines()[-12:]
    return result.returncode, seconds, tail, combined


def native_binary():
    key = {
        'linux': f"linux-{'x64' if platform.machine() in ('x86_64', 'AMD64') else platform.machine()}",
        'darwin': f"darwin-{'arm64' if platform.machine() == 'arm64' else 'x64'}",
        'win32': 'win32-x64',
    }.get(sys.platform)
    if not key:
        return None
    name = 'codsh-rust.exe' if sys.platform == 'win32' else 'codsh-rust'
    for candidate in (
        ROOT / 'packages/cli/native' / key / name,
        ROOT / 'rust/target/debug' / name,
        ROOT / 'rust/target/release' / name,
    ):
        if candidate.is_file():
            return candidate
    return None


def classify_script(code, seconds, tail, combined, *, ok_markers=(), unavailable_markers=(), refused_markers=()):
    text = combined or '\n'.join(tail)
    lower = text.lower()
    for marker in unavailable_markers:
        if marker.lower() in lower:
            return cell('unavailable', {'tail': tail, 'marker': marker}, seconds)
    for marker in refused_markers:
        if marker.lower() in lower:
            return cell('refused', {'tail': tail, 'marker': marker}, seconds)
    if code == 0 and (not ok_markers or any(m.lower() in lower for m in ok_markers)):
        return cell('ok', {'tail': tail}, seconds)
    return cell('fail', {'exit': code, 'tail': tail}, seconds)


def keys_prompt(output):
    if sys.platform == 'win32':
        return cell('unavailable', 'Windows keys covered by ConPTY harness (editing/history)')
    code, seconds, tail, combined = run_script('rust-prompt-pty-test.py', timeout=1200)
    return classify_script(code, seconds, tail, combined, ok_markers=('PASS: rust prompt-edit',))


def mouse_nav(output):
    if sys.platform == 'win32':
        return cell('unavailable', 'Windows mouse covered by ConPTY harness')
    code, seconds, tail, combined = run_script('rust-nav-pty-test.py', timeout=900)
    return classify_script(code, seconds, tail, combined)


def shell_tools(output):
    if sys.platform == 'win32':
        return cell('unavailable', 'Windows shell covered by ConPTY harness (pwsh)')
    code, seconds, tail, combined = run_script('rust-shell-pty-test.py', timeout=900)
    return classify_script(code, seconds, tail, combined, ok_markers=('PASS: rust dsh shell',))


def cancel_turn(output):
    if sys.platform == 'win32':
        return cell('unavailable', 'Windows cancel covered by ConPTY harness')
    code, seconds, tail, combined = run_script('rust-cancel-pty-test.py', timeout=900)
    return classify_script(code, seconds, tail, combined, ok_markers=('PASS: rust dsh cancel',))


def screen_modes(output):
    if sys.platform == 'win32':
        return cell('unavailable', 'Windows screen modes covered by ConPTY harness')
    code, seconds, tail, combined = run_script('rust-screen-pty-test.py', timeout=1200)
    return classify_script(code, seconds, tail, combined)


def terminal_suite(output):
    if sys.platform == 'win32':
        return cell('unavailable', 'Unix PTY harness; Windows uses ConPTY scripts/rust-windows-pty-test.py')
    code, seconds, tail, combined = run_script('rust-terminal-pty-test.py', timeout=1200)
    return classify_script(code, seconds, tail, combined)


def clipboard_real(output):
    if sys.platform == 'win32':
        return cell('unavailable', 'Windows clipboard covered by ConPTY harness (/copy + empty paste notice)')
    code, seconds, tail, combined = run_script('rust-clipboard-pty-test.py', timeout=900)
    text = combined.lower()
    if 'unavailable:' in text:
        reason = next((line for line in (combined or '').splitlines() if line.startswith('UNAVAILABLE:')), 'unavailable')
        return cell('unavailable', reason, seconds)
    return classify_script(code, seconds, tail, combined, ok_markers=('PASS: rust real clipboard',))


def voice_doctor(output):
    """Doctor without CODSH_VOICE_DEVICES: never invent a microphone."""
    started = time.monotonic()
    binary = native_binary()
    launcher = os.environ.get('CODSH_MATRIX_LAUNCHER')
    env = {**os.environ}
    env.pop('CODSH_VOICE_DEVICES', None)
    env.pop('CODSH_VOICE_FIXTURE', None)
    home = output / 'voice-home'
    home.mkdir(parents=True, exist_ok=True)
    env['HOME'] = str(home)
    if launcher:
        argv = [NODE, launcher, '--rust', 'voice', 'doctor', '--json']
    elif binary:
        argv = [str(binary), 'voice', 'doctor', '--json']
    else:
        return cell('unavailable', 'no launcher or native binary for voice doctor', time.monotonic() - started)
    try:
        result = subprocess.run(argv, cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as error:
        return cell('fail', {'error': str(error)}, time.monotonic() - started)
    seconds = time.monotonic() - started
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError:
        return cell('fail', {'exit': result.returncode, 'stdout': result.stdout[-800:], 'stderr': result.stderr[-800:]}, seconds)
    finding = report.get('finding')
    devices = report.get('devices') or []
    if finding in ('voice.platform-unverified', 'voice.no-input-device', 'voice.permission-denied'):
        # Honest outcomes: platform unverified, no mic, or denied. Never a pass.
        return cell('refused' if finding == 'voice.permission-denied' else 'unavailable', {
            'finding': finding,
            'platform': report.get('platform'),
            'supported': report.get('supported'),
            'devices': len(devices),
            'evidence': report.get('evidence'),
            'nextSteps': report.get('nextSteps'),
        }, seconds)
    if finding is None and devices and report.get('supported'):
        # A real device list is fine; recording itself stays unverified on macOS.
        return cell('ok', {
            'finding': None,
            'platform': report.get('platform'),
            'devices': [d.get('name') if isinstance(d, dict) else d for d in devices[:5]],
            'permission': report.get('permission'),
            'note': 'listing only; live capture remains unverified (CODSH_VOICE_FIXTURE path)',
        }, seconds)
    if finding is None and not devices:
        return cell('fail', {'error': 'doctor reported no finding and no devices', 'report': report}, seconds)
    return cell('fail', {'report': report}, seconds)


def sandbox_profiles(output):
    started = time.monotonic()
    if sys.platform == 'win32':
        return cell('refused', 'codsh sandbox profiles are refused on Windows (kernel confinement not implemented)', time.monotonic() - started)
    binary = native_binary()
    if binary is None:
        return cell('unavailable', 'no native binary', time.monotonic() - started)
    work = Path(tempfile.mkdtemp(prefix='codsh-matrix-sandbox-', dir=str(output)))
    try:
        home = work / 'home'
        home.mkdir()
        grok = home / '.grok'
        dsh = home / 'dsh'
        env = {**os.environ, 'HOME': str(home), 'GROK_HOME': str(grok), 'DSH_HOME': str(dsh)}
        grok.mkdir(parents=True)
        dsh.mkdir(parents=True)
        report = work / 'report.json'
        off = subprocess.run(
            [str(binary), '--sandbox', 'off', '--version'],
            env=env, capture_output=True, text=True, timeout=30,
        )
        if off.returncode != 0:
            return cell('fail', {'off': (off.stderr or off.stdout)[-500:]}, time.monotonic() - started)
        bad = grok / 'sandbox.toml'
        bad.write_text('[profiles.bad]\nextends = "workspace"\ndeny = ["**.pem"]\n')
        refused = subprocess.run(
            [str(binary), '--sandbox', 'bad', '--sandbox-report', str(report)],
            env=env, capture_output=True, text=True, timeout=30,
        )
        msg = (refused.stderr or refused.stdout or '').strip()
        if refused.returncode == 0:
            return cell('fail', {'unexpected': 'bad glob was accepted', 'msg': msg}, time.monotonic() - started)
        detail = {'refused_bad_glob': msg[-400:], 'off_ok': True}
        probe = work / 'probe.py'
        probe.write_text(
            "import os\n"
            "outside=os.environ['MATRIX_OUTSIDE']; workspace=os.environ['MATRIX_WORKSPACE']\n"
            "results={}\n"
            "try:\n"
            "  open(os.path.join(outside,'evil.txt'),'w').write('x'); results['outside_write']='allowed'\n"
            "except OSError as e:\n"
            "  results['outside_write']=f'denied:{e.errno}'\n"
            "try:\n"
            "  open(os.path.join(workspace,'ok2.txt'),'w').write('x'); results['workspace_write']='allowed'\n"
            "except OSError as e:\n"
            "  results['workspace_write']=f'denied:{e.errno}'\n"
            "print(results)\n"
        )
        ws = work / 'workspace'
        ws.mkdir(exist_ok=True)
        outside = work / 'outside'
        outside.mkdir(exist_ok=True)
        bad.unlink(missing_ok=True)
        bad.write_text('[profiles.matrix]\nextends = "workspace"\n')
        env2 = {**env, 'MATRIX_OUTSIDE': str(outside), 'MATRIX_WORKSPACE': str(ws)}
        confined = subprocess.run(
            [str(binary), '--sandbox', 'matrix', '--sandbox-probe', str(probe)],
            env=env2, capture_output=True, text=True, timeout=60, cwd=str(ws),
        )
        detail['workspace_probe_exit'] = confined.returncode
        detail['workspace_probe_out'] = (confined.stdout + confined.stderr)[-800:]
        if sys.platform == 'linux':
            detail['note'] = (
                'Linux Landlock cannot deny globs created after launch; those profiles refuse with an actionable message. '
                'A plain workspace profile is probed here; exotic deny globs and the known bubblewrap gap stay documented.'
            )
        if confined.returncode != 0 and 'refusing sandbox' in (confined.stderr + confined.stdout):
            return cell('refused', detail, time.monotonic() - started)
        if confined.returncode != 0:
            return cell('fail', detail, time.monotonic() - started)
        out = detail['workspace_probe_out']
        if "outside_write']='allowed'" in out or "outside_write': 'allowed'" in out:
            return cell('fail', {**detail, 'error': 'outside write was allowed under workspace profile'}, time.monotonic() - started)
        return cell('ok', detail, time.monotonic() - started)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def remote_ssh(output):
    if sys.platform == 'win32':
        return cell('refused', 'shared server, --remote and wrap are not available on Windows')
    if not shutil.which('ssh') or not (shutil.which('sshd') or Path('/usr/sbin/sshd').is_file()):
        return cell('unavailable', 'no local ssh/sshd for the loopback remote PTY harness')
    code, seconds, tail, combined = run_script('rust-remote-pty-test.py', timeout=1200)
    if 'SKIP' in combined and 'OpenSSH' in combined:
        return cell('unavailable', {'tail': tail}, seconds)
    return classify_script(code, seconds, tail, combined)


def tmux_real(output):
    if sys.platform == 'win32':
        return cell('unavailable', 'tmux scenario is Unix-only')
    if not shutil.which('tmux'):
        return cell('unavailable', 'tmux is not installed')
    code, seconds, tail, combined = run_script('rust-tmux-pty-test.py', timeout=900)
    text = combined.lower()
    if 'unavailable:' in text:
        reason = next((line for line in combined.splitlines() if line.startswith('UNAVAILABLE:')), 'unavailable')
        return cell('unavailable', reason, seconds)
    return classify_script(code, seconds, tail, combined, ok_markers=('PASS: rust tmux',))


def windows_conpty(output):
    if sys.platform != 'win32':
        return cell('unavailable', 'Windows ConPTY only')
    report = output / 'windows-report.json'
    if report.is_file():
        payload = json.loads(report.read_text(encoding='utf-8'))
        return cell('ok' if payload.get('ok') else 'fail', {
            'report': str(report),
            'steps': [{'name': s.get('name'), 'ok': s.get('ok')} for s in payload.get('steps', [])],
        })
    package = os.environ.get('CODSH_MATRIX_PACKAGE')
    if not package:
        packed = list((ROOT / 'packed').glob('codsh-cli-*.tgz')) if (ROOT / 'packed').is_dir() else []
        package = str(packed[0]) if packed else None
    if not package:
        return cell('unavailable', 'no packed codsh-cli tarball for the ConPTY harness')
    code, seconds, tail, combined = run_script(
        'rust-windows-pty-test.py',
        argv=['--package', package, '--output', str(output)],
        timeout=2400,
    )
    return cell('ok' if code == 0 else 'fail', {'exit': code, 'tail': tail}, seconds)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {
        'schema': 'codsh.capability-matrix.v1',
        'environment': environment(),
        'cells': {},
        'notes': [],
    }
    checks = [
        ('keys_prompt', keys_prompt),
        ('mouse_nav', mouse_nav),
        ('shell_tools', shell_tools),
        ('cancel_turn', cancel_turn),
        ('screen_modes', screen_modes),
        ('terminal_restore_hangup_early_quit', terminal_suite),
        ('clipboard_real', clipboard_real),
        ('voice_doctor', voice_doctor),
        ('sandbox_profiles', sandbox_profiles),
        ('remote_ssh', remote_ssh),
        ('tmux_real', tmux_real),
        ('windows_conpty', windows_conpty),
    ]
    for name, fn in checks:
        print(f'::group::{name}', flush=True)
        try:
            report['cells'][name] = fn(output)
        except Exception as error:  # noqa: BLE001
            report['cells'][name] = cell('fail', {'error': f'{type(error).__name__}: {error}'[:2000]})
        status = report['cells'][name]['status']
        print(f'{status.upper()} {name} {json.dumps(report["cells"][name], ensure_ascii=False)[:400]}', flush=True)
        print('::endgroup::', flush=True)
    if sys.platform == 'win32':
        report['notes'].extend([
            'dsh 0.1.5-rc.3 Windows ACL sandbox (workspace-write by default) cannot enter a workspace inside %USERPROFILE%; keep projects outside the profile or set dsh sandbox yourself.',
            'npm update fails with EBUSY while codsh-rust.exe is still running; close the client first.',
            'No win32-arm64 prebuild; no Windows Terminal / conhost / VS Code driving in CI (ConPTY harness only).',
            'codsh sandbox profiles are refused on Windows; shared server, --remote and wrap are unavailable.',
        ])
    if sys.platform == 'linux':
        report['notes'].extend([
            'bubblewrap workspace-profile gap: filesystem_sandbox unit tests document the known Linux limit; matrix records refuse messages for unsupported globs.',
            'Empty bracketed paste on Linux matches the reference (Ignore); Ctrl+V reads the image clipboard via xclip/wl-paste when a display is reachable.',
            'Real GNOME Terminal against a desktop session is not driven in CI; X11 is exercised under xvfb-run when available.',
            'voice.platform-unverified: Linux capture is not exercised; doctor must not invent a microphone.',
        ])
    if sys.platform == 'darwin':
        report['notes'].extend([
            'Ad-hoc signature only; no Developer ID or notarization.',
            'Microphone capture from this process is unverified (avfoundation / TCC); doctor lists devices, recording uses CODSH_VOICE_FIXTURE.',
        ])
    report['ok'] = all(c['status'] in ('ok', 'refused', 'unavailable') for c in report['cells'].values())
    (output / 'capability-matrix.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({
        'ok': report['ok'],
        'environment': report['environment'],
        'summary': {k: v['status'] for k, v in report['cells'].items()},
    }, indent=2))
    sys.exit(0 if report['ok'] else 1)


if __name__ == '__main__':
    main()
