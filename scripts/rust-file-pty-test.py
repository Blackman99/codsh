#!/usr/bin/env python3
"""Installed-product PTY: real dsh file tools, diffs, and allow/reject."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()


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
    payload = json.dumps({'rows': rows, 'cols': cols, 'bytes': __import__('base64').b64encode(data).decode()})
    return run([NODE, '--import', 'tsx', '-e',
                f"import {{ Terminal }} from {json.dumps(emulator.as_uri())}; "
                "let input=''; for await (const chunk of process.stdin) input+=chunk; "
                "const spec=JSON.parse(input); const t=new Terminal(spec.rows,spec.cols); "
                "t.feed(Buffer.from(spec.bytes,'base64').toString()); console.log(t.text);"],
               input=payload, cwd=ROOT).stdout


def exercise(name, launcher, cwd, env, output, typed, wait_for, action='allow', cols=100, rows=48, extra=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    original = termios.tcgetattr(slave)
    argv = [NODE, str(launcher), '--rust', *(extra or [])]
    process = subprocess.Popen(argv, cwd=cwd, env=env,
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

    def wait_visible(text, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            pump()
            shown = visible()
            if text in shown:
                return shown
            if process.poll() is not None:
                break
        raise AssertionError(f'{name}: missing {text!r}\n{visible()}\nraw={bytes(data)[-2500:]!r}')

    try:
        wait_visible('codsh')
        wait_visible('Draft (not sent)')
        wait_visible('Connected to dsh ACP', 25)
        os.write(master, typed.encode())
        wait_visible(typed)
        os.write(master, b'\r')
        if action == 'allow-if-asked':
            deadline = time.monotonic() + 8
            asked = False
            while time.monotonic() < deadline:
                pump()
                if 'y=allow once' in visible():
                    asked = True
                    break
                if any(marker in visible() for marker in wait_for):
                    break
            if asked:
                os.write(master, b'y')
            for marker in wait_for:
                wait_visible(marker, 30)
            shown = visible()
            os.write(master, b'\x11')
            process.wait(timeout=12)
            pump()
            os.write(master, b'AFTER_EXIT_CANONICAL\n')
            assert select.select([slave], [], [], 2)[0]
            assert os.read(slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
            after = termios.tcgetattr(slave)
            (output / f'{name}.ansi').write_bytes(data)
            (output / f'{name}.txt').write_text(shown)
            assert original == after, f'{name}: terminal modes were not restored'
            assert b'\x1b[?1049l' in data
            return {'name': name, 'exit': process.returncode, 'screen': shown}
        if action in {'allow', 'reject', 'quit-approval'}:
            wait_visible('Allow ', 30)
            wait_visible('y=allow once', 10)
            if action == 'allow':
                os.write(master, b'y')
            elif action == 'reject':
                os.write(master, b'n')
            else:
                os.write(master, b'\x11')
                process.wait(timeout=12)
                pump()
                shown = visible()
                os.write(master, b'AFTER_EXIT_CANONICAL\n')
                assert select.select([slave], [], [], 2)[0]
                assert os.read(slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
                after = termios.tcgetattr(slave)
                (output / f'{name}.ansi').write_bytes(data)
                (output / f'{name}.txt').write_text(shown)
                assert original == after, f'{name}: terminal modes were not restored'
                assert b'\x1b[?1049l' in data
                return {'name': name, 'exit': process.returncode, 'screen': shown}
        for marker in wait_for:
            wait_visible(marker, 30)
        shown = visible()
        os.write(master, b'\x11')
        process.wait(timeout=12)
        pump()
        os.write(master, b'AFTER_EXIT_CANONICAL\n')
        assert select.select([slave], [], [], 2)[0]
        assert os.read(slave, 4096) == b'AFTER_EXIT_CANONICAL\n'
        after = termios.tcgetattr(slave)
        (output / f'{name}.ansi').write_bytes(data)
        (output / f'{name}.txt').write_text(shown)
        assert original == after, f'{name}: terminal modes were not restored'
        assert b'\x1b[?1049l' in data
        return {'name': name, 'exit': process.returncode, 'screen': shown}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


def review_results(path, prompt):
    """Model-visible tool text from the turn that contains this typed prompt."""
    if not path.exists():
        return []
    texts = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if prompt not in ''.join(record.get('user') or []):
            continue
        for item in record.get('results') or []:
            texts.append(item.get('text') or '')
    return texts


def flat(text):
    # Drop transcript `>` markers and wrapping spaces before comparing.
    return ''.join(line.lstrip('> ').strip() for line in text.splitlines())


def model_lines(results):
    # The search card omits the model-only "Found N matches" header.
    lines = []
    for item in results:
        for line in item.splitlines():
            text = flat(line)
            if not text or text.startswith('Found') and 'match' in text:
                continue
            lines.append(text)
    return lines


def screen_matches_model(screen, results):
    shown = flat(screen)
    lines = model_lines(results)
    missing = [line for line in lines if line not in shown]
    return bool(lines) and not missing, missing


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-file-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-file-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        pack_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'],
            'npm_config_cache': str(work / 'npm-cache'),
            'npm_config_userconfig': str(work / 'empty-user.npmrc'),
            'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
            'npm_config_update_notifier': 'false',
        }
        pack = json.loads(run(['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
                             cwd=ROOT / 'packages/cli', env=pack_env).stdout)[0]['filename']
        prefix = work / 'installed'
        run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
        launcher = prefix / 'node_modules/.bin/codsh'
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        base_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
        }
        (cwd / 'note.txt').write_text('alpha\n')
        allow = exercise('allow-edit', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'}, output,
                         typed='TOKEN_FILE_EDIT', wait_for=['+ALPHA', 'successfully.'], action='allow')
        assert 'edit note.txt' in allow['screen']
        assert '-alpha' in allow['screen'] and '+ALPHA' in allow['screen']
        assert (cwd / 'note.txt').read_text() == 'ALPHA\n'
        assert 'successfully.' in allow['screen']
        assert 'RUST_ACP_FILE_DONE' in allow['screen']

        (cwd / 'note.txt').write_text('alpha\n')
        reject = exercise('reject-edit', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'}, output,
                          typed='TOKEN_FILE_REJECT', wait_for=['rejected', 'the user'], action='reject')
        assert (cwd / 'note.txt').read_text() == 'alpha\n'
        assert 'rejected' in reject['screen'].lower() or 'the user' in reject['screen'].lower()
        assert 'successfully.' not in reject['screen']

        (cwd / 'note.txt').write_text('alpha\n')
        cancelled = exercise('quit-approval', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-edit'}, output,
                             typed='TOKEN_FILE_QUIT', wait_for=[], action='quit-approval')
        assert (cwd / 'note.txt').read_text() == 'alpha\n'
        assert cancelled['exit'] == 0

        missing = exercise('missing-file', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-missing'}, output,
                           typed='TOKEN_FILE_MISSING', wait_for=['cannot read', 'not found'], action='none')
        assert not (cwd / 'missing-note.txt').exists()
        assert 'successfully.' not in missing['screen']
        assert 'not found' in missing['screen'] or 'cannot read' in missing['screen']
        assert 'cannot read' in missing['screen']
        assert 'failed' in missing['screen'].lower(), missing['screen']
        assert '[error]' in missing['screen'], missing['screen']

        (cwd / 'note.txt').write_text('alpha\n')
        error = exercise('tool-error', launcher, cwd, {**base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'file-error'}, output,
                         typed='TOKEN_FILE_ERROR', wait_for=['old_string was not found'], action='allow')
        assert (cwd / 'note.txt').read_text() == 'alpha\n'
        assert 'successfully.' not in error['screen']
        assert 'failed' in error['screen'].lower(), error['screen']
        assert '[error]' in error['screen'], error['screen']

        (cwd / 'visible.txt').write_text('NEEDLE in the open file\n')
        (cwd / 'secret').mkdir()
        (cwd / 'secret' / 'key.txt').write_text('SECRET_LINE must stay hidden\n')
        grok_home = home / '.codsh-rust' / '.grok'
        grok_home.mkdir(parents=True, exist_ok=True)
        (grok_home / 'config.toml').write_text("""
[models]
default = "user-model"

[model.user-model]
name = "User model"
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"

[permission]
deny = ["Read(secret/**)"]
""")
        search_env = {**base_env, 'XAI_API_KEY': 'test-key-not-a-secret-for-logs', 'CODSH_REVIEW_TRACE': str(output / 'review-trace.jsonl')}
        deny_extra = ['--deny', 'Read(secret/**)']

        found = exercise('search-needle', launcher, cwd, {**search_env, 'DSH_CODE_CLI_MOCK_TOOL': 'search-needle'}, output,
                         typed='find NEEDLE in this repo', wait_for=['NEEDLE', 'visible.txt', 'RUST_ACP_SEARCH_DONE'], action='none', extra=deny_extra)
        assert 'SECRET_LINE' not in found['screen']
        assert 'secret/key.txt' not in found['screen']
        assert 'visible.txt' in found['screen']
        needle_trace = review_results(output / 'review-trace.jsonl', 'find NEEDLE in this repo')
        assert any('visible.txt' in item and 'NEEDLE' in item for item in needle_trace)
        assert all('secret/key.txt' not in item and 'SECRET_LINE' not in item for item in needle_trace)
        matched, unmatched = screen_matches_model(found['screen'], needle_trace)
        assert matched, unmatched

        empty = exercise('search-empty', launcher, cwd, {**search_env, 'DSH_CODE_CLI_MOCK_TOOL': 'search-empty'}, output,
                         typed='search for NO_SUCH_TOKEN_ZZZ', wait_for=['No matches found', 'RUST_ACP_SEARCH_DONE'], action='none', extra=deny_extra)
        assert 'SECRET_LINE' not in empty['screen']
        assert 'No matches found' in empty['screen']
        empty_trace = review_results(output / 'review-trace.jsonl', 'search for NO_SUCH_TOKEN_ZZZ')
        assert any('No matches found' in item for item in empty_trace)
        assert all('SECRET_LINE' not in item and 'NEEDLE' not in item for item in empty_trace)
        matched, unmatched = screen_matches_model(empty['screen'], empty_trace)
        assert matched, unmatched

        denied = exercise('search-denied', launcher, cwd, {**search_env, 'DSH_CODE_CLI_MOCK_TOOL': 'search-denied'}, output,
                          typed='search SECRET_LINE including shell', wait_for=['visible.txt', 'no results were returned', 'RUST_ACP_SEARCH_ERROR'], action='none', extra=deny_extra)
        denied_body = denied['screen'].split('search SECRET_LINE including shell', 1)[-1]
        assert 'SECRET_LINE' not in denied_body
        assert 'secret/key.txt' not in denied_body
        assert 'must stay hidden' not in denied_body
        assert 'Denied' in denied['screen'] or 'denied' in denied['screen']
        denied_trace = review_results(output / 'review-trace.jsonl', 'search SECRET_LINE including shell')
        assert denied_trace
        assert any('visible.txt' in item for item in denied_trace)
        assert any('no results were returned' in item for item in denied_trace)
        assert all('SECRET_LINE' not in item and 'secret/key.txt' not in item and 'must stay hidden' not in item for item in denied_trace)
        matched, unmatched = screen_matches_model(denied['screen'], denied_trace)
        assert matched, unmatched

        (cwd / 'paged.txt').write_text('PAGE one\nPAGE two\nPAGE three\nPAGE four\n')
        continued = exercise('search-continue', launcher, cwd, {**search_env, 'DSH_CODE_CLI_MOCK_TOOL': 'search-continue'}, output,
                             typed='find PAGE and keep reading', wait_for=['PAGE one', 'PAGE four', 'RUST_ACP_SEARCH_DONE'], action='none', extra=deny_extra)
        assert 'offset=' in continued['screen'] or 'Showing lines' in continued['screen']
        assert 'SECRET_LINE' not in continued['screen']
        continued_trace = review_results(output / 'review-trace.jsonl', 'find PAGE and keep reading')
        assert any('PAGE four' in item or 'offset=' in item for item in continued_trace)
        assert all('SECRET_LINE' not in item for item in continued_trace)
        matched, unmatched = screen_matches_model(continued['screen'], continued_trace)
        assert matched, unmatched

        (cwd / 'blob.bin').write_bytes(b'\x00\x01\x02NEEDLE-BINARY')
        binary = exercise('search-binary', launcher, cwd, {**search_env, 'DSH_CODE_CLI_MOCK_TOOL': 'search-binary'}, output,
                          typed='read the binary blob', wait_for=['binary', 'RUST_ACP_SEARCH_ERROR'], action='none', extra=deny_extra)
        assert 'NEEDLE-BINARY' not in binary['screen']
        assert 'binary file' in binary['screen']
        assert 'failed' in binary['screen'].lower()
        binary_trace = review_results(output / 'review-trace.jsonl', 'read the binary blob')
        assert any('binary file' in item for item in binary_trace)
        assert all('NEEDLE-BINARY' not in item for item in binary_trace)
        matched, unmatched = screen_matches_model(binary['screen'], binary_trace)
        assert matched, unmatched

        moving = cwd / 'moving.txt'
        moving.write_text('before\n')
        stale = exercise('search-stale', launcher, cwd, {**search_env, 'DSH_CODE_CLI_MOCK_TOOL': 'search-stale'}, output,
                         typed='edit the moving file', wait_for=['re-read', 'RUST_ACP_SEARCH_ERROR'], action='allow-if-asked', extra=deny_extra)
        assert 'changed-underfoot' in moving.read_text()
        assert 'after' not in moving.read_text()
        assert 'failed' in stale['screen'].lower()
        stale_trace = review_results(output / 'review-trace.jsonl', 'edit the moving file')
        assert any('re-read' in item for item in stale_trace)
        assert all('changed-underfoot' not in item for item in stale_trace)
        matched, unmatched = screen_matches_model(stale['screen'], stale_trace)
        assert matched, unmatched

        (cwd / 'nav.ts').write_text('export const marker = 1\n')
        missing_lsp = exercise('search-lsp', launcher, cwd, {**search_env, 'DSH_CODE_CLI_MOCK_TOOL': 'search-lsp'}, output,
                               typed='go to the definition of marker', wait_for=['no LSP provider', 'RUST_ACP_SEARCH_ERROR'], action='none', extra=deny_extra)
        assert 'export const marker' not in missing_lsp['screen']
        assert 'failed' in missing_lsp['screen'].lower()
        assert 'nav.ts:1' not in missing_lsp['screen']
        lsp_trace = review_results(output / 'review-trace.jsonl', 'go to the definition of marker')
        assert any('no LSP provider' in item for item in lsp_trace)
        assert all('export const marker' not in item and 'nav.ts:1' not in item for item in lsp_trace)
        matched, unmatched = screen_matches_model(missing_lsp['screen'], lsp_trace)
        assert matched, unmatched

        (output / 'result.json').write_text(json.dumps({
            'results': [
                {'name': allow['name'], 'exit': allow['exit']},
                {'name': reject['name'], 'exit': reject['exit']},
                {'name': cancelled['name'], 'exit': cancelled['exit']},
                {'name': missing['name'], 'exit': missing['exit']},
                {'name': error['name'], 'exit': error['exit']},
                {'name': found['name'], 'exit': found['exit']},
                {'name': empty['name'], 'exit': empty['exit']},
                {'name': denied['name'], 'exit': denied['exit']},
                {'name': continued['name'], 'exit': continued['exit']},
                {'name': binary['name'], 'exit': binary['exit']},
                {'name': stale['name'], 'exit': stale['exit']},
                {'name': missing_lsp['name'], 'exit': missing_lsp['exit']},
            ],
            'dshBin': dsh,
            'noteAfterAllow': 'ALPHA\\n',
        }, indent=2) + '\n')
        assert all(item['exit'] == 0 for item in [allow, reject, cancelled, missing, error, found, empty, denied, continued, binary, stale, missing_lsp])
    print(f'PASS: rust dsh file-tool PTY; evidence: {output}')


if __name__ == '__main__':
    main()
