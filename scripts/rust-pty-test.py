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
DATA_VOLUME_PREFIX = '/System/Volumes/Data'


def data_volume_alias(path):
    resolved = Path(path).resolve()
    text = str(resolved)
    if text == DATA_VOLUME_PREFIX or text.startswith(DATA_VOLUME_PREFIX + os.sep):
        return Path(text[len(DATA_VOLUME_PREFIX):] or os.sep)
    return Path(DATA_VOLUME_PREFIX + text)


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


def identity(path):
    try:
        stat = os.stat(path)
        native = run([NODE, '--input-type=module', '-e',
                      'import { realpathSync } from "node:fs"; console.log(JSON.stringify(realpathSync.native(process.argv[1])))',
                      str(path)]).stdout
        return {'realpath': json.loads(native), 'device': stat.st_dev, 'inode': stat.st_ino}
    except OSError as error:
        return {'errno': error.errno}


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


def path_semantics_matrix(launcher, work, output, env):
    results = []
    resolver = (ROOT / 'node_modules/@deepseek-ai/dsh-home-paths/lib/index.js').as_uri()

    def effective_home(variable, child_env, cwd):
        if variable == 'DSH_HOME':
            script = f'import {{ resolveDshHome }} from {json.dumps(resolver)}; console.log(JSON.stringify(resolveDshHome()))'
            return json.loads(run([NODE, '--input-type=module', '-e', script], env=child_env, cwd=cwd).stdout)
        # Official dirs.rs uses nonempty GROK_HOME verbatim, including whitespace and tilde.
        return child_env.get(variable) or str(Path(child_env['HOME']) / '.grok')

    def fixture(name, root=work):
        base = root / name
        home, cwd = base / 'home', base / 'workspace'
        home.mkdir(parents=True)
        cwd.mkdir()
        return base, home, cwd

    def environment(home, variable, value):
        child_env = {'HOME': str(home), 'PATH': env['PATH'], 'TERM': env['TERM'],
                     'DSH_BIN': env.get('DSH_BIN', '/no/runtime/must/be/started')}
        if value is not None:
            child_env[variable] = value
        return child_env

    def check(name, variable, value, paths, refuse):
        base, home, cwd = paths
        child_env = environment(home, variable, value)
        resolved = effective_home(variable, child_env, cwd)
        legacy = resolved if os.path.isabs(resolved) else str(cwd) + '/' + resolved
        candidate = home / '.codsh-rust'
        before = snapshot_tree(base)
        identities_before = {'legacy': identity(legacy), 'candidate': identity(candidate)}
        observed = refusal_probe(launcher, cwd, child_env, output / f'{name}.ansi')
        after = snapshot_tree(base)
        outside_candidate = lambda tree: {key: val for key, val in tree.items()
                                          if key != 'home/.codsh-rust' and not key.startswith('home/.codsh-rust/')}
        refused = any(message in observed['output'] for message in
                      ['overlaps a legacy Home', 'unresolved symlink', 'ELOOP',
                       'refusing GROK_HOME with ..', 'refusing unresolved non-ASCII Home component',
                       'cannot establish Home directory identity'])
        welcome = observed['enteredAlternateScreen'] and all(word in observed['output'] for word in ['codsh', 'Draft'])
        identities_after = {'legacy': identity(legacy), 'candidate': identity(candidate)}
        passed = observed['terminalRestored'] and identities_before['legacy'] == identities_after['legacy'] and (
            observed['exit'] == 1 and refused and not observed['enteredAlternateScreen'] and before == after
            if refuse else observed['exit'] == 0 and welcome and outside_candidate(before) == outside_candidate(after)
            and all(after.get(key) == value for key, value in before.items())
            and (candidate / 'dsh/profiles/rust/package.json').is_file())
        legacy_profile = Path(legacy) / ('profiles/rust/package.json' if Path(legacy).name == 'dsh' else 'dsh/profiles/rust/package.json')
        profile = candidate / 'dsh/profiles/rust/package.json'
        same_profile = profile.is_file() and legacy_profile.is_file() and os.path.samefile(profile, legacy_profile)
        results.append({**observed, 'name': name, 'variable': variable, 'configured': value,
                        'profileVisibleThroughLegacy': same_profile,
                        'resolvedLegacyHome': resolved, 'expectedRefusal': refuse, 'passed': passed,
                        'identitiesBefore': identities_before,
                        'identitiesAfter': identities_after,
                        'treeUnchanged': before == after, 'before': before, 'after': after})

    for variable, default_name in [('DSH_HOME', '.dsh'), ('GROK_HOME', '.grok')]:
        for existing in [False, True]:
            for target in ['.codsh-rust', '.codsh-rust/dsh', '独立 legacy home']:
                for spelling in ['absolute', 'relative', 'cwd-relative', 'tilde', 'backslash-tilde']:
                    name = f'paths-{variable}-{existing}-{target.replace("/", "-")}-{spelling}'
                    paths = base, home, cwd = fixture(name)
                    if spelling == 'cwd-relative':
                        (cwd / 'home-link').symlink_to(home)
                    value = {'absolute': str(home / target), 'relative': '../home/' + target,
                             'cwd-relative': './home-link/' + target,
                             'tilde': '~/' + target, 'backslash-tilde': '~\\' + target}[spelling]
                    resolved = effective_home(variable, environment(home, variable, value), cwd)
                    actual = Path(resolved) if os.path.isabs(resolved) else cwd / resolved
                    if existing:
                        actual.mkdir(parents=True)
                        (actual / 'canary').write_text('synthetic legacy contents\n')
                    overlap = target.startswith('.codsh-rust') and (variable == 'DSH_HOME' or spelling in ['absolute', 'relative', 'cwd-relative'])
                    # Relative GROK_HOME retains ..; no lexical traversal guess is permitted.
                    check(name, variable, value, paths, overlap or (variable == 'GROK_HOME' and spelling == 'relative')
                          or (not existing and not target.isascii()))
            for value in ['~', '~other', '  legacy 空间  ']:
                name = f'paths-{variable}-{existing}-literal-{value}'
                paths = base, home, cwd = fixture(name)
                resolved = effective_home(variable, environment(home, variable, value), cwd)
                actual = Path(resolved) if os.path.isabs(resolved) else cwd / resolved
                if existing:
                    actual.mkdir(parents=True, exist_ok=True)
                    (actual / 'canary').write_text('synthetic literal name\n')
                check(name, variable, value, paths, (variable == 'DSH_HOME' and value == '~')
                      or (not existing and not value.isascii()))
            for entry in ['directory', 'symlink', 'dangling', 'missing']:
                for target in ['.codsh-rust', '独立 legacy home']:
                    name = f'paths-{variable}-{existing}-dotdot-{entry}-{target}'
                    paths = base, home, cwd = fixture(name)
                    (home / 'separate').mkdir()
                    jump = home / 'separate/jump'
                    if entry == 'directory':
                        jump.mkdir()
                    elif entry in ['symlink', 'dangling']:
                        jump.symlink_to('../real-child')
                        if entry == 'symlink':
                            (home / 'real-child').mkdir()
                    if existing:
                        for location in [home / target, home / 'separate' / target]:
                            location.mkdir(parents=True)
                            (location / 'canary').write_text('synthetic traversal contents\n')
                    value = str(jump) + '/../' + target
                    check(name, variable, value, paths, variable == 'GROK_HOME'
                          or (not existing and not target.isascii()))
            for target in ['.codsh-rust', '独立 legacy home']:
                name = f'paths-{variable}-{existing}-blank-link-{target}'
                paths = base, home, cwd = fixture(name)
                (cwd / ' \t ').symlink_to(home / target)
                if existing:
                    (home / target).mkdir()
                    (home / target / 'canary').write_text('synthetic whitespace Home\n')
                check(name, variable, ' \t ', paths, variable == 'GROK_HOME' and (not existing or target == '.codsh-rust'))
            name = f'paths-{variable}-{existing}-lexical-dotdot-overlap'
            paths = base, home, cwd = fixture(name)
            (home / 'jump').symlink_to('separate/child')
            (home / 'separate/child').mkdir(parents=True)
            if existing:
                (home / '.codsh-rust').mkdir()
            check(name, variable, str(home / 'jump') + '/../.codsh-rust', paths, True)
            for mode in ['explicit', 'default']:
                for target in ['.codsh-rust', '独立 legacy home']:
                    name = f'paths-{variable}-{existing}-link-target-dotdot-{mode}-{target}'
                    paths = base, home, cwd = fixture(name)
                    (home / 'real-child').mkdir()
                    (home / 'separate').mkdir()
                    (home / 'separate/jump').symlink_to('../real-child')
                    alias = home / (default_name if mode == 'default' else 'legacy-link')
                    alias.symlink_to('separate/jump/../' + target)
                    if existing:
                        (home / target).mkdir()
                        (home / target / 'canary').write_text('synthetic link target traversal\n')
                    check(name, variable, None if mode == 'default' else str(alias), paths,
                          not existing or target == '.codsh-rust')
            for value_name, value in [('unset', None), ('empty', ''), ('blank', ' \t '), ('override', 'separate')]:
                for target in ['.codsh-rust', '独立 legacy home']:
                    name = f'paths-{variable}-{existing}-default-{value_name}-{target}'
                    paths = base, home, cwd = fixture(name)
                    (home / default_name).symlink_to(target)
                    if existing:
                        (home / target).mkdir()
                        (home / target / 'canary').write_text('synthetic default Home\n')
                    check(name, variable, value, paths, not existing or target == '.codsh-rust')
        # A literal Grok tilde can itself be a filesystem link, not home expansion.
        if variable == 'GROK_HOME':
            for existing in [False, True]:
                name = f'paths-GROK_HOME-{existing}-literal-tilde-link'
                paths = base, home, cwd = fixture(name)
                (cwd / '~').symlink_to(home)
                if existing:
                    (home / '.codsh-rust').mkdir()
                check(name, variable, '~/.codsh-rust', paths, True)
    for variable, default_name in [('DSH_HOME', '.dsh'), ('GROK_HOME', '.grok')]:
        for existing in [False, True]:
            for index, spelling in enumerate(['.codſh-rust', '.codsh-ruſt', '.codsh-ruﬅ']):
                for suffix in ['', '/dsh']:
                    for mode in ['absolute', 'relative', 'default-link']:
                        name = f'unicode-{variable}-{existing}-{index}-{bool(suffix)}-{mode}'
                        paths = base, home, cwd = fixture(name)
                        old = home / (spelling + suffix)
                        if existing:
                            old.mkdir(parents=True)
                            (old / 'canary').write_text('synthetic Unicode alias\n')
                            assert os.path.samefile(home / spelling, home / '.codsh-rust'), 'Unicode alias cases require the verified macOS filesystem equivalence'
                        else:
                            assert not old.exists() and not (home / '.codsh-rust').exists()
                        value = str(old)
                        if mode == 'relative':
                            (cwd / 'home-link').symlink_to(home)
                            value = './home-link/' + spelling + suffix
                        elif mode == 'default-link':
                            (home / default_name).symlink_to(spelling + suffix)
                            value = None
                        check(name, variable, value, paths, True)
            for index, spelling in enumerate(['.codsh-rust-other', '独立 legacy home', 'café', 'cafe\u0301', '😀', 'separate-\u200b-home']):
                name = f'unicode-control-{variable}-{existing}-{index}'
                paths = base, home, cwd = fixture(name)
                old = home / spelling
                if existing:
                    old.mkdir()
                    (old / 'canary').write_text('synthetic separate Unicode Home\n')
                check(name, variable, str(old), paths, not existing and not spelling.isascii())
        for mode in ['absolute', 'relative', 'default-link']:
            for suffix in ['', 'missing-ascii/child', 'missing-ſ/child']:
                name = f'unicode-ancestor-{variable}-{mode}-{suffix.replace("/", "-")}'
                paths = base, home, cwd = fixture(name)
                old = home / '独立 legacy home'
                old.mkdir()
                (old / 'canary').write_text('synthetic resolved Unicode ancestor\n')
                configured = old / suffix
                value = str(configured)
                if mode == 'relative':
                    (cwd / 'legacy-link').symlink_to(old)
                    value = './legacy-link/' + suffix
                elif mode == 'default-link':
                    (home / default_name).symlink_to(configured)
                    value = None
                check(name, variable, value, paths, bool(suffix) and (not suffix.isascii() or mode == 'default-link'))
    for variable in ['DSH_HOME', 'GROK_HOME']:
        name = f'identity-file-{variable}'
        paths = base, home, cwd = fixture(name)
        target = home / 'legacy-file'
        target.write_text('synthetic non-directory Home\n')
        check(name, variable, str(target), paths, True)
    firmlink_root = Path(tempfile.mkdtemp(prefix='codsh-firmlink-', dir='/tmp'))
    try:
        for variable, default_name in [('DSH_HOME', '.dsh'), ('GROK_HOME', '.grok')]:
            for reverse in [False, True]:
                for state in ['absent', 'root-only', 'existing']:
                    for index, target in enumerate(['.codsh-rust', '.codsh-rust/dsh', '.codsh-rust/dsh/profiles/rust',
                                                    '.CODSH-RUST/DSH', '.codsh-rust-other', 'separate/nested']):
                        name = f'firmlink-{variable}-{reverse}-{state}-{index}'
                        base, home, cwd = fixture(name, firmlink_root)
                        alias = data_volume_alias(home)
                        assert os.path.samefile(home, alias), 'firmlink regressions require a Data-volume alias'
                        home_id, alias_id = identity(home), identity(alias)
                        assert home_id['realpath'] != alias_id['realpath']
                        assert (home_id['device'], home_id['inode']) == (alias_id['device'], alias_id['inode'])
                        if state == 'root-only':
                            (home / '.codsh-rust').mkdir()
                        elif state == 'existing':
                            (home / target).mkdir(parents=True)
                            (home / target / 'canary').write_text('synthetic firmlink Home\n')
                        selected_home, legacy_home = (alias, home) if reverse else (home, alias)
                        check(name, variable, str(legacy_home / target), (base, selected_home, cwd),
                              target.lower().split('/')[0] == '.codsh-rust')
                        results[-1]['homeAliasIdentities'] = [home_id, alias_id]
                for existing in [False, True]:
                    for target in ['.codsh-rust/dsh', 'separate/nested']:
                        name = f'firmlink-default-{variable}-{reverse}-{existing}-{target.replace("/", "-")}'
                        base, home, cwd = fixture(name, firmlink_root)
                        alias = data_volume_alias(home)
                        home_id, alias_id = identity(home), identity(alias)
                        assert os.path.samefile(home, alias) and home_id['realpath'] != alias_id['realpath']
                        assert (home_id['device'], home_id['inode']) == (alias_id['device'], alias_id['inode'])
                        if existing:
                            (home / target).mkdir(parents=True)
                            (home / target / 'canary').write_text('synthetic default firmlink Home\n')
                        selected_home, legacy_home = (alias, home) if reverse else (home, alias)
                        (home / default_name).symlink_to(legacy_home / target)
                        check(name, variable, None, (base, selected_home, cwd),
                              not existing or target.startswith('.codsh-rust/'))
                        results[-1]['homeAliasIdentities'] = [home_id, alias_id]
                name = f'firmlink-parent-{variable}-{reverse}'
                base, home, cwd = fixture(name, firmlink_root)
                alias = data_volume_alias(home)
                home_id, alias_id = identity(home), identity(alias)
                assert os.path.samefile(home, alias) and home_id['realpath'] != alias_id['realpath']
                assert (home_id['device'], home_id['inode']) == (alias_id['device'], alias_id['inode'])
                selected_home, legacy_home = (alias, home) if reverse else (home, alias)
                check(name, variable, str(legacy_home), (base, selected_home, cwd), True)
                results[-1]['homeAliasIdentities'] = [home_id, alias_id]
    finally:
        shutil.rmtree(firmlink_root, ignore_errors=True)
    (output / 'path-semantics-results.json').write_text(json.dumps(results, indent=2) + '\n')
    failed = [result['name'] for result in results if not result['passed']]
    assert not failed, f'path semantics failed: {failed}; see path-semantics-results.json'
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise SystemExit('macOS network audit required; other platform evidence remains unverified')
    output = (args.output or ROOT / '.scratch' / f'rust-pty-{time.time_ns()}').resolve()
    output.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix='codsh-rust-product-', dir=output) as temporary:
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
        pack_env = {**env, 'npm_config_cache': str(work / 'npm-cache'),
                    'npm_config_userconfig': str(work / 'empty-user.npmrc'),
                    'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
                    'npm_config_update_notifier': 'false'}
        pack = json.loads(run(['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
                             cwd=ROOT / 'packages/cli', env=pack_env).stdout)[0]['filename']
        prefix = work / 'installed'
        run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
        launcher = prefix / 'node_modules/.bin/codsh'
        package = prefix / 'node_modules/codsh-cli'
        binary = package / 'native' / ('darwin-arm64' if os.uname().machine == 'arm64' else 'darwin-x64') / 'codsh-rust'
        assert binary.exists(), 'candidate must contain the real native artifact'
        for relative in ['bin/codsh.mjs', 'bin/rust.mjs']:
            assert (package / relative).read_bytes() == (ROOT / 'packages/cli' / relative).read_bytes()
        semantics_results = path_semantics_matrix(launcher, work, output, env)
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
            launch_env = dict(child_env or env)
            launch_env.setdefault('DSH_BIN', env.get('DSH_BIN', '/no/runtime/must/be/started'))
            process = subprocess.Popen([*(prefix_command or []), NODE, str(launcher), '--rust'], cwd=cwd, env=launch_env,
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
        for variable, kind in [('DSH_HOME', 'tilde'), ('DSH_HOME', 'dotdot'),
                               ('DSH_HOME', 'blank'), ('GROK_HOME', 'tilde'),
                               ('GROK_HOME', 'relative'), ('GROK_HOME', 'blank')]:
            control_home = work / f'ui-{variable}-{kind}'
            control_home.mkdir()
            child_env = {'HOME': str(control_home), 'PATH': env['PATH'], 'TERM': env['TERM']}
            if kind == 'dotdot':
                (control_home / 'real-child').mkdir()
                (control_home / 'separate').mkdir()
                (control_home / 'separate/jump').symlink_to('../real-child')
                old = control_home / 'separate/独立 legacy home'
                child_env[variable] = str(control_home / 'separate/jump') + '/../独立 legacy home'
            elif kind == 'blank':
                child_env[variable] = '  '
                old = control_home / '.dsh' if variable == 'DSH_HOME' else cwd / '  '
            elif kind == 'relative':
                child_env[variable] = './独立 legacy home'
                old = cwd / '独立 legacy home'
            else:
                child_env[variable] = '~/独立 legacy home'
                old = control_home / '独立 legacy home' if variable == 'DSH_HOME' else cwd / '~/独立 legacy home'
            old.mkdir(parents=True)
            (old / 'canary').write_text('synthetic semantic control\n')
            original_legacy = snapshot_tree(old)
            exercise(f'semantics-{variable}-{kind}', child_env=child_env)
            assert snapshot_tree(old) == original_legacy
            assert (control_home / '.codsh-rust/dsh/profiles/rust/package.json').is_file()
        for variable in ['DSH_HOME', 'GROK_HOME']:
            for kind in ['existing', 'missing-ascii']:
                control_home = work / f'unicode-ui-{variable}-{kind}' / '用户 Home'
                old = control_home / '独立旧目录'
                old.mkdir(parents=True)
                (old / 'canary').write_text('synthetic Unicode legacy contents\n')
                before_unicode = snapshot_tree(old)
                configured = old if kind == 'existing' else old / 'missing-ascii/child'
                child_env = {'HOME': str(control_home), 'PATH': env['PATH'], 'TERM': env['TERM'], variable: str(configured)}
                exercise(f'unicode-{variable}-{kind}', child_env=child_env)
                assert snapshot_tree(old) == before_unicode
                assert (control_home / '.codsh-rust/dsh/profiles/rust/package.json').is_file()
        with tempfile.TemporaryDirectory(prefix='codsh-firmlink-ui-', dir='/tmp') as firmlink_ui:
            firmlink_ui_root = Path(firmlink_ui)
            for variable in ['DSH_HOME', 'GROK_HOME']:
                for reverse in [False, True]:
                    for existing in [False, True]:
                        name = f'firmlink-ui-{variable}-{reverse}-{existing}'
                        control_home = firmlink_ui_root / name
                        control_home.mkdir()
                        alias = data_volume_alias(control_home)
                        assert os.path.samefile(control_home, alias)
                        home_id, alias_id = identity(control_home), identity(alias)
                        assert home_id['realpath'] != alias_id['realpath']
                        assert (home_id['device'], home_id['inode']) == (alias_id['device'], alias_id['inode'])
                        old = control_home / '.codsh-rust-other/nested'
                        if existing:
                            old.mkdir(parents=True)
                            (old / 'canary').write_text('synthetic separate firmlink data\n')
                        before_control = snapshot_tree(control_home)
                        selected_home, legacy_home = (alias, control_home) if reverse else (control_home, alias)
                        child_env = {'HOME': str(selected_home), 'PATH': env['PATH'], 'TERM': env['TERM'],
                                     variable: str(legacy_home / '.codsh-rust-other/nested')}
                        exercise(name, child_env=child_env)
                        after_control = snapshot_tree(control_home)
                        without_preview = lambda tree: {key: value for key, value in tree.items()
                                                         if key != '.codsh-rust' and not key.startswith('.codsh-rust/')}
                        assert without_preview(after_control) == before_control
                        assert (control_home / '.codsh-rust/dsh/profiles/rust/package.json').is_file()
        profile = home / '.codsh-rust/dsh/profiles/rust/package.json'
        assert json.loads(profile.read_text())['dsh']['profile']['bundles'] == []
        profile.write_text('{invalid JSON')
        exercise('startup-error', action='error')
        assert digest_tree(legacy) == before
        assert (home / '.grok/canary').read_text() == 'synthetic official home\n'
        assert not list((home / '.codsh-rust').rglob('*session*'))
        for arguments, expected in [(['--rust', '--version'], 'codsh-rust'), (['--rust', '--help'], 'Isolated Rust client')]:
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
            'pathSemanticsCases': len(semantics_results), 'pathSemanticsEvidence': 'path-semantics-results.json',
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
