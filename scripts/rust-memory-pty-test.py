#!/usr/bin/env python3
"""Packed PTY: explicit local memory for ticket 53 / issue 185.

Uses an isolated home and synthetic notes. It never reads ~/.grok or a real
memory directory.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    spec = importlib.util.spec_from_file_location(
        'rust_screen_pty_test', ROOT / 'scripts' / 'rust-screen-pty-test.py')
    screen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(screen)
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-memory-', dir='/tmp'))
    with tempfile.TemporaryDirectory(prefix='codsh-rust-memory-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        (cwd / '.git').mkdir(parents=True)
        (cwd / '.git' / 'config').write_text(
            '[remote "origin"]\n\turl = https://github.com/Example/Widget.git\n')
        other = work / 'other'
        (other / '.git').mkdir(parents=True)
        (other / '.git' / 'config').write_text(
            '[remote "origin"]\n\turl = https://github.com/Example/Other.git\n')
        pack_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'],
            'npm_config_cache': str(work / 'npm-cache'),
            'npm_config_userconfig': str(work / 'empty-user.npmrc'),
            'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
            'npm_config_update_notifier': 'false',
        }
        pack = json.loads(run(
            ['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
            cwd=ROOT / 'packages/cli', env=pack_env).stdout)[0]['filename']
        prefix = work / 'installed'
        run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline',
             '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
        launcher = prefix / 'node_modules/.bin/codsh'
        patch = work / 'overlay.yml'
        patch.write_text(screen.overlay_text())
        grok = home / '.codsh-rust' / '.grok'
        grok.mkdir(parents=True)
        (grok / 'config.toml').write_text("""
[models]
default = "gateway"

[model.gateway]
name = "Local gateway"
model = "mock-model"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"
api_key = "memory-secret"

[memory]
enabled = true
""")
        base_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'COLORTERM': 'truecolor',
            'DSH_BIN': screen.dsh_bin(), 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'XAI_API_KEY': 'memory-secret',
        }
        session = screen.Session('memory-browser', launcher, cwd, base_env, output)
        try:
            session.wait_visible('Connected to dsh ACP', 25)
            # Slash completion runs the highlighted command on Enter, so the
            # note is the next line after /remember, not arguments on the same line.
            session.write('/remember\r')
            session.wait_visible('Next line becomes the note', 10)
            session.write('open the synthetic PR links\r')
            session.wait_visible('Save this note', 10)
            shown = session.visible()
            assert 'open the synthetic PR links' in shown, shown
            note = grok / 'memory'
            assert not any(note.rglob('MEMORY.md')), 'note written before confirm'
            session.write('n')
            session.pump(0.4)
            session.wait_visible('nothing was written', 5)
            assert not any(note.rglob('MEMORY.md')), 'cancel wrote a note'
            session.write('/remember\r')
            session.wait_visible('Next line becomes the note', 10)
            session.write('open the synthetic PR links\r')
            session.wait_visible('Save this note', 10)
            session.write('y')
            session.wait_visible('Memory saved to', 10)
            saved = list(note.rglob('MEMORY.md'))
            assert len(saved) == 1, saved
            assert saved[0].name == 'MEMORY.md'
            assert 'topics' not in str(saved[0])
            assert 'synthetic PR links' in saved[0].read_text()
            session.write('/memory\r')
            session.wait_visible('Memory', 10)
            session.wait_visible('[workspace]', 5)
            session.wait_visible('read-only', 5)
            session.wait_visible('MEMORY.md', 5)
            session.write('x')
            session.pump(0.3)
            session.wait_visible('cannot be deleted', 5)
            assert saved[0].is_file(), 'x deleted MEMORY.md'
            session.write('\x1b')
            session.wait_visible('memory on for this session', 5)
            sessions = saved[0].parent / 'sessions'
            sessions.mkdir()
            for index in range(8):
                (sessions / f's{index}.md').write_text(f'session log {index}\n')
            (saved[0].parent / 'index.sqlite').write_bytes(b'sqlite')
            session.write('/memory\r')
            session.wait_visible('MEMORY.md', 5)
            # Reverse-chronological names put sessions/s0.md last. Walk the
            # list and stop on that highlighted row.
            shown = ''
            for _ in range(12):
                session.write('j')
                session.pump(0.12)
                shown = session.visible()
                if '> [workspace] sessions/s0.md' in shown:
                    break
            assert '> [workspace] sessions/s0.md' in shown, shown
            assert 'read-only' in shown
            session.resize(24, 60)
            session.pump(0.4)
            narrow = session.visible()
            assert 'preview hidden' in narrow, narrow
            assert 'session log 0' not in narrow, narrow
            session.write('\r')
            session.wait_visible('session log 0', 5)
            session.write('\x1b')
            session.pump(0.3)
            session.resize(36, 100)
            session.pump(0.4)
            session.write('x')
            session.pump(0.3)
            session.write('x')
            session.pump(0.4)
            assert not (sessions / 's0.md').exists()
            assert saved[0].is_file(), 'x deleted MEMORY.md'
            session.write('/')
            session.write('missing-token')
            session.wait_visible('No notes match', 5)
            session.write('\x7f' * 13)
            session.pump(0.3)
            session.write('\x1b')  # leave the filter
            session.pump(0.3)
            session.write('\x1b')  # close the browser
            session.wait_visible('memory on for this session', 5)
            hidden = dict(base_env)
            hidden['GROK_MEMORY'] = '0'
            blocked = screen.Session('memory-force-off', launcher, cwd, hidden, output)
            try:
                blocked.wait_visible('Connected to dsh ACP', 25)
                blocked.write('/memory\r')
                blocked.wait_visible('GROK_MEMORY=0', 10)
                assert 'synthetic PR links' not in blocked.visible()
                assert saved[0].is_file()
            finally:
                blocked.write('\x11')
                blocked.pump(0.5)
                if blocked.process.poll() is None:
                    blocked.process.terminate()
            off = grok / 'config.toml'
            original_config = off.read_text()
            off.write_text(original_config.replace('enabled = true', 'enabled = false'))
            disabled = dict(base_env)
            disabled['GROK_MEMORY'] = '1'
            quiet = screen.Session('memory-config-off', launcher, cwd, disabled, output)
            try:
                quiet.wait_visible('Connected to dsh ACP', 25)
                quiet.write('/memory\r')
                quiet.wait_visible('Memory', 10)
                quiet.wait_visible('session=off', 5)
                # enabled=false still lists the file. It does not inject it.
                quiet.wait_visible('MEMORY.md', 5)
                quiet.write('\x1b')
                quiet.wait_visible('memory off for this session', 5)
                quiet.write('memory-off-token\r')
                quiet.wait_visible('memory-off-token', 15)
                off_screen = quiet.visible()
                assert 'synthetic PR links' not in off_screen, off_screen
                quiet.write('/memory\r')
                quiet.wait_visible('session=off', 5)
                quiet.write('t')
                quiet.wait_visible('memory on for this session', 5)
                assert 'config.toml was not changed' in quiet.visible()
                quiet.write('\x1b')
                quiet.pump(0.3)
                assert saved[0].is_file()
            finally:
                quiet.write('\x11')
                quiet.pump(0.5)
                if quiet.process.poll() is None:
                    quiet.process.terminate()
                off.write_text(original_config)
            cleared = subprocess.run(
                [NODE, str(launcher), '--rust', 'memory', 'clear', '--workspace', '--yes'],
                cwd=cwd, env=base_env, capture_output=True, text=True, timeout=20)
            assert cleared.returncode == 0, cleared.stderr + cleared.stdout
            assert 'removed' in cleared.stdout
            assert not saved[0].exists()
            assert not sessions.exists()
            assert not (saved[0].parent / 'index.sqlite').exists()
        finally:
            session.write('\x11')
            session.pump(0.5)
            if session.process.poll() is None:
                session.process.terminate()
    print('rust-memory-pty-test: ok')


if __name__ == '__main__':
    main()
