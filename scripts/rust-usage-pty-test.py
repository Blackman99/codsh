#!/usr/bin/env python3
"""PTY: session usage and cost across surfaces (ticket 65 / #197).

Real dsh runs every parent and child turn; the keyless mock LLM
(e2e/fixtures/rust-acp-mock-llm.mjs, mode `subagents`) scripts the model and
DSH_CODE_CLI_MOCK_USAGE controls the provider usage reports (rich, none,
child-none). The explore subagent type runs on a second route
([subagents.models] explore = "narrow"), so the per-model rows are real.

Checked, all from one ledger folded from the dsh session logs:
/usage and /cost before and after a parent-child turn (input with cache
reads and writes, output with reasoning, total, calls, subagents, by model,
cost "not available (not reported by the provider)", never $0); the status
line command payload (session_usage, session_*_tokens, no total_cost_usd);
/session-info's usage line; `codsh --rust usage <id> [turn]` and its
errors; a resume that does not double count and then adds the new turn; a
headless fork that reports its own turn while its session totals keep the
inherited history; a
child from the earlier process read from the session store; an interrupted
turn counted as an unreported call; missing (none) and partial
(child-none) reports marked incomplete; and the headless json,
streaming-json, and streaming-messages-json results of the same data,
including a failed turn. No price table and no paid model is touched.

Runs on Linux and macOS against the repo launcher and the staged native
binary (run `pnpm run build:rust` first). It reuses the Session harness of
rust-screen-pty-test.py.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
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

CONFIG = """
[model.chat]
name = "Chat"
model = "cli-mock"
base_url = "http://127.0.0.1:1/v1"
env_key = "XAI_API_KEY"
api_backend = "chat_completions"
context_window = 128000

[model.narrow]
name = "Narrow"
model = "narrow"
base_url = "http://127.0.0.1:1/v1"
env_key = "XAI_API_KEY"
api_backend = "chat_completions"
context_window = 64000

[models]
default = "chat"

[subagents.models]
explore = "narrow"

[ui.status_line]
type = "command"
command = "{script}"
"""

# One parent-child turn with the rich reports: the parent makes two calls
# (spawn, then answer) on cli-mock, the explore child one call on narrow.
PARENT = {'in': 2 * 1340, 'uncached': 2 * 1000, 'cached': 2 * 300, 'write': 2 * 40, 'out': 2 * 200, 'reasoning': 2 * 50}
CHILD = {'in': 500, 'out': 100}
TURN_IN = PARENT['in'] + CHILD['in']
TURN_OUT = PARENT['out'] + CHILD['out']
TURN_TOTAL = TURN_IN + TURN_OUT


def group(n):
    return f'{n:,}'


def flat(text):
    return re.sub(r'\s+', ' ', text)


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


def wait_flat(session, needle, seconds=30):
    return wait_until(session, lambda shown: needle in flat(shown), f'missing {needle!r}', seconds)


def prompt(session, text):
    session.write(text)
    session.wait_visible(text[:20], 10)
    session.write(b'\r')


def usage_block(session, command='/usage'):
    session.send_slash(command)
    return flat(wait_flat(session, 'Not counted: auxiliary calls', 20))


def last_payload(path, predicate, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists():
            for line in reversed(path.read_text().splitlines()):
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if predicate(payload):
                    return payload
        time.sleep(0.2)
    raise AssertionError(f'no status-line payload matched in {path}:\n{path.read_text() if path.exists() else ""}')


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-usage-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-rust-usage-home-', dir='/tmp') as temporary:
        work = Path(temporary).resolve()
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        grok = home / '.codsh-rust' / '.grok'
        grok.mkdir(parents=True)
        payloads = work / 'status-payloads.jsonl'
        script = grok / 'statusline.sh'
        script.write_text(f'#!/bin/sh\nread -r line\nprintf "%s\\n" "$line" >> "{payloads}"\necho USAGE_STATUS_OK\n')
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        (grok / 'config.toml').write_text(CONFIG.replace('{script}', str(script)))
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'subagents', 'DSH_CODE_CLI_MOCK_USAGE': 'rich',
        }

        def cli(*args, extra_env=None):
            return subprocess.run([NODE, str(LAUNCHER), '--rust', *args], cwd=cwd,
                                  env={**env, **(extra_env or {})}, capture_output=True, text=True, timeout=120)

        # 1. A fresh session: empty ledger, one parent-child turn, every surface.
        session = Session('usage', LAUNCHER, cwd, env, output,
                          extra=['--fullscreen', '--trust', '--always-approve'], cols=180, rows=50)
        try:
            session.wait_visible('Connected to dsh ACP', 30)
            session.send_slash('/usage')
            wait_flat(session, 'Session usage: no model calls yet in this session.', 20)
            prompt(session, 'SPAWN:explore:MODEL')
            wait_flat(session, 'PARENT_DONE', 40)
            text = usage_block(session)
            assert 'Session usage (whole dsh session log, subagents included):' in text, text
            assert f'Input tokens: {group(TURN_IN)} ({group(PARENT["cached"])} cached, {group(PARENT["write"])} cache writes)' in text, text
            assert f'Output tokens: {group(TURN_OUT)} ({group(PARENT["reasoning"])} reasoning)' in text, text
            assert f'Total tokens: {group(TURN_TOTAL)} · Model calls: 3 · API time: ' in text, text
            assert 'Cost: not available (not reported by the provider)' in text, text
            assert 'Subagents: 1 session · 1 call · 600 tokens' in text, text
            assert f'cli-mock/cli-mock {group(PARENT["in"])} in / {group(PARENT["out"])} out (cost unknown)' in text, text
            assert 'cli-mock/narrow 500 in / 100 out (cost unknown)' in text, text
            assert '$0' not in text and 'incomplete' not in text, text
            results['usage'] = True
            cost = usage_block(session, '/cost')
            assert f'Total tokens: {group(TURN_TOTAL)}' in cost, cost
            results['cost_alias'] = True
            payload = last_payload(payloads, lambda item: 'session_usage' in item)
            assert payload['session_usage'] == {
                'input_tokens': PARENT['uncached'] + CHILD['in'], 'output_tokens': TURN_OUT,
                'cache_creation_input_tokens': PARENT['write'], 'cache_read_input_tokens': PARENT['cached'],
            }, payload
            assert payload['context_window']['session_input_tokens'] == TURN_IN, payload
            assert payload['context_window']['session_output_tokens'] == TURN_OUT, payload
            assert 'total_cost_usd' not in payload.get('cost', {}), payload
            assert payload['cost']['total_api_duration_ms'] >= 0, payload
            results['status_line'] = True
            session.send_slash('/session-info')
            info = flat(wait_flat(session, 'Usage: ' + group(TURN_TOTAL), 20))
            assert (f'Usage: {group(TURN_TOTAL)} tokens ({group(TURN_IN)} in / {group(TURN_OUT)} out) · 3 model calls · '
                    'cost not available (not reported by the provider) · subagents 1 session') in info, info
            results['session_info'] = True
            # The status row runs the payload-logging command, so read the id
            # from the /session-info card.
            session_id = re.search(r'Session ID: ([0-9a-f-]{8,})', info).group(1)
            results['first'] = session.finish(expect_alt_leave=True)['exit']
        finally:
            session.close()

        # 2. The offline reader shows the same numbers, per session and per turn.
        shown = cli('usage', session_id)
        assert shown.returncode == 0, shown.stderr
        ledger = json.loads(shown.stdout)
        assert ledger['sessionId'] == session_id
        assert ledger['session']['totalTokens'] == TURN_TOTAL, ledger['session']
        assert ledger['session']['costUsdTicks'] is None and ledger['session']['costStatus'] == 'unknown'
        assert [row['turnNumber'] for row in ledger['turns']] == [1], ledger['turns']
        turn = json.loads(cli('usage', session_id, '1').stdout)
        assert turn['turnNumber'] == 1 and turn['modelCalls'] == 3 and turn['numTurns'] == 2, turn
        missing = cli('usage', 'no-such-session')
        assert missing.returncode != 0 and "Session 'no-such-session' not found." in missing.stderr, missing.stderr
        bad_turn = cli('usage', session_id, '9')
        assert bad_turn.returncode != 0 and f"Turn 9 not found in session '{session_id}'." in bad_turn.stderr, bad_turn.stderr
        results['cli'] = True

        # 3. Resume: nothing is counted twice; the child of the first process
        # comes from the session store; a new turn adds; an interrupted turn
        # is an unreported call.
        resumed = Session('usage-resume', LAUNCHER, cwd, {**env, 'DSH_CODE_CLI_MOCK_DELAY_MS': '0'}, output,
                          extra=['--fullscreen', '--trust', '--always-approve', '--resume', session_id], cols=180, rows=50)
        try:
            resumed.wait_visible('Connected to dsh ACP', 30)
            text = usage_block(resumed)
            assert f'Total tokens: {group(TURN_TOTAL)}' in text and 'Subagents: 1 session' in text, text
            assert 'incomplete' not in text, text
            prompt(resumed, 'SPAWN:explore:ECHO')
            wait_until(resumed, lambda shown: flat(shown).count('PARENT_DONE') >= 2, 'second PARENT_DONE', 40)
            text = usage_block(resumed)
            assert f'Total tokens: {group(2 * TURN_TOTAL)}' in text, text
            assert 'Model calls: 6 ·' in text and 'Subagents: 2 sessions · 2 calls · 1,200 tokens' in text, text
            results['resume'] = True
            results['second'] = resumed.finish(expect_alt_leave=True)['exit']
        finally:
            resumed.close()
        slow = Session('usage-cancel', LAUNCHER, cwd, {**env, 'DSH_CODE_CLI_MOCK_DELAY_MS': '8000'}, output,
                       extra=['--fullscreen', '--trust', '--always-approve', '--resume', session_id], cols=180, rows=50)
        try:
            slow.wait_visible('Connected to dsh ACP', 30)
            prompt(slow, 'SPAWN:explore:ECHO')
            slow.wait_visible('Streaming turn', 15)
            slow.write(b'\x03')
            slow.wait_visible('[cancelled]', 20)
            text = usage_block(slow)
            assert f'Total tokens: {group(2 * TURN_TOTAL)}' in text, text
            assert 'Model calls: 7 ·' in text, text
            assert 'Note: usage is incomplete and may under-count. (1 model call reported no token usage)' in text, text
            payload = last_payload(payloads, lambda item: item.get('session_id') == session_id
                                   and item.get('context_window', {}).get('session_input_tokens') == 2 * TURN_IN)
            assert 'total_cost_usd' not in payload.get('cost', {}), payload
            results['interrupted'] = True
            results['third'] = slow.finish(expect_alt_leave=True)['exit']
        finally:
            slow.close()
        rows = json.loads(cli('usage', session_id).stdout)['turns']
        assert [row['turnNumber'] for row in rows] == [1, 2, 3], rows
        assert rows[2]['endReason'] == 'aborted' and rows[2]['usageIsIncomplete'] is True, rows[2]
        assert rows[2]['totalTokens'] == 0 and rows[2]['unreportedCalls'] == 1, rows[2]

        # 4. Missing and partial provider reports.
        silent = Session('usage-none', LAUNCHER, cwd, {**env, 'DSH_CODE_CLI_MOCK_USAGE': 'none'}, output,
                         extra=['--fullscreen', '--trust', '--always-approve'], cols=180, rows=50)
        try:
            silent.wait_visible('Connected to dsh ACP', 30)
            prompt(silent, 'SPAWN:explore:ECHO')
            wait_flat(silent, 'PARENT_DONE', 40)
            text = usage_block(silent)
            assert 'Tokens: not reported by the provider (3 model calls)' in text, text
            assert 'Input tokens' not in text and '$0' not in text, text
            assert '(3 model calls reported no token usage)' in text, text
            results['missing'] = True
            silent.finish(expect_alt_leave=True)
        finally:
            silent.close()
        partial = Session('usage-partial', LAUNCHER, cwd, {**env, 'DSH_CODE_CLI_MOCK_USAGE': 'child-none'}, output,
                          extra=['--fullscreen', '--trust', '--always-approve'], cols=180, rows=50)
        try:
            partial.wait_visible('Connected to dsh ACP', 30)
            prompt(partial, 'SPAWN:explore:ECHO')
            wait_flat(partial, 'PARENT_DONE', 40)
            text = usage_block(partial)
            assert f'Total tokens: {group(PARENT["in"] + PARENT["out"])}' in text, text
            assert 'Subagents: 1 session · 1 call · 0 tokens' in text, text
            assert 'Note: usage is incomplete and may under-count. (1 model call reported no token usage)' in text, text
            results['partial'] = True
            partial.finish(expect_alt_leave=True)
        finally:
            partial.close()

        # 5. Headless: the same fold for the turns the prompt started.
        def headless(fmt, extra_env=None, prompt_text='SPAWN:explore:MODEL', *more):
            return cli('--trust', '--always-approve', '-p', prompt_text, '--output-format', fmt, *more, extra_env=extra_env)

        body = json.loads(headless('json').stdout)
        assert body['usage'] == {
            'input_tokens': PARENT['uncached'] + CHILD['in'], 'cache_read_input_tokens': PARENT['cached'],
            'cache_creation_input_tokens': PARENT['write'], 'output_tokens': TURN_OUT,
            'reasoning_tokens': PARENT['reasoning'], 'total_tokens': TURN_TOTAL,
        }, body
        assert body['modelUsage']['cli-mock/narrow'] == {
            'inputTokens': 500, 'outputTokens': 100, 'cacheReadInputTokens': 0, 'cacheCreationInputTokens': 0, 'modelCalls': 1,
        }, body
        assert body['num_turns'] == 2 and body['cost_status'] == 'unknown', body
        for key in ('total_cost_usd', 'total_cost_usd_ticks', 'usage_absent', 'usage_is_incomplete'):
            assert key not in body, body
        followed = json.loads(cli('--trust', '--always-approve', '-c', '-p', 'SPAWN:explore:ECHO', '--output-format', 'json').stdout)
        assert followed['usage']['total_tokens'] == TURN_TOTAL, followed
        # A fork: the prompt reports only its own turn; the fork's session
        # totals keep the inherited history (reference `usage` rule).
        forked = json.loads(cli('--trust', '--always-approve', '--resume', followed['sessionId'], '--fork-session',
                                '-p', 'SPAWN:explore:ECHO', '--output-format', 'json').stdout)
        assert forked['sessionId'] != followed['sessionId'], forked
        assert forked['usage']['total_tokens'] == TURN_TOTAL, forked
        fork_ledger = json.loads(cli('usage', forked['sessionId']).stdout)
        assert fork_ledger['session']['totalTokens'] == 3 * TURN_TOTAL, fork_ledger['session']
        results['fork'] = True
        events = [json.loads(line) for line in headless('streaming-json').stdout.splitlines() if line.strip()]
        assert events[-1]['type'] == 'end' and events[-1]['usage']['total_tokens'] == TURN_TOTAL, events[-1]
        messages = [json.loads(line) for line in headless('streaming-messages-json').stdout.splitlines() if line.strip()]
        result = messages[-1]
        assert result['type'] == 'result' and result['num_turns'] == 2, result
        assert result['usage']['total_tokens'] == TURN_TOTAL and 'total_cost_usd' not in result, result
        partial_body = json.loads(headless('json', {'DSH_CODE_CLI_MOCK_USAGE': 'child-none'}).stdout)
        assert partial_body['usage_is_incomplete'] is True and partial_body['usage']['total_tokens'] == PARENT['in'] + PARENT['out'], partial_body
        none_body = json.loads(headless('json', {'DSH_CODE_CLI_MOCK_USAGE': 'none'}).stdout)
        assert 'usage' not in none_body and none_body['usage_is_incomplete'] is True, none_body
        failed = cli('--trust', '-p', 'hello', '--output-format', 'json', extra_env={'DSH_CODE_CLI_MOCK_TOOL': 'fail-stream'})
        assert failed.returncode != 0
        failed_body = json.loads(failed.stdout)
        assert failed_body['type'] == 'error' and failed_body['usage_is_incomplete'] is True, failed_body
        assert 'usage' not in failed_body and 'total_cost_usd' not in failed_body, failed_body
        results['headless'] = True
    print(json.dumps({'output': str(output), **results}, indent=2))


if __name__ == '__main__':
    main()
