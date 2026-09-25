#!/usr/bin/env python3
"""Install the packed codsh-cli like a user, then update, break, and roll it back (ticket 66).

The tarball comes from `npm pack` of packages/cli with the staged host Rust
client (`pnpm run build:rust`). It is installed with `npm install -g` into a
fresh temporary prefix beside a dsh, the layout `npm install -g
@deepseek-ai/dsh codsh-cli` produces: the harness packages live under dsh's own
node_modules, never above codsh-cli. No CODSH_ACP_PATCH is set, so the
launcher's own plugin overlay runs. A local OpenAI-compatible fixture answers
turns; fake cargo/rustc/rustup/grok on PATH record any call. Legacy ~/.dsh and
~/.grok canaries must stay byte-identical throughout.

dsh comes from this checkout's install unless CODSH_INSTALL_TEST_DSH names a
dsh package directory (for example one installed from the registry with
`npm install -g --prefix <dir> @deepseek-ai/dsh`). Runs on Linux; macOS runs
are expected to work but are not recorded by this script's author.
"""
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
NPM = shutil.which('npm')
KEY = ('darwin' if sys.platform == 'darwin' else 'linux') + '-' + ('arm64' if os.uname().machine in ('arm64', 'aarch64') else 'x64')

spec = importlib.util.spec_from_file_location('rust_screen', ROOT / 'scripts/rust-screen-pty-test.py')
rust_screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rust_screen)


def run(argv, check=True, **kwargs):
    result = subprocess.run(argv, capture_output=True, text=True, **kwargs)
    if check and result.returncode != 0:
        raise AssertionError(f'{argv} failed ({result.returncode})\nstdout={result.stdout}\nstderr={result.stderr}')
    return result


def repo_dsh_package():
    script = ("const { createRequire } = require('node:module'); const r = createRequire(process.argv[1]);"
              " process.stdout.write(require('node:fs').realpathSync(require('node:path').dirname(r.resolve('@deepseek-ai/dsh/package.json'))))")
    return Path(run([NODE, '-e', script, str(ROOT / 'package.json')]).stdout)


class FakeLLM(http.server.BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"data":[{"id":"install-model"}]}')

    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length', 0) or 0))
        FakeLLM.requests.append(self.path)
        answer = f'INSTALL_TURN_{len(FakeLLM.requests)}'
        chunks = [
            {'id': 'c', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'install-model',
             'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': answer}, 'finish_reason': None}]},
            {'id': 'c', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'install-model',
             'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
             'usage': {'prompt_tokens': 3, 'completion_tokens': 2, 'total_tokens': 5}},
        ]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for chunk in chunks:
            self.wfile.write(f'data: {json.dumps(chunk)}\n\n'.encode())
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()


class Registry(http.server.BaseHTTPRequestHandler):
    latest = None

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'latest': Registry.latest}).encode())


def serve(handler):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def tree_digest(path):
    digest = hashlib.sha256()
    for item in sorted(Path(path).rglob('*')):
        digest.update(str(item.relative_to(path)).encode())
        if item.is_file() and not item.is_symlink():
            digest.update(item.read_bytes())
    return digest.hexdigest()


def main():
    if sys.platform not in ('linux', 'darwin'):
        raise SystemExit('Linux or macOS required; Windows installation is ticket 68')
    staged = ROOT / 'packages/cli/native' / KEY
    if not (staged / 'artifact.json').is_file():
        raise SystemExit(f'stage the host Rust client first: pnpm run build:rust (missing {staged})')
    version = json.loads((ROOT / 'packages/cli/package.json').read_text())['version']
    dsh_package = Path(os.environ['CODSH_INSTALL_TEST_DSH']).resolve() if os.environ.get('CODSH_INSTALL_TEST_DSH') else repo_dsh_package()
    dsh_version = json.loads((dsh_package / 'package.json').read_text())['version']
    llm = serve(FakeLLM)
    registry = serve(Registry)
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-install-out-', dir='/tmp'))
    results = {'key': KEY, 'version': version, 'dsh': {'package': str(dsh_package), 'version': dsh_version}}
    work = Path(tempfile.mkdtemp(prefix='codsh-rust-install-', dir='/tmp'))
    try:
        home = work / 'home'
        (home / '.dsh').mkdir(parents=True)
        (home / '.dsh/settings.yaml').write_text('agent-default-model:\n  provider: legacy\n  model: legacy\n')
        (home / '.grok').mkdir()
        (home / '.grok/config.toml').write_text('[models]\ndefault = "legacy"\n')
        (home / '.grok/sessions').mkdir()
        (home / '.grok/sessions/keep.jsonl').write_text('{"legacy":true}\n')
        legacy_before = {name: tree_digest(home / name) for name in ('.dsh', '.grok')}
        cwd = work / 'project'
        cwd.mkdir()
        npm_env = {
            'HOME': str(work / 'npm-home'), 'PATH': os.environ['PATH'],
            'npm_config_cache': str(work / 'npm-cache'),
            'npm_config_userconfig': str(work / 'empty-user.npmrc'),
            'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
            'npm_config_update_notifier': 'false',
        }

        def pack(directory, destination):
            destination.mkdir(parents=True, exist_ok=True)
            name = json.loads(run([NPM, 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(destination)],
                                  cwd=directory, env=npm_env).stdout)[0]['filename']
            return destination / name

        prefix = work / 'prefix'

        def install(tarball):
            run([NPM, 'install', '-g', '--prefix', str(prefix), '--offline', '--ignore-scripts', '--no-audit', '--no-fund', str(tarball)], env=npm_env)

        # Tarballs: this version, a later one, and a later one that lost its Rust client.
        tar_current = pack(ROOT / 'packages/cli', work / 'tarballs/current')

        def variant(new_version, drop_native=False):
            copy = work / f'pkg-{new_version}'
            shutil.copytree(ROOT / 'packages/cli', copy, symlinks=True)
            manifest = json.loads((copy / 'package.json').read_text())
            manifest['version'] = new_version
            (copy / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
            if drop_native:
                shutil.rmtree(copy / 'native')
            else:
                artifact = json.loads((copy / 'native' / KEY / 'artifact.json').read_text())
                artifact['version'] = new_version
                (copy / 'native' / KEY / 'artifact.json').write_text(json.dumps(artifact, indent=2) + '\n')
            return pack(copy, work / f'tarballs/{new_version}')

        newer = '99.0.1'
        broken = '99.0.2'
        tar_newer = variant(newer)
        tar_broken = variant(broken, drop_native=True)

        # dsh beside codsh-cli, as a global npm install lays them out.
        (prefix / 'lib/node_modules/@deepseek-ai').mkdir(parents=True)
        (prefix / 'bin').mkdir()
        os.symlink(dsh_package, prefix / 'lib/node_modules/@deepseek-ai/dsh')
        os.symlink(dsh_package / 'lib/bin.js', prefix / 'bin/dsh')
        install(tar_current)
        package = prefix / 'lib/node_modules/codsh-cli'
        launcher = prefix / 'bin/codsh'
        binary = package / 'native' / KEY / 'codsh-rust'

        # Anything that tries to compile or reach an official runtime is recorded.
        canary_bin = work / 'canary-bin'
        canary_bin.mkdir()
        canary = work / 'canary.log'
        for name in ('cargo', 'rustc', 'rustup', 'grok'):
            tool = canary_bin / name
            tool.write_text(f'#!/bin/sh\necho "{name} $*" >> {canary}\nexit 97\n')
            tool.chmod(0o755)
        node_dir = str(Path(NODE).parent)
        base_env = {
            'HOME': str(home), 'PATH': f'{canary_bin}:{prefix / "bin"}:{node_dir}:/usr/bin:/bin',
            'TERM': 'xterm-256color', 'LANG': 'C.UTF-8', 'INSTALL_API_KEY': 'install-token',
        }
        isolated = home / '.codsh-rust'
        (isolated / '.grok').mkdir(parents=True)
        (isolated / '.grok/config.toml').write_text(f"""[models]
default = "fake"

[model.fake]
name = "Install fixture"
model = "install-model"
base_url = "http://127.0.0.1:{llm.server_address[1]}/v1"
env_key = "INSTALL_API_KEY"
api_backend = "chat_completions"
""")

        def codsh(*args, env=None, timeout=90):
            return run([str(launcher), '--rust', *args], check=False, cwd=cwd, env=env or base_env, timeout=timeout)

        def assert_refused(result, *needles):
            assert result.returncode == 1, (result.returncode, result.stdout, result.stderr)
            for needle in needles:
                assert needle in result.stderr, (needle, result.stderr)

        def legacy_intact():
            for name, digest in legacy_before.items():
                assert tree_digest(home / name) == digest, f'legacy {name} changed'

        # 1. A clean install carries the prebuilt client and needs no Rust toolchain.
        assert binary.read_bytes() == (staged / 'codsh-rust').read_bytes()
        assert not any(package.rglob('Cargo.toml')) and not any(package.rglob('*.rs'))
        check = codsh('install-check', '--json')
        assert check.returncode == 0, check.stdout + check.stderr
        report = json.loads(check.stdout)
        assert report['artifact']['ok'] and report['artifact']['key'] == KEY and report['artifact']['version'] == version
        assert report['dsh']['ok'] and report['dsh']['version'] == dsh_version
        assert Path(report['dsh']['entry']).resolve() == (dsh_package / 'lib/bin.js').resolve()
        results['install_check'] = {k: report[k] for k in ('artifact', 'dsh')}

        # 2. A headless turn through the launcher's own plugin overlay.
        first = codsh('-p', 'first installed turn')
        assert first.returncode == 0, first.stdout + first.stderr
        assert 'INSTALL_TURN_1' in first.stdout, first.stdout
        assert 'updated' not in first.stderr and 'earlier version' not in first.stderr, first.stderr
        overlay = (isolated / 'dsh/rust-file-approval.yml').read_text()
        assert f"file://{package}/bin/rust-acp-hooks.mjs" in overlay, overlay
        stamp = json.loads((isolated / 'codsh-version.json').read_text())
        assert stamp['lastVersion'] == version
        results['headless_turn'] = first.stdout.strip()

        # 3. The interactive client in a PTY: a turn, quit, terminal restored.
        session = rust_screen.Session('install-tui', launcher, cwd, base_env, output)
        try:
            session.wait_visible('Enter', 30)
            session.write('second installed turn\r')
            session.wait_visible('INSTALL_TURN_2', 60)
            results['tui'] = session.finish(expect_alt_leave=True)
            assert results['tui']['exit'] == 0
        finally:
            session.close()

        def session_ids():
            listed = codsh('sessions', 'list')
            assert listed.returncode == 0, listed.stdout + listed.stderr
            return set(re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', listed.stdout))
        before_update = session_ids()
        # The headless turn and the PTY turn are both durable dsh sessions.
        assert len(before_update) >= 2, before_update
        results['sessions_before_update'] = len(before_update)

        # 4. Update in place: sessions survive, the change is announced once.
        install(tar_newer)
        updated = codsh('-p', 'after update')
        assert updated.returncode == 0, updated.stdout + updated.stderr
        assert f'codsh: Rust client updated {version} → {newer}' in updated.stderr, updated.stderr
        assert 'INSTALL_TURN_3' in updated.stdout
        again = codsh('-p', 'quiet second run')
        assert 'updated' not in again.stderr, again.stderr
        assert before_update <= session_ids()
        results['update'] = updated.stderr.strip()

        # 5-8. Broken installs are refused before the Rust Home or dsh is touched.
        requests_before = len(FakeLLM.requests)
        home_before = tree_digest(isolated)
        artifact_file = package / 'native' / KEY / 'artifact.json'
        original_artifact = artifact_file.read_text()
        original_binary = binary.read_bytes()
        artifact = json.loads(original_artifact)
        artifact['version'] = version
        artifact_file.write_text(json.dumps(artifact))
        assert_refused(codsh('-p', 'x'), f'Rust client {version} does not match this codsh-cli {newer}: an update did not finish.',
                       f'npm install -g codsh-cli@{newer}')
        artifact_file.write_text(original_artifact)
        damaged = bytearray(original_binary)
        damaged[len(damaged) // 2] ^= 0xFF
        binary.write_bytes(bytes(damaged))
        assert_refused(codsh('-p', 'x'), 'damaged or incomplete download', f'npm install -g codsh-cli@{newer}')
        wrong = bytearray(4096)
        wrong[0:4] = b'\x7fELF' if KEY.startswith('linux') else bytes.fromhex('cffaedfe')
        if KEY.startswith('linux'):
            wrong[4], wrong[5] = 2, 1
            wrong[18:20] = (0xB7 if KEY.endswith('x64') else 0x3E).to_bytes(2, 'little')
        else:
            wrong[4:8] = (0x0100000C if KEY.endswith('x64') else 0x01000007).to_bytes(4, 'little')
        binary.write_bytes(bytes(wrong))
        artifact['version'] = newer
        artifact['sha256'] = hashlib.sha256(bytes(wrong)).hexdigest()
        artifact_file.write_text(json.dumps(artifact))
        assert_refused(codsh('-p', 'x'), 'integrity/platform mismatch', 'executable, not a')
        binary.write_bytes(original_binary)
        artifact_file.write_text(original_artifact)
        native_dir = package / 'native' / KEY
        hidden = package / 'native' / 'hidden'
        native_dir.rename(hidden)
        assert_refused(codsh('-p', 'x'), f'Rust client artifact is not installed for {KEY}', 'ordinary codsh remains available')
        hidden.rename(native_dir)
        assert len(FakeLLM.requests) == requests_before and tree_digest(isolated) == home_before
        results['refusals'] = ['version', 'corrupt', 'target', 'missing']

        # 9. dsh too old, and no dsh at all.
        old = work / 'old-dsh/node_modules/@deepseek-ai/dsh'
        (old / 'lib').mkdir(parents=True)
        (old / 'package.json').write_text(json.dumps({'name': '@deepseek-ai/dsh', 'version': '0.1.4', 'bin': {'dsh': 'lib/bin.js'}}))
        (old / 'lib/bin.js').write_text("process.stderr.write('OLD_DSH_STARTED\\n')\n")
        too_old = codsh('-p', 'x', env={**base_env, 'DSH_BIN': str(old / 'lib/bin.js')})
        assert_refused(too_old, 'dsh 0.1.4', 'npm install -g @deepseek-ai/dsh')
        assert 'OLD_DSH_STARTED' not in too_old.stderr
        (prefix / 'lib/node_modules/@deepseek-ai/dsh').unlink()
        (prefix / 'bin/dsh').unlink()
        no_dsh_check = codsh('install-check')
        assert no_dsh_check.returncode == 1 and 'dsh: dsh-missing' in no_dsh_check.stdout, no_dsh_check.stdout
        no_dsh = codsh('-p', 'x')
        assert no_dsh.returncode == 1
        assert 'the dsh runtime (dsh) was not found' in no_dsh.stderr, no_dsh.stderr
        assert 'npm install -g @deepseek-ai/dsh' in no_dsh.stderr and 'install-check' in no_dsh.stderr
        os.symlink(dsh_package, prefix / 'lib/node_modules/@deepseek-ai/dsh')
        os.symlink(dsh_package / 'lib/bin.js', prefix / 'bin/dsh')
        assert len(FakeLLM.requests) == requests_before
        results['dsh_refusals'] = [too_old.stderr.strip().splitlines()[0], no_dsh.stderr.strip().splitlines()[0]]

        # 10. Roll back to the earlier package: data kept, the downgrade is named.
        install(tar_current)
        rolled = codsh('-p', 'after rollback')
        assert rolled.returncode == 0, rolled.stdout + rolled.stderr
        assert f'last used by codsh {newer}; now running {version} (an earlier version)' in rolled.stderr, rolled.stderr
        assert f'npm install -g codsh-cli@{newer}' in rolled.stderr
        assert before_update <= session_ids()
        stamp = json.loads((isolated / 'codsh-version.json').read_text())
        assert stamp['lastVersion'] == version and stamp['newestVersion'] == newer
        results['rollback'] = rolled.stderr.strip()

        # 11. `codsh update` to a package without this platform's client names the way back.
        fake_npm_dir = work / 'fake-npm'
        fake_npm_dir.mkdir()
        (fake_npm_dir / 'npm').write_text(
            f'#!/bin/sh\n[ "$1 $2" = "install -g" ] && [ "$3" = "codsh-cli@{broken}" ] || exit 64\n'
            f'exec "{NPM}" install -g --prefix "{prefix}" --offline --ignore-scripts --no-audit --no-fund "{tar_broken}"\n')
        (fake_npm_dir / 'npm').chmod(0o755)
        legacy_dsh = work / 'legacy-dsh.mjs'
        legacy_dsh.write_text("if (process.argv.includes('--version')) console.log('0.1.5-rc.3'); process.exit(0)\n")
        Registry.latest = broken
        update_env = {**base_env, **{k: v for k, v in npm_env.items() if k.startswith('npm_config')},
                      'PATH': f'{fake_npm_dir}:{base_env["PATH"]}', 'DSH_BIN': str(legacy_dsh),
                      'CODSH_UPDATE_REGISTRY': f'http://127.0.0.1:{registry.server_address[1]}'}
        updating = run([str(launcher), 'update'], check=False, cwd=cwd, env=update_env, timeout=120)
        assert updating.returncode == 1, updating.stdout + updating.stderr
        assert f'codsh-cli {broken} is installed, but its Rust client (codsh --rust) does not verify on this machine' in updating.stderr, updating.stderr
        assert f'not installed for {KEY}' in updating.stderr
        assert f'go back to the version you had:  npm install -g codsh-cli@{version}' in updating.stderr
        install(tar_current)
        recovered = codsh('install-check')
        assert recovered.returncode == 0, recovered.stdout
        final = codsh('-p', 'after recovery')
        assert final.returncode == 0 and 'INSTALL_TURN_' in final.stdout, final.stdout + final.stderr
        results['update_partial_failure'] = updating.stderr.strip()

        legacy_intact()
        assert not canary.exists(), canary.read_text()
        results['legacy_untouched'] = True
        results['no_toolchain_or_official_runtime_called'] = True
        results['llm_requests'] = len(FakeLLM.requests)
        (output / 'result.json').write_text(json.dumps(results, indent=2))
        print(json.dumps(results, indent=2))
        print(f'artifacts {output}')
    finally:
        llm.shutdown()
        registry.shutdown()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
