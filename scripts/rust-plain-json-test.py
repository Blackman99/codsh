#!/usr/bin/env python3
"""Installed headless JSON: real dsh, no TTY, provider fixture only.

Consumes every public --output-format of the pinned reference (plain, json,
streaming-json, streaming-messages-json), including --include-partial-messages.
Stdout lines that claim to be JSON must parse. Spend fields appear only when
dsh sent them. Logs stay on stderr.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
# num_turns on streaming-messages-json is the assistant-frame count, the
# documented fallback when dsh sent no usage ledger. It is not a bill.
SPEND_KEYS = (
    'usage', 'modelUsage', 'total_cost_usd', 'total_cost_usd_ticks',
    'cost_is_partial', 'usage_is_incomplete', 'costUSD', 'total_cost',
)


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


def dsh_bin():
    located = subprocess.run(
        ['node', '-e', "console.log(require('fs').realpathSync(require('child_process').execFileSync('which',['dsh']).toString().trim()))"],
        capture_output=True, text=True,
    )
    if located.returncode == 0 and located.stdout.strip():
        return located.stdout.strip()
    script = (
        "import { createRequire } from 'node:module'; import { dirname, join } from 'node:path';"
        " import { readFileSync } from 'node:fs'; const r=createRequire(process.argv[1]);"
        " const m=r.resolve('@deepseek-ai/dsh/package.json');"
        " const bin=JSON.parse(readFileSync(m,'utf8')).bin;"
        " process.stdout.write(join(dirname(m), typeof bin==='string'?bin:bin.dsh))"
    )
    return run([NODE, '--input-type=module', '-e', script, str(ROOT / 'package.json')], cwd=ROOT).stdout


def overlay_text():
    return run(
        [NODE, '--input-type=module', '-e',
         "import { rustAcpOverlay } from './scripts/rust-acp-overlay.mjs'; process.stdout.write(rustAcpOverlay())"],
        cwd=ROOT,
    ).stdout


def plain(launcher, cwd, env, args, timeout=45):
    return subprocess.run(
        [NODE, str(launcher), '--rust', *args],
        cwd=cwd, env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=timeout,
    )


def start_plain(launcher, cwd, env, args):
    return subprocess.Popen(
        [NODE, str(launcher), '--rust', *args],
        cwd=cwd, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, text=True,
    )


def lines_of(text):
    return [line for line in text.splitlines() if line.strip()]


def parse_ndjson(stdout, label):
    parsed = []
    for index, line in enumerate(lines_of(stdout), start=1):
        try:
            parsed.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise AssertionError(f'{label} line {index} is not JSON: {line!r} ({error})') from error
    return parsed


def assert_no_log_on_stdout(stdout, label):
    lowered = stdout.lower()
    for marker in ('connecting to dsh', 'rust startup', 'acp connection', 'warning:'):
        assert marker not in lowered, f'{label} mixed a log into stdout: {stdout[:400]!r}'


def assert_spend_absent(value, label):
    if isinstance(value, dict):
        for key in SPEND_KEYS:
            assert key not in value, f'{label} invented {key}: {value}'
        for child in value.values():
            assert_spend_absent(child, label)
    elif isinstance(value, list):
        for child in value:
            assert_spend_absent(child, label)


def session_prompts(home, dsh, cwd):
    listed = run([
        NODE, str(ROOT / 'packages/cli/bin/rust-acp-session-read.mjs'), '--list',
    ], env={
        'DSH_HOME': str(home / '.codsh-rust' / 'dsh'),
        'DSH_BIN': dsh,
        'PATH': os.environ['PATH'],
    })
    catalog = json.loads(listed.stdout)
    here = [
        session for session in catalog.get('sessions', [])
        if str(cwd) in str(session.get('cwd', ''))
    ]
    return here


def main():
    failures = []

    def check(name, fn):
        try:
            fn()
        except Exception as error:  # noqa: BLE001 - report every consumer failure
            failures.append(f'{name}: {error}')
            print(f'FAIL {name}: {error}', file=sys.stderr)
        else:
            print(f'ok {name}')

    output = Path(tempfile.mkdtemp(prefix='codsh-146-json-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-146-json-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        project = work / 'project'
        project.mkdir()
        (project / 'note.txt').write_text('PLAIN_NOTE\n')
        pack_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'],
            'npm_config_cache': str(work / 'npm-cache'),
            'npm_config_userconfig': str(work / 'empty-user.npmrc'),
            'npm_config_globalconfig': str(work / 'empty-global.npmrc'),
            'npm_config_update_notifier': 'false',
        }
        pack = json.loads(run(
            ['npm', 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', str(work)],
            cwd=ROOT / 'packages/cli', env=pack_env,
        ).stdout)[0]['filename']
        prefix = work / 'installed'
        run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline',
             '--no-audit', '--no-fund', str(work / pack)], env=pack_env)
        launcher = prefix / 'node_modules/.bin/codsh'
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        base = {
            'HOME': str(home), 'PATH': os.environ['PATH'],
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
        }

        def env(mode, **extra):
            return {**base, 'DSH_CODE_CLI_MOCK_TOOL': mode, **extra}

        def case_plain_text():
            result = plain(launcher, project, env('echo'), ['-p', 'PLAIN_TOKEN', '--output-format', 'plain'])
            assert result.returncode == 0, result.stderr
            assert 'PLAIN_TOKEN' in result.stdout
            assert result.stdout.endswith('\n')
            json.loads  # plain is not JSON
            with_default = plain(launcher, project, env('echo'), ['-p', 'PLAIN_DEFAULT'])
            assert with_default.returncode == 0, with_default.stderr
            assert 'PLAIN_DEFAULT' in with_default.stdout
            assert '\n{' not in with_default.stdout

        def case_json_object():
            result = plain(launcher, project, env('echo'), ['-p', 'JSON_TOKEN', '--output-format', 'json'])
            assert result.returncode == 0, result.stderr
            assert_no_log_on_stdout(result.stdout, 'json')
            body = json.loads(result.stdout)
            assert isinstance(body, dict)
            assert 'JSON_TOKEN' in body['text']
            assert body['stopReason'] == 'end_turn'
            assert body['sessionId']
            assert body['requestId']
            assert 'thought' not in body
            assert_spend_absent(body, 'json echo')
            assert 'usage_absent' in body and body['usage_absent'] is True
            assert 'Connecting' not in result.stdout
            # Diagnostics, if any, stay off the JSON object.
            assert result.stderr == '' or 'JSON_TOKEN' not in result.stderr

        def case_json_reasoning_and_tools():
            reasoned = plain(launcher, project, env('reasoning'),
                             ['-p', 'think', '--output-format', 'json'])
            assert reasoned.returncode == 0, reasoned.stderr
            body = json.loads(reasoned.stdout)
            assert 'RUST_ACP_ANSWER' in body['text']
            assert body.get('thought') and 'RUST_ACP_THOUGHT' in body['thought']
            assert_spend_absent(body, 'json reasoning')
            tool_dir = work / 'json-tool'
            tool_dir.mkdir()
            (tool_dir / 'note.txt').write_text('alpha\n')
            edited = plain(launcher, tool_dir, env('file-edit'),
                           ['-p', 'edit the note', '--output-format', 'json', '--always-approve'])
            assert edited.returncode == 0, edited.stderr
            edited_body = json.loads(edited.stdout)
            assert 'RUST_ACP_FILE_DONE' in edited_body['text']
            assert (tool_dir / 'note.txt').read_text() == 'ALPHA\n'
            assert_spend_absent(edited_body, 'json tool')

        def case_streaming_json_order():
            stream_dir = work / 'stream-tool'
            stream_dir.mkdir()
            (stream_dir / 'note.txt').write_text('alpha\n')
            result = plain(
                launcher, stream_dir, env('file-edit'),
                ['-p', 'edit the note', '--output-format', 'streaming-json', '--always-approve'],
            )
            assert result.returncode == 0, result.stderr
            assert_no_log_on_stdout(result.stdout, 'streaming-json')
            events = parse_ndjson(result.stdout, 'streaming-json')
            kinds = [event['type'] for event in events]
            assert kinds[-1] == 'end', kinds
            call = next(event for event in events if event['type'] == 'tool_call' and event.get('toolName') == 'edit')
            assert call['rawInput']['file_path'] == 'note.txt'
            assert call['rawInput']['old_string'] == 'alpha'
            assert call['rawInput']['new_string'] == 'ALPHA'
            assert call['toolCallId']
            update = next(event for event in events
                          if event['type'] == 'tool_call_update' and event['toolCallId'] == call['toolCallId'])
            assert update['status'] == 'completed'
            assert 'ALPHA' in json.dumps(update.get('content')) or 'updated' in json.dumps(update).lower()
            text = ''.join(event['data'] for event in events if event['type'] == 'text')
            assert 'RUST_ACP_FILE_DONE' in text
            end = events[-1]
            assert end['stopReason'] == 'end_turn'
            assert end['sessionId'] and end['requestId']
            assert_spend_absent(events, 'streaming-json')
            assert kinds.index('tool_call') < kinds.index('tool_call_update') < kinds.index('text') < len(kinds) - 1
            assert (stream_dir / 'note.txt').read_text() == 'ALPHA\n'

        def case_streaming_messages():
            message_dir = work / 'messages-tool'
            message_dir.mkdir()
            (message_dir / 'note.txt').write_text('alpha\n')
            result = plain(
                launcher, message_dir, env('reasoning'),
                ['-p', 'REASON_TOKEN', '--output-format', 'streaming-messages-json'],
            )
            assert result.returncode == 0, result.stderr
            events = parse_ndjson(result.stdout, 'streaming-messages-json')
            assert events[0]['type'] == 'system' and events[0]['subtype'] == 'init', events[0]
            assert events[0]['session_id']
            assert events[0]['cwd']
            # dsh does not advertise available_commands on this client. The
            # list is present and empty; names are not invented.
            assert events[0]['tools'] == []
            assert events[0]['slash_commands'] == []
            assert 'claude_code_version' not in events[0]
            assert events[-1]['type'] == 'result'
            assert events[-1]['subtype'] == 'success'
            assert events[-1]['is_error'] is False
            assert 'RUST_ACP_ANSWER' in events[-1]['result'], events[-1]
            assert events[-1]['stop_reason'] == 'end_turn'
            assert events[-1]['session_id'] == events[0]['session_id']
            assistant = [event for event in events if event['type'] == 'assistant']
            assert assistant, events
            thinking = [
                block for event in assistant for block in event['message']['content']
                if block.get('type') == 'thinking'
            ]
            assert thinking and 'RUST_ACP_THOUGHT' in thinking[0]['thinking']
            assert_spend_absent(events, 'streaming-messages-json')
            assert events[-1]['num_turns'] == len(assistant)
            assert 'usage_absent' in events[-1]
            # Partials are off: no stream_event framing.
            assert not any(event['type'] == 'stream_event' for event in events)

        def case_partial_messages():
            tool_dir = work / 'partial-tool'
            tool_dir.mkdir()
            (tool_dir / 'note.txt').write_text('alpha\n')
            result = plain(
                launcher, tool_dir, env('file-edit'),
                ['-p', 'edit the note', '--output-format', 'streaming-messages-json',
                 '--include-partial-messages', '--always-approve'],
            )
            assert result.returncode == 0, result.stderr
            events = parse_ndjson(result.stdout, 'partial messages')
            framed = [event for event in events if event['type'] == 'stream_event']
            inner = [event['event']['type'] for event in framed]
            assert inner[0] == 'message_start', inner
            assert 'content_block_start' in inner and 'content_block_delta' in inner
            assert 'content_block_stop' in inner and 'message_delta' in inner and 'message_stop' in inner
            assert inner[-1] == 'message_stop'
            deltas = [
                event['event'] for event in framed
                if event['event']['type'] == 'content_block_delta'
                and event['event'].get('delta', {}).get('type') == 'input_json_delta'
            ]
            assert deltas, inner
            # Each tool arrives as one complete JSON delta, not invented fragments.
            parsed_inputs = [json.loads(item['delta']['partial_json']) for item in deltas]
            edit = next(item for item in parsed_inputs if item.get('old_string') == 'alpha')
            assert edit['file_path'] == 'note.txt'
            assert edit['new_string'] == 'ALPHA'
            assert events[-1]['type'] == 'result'
            # The same flag on another format warns and does not change that format.
            warned = plain(
                launcher, project, env('echo'),
                ['-p', 'PARTIAL_IGNORED', '--output-format', 'json', '--include-partial-messages'],
            )
            assert warned.returncode == 0, warned.stderr
            body = json.loads(warned.stdout)
            assert 'PARTIAL_IGNORED' in body['text']
            assert 'include-partial-messages' in warned.stderr
            assert 'ignored' in warned.stderr

        def case_missing_usage_not_rewritten():
            result = plain(launcher, project, env('echo'),
                           ['-p', 'NO_USAGE', '--output-format', 'streaming-json'])
            assert result.returncode == 0, result.stderr
            events = parse_ndjson(result.stdout, 'no usage')
            assert not any(event['type'] == 'usage' for event in events)
            assert_spend_absent(events, 'no usage stream')
            assert events[-1]['type'] == 'end'

        def case_interrupt_truncation_error_approval():
            hanging = start_plain(
                launcher, project,
                env('echo', DSH_CODE_CLI_MOCK_DELAY_MS='30000'),
                ['-p', 'HANG', '--output-format', 'json'],
            )
            time.sleep(1.5)
            os.killpg(hanging.pid, signal.SIGINT)
            try:
                out, err = hanging.communicate(timeout=20)
            except subprocess.TimeoutExpired as error:
                hanging.kill()
                raise AssertionError(f'interrupt hung: {error}') from error
            assert hanging.returncode == 130, (hanging.returncode, out, err)
            if out.strip():
                body = json.loads(out)
                assert body.get('type') == 'error' or body.get('stopReason') == 'cancelled'
                assert body.get('stopReason') != 'end_turn'
            assert 'HANG' not in out or 'cancelled' in out or '"type": "error"' in out or '"type":"error"' in out

            truncated = plain(launcher, project, env('max-tokens'),
                              ['-p', 'cut', '--output-format', 'json'])
            assert truncated.returncode == 1, (truncated.returncode, truncated.stdout, truncated.stderr)
            body = json.loads(truncated.stdout)
            assert body.get('stopReason') == 'max_tokens', body
            assert 'RUST_ACP_TRUNCATED' in body.get('text', '')

            failed = plain(launcher, project, env('fail-stream'),
                           ['-p', 'boom', '--output-format', 'streaming-json'])
            assert failed.returncode == 1, failed.stdout
            events = parse_ndjson(failed.stdout, 'model error')
            assert events[-1]['type'] == 'error'
            assert 'provider failed' in events[-1]['message'] or 'MOCK_STREAM_FAIL' in events[-1]['message']
            assert not any(event.get('type') == 'end' and event.get('stopReason') == 'end_turn' for event in events)

            denied = work / 'denied'
            denied.mkdir()
            (denied / 'note.txt').write_text('alpha\n')
            approval = plain(
                launcher, denied, env('file-edit'),
                ['-p', 'edit the note', '--output-format', 'json'],
            )
            assert approval.returncode == 1, (approval.returncode, approval.stdout, approval.stderr[-800:])
            approval_body = json.loads(approval.stdout)
            assert approval_body.get('type') == 'error' or approval_body.get('stopReason') != 'end_turn'
            assert 'RUST_ACP_FILE_DONE' not in approval.stdout
            assert (denied / 'note.txt').read_text() == 'alpha\n'

        def case_same_side_effects():
            left = work / 'side-plain'
            right = work / 'side-json'
            for path in (left, right):
                path.mkdir()
                (path / 'note.txt').write_text('alpha\n')
            plain_run = plain(launcher, left, env('file-edit'),
                              ['-p', 'edit the note', '--always-approve'])
            json_run = plain(launcher, right, env('file-edit'),
                             ['-p', 'edit the note', '--output-format', 'json', '--always-approve'])
            assert plain_run.returncode == 0, plain_run.stderr
            assert json_run.returncode == 0, json_run.stderr
            assert (left / 'note.txt').read_text() == (right / 'note.txt').read_text() == 'ALPHA\n'
            body = json.loads(json_run.stdout)
            assert 'RUST_ACP_FILE_DONE' in plain_run.stdout
            assert 'RUST_ACP_FILE_DONE' in body['text']
            left_sessions = session_prompts(home, dsh, left)
            right_sessions = session_prompts(home, dsh, right)
            assert len(left_sessions) == 1 and len(right_sessions) == 1
            assert left_sessions[0]['id'] != right_sessions[0]['id']
            assert any('edit the note' in str(item) for item in left_sessions[0].get('prompts', []))
            assert any('edit the note' in str(item) for item in right_sessions[0].get('prompts', []))
            # Resume through JSON sees the same stored prompt the plain path stored.
            resumed = plain(
                launcher, right, env('echo'),
                ['-c', '-p', 'JSON_FOLLOW', '--output-format', 'json'],
            )
            assert resumed.returncode == 0, resumed.stderr
            resumed_body = json.loads(resumed.stdout)
            assert resumed_body['sessionId'] == body['sessionId']
            assert 'edit the note' in resumed_body['text'] and 'JSON_FOLLOW' in resumed_body['text']

        def case_unknown_format_still_rejected():
            bad = plain(launcher, project, env('echo'), ['--output-format', 'not-a-format'])
            assert bad.returncode == 2
            assert bad.stdout == ''
            assert "invalid value 'not-a-format'" in bad.stderr

        check('plain text', case_plain_text)
        check('json object', case_json_object)
        check('json reasoning and tools', case_json_reasoning_and_tools)
        check('streaming-json order', case_streaming_json_order)
        check('streaming-messages-json', case_streaming_messages)
        check('include-partial-messages', case_partial_messages)
        check('missing usage', case_missing_usage_not_rewritten)
        check('interrupt truncation error approval', case_interrupt_truncation_error_approval)
        check('same side effects', case_same_side_effects)
        check('unknown format', case_unknown_format_still_rejected)

    print(f'artifacts {output}')
    if failures:
        print(f'{len(failures)} failed', file=sys.stderr)
        return 1
    print('all json consumer checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
