#!/usr/bin/env python3
"""Reusable platform run for the installed Rust client (#199; reused by #200/#201).

Records the real environment (OS release, kernel, CPU, C library, Node,
terminal), then runs the installed-product checks this platform supports and
writes one report:

  install-check   `codsh --rust install-check --json` of a clean `npm install -g`
  install         scripts/rust-install-test.py (install, update, damage, rollback)
  turn            scripts/rust-turn-pty-test.py (real dsh ACP turn in a PTY)
  approval        scripts/rust-permission-pty-test.py (tool approval)
  cancel          scripts/rust-cancel-pty-test.py (cancel a running turn)
  resume          scripts/rust-resume-pty-test.py (resume a session)

Each step's output is kept under --output. `untested` lists capabilities this
run does not exercise on this platform, so a green report is never read as
full platform support; the capability matrix (#201) covers them.

  python3 scripts/rust-platform-test.py [--only install,turn] [--output DIR]
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
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()

STEPS = {
    'install': ['scripts/rust-install-test.py'],
    'turn': ['scripts/rust-turn-pty-test.py'],
    'approval': ['scripts/rust-permission-pty-test.py'],
    'cancel': ['scripts/rust-cancel-pty-test.py'],
    'resume': ['scripts/rust-resume-pty-test.py'],
}

# What this run does not exercise; each needs a real device, display, service
# or privilege that a CI runner or container does not have.
UNTESTED = {
    'common': [
        'system clipboard read/write and image paste (needs a display/pasteboard; #201)',
        'microphone capture and its authorization prompt (needs an audio device; #201)',
        'desktop notifications and terminal bell routing (#201)',
        'real terminal emulators other than the PTY harness (iTerm2, Terminal.app, GNOME Terminal, Windows Terminal) and tmux/SSH wrapping (#201)',
        'mouse reporting in a real emulator (#201)',
        'long-running concurrency and resource stress (#209)',
        'real paid model providers (#203)',
    ],
    'linux': [
        'bubblewrap filesystem sandbox profiles (known workspace-profile gap in filesystem_sandbox; #201)',
        'Wayland/X11 clipboard helpers (wl-copy/xclip) and OSC 52 over SSH (#201)',
        'linux-arm64 beyond the build and install-check (#201)',
        'musl (Alpine) and glibc older than the recorded floor: refused by the launcher, not supported',
    ],
    'darwin': [
        'Seatbelt sandbox profiles on a signed-in desktop session (#201)',
        'Developer ID signing / notarization and Gatekeeper on downloaded files (not performed; ad-hoc signature only)',
    ],
}


def capture(argv):
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=20).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def environment():
    info = {
        'platform': sys.platform, 'machine': platform.machine(), 'kernel': platform.release(),
        'python': platform.python_version(),
        'node': capture([NODE, '-p', "process.version + ' ' + process.platform + '-' + process.arch"]),
        'libc': capture([NODE, '-p', "process.report.getReport().header.glibcVersionRuntime || 'not glibc'"]) if sys.platform == 'linux' else None,
        'term': os.environ.get('TERM'), 'term_program': os.environ.get('TERM_PROGRAM'),
        'toolchain_on_path': {tool: shutil.which(tool) for tool in ('cargo', 'rustc', 'rustup')},
        # The install step's dsh: a registry install (CI) or the checkout's.
        'install_dsh': os.environ.get('CODSH_INSTALL_TEST_DSH') or 'checkout node_modules',
        'ci': os.environ.get('GITHUB_ACTIONS') == 'true',
    }
    if sys.platform == 'linux':
        release = Path('/etc/os-release')
        if release.exists():
            fields = dict(line.split('=', 1) for line in release.read_text().splitlines() if '=' in line)
            info['os'] = fields.get('PRETTY_NAME', '').strip('"')
        info['container'] = Path('/.dockerenv').exists() or Path('/run/.containerenv').exists()
    elif sys.platform == 'darwin':
        info['os'] = f"macOS {capture(['sw_vers', '-productVersion'])} ({capture(['sw_vers', '-buildVersion'])})"
        info['rosetta'] = capture(['sysctl', '-in', 'sysctl.proc_translated']) == '1'
    return info


def install_check(output):
    """`codsh --rust install-check --json` from a clean global install of the packed package."""
    work = Path(tempfile.mkdtemp(prefix='codsh-platform-check-'))
    try:
        env = {**os.environ, 'npm_config_cache': str(work / 'cache'), 'npm_config_update_notifier': 'false',
               'npm_config_userconfig': str(work / 'empty.npmrc')}
        packed = json.loads(subprocess.run(['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', str(work)],
                                           cwd=ROOT / 'packages/cli', env=env, check=True, capture_output=True, text=True).stdout)[0]['filename']
        prefix = work / 'prefix'
        subprocess.run(['npm', 'install', '-g', '--prefix', str(prefix), '--offline', '--ignore-scripts', '--no-audit', '--no-fund', str(work / packed)],
                       env=env, check=True, capture_output=True, text=True)
        launcher = prefix / 'bin' / 'codsh'
        home = work / 'home'
        home.mkdir()
        result = subprocess.run([str(launcher), '--rust', 'install-check', '--json'], env={**env, 'HOME': str(home)},
                                capture_output=True, text=True, timeout=60)
        (output / 'install-check.json').write_text(result.stdout)
        report = json.loads(result.stdout)
        # dsh is not part of this step; the artifact and the runtime must verify.
        ok = report['artifact']['ok'] and report.get('runtime', {'ok': True})['ok']
        return ok, {'artifact': report['artifact'], 'runtime': report.get('runtime')}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', help='comma-separated steps: install-check,' + ','.join(STEPS))
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if sys.platform not in ('linux', 'darwin'):
        raise SystemExit('macOS or Linux required; the native Windows entry is ticket 68')
    output = (args.output or Path(tempfile.mkdtemp(prefix='codsh-platform-'))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    selected = args.only.split(',') if args.only else ['install-check', *STEPS]
    unknown = [name for name in selected if name != 'install-check' and name not in STEPS]
    if unknown:
        raise SystemExit(f'unknown steps: {unknown}')
    report = {'schema': 'codsh.platform-run.v1', 'environment': environment(), 'steps': [],
              'untested': UNTESTED['common'] + UNTESTED.get(sys.platform, [])}
    for name in selected:
        started = time.monotonic()
        if name == 'install-check':
            try:
                ok, detail = install_check(output)
            except Exception as error:  # noqa: BLE001 - recorded, not hidden
                ok, detail = False, {'error': str(error)}
            report['steps'].append({'name': name, 'ok': ok, 'seconds': round(time.monotonic() - started, 1), 'detail': detail})
        else:
            log = output / f'{name}.log'
            with log.open('w') as handle:
                result = subprocess.run([sys.executable, *STEPS[name]], cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT, timeout=1800)
            tail = log.read_text(errors='replace').strip().splitlines()[-3:]
            report['steps'].append({'name': name, 'ok': result.returncode == 0, 'exit': result.returncode,
                                    'seconds': round(time.monotonic() - started, 1), 'log': str(log), 'tail': tail})
        step = report['steps'][-1]
        print(f"{'PASS' if step['ok'] else 'FAIL'} {name} ({step['seconds']}s)", flush=True)
    report['ok'] = all(step['ok'] for step in report['steps'])
    (output / 'platform-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'environment': report['environment'], 'ok': report['ok'], 'untested': report['untested']}, indent=2))
    print(f'report {output / "platform-report.json"}')
    sys.exit(0 if report['ok'] else 1)


if __name__ == '__main__':
    main()
