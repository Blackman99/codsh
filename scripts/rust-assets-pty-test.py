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


def seed(repo, grok_home, extra, configured):
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
    write(src / '.grok' / 'skills' / 'hidden' / 'SKILL.md', """---
name: hidden
description: Model only.
user-invocable: false
---
HIDDEN_BODY
""")
    write(src / '.grok' / 'skills' / 'login' / 'SKILL.md', """---
name: login
description: Not the sign-in command.
---
LOGIN_SKILL_BODY
""")
    deep7 = src / '.grok' / 'skills'
    for part in ('n', 'a', 'b', 'c', 'd', 'e', 'f'):
        deep7 = deep7 / part
    write(deep7 / 'SKILL.md', """---
name: deep7
description: Seventh directory under the skill root.
---
DEEP7_BODY
""")
    deep6 = src / '.grok' / 'skills'
    for part in ('p', 'a', 'b', 'c', 'd', 'e'):
        deep6 = deep6 / part
    write(deep6 / 'SKILL.md', """---
name: deep6
description: Sixth directory under the skill root.
---
DEEP6_BODY
""")
    parent = src / '.grok' / 'skills' / 'parent'
    write(parent / 'SKILL.md', """---
name: parent
description: Directory that already has a skill.
---
PARENT_BODY
""")
    write(parent / 'child' / 'SKILL.md', """---
name: child
description: Child of a skill directory.
---
CHILD_BODY
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

[skills]
paths = [{json.dumps(str(configured))}]
""")
    write(configured / 'SKILL.md', """---
name: config-root
description: The configured directory itself.
---
CONFIG_ROOT
""")
    at_limit = configured
    for part in ('a', 'b', 'c', 'd', 'e'):
        at_limit = at_limit / part
    write(at_limit / 'SKILL.md', """---
name: config-deep5
description: Fifth child under a configured path.
---
CONFIG_DEEP5
""")
    write(at_limit / 'child' / 'SKILL.md', """---
name: config-sixth
description: Sixth child under a configured path.
---
CONFIG_SIXTH
""")
    too_deep = configured
    for part in ('z', 'a', 'b', 'c', 'd', 'e', 'f'):
        too_deep = too_deep / part
    write(too_deep / 'SKILL.md', """---
name: config-deep7
description: Seventh child under a configured path.
---
CONFIG_DEEP7
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
        configured = work / 'configured-skills'
        grok_seed = work / 'grok-seed'
        seed(repo, grok_seed, extra, configured)
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
        assert all(agent['source'] == 'user' for agent in denied_json['assets']['agents'])
        assert all(skill['source'] != 'project' for skill in denied_json['assets']['skills'])
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
            assert '/hidden' not in shown.replace('\n', '')
            trusted.write('\x03')
            trusted.write('/log')
            shown = trusted.wait_visible('> /login ', 10)
            assert 'Sign in to a configured identity provider' in shown.replace('\n', '')
            trusted.write('\x1b[B')
            trusted.write('\x1b[B')
            shown = trusted.wait_visible('> /local:login', 10)
            trusted.write('\x1b')
            trusted.pump(0.3)
            trusted.write('/login\r')
            shown = trusted.wait_visible('does not require login', 15)
            flat = shown.replace('\n', '')
            assert 'LOGIN_SKILL_BODY' not in flat.split('does not require login')[-1]
            assert 'Follow the local:login skill' not in flat.split('does not require login')[-1]
            trusted.write('\x03')
            trusted.pump(0.4)
            trusted.write('/local:login \r')
            shown = trusted.wait_visible('LOGIN_SKILL_BODY', 30)
            raw = bytes(trusted.data).decode('utf-8', 'replace')
            assert 'Follow the local:login skill' in raw
            trusted.write('\x03')
            trusted.write('/deep6 now\r')
            shown = trusted.wait_visible('DEEP6_BODY', 30)
            trusted.write('\x03')
            trusted.write('/child now\r')
            shown = trusted.wait_visible('CHILD_BODY', 30)
            trusted.write('\x03')
            trusted.write('/config-root now\r')
            shown = trusted.wait_visible('CONFIG_ROOT', 30)
            trusted.write('\x03')
            trusted.write('/config-deep5 now\r')
            shown = trusted.wait_visible('CONFIG_DEEP5', 30)
            trusted.write('\x03')
            trusted.write('/config-sixth gone\r')
            shown = trusted.wait_visible('/config-sixth gone', 30)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                trusted.pump()
                shown = trusted.visible()
                flat = shown.replace('\n', '')
                if '/config-sixth gone' in flat and 'Streaming turn' not in flat:
                    break
            flat = shown.replace('\n', '')
            assert 'CONFIG_SIXTH' not in flat
            assert 'Follow the config:config-sixth skill' not in flat
            trusted.write('\x03')
            trusted.write('/config-deep7 gone\r')
            shown = trusted.wait_visible('/config-deep7 gone', 30)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                trusted.pump()
                shown = trusted.visible()
                flat = shown.replace('\n', '')
                if '/config-deep7 gone' in flat and 'Streaming turn' not in flat:
                    break
            flat = shown.replace('\n', '')
            assert 'CONFIG_DEEP7' not in flat
            assert 'Follow the config:config-deep7 skill' not in flat
            trusted.write('\x03')
            trusted.write('/deep7 gone\r')
            shown = trusted.wait_visible('/deep7 gone', 30)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                trusted.pump()
                shown = trusted.visible()
                flat = shown.replace('\n', '')
                if '/deep7 gone' in flat and 'Streaming turn' not in flat:
                    break
            flat = shown.replace('\n', '')
            assert 'DEEP7_BODY' not in flat
            assert 'Follow the local:deep7 skill' not in flat
            assert 'Follow the deep7 skill' not in flat
            trusted.write('\x03')
            trusted.write('/ship-note')
            shown = trusted.wait_visible('/ship-note', 10)
            assert '/ship-note' in shown.replace('\n', '')
            trusted.write('\x03')
            trusted.write('/commit fix the build\r')
            shown = trusted.wait_visible('COMMIT_BODY', 30)
            assert 'fix the build' in shown.replace('\n', '')
            trusted.write('\x03')
            trusted.write('/ship-note 163\r')
            shown = trusted.wait_visible('SHIP_NOTE_BODY', 30)
            assert '163' in shown.replace('\n', '')
            assert 'Run the custom command' in shown.replace('\n', '')
            added = cwd / '.grok' / 'skills' / 'added' / 'SKILL.md'
            write(added, """---
name: added
description: Newly added skill.
---
SKILL_ADDED
""")
            trusted.write('\x03')
            trusted.write('/reload-assets\r')
            rescanned = trusted.wait_visible('Rescanned assets', 10)
            # commit, hidden, login, parent, child, deep6, the configured
            # directory, its fifth child, plus the skill added in this session.
            # The named seventh directory and the configured sixth child are
            # not counted.
            assert '9 skills' in rescanned.replace('\n', '')
            trusted.write('/added')
            shown = trusted.wait_visible('/added', 10)
            trusted.write('\x03')
            trusted.write('/added now\r')
            shown = trusted.wait_visible('SKILL_ADDED', 30)
            added.unlink()
            trusted.write('\x03')
            trusted.write('/reload-assets\r')
            trusted.wait_visible('8 skills', 10)
            trusted.write('/added gone\r')
            shown = trusted.wait_visible('/added gone', 30)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                trusted.pump()
                shown = trusted.visible()
                flat = shown.replace('\n', '')
                if '/added gone' in flat and 'Streaming turn' not in flat:
                    break
            raw = bytes(trusted.data).decode('utf-8', 'replace')
            submitted = raw.rsplit('/added gone', 1)
            assert len(submitted) == 2
            reply = submitted[1]
            assert 'Follow the local:added skill' not in reply
            assert 'Follow the added skill' not in reply
            assert 'SKILL_ADDED' not in reply
        finally:
            results.append(trusted.finish(expect_alt_leave=False))
            trusted.close()

        ruled = Session(
            'assets-session-rules', launcher, cwd, base_env, output,
            extra=['--trust', '--minimal', '--rules', 'SESSION_RULE_SENTINEL'])
        try:
            ruled.wait_visible('Connected to dsh ACP', 30)
            ruled.write('ASK_SESSION\r')
            shown = ruled.wait_visible('SESSION_RULE_SENTINEL', 30)
            assert 'ASK_SESSION' in shown.replace('\n', '')
            ruled.write('\x03')
            ruled.write('/compact keep\r')
            shown = ruled.wait_visible('MOCK_COMPACTION_SUMMARY', 20)
            flat = shown.replace('\n', '')
            assert 'instruction:Additional compaction instruction' in flat or 'keep' in flat
            assert 'Follow the local:compact skill' not in flat
            assert 'COMMIT_BODY' not in flat.split('MOCK_COMPACTION_SUMMARY')[-1]
        finally:
            results.append(ruled.finish(expect_alt_leave=False))
            ruled.close()

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
