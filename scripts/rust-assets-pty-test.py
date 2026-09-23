#!/usr/bin/env python3
"""Installed-product PTY: trusted rules, skills, and custom commands reach dsh."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    'rust_prompt_pty_test', ROOT / 'scripts' / 'rust-prompt-pty-test.py')
prompt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prompt)
Session = prompt.screen.Session
run = prompt.run
NODE = prompt.NODE


def answer_has(shown, *needles):
    flat = shown.replace('\n', '')
    missing = [needle for needle in needles if needle not in flat]
    assert not missing, f'missing {missing}\n{shown}'
    return flat


def write(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)


def seed(repo, grok_home, extra):
    (repo / '.git').mkdir(parents=True, exist_ok=True)
    write(grok_home / 'rules' / 'home.md', 'HOME_RULE\n')
    write(extra / 'extra.md', 'EXTRA_RULE\n')
    write(extra / 'nested' / 'skip.md', 'NESTED_RULE\n')
    write(repo / 'AGENTS.md', 'ROOT_RULE\n')
    src = repo / 'src'
    write(src / 'AGENTS.md', 'DEEP_RULE\n')
    write(src / '.gitignore', 'CLAUDE.local.md\n')
    write(src / 'CLAUDE.local.md', 'IGNORED_LOCAL\n')
    write(src / '.grok' / 'rules' / 'a.md', 'DIR_RULE_A\n')
    write(src / '.grok' / 'rules' / 'b.md', 'DIR_RULE_B\n')
    write(src / '.grok' / 'skills' / 'commit' / 'SKILL.md', """---
name: commit
description: Create commits when asked.
argument-hint: message
---
COMMIT_BODY
""")
    write(src / '.grok' / 'commands' / 'ship-note.md', """---
description: Write a ship note
argument-hint: ticket
---
SHIP_NOTE_BODY
""")
    write(src / '.grok' / 'agents' / 'reviewer.md', """---
name: reviewer
description: Reviews diffs
---
REVIEWER_BODY
""")
    write(grok_home / 'config.toml', f"""
[models]
default = "user-model"

[model.user-model]
name = "User model"
model = "cli-mock"
base_url = "http://127.0.0.1:9/v1"
env_key = "XAI_API_KEY"

[paths]
extra_rule_dirs = [{json.dumps(str(extra))}, "relative/nope"]
""")


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-assets-', dir='/tmp'))
    dsh = prompt.dsh_bin()
    overlay = prompt.overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-assets-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        repo = work / 'repo'
        extra = work / 'team-rules'
        grok_seed = work / 'grok-seed'
        seed(repo, grok_seed, extra)
        launcher = prompt.pack_install(work, home)
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        base_env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE,
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'CODSH_UPDATE_CHECK': 'off',
            'XAI_API_KEY': 'test-key-not-a-secret-for-logs',
            'CODSH_ACP_PATCH': str(patch),
        }
        rust_grok = home / '.codsh-rust' / '.grok'
        rust_grok.mkdir(parents=True)
        shutil.copytree(grok_seed, rust_grok, dirs_exist_ok=True)
        cwd = repo / 'src'
        results = []

        denied = run([NODE, str(launcher), '--rust', 'inspect', '--json'], cwd=cwd, env=base_env)
        denied_json = json.loads(denied.stdout)
        assert denied_json['projectAssetsActive'] is False
        rule_text = '\n'.join(item['path'] for item in denied_json['assets']['rules'])
        assert 'home.md' in rule_text
        assert 'AGENTS.md' not in rule_text
        assert denied_json['assets']['commands'] == []
        assert any(item['kind'] == 'rule-path' for item in denied_json['assets']['diagnostics'])

        trusted = Session('assets-trusted', launcher, cwd, base_env, output, extra=['--trust', '--minimal'])
        try:
            trusted.wait_visible('Connected to dsh ACP', 30)
            trusted.write('ASK_RULES\r')
            shown = trusted.wait_visible('HOME_RULE', 30)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and 'REVIEWER_BODY' not in shown.replace('\n', ''):
                trusted.pump()
                shown = trusted.visible()
            echo = answer_has(shown, 'HOME_RULE', 'EXTRA_RULE', 'ROOT_RULE', 'DEEP_RULE', 'DIR_RULE_A', 'REVIEWER_BODY')
            assert 'NESTED_RULE' not in echo
            assert 'IGNORED_LOCAL' not in echo
            assert echo.index('ROOT_RULE') < echo.index('DEEP_RULE') < echo.index('DIR_RULE_A')
            trusted.write('\x03')
            trusted.write('/commit')
            shown = trusted.wait_visible('skill ·', 10)
            assert '/commit' in shown
            trusted.write('\x03')
            trusted.write('/ship-note')
            shown = trusted.wait_visible('/ship-note', 10)
            assert 'skill ·' in shown
            trusted.write('\x03')
            trusted.write('/commit fix the build\r')
            shown = trusted.wait_visible('COMMIT_BODY', 30)
            assert 'fix the build' in shown.replace('\n', '')
            trusted.write('\x03')
            trusted.write('/ship-note 163\r')
            shown = trusted.wait_visible('SHIP_NOTE_BODY', 30)
            assert '163' in shown.replace('\n', '')
            added = cwd / '.grok' / 'skills' / 'added' / 'SKILL.md'
            write(added, """---
name: added
description: Newly added skill.
---
SKILL_ADDED
""")
            trusted.write('\x03')
            trusted.write('/reload-assets\r')
            trusted.wait_visible('Rescanned assets', 10)
            trusted.write('/added')
            shown = trusted.wait_visible('/added', 10)
            trusted.write('\x03')
            trusted.write('/added now\r')
            shown = trusted.wait_visible('SKILL_ADDED', 30)
            added.unlink()
            trusted.write('\x03')
            trusted.write('/reload-assets\r')
            trusted.wait_visible('Rescanned assets', 10)
            trusted.write('/added gone\r')
            trusted.pump(1.2)
            shown = trusted.visible()
            flat = shown.replace('\n', '')
            assert 'SKILL_ADDED' not in flat.split('Rescanned assets')[-1]
            assert '/added' in shown or 'not invocable' in shown.lower() or 'unknown' in shown.lower()
        finally:
            results.append(trusted.finish(expect_alt_leave=False))
            trusted.close()

        empty = work / 'empty-repo' / 'src'
        (work / 'empty-repo' / '.git').mkdir(parents=True)
        empty.mkdir()
        blank = Session('assets-empty', launcher, empty, base_env, output, extra=['--trust', '--minimal'])
        try:
            blank.wait_visible('Connected to dsh ACP', 30)
            blank.write('/')
            shown = blank.wait_visible('slash completion', 10)
            flat = shown.replace('\n', '')
            assert '/ship-note' not in flat
            assert '/commit' not in flat
            blank.write('\x03')
            blank.write('EMPTY_OK\r')
            shown = blank.wait_visible('HOME_RULE', 30)
            flat = shown.replace('\n', '')
            assert 'EMPTY_OK' in flat
            assert 'ROOT_RULE' not in flat
        finally:
            results.append(blank.finish(expect_alt_leave=False))
            blank.close()

        (output / 'results.json').write_text(json.dumps({
            'output': str(output),
            'sessions': [item['name'] for item in results],
        }, indent=2))
        print(f'PASS assets pty evidence {output}')


if __name__ == '__main__':
    main()
