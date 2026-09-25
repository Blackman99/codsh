#!/usr/bin/env python3
"""PTY: copy legacy codsh sessions into the isolated Rust client (ticket 62 / #194).

The legacy client is the real `dsh --profile code` bundle over its own dsh
Home, driven by the keyless mock LLM (e2e harness): it creates a write
session and a session with two subagent children. A third legacy session
with an image and a file attachment is written with the pinned dsh
persistence and the real attachment store (scripts/rust-session-migrate-fixture.mjs).

Checked through the repo launcher and the staged native binary:
`codsh --rust import sessions` lists without writing; `--all` previews;
`--all --apply --json` copies all three under new ids with provenance;
the legacy Home is byte- and mtime-identical afterwards; each copy resumes
and continues a turn headlessly (the attachment copy included, so dsh
resolves the copied image and file); the subagent copy resumes in the TUI
(PTY), continues a turn, and /session-info shows its legacy origin; the
legacy client itself still resumes and continues its original session;
after that growth a re-import is a conflict and `--again` makes a second
copy that carries the new turn while the first copy stays as it was.

Runs on Linux and macOS (run `pnpm run build` and `pnpm run build:rust`
first). It reuses the Session harness of rust-screen-pty-test.py.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('screen_pty', ROOT / 'scripts/rust-screen-pty-test.py')
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)
Session = screen.Session
NODE = screen.NODE
LAUNCHER = ROOT / 'packages/cli/bin/codsh.mjs'
LEGACY_ID = re.compile(r'codsh --resume (session-[0-9a-f-]{36})')

LEGACY = r"""
import { cloneTemplateProfiles, ensureTemplateHome, overlayText, resolveLaunch } from './e2e/harness.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [home, cwd, mode, input, ...args] = JSON.parse(process.env.LEGACY_ARGS)
if (!existsSync(join(home, 'profiles'))) await cloneTemplateProfiles(join(ensureTemplateHome(), 'profiles'), join(home, 'profiles'))
const overlay = join(home, 'mock.cordis.patch.yml')
writeFileSync(overlay, overlayText())
const launch = resolveLaunch({ overlay, args, home, mode })
const result = spawnSync(launch.command, launch.args, { cwd, env: launch.env, input, encoding: 'utf8', timeout: 90000 })
process.stdout.write(JSON.stringify({ exit: result.status, stdout: result.stdout, stderr: result.stderr }))
"""

FIXTURE = r"""
import { openLegacyHome, tinyPng } from './scripts/rust-session-migrate-fixture.mjs'
const [dsh, home, cwd] = process.argv.slice(1)
const fx = await openLegacyHome(dsh, home)
const image = await fx.saveImage(tinyPng())
const file = await fx.saveFile('notes.txt', 'ATTACHED_FILE_BODY\n')
await fx.write('session-00000000-0000-4000-8000-0000000001a4', fx.turn(1, 'ATTACH_PROMPT', {
  blocks: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }], title: 'attachments', answer: 'ATTACH_ANSWER',
}), { cwd, agentPreset: 'code-cli' })
await fx.close()
process.stdout.write(JSON.stringify({ image, file }))
"""


def legacy(home, cwd, mode, text, *args):
    out = subprocess.run([NODE, '--import', 'tsx', '--input-type=module', '-e', LEGACY], cwd=ROOT,
                         env={**os.environ, 'LEGACY_ARGS': json.dumps([str(home), str(cwd), mode, text, *args])},
                         capture_output=True, text=True, timeout=150, check=True)
    result = json.loads(out.stdout)
    assert result['exit'] == 0, result
    return result


def snapshot(root):
    out = {}
    for path in sorted(Path(root).rglob('*')):
        if path.is_file() and not path.is_symlink():
            out[str(path.relative_to(root))] = (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
    return out


def main():
    if not sys.platform.startswith(('linux', 'darwin')):
        raise SystemExit('PTY evidence needs Linux or macOS')
    output = Path(tempfile.mkdtemp(prefix='codsh-194-migrate-', dir='/tmp'))
    dsh = screen.dsh_bin()
    overlay = screen.overlay_text()
    results = {}
    with tempfile.TemporaryDirectory(prefix='codsh-194-migrate-home-', dir='/tmp') as temporary:
        work = Path(temporary).resolve()
        home = work / 'home'
        home.mkdir()
        legacy_home = work / 'legacy-dsh'
        legacy_home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        isolated = home / '.codsh-rust' / 'dsh'
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_HOME': str(legacy_home),
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off', 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }

        def cli(*args, check_exit=0):
            done = subprocess.run([NODE, str(LAUNCHER), '--rust', *args], cwd=cwd, env=env,
                                  capture_output=True, text=True, timeout=120)
            if check_exit is not None:
                assert done.returncode == check_exit, (args, done.returncode, done.stdout, done.stderr)
            return done

        # 1. The old client makes real sessions in its own dsh Home.
        write = legacy(legacy_home, cwd, 'write', 'create the note\n/exit\n')
        write_id = LEGACY_ID.search(write['stdout']).group(1)
        delegate = legacy(legacy_home, cwd, 'subagents', 'delegate it\n/exit\n')
        delegate_id = LEGACY_ID.search(delegate['stdout']).group(1)
        assert (cwd / 'note.txt').read_text() == 'CODE_CLI_ROUND_TRIP\n'
        attached = json.loads(subprocess.run([NODE, '--input-type=module', '-e', FIXTURE, dsh, str(legacy_home), str(cwd)],
                                             cwd=ROOT, capture_output=True, text=True, check=True).stdout)
        attach_id = 'session-00000000-0000-4000-8000-0000000001a4'
        before = snapshot(legacy_home)
        results['legacy_sessions'] = [write_id, delegate_id, attach_id]

        # 2. List and preview write nothing.
        listed = cli('import', 'sessions').stdout
        for sid in (write_id, delegate_id, attach_id):
            assert sid in listed, listed
        assert 'not imported' in listed and '2 subagent(s)' in listed and '2 attachment(s)' in listed, listed
        assert 'Nothing was written' in listed, listed
        preview = cli('import', 'sessions', '--all').stdout
        assert preview.count('Would import') == 3, preview
        assert not (isolated / 'session-migrations').exists()
        assert cli('import', 'sessions', '--help').stdout.count('never writes') == 1
        assert cli('import', 'sessions', '--apply', check_exit=None).returncode != 0
        results['list_preview'] = True

        # 3. Apply copies all three with provenance; the legacy Home is untouched.
        applied = json.loads(cli('import', 'sessions', '--all', '--apply', '--json').stdout)
        copies = {row['sessionId']: row for row in applied['results']}
        assert all(row['outcome'] == 'imported' and row['status'] == 'complete' for row in copies.values()), applied
        assert snapshot(legacy_home) == before
        for sid, row in copies.items():
            record = json.loads((isolated / 'session-migrations' / f"{row['copyId']}.json").read_text())
            assert record['source']['sessionId'] == sid and record['source']['home'] == str(legacy_home), record
        assert len(copies[delegate_id]['children']) == 2
        hexed = attached['image']['attachmentId'][7:]
        assert (isolated / 'attachments/v1/objects' / hexed[:2] / hexed).exists()
        again = json.loads(cli('import', 'sessions', write_id, '--apply', '--json').stdout)
        assert again['results'][0]['outcome'] == 'already-imported', again
        results['apply'] = {sid: row['copyId'] for sid, row in copies.items()}

        # 4. Each copy resumes and continues headlessly.
        for sid, token, seen in ((write_id, 'CONTINUE_WRITE_194', 'create the note'),
                                 (attach_id, 'CONTINUE_ATTACH_194', 'ATTACH_PROMPT')):
            done = cli('--resume', copies[sid]['copyId'], '-p', token, '--output-format', 'json')
            answer = json.loads(done.stdout)
            assert answer['sessionId'] == copies[sid]['copyId'], answer
            assert token in answer['text'] and seen in answer['text'], answer
        assert snapshot(legacy_home) == before
        results['headless_resume'] = True

        # 5. The subagent copy resumes in the TUI and continues a turn.
        copy_id = copies[delegate_id]['copyId']
        session = Session('resume-copy', LAUNCHER, cwd, env, output, extra=['--resume', copy_id], cols=140, rows=44)
        try:
            shown = session.wait_visible('resumed', 30)
            assert copy_id in session.current_text(), shown
            session.wait_visible('delegate it', 10)
            session.write('TUI_AFTER_IMPORT_194')
            session.wait_visible('TUI_AFTER_IMPORT_194', 10)
            session.write(b'\r')
            session.wait_visible('RUST_ACP_ANSWER', 30)
            session.send_slash('/session-info')
            info = session.wait_visible(f'Imported from: legacy dsh session {delegate_id}', 20)
            assert 'copy complete' in info.replace('\n', ''), info
            results['tui_resume'] = session.finish()['exit']
        finally:
            session.close()
        assert snapshot(legacy_home) == before

        # 6. The old client still resumes and continues its original session.
        grown = legacy(legacy_home, cwd, 'echo', 'LEGACY_AFTER_IMPORT_194\n/exit\n', '--resume', write_id)
        assert write_id in grown['stdout'], grown
        assert snapshot(legacy_home) != before
        results['legacy_resume'] = True

        # 7. A changed legacy session is a conflict until --again.
        conflict = json.loads(cli('import', 'sessions', write_id, '--apply', '--json', check_exit=1).stdout)
        assert conflict['results'][0]['outcome'] == 'conflict', conflict
        second = json.loads(cli('import', 'sessions', write_id, '--apply', '--again', '--json').stdout)['results'][0]
        assert second['outcome'] == 'imported' and second['copyId'] != copies[write_id]['copyId'], second
        fresh = json.loads(cli('--resume', second['copyId'], '-p', 'SECOND_COPY_194', '--output-format', 'json').stdout)
        assert 'LEGACY_AFTER_IMPORT_194' in fresh['text'], fresh
        old = json.loads(cli('--resume', copies[write_id]['copyId'], '-p', 'FIRST_COPY_194', '--output-format', 'json').stdout)
        assert 'LEGACY_AFTER_IMPORT_194' not in old['text'] and 'CONTINUE_WRITE_194' in old['text'], old
        results['conflict_again'] = True

    (output / 'result.json').write_text(json.dumps(results, indent=2) + '\n')
    print(f'PASS: rust session import PTY; evidence: {output}')


if __name__ == '__main__':
    main()
