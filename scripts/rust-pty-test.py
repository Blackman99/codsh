#!/usr/bin/env python3
"""Exercise the locally packed candidate through a real PTY, never personal data."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


def digest_tree(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob('*') if p.is_file()}


def snapshot_tree(root):
    return {str(path.relative_to(root)): {'symlink': os.readlink(path)} if path.is_symlink()
            else 'directory' if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob('*')}


def refusal_probe(launcher, cwd, env, capture):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    original = termios.tcgetattr(slave)
    process = subprocess.Popen([NODE, str(launcher), '--rust'], cwd=cwd, env=env,
                               stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    data = bytearray()
    quit_sent = False
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                data.extend(os.read(master, 65536))
            if b'\x1b[?1049h' in data and not quit_sent:
                os.write(master, b'\x11')
                quit_sent = True
            if process.poll() is not None:
                while select.select([master], [], [], 0.05)[0]:
                    data.extend(os.read(master, 65536))
                break
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        os.write(master, b'AFTER_ALIAS_REFUSAL\n')
        assert select.select([slave], [], [], 2)[0]
        assert os.read(slave, 4096) == b'AFTER_ALIAS_REFUSAL\n'
        capture.write_bytes(data)
        return {'exit': process.returncode, 'output': data.decode(errors='replace'),
                'enteredAlternateScreen': b'\x1b[?1049h' in data,
                'terminalRestored': termios.tcgetattr(slave) == original}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise SystemExit('macOS network audit required; other platform evidence remains unverified')
    output = (args.output or ROOT / '.scratch' / f'rust-pty-{time.time_ns()}').resolve()
    output.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix='codsh-rust-product-') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        legacy = home / '.dsh'
        legacy.mkdir()
        (legacy / 'settings.yaml').write_text('synthetic legacy canary\n')
        (legacy / '.credentials.yaml').write_text('synthetic-not-a-key\n')
        (home / '.grok').mkdir()
        (home / '.grok' / 'canary').write_text('synthetic official home\n')
        before = digest_tree(legacy)
        env = {'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
               'DSH_HOME': str(legacy), 'DSH_BIN': '/no/runtime/must/be/started',
               'GROK_HOME': str(home / '.grok'), 'XAI_API_KEY': 'synthetic-do-not-use'}
        pack = json.loads(run(['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', str(work)],
                             cwd=ROOT / 'packages/cli', env=env).stdout)[0]['filename']
        prefix = work / 'installed'
        run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--no-audit', '--no-fund', str(work / pack)], env=env)
        launcher = prefix / 'node_modules/.bin/codsh'
        package = prefix / 'node_modules/codsh-cli'
        binary = package / 'native' / ('darwin-arm64' if os.uname().machine == 'arm64' else 'darwin-x64') / 'codsh-rust'
        assert binary.exists(), 'candidate must contain the real native artifact'
        alias_results = []
        for variable in ['DSH_HOME', 'GROK_HOME']:
            for kind, actual_parts, configured_parts in [
                ('root', ['.CODSH-RUST'], ['.CODSH-RUST']),
                ('dsh', ['.CODSH-RUST', 'DSH'], ['.CODSH-RUST', 'DSH']),
                ('nested', ['.CODSH-RUST', 'DSH', 'profiles', 'rust'], ['.CODSH-RUST', 'DSH', 'profiles', 'rust']),
                ('reverse', ['.codsh-rust', 'dsh'], ['.CODSH-RUST', 'DSH']),
                ('missing-child', ['.CODSH-RUST'], ['.CODSH-RUST', 'not-created']),
                ('absent-root', [], ['.CODSH-RUST']),
                ('absent-dsh', [], ['.CODSH-RUST', 'DSH']),
                ('absent-profile', [], ['.CODSH-RUST', 'DSH', 'profiles', 'rust']),
                ('absent-mixed-case', [], ['.CoDsH-RuSt', 'DsH']),
                ('absent-same-spelling', [], ['.codsh-rust', 'dsh']),
            ]:
                alias_home = work / f'alias-{variable}-{kind}'
                actual = alias_home.joinpath(*actual_parts)
                actual.mkdir(parents=True)
                (actual / 'canary').write_text('synthetic legacy data must remain unchanged\n')
                candidate_root = alias_home / '.codsh-rust'
                configured = alias_home.joinpath(*configured_parts)
                if actual_parts:
                    assert candidate_root.exists() and os.path.samefile(candidate_root, alias_home / actual_parts[0]), 'case-alias regressions require a case-insensitive filesystem'
                else:
                    assert not candidate_root.exists() and not configured.exists(), 'first-run regression must start without either Home'
                root_existed = candidate_root.exists()
                configured_existed = configured.exists()
                alias_before = snapshot_tree(alias_home)
                alias_env = {'HOME': str(alias_home), 'PATH': env['PATH'], 'TERM': env['TERM'], variable: str(configured)}
                observed = refusal_probe(launcher, cwd, alias_env, output / f'alias-{variable}-{kind}.ansi')
                alias_after = snapshot_tree(alias_home)
                result = {**observed, 'variable': variable, 'case': kind,
                          'candidateExistedBefore': root_existed, 'configuredExistedBefore': configured_existed,
                          'candidateExistsAfter': candidate_root.exists(), 'configuredExistsAfter': configured.exists(),
                          'refused': 'overlaps a legacy Home' in observed['output'],
                          'treeUnchanged': alias_before == alias_after,
                          'before': alias_before, 'after': alias_after}
                alias_results.append(result)
        (output / 'case-alias-results.json').write_text(json.dumps(alias_results, indent=2) + '\n')
        assert all(result['exit'] == 1 and result['refused'] and not result['enteredAlternateScreen']
                   and result['treeUnchanged'] and result['terminalRestored'] for result in alias_results), 'case-alias launch mutated a legacy tree or failed to refuse; see case-alias-results.json'
        dangling_results = []
        for variable, default_name in [('DSH_HOME', '.dsh'), ('GROK_HOME', '.grok')]:
            for kind in ['explicit-root', 'explicit-child', 'default-root', 'default-child',
                         'ancestor', 'chain', 'absolute-target', 'separate-target', 'cycle']:
                link_home = work / f'dangling-{variable}-{kind}'
                link_home.mkdir()
                (link_home / 'canary').write_text('unrelated synthetic Home data\n')
                candidate = link_home / '.codsh-rust'
                alias = link_home / (default_name if kind.startswith('default') else 'legacy-alias')
                target = '.codsh-rust/dsh' if kind.endswith('child') else '.codsh-rust'
                if kind == 'absolute-target':
                    target = str(candidate / 'dsh')
                elif kind == 'separate-target':
                    target = 'missing-separate-home'
                elif kind in ['chain', 'cycle']:
                    target = 'link-hop'
                    (link_home / target).symlink_to('legacy-alias' if kind == 'cycle' else '.codsh-rust')
                alias.symlink_to(target)
                configured = alias / 'dsh' if kind == 'ancestor' else alias
                assert not candidate.exists() and not configured.exists() and alias.is_symlink()
                link_env = {'HOME': str(link_home), 'PATH': env['PATH'], 'TERM': env['TERM']}
                if not kind.startswith('default'):
                    link_env[variable] = str(configured)
                before_links = snapshot_tree(link_home)
                observed = refusal_probe(launcher, cwd, link_env, output / f'dangling-{variable}-{kind}.ansi')
                after_links = snapshot_tree(link_home)
                result = {**observed, 'variable': variable, 'case': kind,
                          'candidateExistedBefore': False, 'configuredExistedBefore': False,
                          'candidateExistsAfter': candidate.exists(),
                          'refused': 'unresolved symlink' in observed['output'] or 'ELOOP' in observed['output'],
                          'treeUnchanged': before_links == after_links,
                          'before': before_links, 'after': after_links}
                dangling_results.append(result)
        (output / 'dangling-alias-results.json').write_text(json.dumps(dangling_results, indent=2) + '\n')
        assert all(result['exit'] == 1 and result['refused'] and not result['enteredAlternateScreen']
                   and not result['candidateExistsAfter'] and result['treeUnchanged'] and result['terminalRestored']
                   for result in dangling_results), 'unresolved legacy symlink was not refused before writes; see dangling-alias-results.json'
        audit = output / 'network.log'
        dylib = output / 'network-audit.dylib'
        run(['clang', '-dynamiclib', '-Wall', '-Wextra', '-Werror', str(ROOT / 'scripts/rust-network-audit.c'), '-o', str(dylib)])
        # Retain only the observation hooks across the launcher's production env allowlist.
        preload = output / 'audit-preload.cjs'
        preload.write_text("const cp = require('node:child_process'); const original = cp.spawn;\n"
                           "cp.spawn = function(command, args, options) { return original(command, args, {...options, env: {...options.env, DYLD_INSERT_LIBRARIES: process.env.DYLD_INSERT_LIBRARIES, CODSH_NETWORK_AUDIT: process.env.CODSH_NETWORK_AUDIT}}); };\n")
        audit_env = {**env, 'DYLD_INSERT_LIBRARIES': str(dylib), 'CODSH_NETWORK_AUDIT': str(audit), 'NODE_OPTIONS': f'--require={preload}'}
        # Prove the audit detects real networking rather than accepting an inert observer.
        control = output / 'control.c'
        control.write_text('#include <sys/socket.h>\n#include <netinet/in.h>\n#include <unistd.h>\nint main(void) { int s=socket(AF_INET,SOCK_DGRAM,0); if(s<0)return 1; struct sockaddr_in a={0}; a.sin_family=AF_INET; a.sin_port=htons(9); a.sin_addr.s_addr=htonl(INADDR_LOOPBACK); if(sendto(s,"audit-control",13,0,(struct sockaddr*)&a,sizeof(a))!=13)return 2; close(s); return 0; }\n')
        run(['clang', str(control), '-o', str(output / 'control')])
        run([str(output / 'control')], env=audit_env)
        assert 'socket pid=' in audit.read_text() and 'sendto pid=' in audit.read_text()
        (output / 'network-control.log').write_text(audit.read_text())
        audit.unlink()

        emulator = output / 'screen.mjs'
        emulator.write_text(f"import {{ Terminal }} from {json.dumps((ROOT / 'e2e/vt.ts').as_uri())};\n"
                            "let input=''; for await (const chunk of process.stdin) input+=chunk; const spec=JSON.parse(input); const t=new Terminal(spec.rows,spec.cols); t.feed(Buffer.from(spec.bytes,'base64').toString()); console.log(t.text);\n")
        scenarios = []

        def exercise(name, cols=100, rows=30, action='normal', child_env=None, prefix_command=None):
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            original = termios.tcgetattr(slave)
            process = subprocess.Popen([*(prefix_command or []), NODE, str(launcher), '--rust'], cwd=cwd, env=child_env or env,
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

            def screen():
                import base64
                payload = {'rows': rows, 'cols': cols, 'bytes': base64.b64encode(data).decode()}
                return run([NODE, '--import', 'tsx', str(emulator)], input=json.dumps(payload), cwd=ROOT).stdout

            def wait_visible(text):
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline:
                    pump()
                    if text in screen():
                        return
                    if process.poll() is not None:
                        break
                raise AssertionError(f'{name}: missing {text!r}\n{screen()}')

            try:
                if action == 'error':
                    process.wait(timeout=12)
                    pump()
                    assert process.returncode == 1
                    assert b'Rust startup failed' in data
                else:
                    wait_visible('codsh')
                    wait_visible('Draft (not sent)')
                    (output / f'{name}-welcome.txt').write_text(screen())
                    os.write(master, 'draft survives resize'.encode())
                    wait_visible('draft survives resize')
                    if action == 'resize':
                        cols, rows = 32, 14
                        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                        # The child shares the PTY but not its controlling session in this harness.
                        process.send_signal(signal.SIGWINCH)
                        pump(0.5)
                        wait_visible('draft survives resize')
                    os.write(master, b'\r')
                    wait_visible('Execution unavailable')
                    assert 'draft survives resize' in screen()
                    (output / f'{name}-unavailable.txt').write_text(screen())
                    os.write(master, b'\x03')
                    pump(0.3)
                    assert 'draft survives resize' not in screen()
                    if action == 'paste':
                        os.write(master, '\x1b[200~你好\nsecond line\x1b[201~'.encode())
                        wait_visible('你好')
                        wait_visible('second line')
                        os.write(master, b'\x03')
                        pump(0.2)
                    if action == 'signal':
                        process.send_signal(signal.SIGTERM)
                    elif action == 'menu':
                        os.write(master, b'\t\t\t\r')
                    elif action == 'eof':
                        os.write(master, b'\x04')
                    elif action == 'cancel':
                        os.write(master, b'\x03')
                    else:
                        os.write(master, b'\x11')
                    process.wait(timeout=12)
                    pump()
                    assert process.returncode == 0
                # macOS sets PENDIN when returning to canonical mode; consume real input.
                os.write(master, b'AFTER_EXIT_CANONICAL\n')
                assert select.select([slave], [], [], 2)[0], f'{name}: canonical input unavailable'
                assert os.read(slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
                pump()
                after = termios.tcgetattr(slave)
                (output / f'{name}.ansi').write_bytes(data)
                (output / f'{name}-termios.txt').write_text(f'before={original!r}\nafter={after!r}\n')
                assert original == after, f'{name}: terminal modes were not restored: {original!r} != {after!r}'
                assert b'\x1b[?1049l' in data, f'{name}: alternate screen not restored'
                assert b'\x1b[?2004l' in data, f'{name}: bracketed paste not restored'
                assert b'\x1b[?25h' in data, f'{name}: cursor not restored'
                (output / f'{name}.ansi').write_bytes(data)
                scenarios.append({'name': name, 'exit': process.returncode, 'terminalRestored': True})
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                os.close(master)
                os.close(slave)

        exercise('first-run-network', child_env=audit_env)
        lines = audit.read_text().splitlines()
        assert sum(line.startswith('audit-ready') for line in lines) >= 2, lines
        assert all(line.startswith('audit-ready') for line in lines), lines
        policy = '(version 1)(allow default)(deny network*)(deny file-read-data (subpath ' + json.dumps(str(legacy)) + ') (subpath ' + json.dumps(str(home / '.grok')) + '))'
        exercise('network-and-old-home-denied', prefix_command=['/usr/bin/sandbox-exec', '-p', policy])
        exercise('narrow', cols=32, rows=14)
        exercise('resize', action='resize')
        exercise('cancel', action='cancel')
        exercise('signal', action='signal')
        exercise('paste', action='paste')
        exercise('menu-quit', action='menu')
        exercise('ctrl-d', action='eof')
        missing_controls = []
        for variable in ['DSH_HOME', 'GROK_HOME']:
            for name in ['.codsh-rust-other', '.separate-legacy']:
                control_home = work / f'control-{variable}-{name}'
                control_home.mkdir()
                old = control_home / name / 'DSH'
                assert not old.exists() and not (control_home / '.codsh-rust').exists()
                control_env = {'HOME': str(control_home), 'PATH': env['PATH'], 'TERM': env['TERM'], variable: str(old)}
                exercise(f'missing-control-{variable}-{name}', child_env=control_env)
                assert not (control_home / name).exists(), 'separate legacy Home must not be created'
                assert (control_home / '.codsh-rust/dsh/profiles/rust/package.json').is_file()
                missing_controls.append({'variable': variable, 'path': name, 'legacyRemainsAbsent': True})
        resolved_link_controls = []
        for variable, default_name in [('DSH_HOME', '.dsh'), ('GROK_HOME', '.grok')]:
            for kind in ['explicit', 'default', 'missing-child']:
                control_home = work / f'resolved-{variable}-{kind}'
                target = control_home / 'separate-legacy'
                target.mkdir(parents=True)
                (target / 'canary').write_text('synthetic legacy content\n')
                alias = control_home / (default_name if kind == 'default' else 'legacy-alias')
                alias.symlink_to('separate-legacy')
                configured = alias / 'missing-child' if kind == 'missing-child' else alias
                original_legacy = snapshot_tree(target)
                control_env = {'HOME': str(control_home), 'PATH': env['PATH'], 'TERM': env['TERM']}
                if kind != 'default':
                    control_env[variable] = str(configured)
                exercise(f'resolved-link-{variable}-{kind}', child_env=control_env)
                assert snapshot_tree(target) == original_legacy
                assert alias.is_symlink() and os.readlink(alias) == 'separate-legacy'
                resolved_link_controls.append({'variable': variable, 'case': kind, 'legacyUnchanged': True})
        profile = home / '.codsh-rust/dsh/profiles/rust/package.json'
        assert json.loads(profile.read_text())['dsh']['profile']['bundles'] == []
        profile.write_text('{invalid JSON')
        exercise('startup-error', action='error')
        assert digest_tree(legacy) == before
        assert (home / '.grok/canary').read_text() == 'synthetic official home\n'
        assert not list((home / '.codsh-rust').rglob('*session*'))
        for arguments, expected in [(['--rust', '--version'], 'codsh-rust'), (['--rust', '--help'], 'Offline Rust launch preview')]:
            result = run([NODE, str(launcher), *arguments], env=env, cwd=cwd)
            assert expected in result.stdout
        for arguments in [['--rust', '-p', 'must not execute'], ['--rust']]:
            result = subprocess.run([NODE, str(launcher), *arguments], env=env, cwd=cwd, capture_output=True, text=True)
            assert result.returncode == 1
        profile.unlink()
        profile.symlink_to(legacy / 'settings.yaml')
        refused_profile = subprocess.run([NODE, str(launcher), '--rust'], env=env, cwd=cwd, capture_output=True, text=True)
        assert refused_profile.returncode == 1 and 'symlinked Rust Profile' in refused_profile.stderr
        overlap = subprocess.run([NODE, str(launcher), '--rust'], env={**env, 'DSH_HOME': str(home / '.codsh-rust/dsh')}, cwd=cwd, capture_output=True, text=True)
        assert overlap.returncode == 1 and 'overlaps' in overlap.stderr
        artifact = binary.parent / 'artifact.json'
        saved = artifact.read_bytes()
        artifact.write_text(json.dumps({'platform': 'darwin', 'arch': 'invalid', 'sha256': 'invalid'}))
        corrupt = subprocess.run([NODE, str(launcher), '--rust', '--version'], env=env, cwd=cwd, capture_output=True, text=True)
        assert corrupt.returncode == 1 and 'integrity/platform mismatch' in corrupt.stderr
        artifact.write_bytes(saved)
        # Refuse aliasing before reading any legacy contents.
        shutil.rmtree(home / '.codsh-rust')
        (home / '.codsh-rust').symlink_to(legacy, target_is_directory=True)
        refused = subprocess.run([NODE, str(launcher), '--rust'], env=env, cwd=cwd, capture_output=True, text=True)
        assert refused.returncode == 1 and 'symlink' in refused.stderr
        assert digest_tree(legacy) == before
        (output / 'result.json').write_text(json.dumps({
            'scenarios': scenarios, 'networkEvents': lines, 'auditControlDetectedSocket': True,
            'caseAliasRefusals': len(alias_results), 'caseAliasEvidence': 'case-alias-results.json',
            'distinctMissingHomeControls': missing_controls,
            'unresolvedSymlinkRefusals': len(dangling_results), 'unresolvedSymlinkEvidence': 'dangling-alias-results.json',
            'resolvedLegacySymlinkControls': resolved_link_controls,
            'legacyCanariesUnchanged': True, 'symlinkRefused': True,
            'invalidArtifactRefused': True, 'homeOverlapRefused': True,
            'unsupportedArgumentsRefused': True, 'pipeRefused': True,
            'profileSymlinkRefused': True, 'networkAndLegacyReadDenialRunPassed': True,
            'artifactSha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
            'platform': sys.platform, 'limitations': ['No Linux/Windows evidence', 'Socket API observation, not privileged packet capture'],
        }, indent=2) + '\n')
    print(f'PASS: installed candidate PTY/isolation/network audit; evidence: {output}')


if __name__ == '__main__':
    main()
