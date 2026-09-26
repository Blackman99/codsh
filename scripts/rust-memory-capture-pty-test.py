#!/usr/bin/env python3
"""PTY: memory capture, Dream consolidation and diagnostics (ticket 54 / #186).

Real dsh runs every turn and every background memory request; the keyless
mock LLM (e2e/fixtures/rust-acp-mock-llm.mjs) answers the flush and Dream
prompts by listing the MEM_* tokens it received, so each check follows a
token from a typed prompt into a session log, into MEMORY.md, and into the
first request of a later session. Everything lives in an isolated home; no
real ~/.grok and no paid model is touched.

Checked: /flush writes and then appends a delta to the daily session log and
names the route, what was sent and the token usage; /memory then s shows
content-free diagnostics and y copies them; quitting saves the session-end
summary (3 prompts, 50 bytes, no model call); after --continue the first
/flush is a delta against the last flush on disk; a conversational first
prompt recalls a session log before any Dream; /dream refuses a second run
while one is running (the refusal clears with the next notice), keeps a
MEMORY.md edited while it ran, then merges the logs and keeps the previous
version in sessions/.archive/; /new cancels a running Dream and leaves the
gate open; the automatic Dream at launch and the
idle flush run under low configured gates; the next session's first request
carries the consolidated memory. Plain -p runs cover --memory-flush success,
nothing to store, a model failure, [memory_v2] refusal (and no unknown-field
warning from inspect) and GROK_MEMORY_LOG.

Runs on Linux and macOS against the repo launcher and the staged native
binary (run `pnpm run build:rust` first). It reuses the Session harness of
rust-screen-pty-test.py.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
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


def wait_until(session, predicate, what, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump()
        shown = session.visible()
        if predicate(shown):
            return shown
        if session.process.poll() is not None:
            break
    raise AssertionError(f'{session.name}: {what}\n{session.visible()}')


def prompt(session, text):
    session.write(text)
    session.wait_visible(text[:20], 10)
    session.write(b'\r')


def ask(session, text):
    """Send a prompt and wait for the mock's echo of it."""
    prompt(session, text)
    def answered(shown):
        tail = flat(shown).rpartition('RUST_ACP_ANSWER ')[2]
        return 'latest=' in tail and text[:30] in tail.partition('latest=')[2]
    return wait_until(session, answered, f'no answer to {text!r}', 30)


def flat(text):
    """The screen wraps long hints; compare without line breaks."""
    return re.sub(r'\s+', ' ', text)


def wait_flat(session, needle, seconds=30):
    return wait_until(session, lambda shown: needle in flat(shown), f'missing {needle!r}', seconds)


def quit_session(session):
    session.write(b'\x11')
    deadline = time.monotonic() + 15
    while session.process.poll() is None and time.monotonic() < deadline:
        session.pump(0.15)
    assert session.process.poll() is not None, f'{session.name}: quit hung'


def write_config(grok, body):
    grok.mkdir(parents=True, exist_ok=True)
    (grok / 'config.toml').write_text(body)


BASE_CONFIG = '[memory]\nenabled = true\n[memory.dream]\ncheck_interval_secs = 0\n[compaction.memory_flush]\nidle_timeout_secs = 0\n'


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-memory-capture-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-memory-capture-home-', dir='/tmp') as temporary:
        work = Path(temporary).resolve()
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        (cwd / '.git').mkdir(parents=True)
        (cwd / '.git' / 'config').write_text('[remote "origin"]\n\turl = https://github.com/Example/Capture.git\n')
        grok = home / '.codsh-rust' / '.grok'
        write_config(grok, BASE_CONFIG)
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
        }
        memory_root = grok / 'memory'

        def workspace_dir():
            found = [path for path in memory_root.iterdir() if path.is_dir() and 'capture' in path.name]
            assert len(found) == 1, found
            return found[0]

        # 1. Flush, delta flush, diagnostics, and the session-end summary.
        session = Session('capture', LAUNCHER, cwd, env, output,
                          extra=['--fullscreen', '--trust'], cols=160, rows=46)
        try:
            session.wait_visible('Connected to dsh ACP', 30)
            ask(session, 'MEM_ALPHA the widget service listens on port 7431')
            ask(session, 'MEM_BRAVO restart it with make serve')
            session.write('/flush\r')
            shown = wait_flat(session, 'Memory flushed:', 30)
            text = flat(shown)
            assert re.search(r'sent \d+ messages / [\d,]+ chars to ', text), text
            assert ' · tokens in ' in text and 'cost not reported' in text, text
            assert 'appended to sessions/' in text, text
            sessions = workspace_dir() / 'sessions'
            flushed = sorted(sessions.glob('*-user_requested-*.md'))
            assert len(flushed) == 1, flushed
            body = flushed[0].read_text()
            assert body.startswith('## Decisions\n- MOCK_FLUSH') and 'delta=false' in body, body
            assert 'MEM_ALPHA' in body and 'MEM_BRAVO' in body, body
            ask(session, 'MEM_CHARLIE the cache lives in var cache')
            session.write('/flush\r')
            wait_until(session, lambda s: flushed[0].read_text().count('<!-- flush ') == 1, 'second flush', 30)
            body = flushed[0].read_text()
            assert 'delta=true' in body and 'MEM_CHARLIE' in body, body
            results['flush'] = True

            session.write('/memory\r')
            session.wait_visible('Memory', 10)
            session.write('s')
            shown = wait_flat(session, 'Memory diagnostics (content-free', 10)
            text = flat(shown)
            for field in ('capture cursor:', 'queue:', 'gate:', 'lease: free', 'last flush: written',
                          'running: none', 'archive: 0 consolidated session logs', 'memory log: off'):
                assert field in text, (field, text)
            for secret in ('MEM_', str(home), 'widget'):
                assert secret not in text, (secret, text)
            session.write('y')
            wait_flat(session, 'copied memory diagnostics', 10)
            session.write('\x1b')
            session.pump(0.3)
            session.write('\x1b')
            session.pump(0.3)
            results['diagnostics'] = True
        finally:
            quit_session(session)
            (output / 'capture.ansi').write_bytes(session.data)
            session.close()
        summaries = [path for path in sessions.glob('*.md') if 'user_requested' not in path.name]
        assert len(summaries) == 1, list(sessions.iterdir())
        summary = summaries[0].read_text()
        assert re.search(r'-mem-alpha-the-widget-service-l-[0-9a-f]{8}\.md$', summaries[0].name), summaries[0].name
        assert summary.startswith('## Session Summary\n\n- **Messages:** 3 user, 3 assistant, 0 tool results\n'), summary
        assert '## Topics Discussed\n\n1. MEM_ALPHA the widget service listens on port 7431\n' in summary, summary
        results['session_end'] = True

        # 1b. Restart with --continue: the first /flush is a delta against the
        # last flush on disk, not a full resend (issue #186 follow-up).
        session = Session('resumed', LAUNCHER, cwd, {**env, 'GROK_MEMORY_LOG': '1'}, output,
                          extra=['--fullscreen', '--trust', '--continue'], cols=160, rows=46)
        try:
            session.wait_visible('Connected to dsh ACP', 30)
            ask(session, 'MEM_JULIET the queue is redis seven')
            session.write('/flush\r')
            wait_until(session, lambda s: flushed[0].read_text().count('<!-- flush ') == 2, 'resumed flush', 30)
            last = flushed[0].read_text().rpartition('<!-- flush ')[2]
            assert 'delta=true' in last and 'MEM_JULIET' in last, last
            log = (grok / 'logs' / 'memory.log').read_text()
            assert 'flush.start trigger=user_requested delta=true' in log, log
            assert 'delta=false' not in log, log
            results['resumed_flush'] = True
        finally:
            quit_session(session)
            (output / 'resumed.ansi').write_bytes(session.data)
            session.close()
        (grok / 'logs' / 'memory.log').unlink()

        # 1c. Recall before any Dream: a conversational first prompt pulls the
        # session log that shares only some of its words (keywords OR'ed).
        assert not (workspace_dir() / 'MEMORY.md').exists()
        session = Session('recall', LAUNCHER, cwd, env, output,
                          extra=['--fullscreen', '--trust'], cols=160, rows=46)
        try:
            session.wait_visible('Connected to dsh ACP', 30)
            shown = ask(session, 'Which port does the widget service listen on?')
            text = flat(shown)
            assert 'MEM_ALPHA' in text, text
            results['recall_before_dream'] = True
        finally:
            quit_session(session)
            (output / 'recall.ansi').write_bytes(session.data)
            session.close()

        # 2. /dream: busy, a concurrent manual edit kept, then a merge; /new cancels.
        memory_file = workspace_dir() / 'MEMORY.md'
        memory_file.write_text('# Project\n- MEM_OLD first fact\n')
        slow = {**env, 'DSH_CODE_CLI_MOCK_MEMORY_DELAY_MS': '2500'}
        session = Session('dream', LAUNCHER, cwd, slow, output,
                          extra=['--fullscreen', '--trust'], cols=160, rows=46)
        try:
            session.wait_visible('Connected to dsh ACP', 30)
            ask(session, 'hello dream session')
            session.write('/dream\r')
            wait_flat(session, 'Dream running: workspace MEMORY.md and 2 session logs', 10)
            session.write('/dream\r')
            wait_flat(session, 'Dream is already running; try again when it finishes.', 10)
            assert (workspace_dir() / '.dream-mutex').exists()
            memory_file.write_text('# Project\n- MEM_OLD first fact\n- MEM_MANUAL my own edit\n')
            shown = wait_flat(session, 'Dream not written: MEMORY.md changed while Dream ran; your edit was kept', 20)
            # The busy refusal is retired by the next memory notice.
            assert 'Dream is already running' not in flat(shown), flat(shown)
            assert memory_file.read_text() == '# Project\n- MEM_OLD first fact\n- MEM_MANUAL my own edit\n'
            assert not (workspace_dir() / '.dream-consolidated').exists()
            assert not (workspace_dir() / '.dream-mutex').exists()
            session.write('/dream\r')
            shown = wait_flat(session, 'Dream completed: MEMORY.md rewritten', 20)
            text = flat(shown)
            assert 'from 2 session logs; 0 archived; previous version kept in sessions/.archive/MEMORY-before-dream-' in text, text
            merged = memory_file.read_text()
            assert merged.startswith('## Consolidated\n- MOCK_DREAM sessions=2 merged=true'), merged
            for token in ('MEM_ALPHA', 'MEM_BRAVO', 'MEM_CHARLIE', 'MEM_MANUAL', 'MEM_OLD'):
                assert token in merged, (token, merged)
            backups = list((workspace_dir() / 'sessions' / '.archive').glob('MEMORY-before-dream-*.md'))
            assert len(backups) == 1 and 'MEM_MANUAL' in backups[0].read_text(), backups
            marker = workspace_dir() / '.dream-consolidated'
            assert marker.exists() and not (workspace_dir() / '.dream-mutex').exists()
            results['dream'] = True
            stamp = marker.stat().st_mtime
            session.write('/dream\r')
            wait_flat(session, 'Dream running', 10)
            session.write('/new\r')
            wait_flat(session, 'Dream cancelled.', 15)
            assert not (workspace_dir() / '.dream-mutex').exists()
            assert marker.stat().st_mtime == stamp, 'a cancelled Dream moved the gate'
            assert memory_file.read_text() == merged
            results['cancel'] = True
        finally:
            quit_session(session)
            (output / 'dream.ansi').write_bytes(session.data)
            session.close()

        # 3. Automatic Dream at launch, idle flush, and cross-session use.
        (workspace_dir() / '.dream-consolidated').unlink()
        old = workspace_dir() / 'sessions' / '2026-01-01-older-log-aaaaaaaa.md'
        old.write_text('## Older\n- MEM_DELTA deploys go through staging\n')
        long_ago = time.time() - 7200
        os.utime(old, (long_ago, long_ago))
        write_config(grok, '[memory]\nenabled = true\n[memory.dream]\nmin_hours = 0\nmin_sessions = 1\ncheck_interval_secs = 0\n'
                     '[compaction.memory_flush]\nidle_timeout_secs = 2\n')
        session = Session('later', LAUNCHER, cwd, env, output,
                          extra=['--fullscreen', '--trust'], cols=160, rows=46)
        try:
            session.wait_visible('Connected to dsh ACP', 30)
            shown = wait_flat(session, 'Dream completed: MEMORY.md rewritten', 30)
            assert '1 archived' in flat(shown), flat(shown)
            merged = (workspace_dir() / 'MEMORY.md').read_text()
            assert 'MEM_DELTA' in merged and 'MEM_ALPHA' in merged, merged
            assert not old.exists() and (workspace_dir() / 'sessions' / '.archive' / old.name).exists()
            results['auto_dream'] = True
            # The first request of this session carries the consolidated memory.
            shown = ask(session, 'which port does the widget service use')
            text = flat(shown)
            assert 'MOCK_DREAM' in text and 'MEM_DELTA' in text, text
            results['cross_session'] = True
            wait_until(session, lambda s: any(workspace_dir().glob('sessions/*-interval-*.md')), 'idle flush', 20)
            wait_flat(session, 'Memory flushed:', 10)
            results['idle_flush'] = True
        finally:
            quit_session(session)
            (output / 'later.ansi').write_bytes(session.data)
            session.close()

        # 4. Plain -p runs: --memory-flush, failures, memory_v2 and GROK_MEMORY_LOG.
        write_config(grok, BASE_CONFIG)

        def plain(*args, extra_env=None):
            return subprocess.run([NODE, str(LAUNCHER), '--rust', '--trust', *args], cwd=cwd,
                                  env={**env, **(extra_env or {})}, capture_output=True, text=True, timeout=120)

        done = plain('-p', 'MEM_ECHO plain fact to keep', '--memory-flush')
        assert done.returncode == 0, (done.stdout, done.stderr)
        assert 'Memory flushed:' in done.stderr, done.stderr
        assert any('MEM_ECHO' in path.read_text() for path in workspace_dir().glob('sessions/*-user_requested-*.md'))
        nothing = plain('-p', 'hello there', '--memory-flush', extra_env={'DSH_CODE_CLI_MOCK_MEMORY': 'noreply'})
        assert nothing.returncode == 1 and 'memory flush skipped: Memory flush: nothing new worth keeping' in nothing.stderr, nothing.stderr
        failed = plain('-p', 'MEM_FOX', '--memory-flush', extra_env={'DSH_CODE_CLI_MOCK_MEMORY': 'fail'})
        assert failed.returncode == 1 and 'memory flush skipped: Memory flush failed: memory model failed' in failed.stderr, failed.stderr
        bare = plain('--memory-flush')
        assert bare.returncode != 0 and '--memory-flush without a prompt requires --resume/-r or --continue/-c' in bare.stderr, bare.stderr
        blocked = work / 'not-a-dir'
        blocked.write_text('x')
        warned = plain('-p', 'MEM_GOLF', '--memory-flush', extra_env={'GROK_MEMORY_LOG': str(blocked / 'memory.log')})
        assert 'GROK_MEMORY_LOG: cannot write' in warned.stderr, warned.stderr
        logged = plain('-p', 'MEM_HOTEL secret words', '--memory-flush', extra_env={'GROK_MEMORY_LOG': '1'})
        assert logged.returncode == 0, logged.stderr
        log = (grok / 'logs' / 'memory.log').read_text()
        assert 'flush.start trigger=user_requested' in log and 'flush.done trigger=user_requested outcome=written' in log, log
        assert 'MEM_' not in log and 'secret' not in log, log
        results['plain'] = True
        write_config(grok, BASE_CONFIG + '[memory_v2]\nenabled = true\n')
        refused = plain('-p', 'MEM_INDIA', '--memory-flush')
        assert refused.returncode == 1 and '[memory_v2] enabled = true selects the reference v2 store' in refused.stderr, refused.stderr
        assert not (memory_root / 'memory-v2').exists() and not (grok / 'memory-v2').exists()
        inspected = plain('inspect')
        assert 'unknown security/policy field' not in inspected.stdout + inspected.stderr, inspected.stdout + inspected.stderr
        results['memory_v2'] = True
    print(json.dumps({'output': str(output), **results}, indent=2))


if __name__ == '__main__':
    main()
