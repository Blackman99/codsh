#!/usr/bin/env python3
"""Installed-product PTY: prompt editing, history, completion, vim, paste, external editor."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    'rust_resume_pty_test', ROOT / 'scripts' / 'rust-resume-pty-test.py')
resume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resume)
screen_spec = importlib.util.spec_from_file_location(
    'rust_screen_pty_test', ROOT / 'scripts' / 'rust-screen-pty-test.py')
screen = importlib.util.module_from_spec(screen_spec)
screen_spec.loader.exec_module(screen)
NODE = resume.NODE
Session = screen.Session
dsh_bin = resume.dsh_bin
overlay_text = resume.overlay_text
run = resume.run

SHIFT_ENTER = b'\x1b[13;2u'
PASTE_OPEN = b'\x1b[200~'
PASTE_CLOSE = b'\x1b[201~'


def wait_idle(session, marker, seconds=20):
    session.wait_visible(marker, seconds)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.pump()
        shown = session.visible()
        if 'Streaming turn' not in shown and 'Cancelling turn' not in shown:
            return shown
    raise AssertionError(f'{session.name}: still streaming after {marker!r}\n{session.visible()}')


def answer_lines(shown):
    collected = []
    pending = None
    for raw in shown.splitlines():
        line = raw.strip()
        if 'RUST_ACP_ANSWER' in line:
            if pending is not None:
                collected.append(pending)
            pending = line
            continue
        if pending is not None:
            if line.startswith('>') or line.startswith('┌') or line.startswith('mode=') or not line:
                collected.append(pending)
                pending = None
            elif line.startswith('model=') or 'TOKEN_' in line or '⏎' in line:
                pending = f'{pending} {line}'
    if pending is not None:
        collected.append(pending)
    return collected


def latest_answer(shown):
    lines = answer_lines(shown)
    assert lines, f'missing RUST_ACP_ANSWER\n{shown}'
    return lines[-1]


def wait_answer(session, *needles, seconds=20, count=None):
    deadline = time.monotonic() + seconds
    shown = ''
    while time.monotonic() < deadline:
        session.pump()
        shown = session.visible()
        if 'Streaming turn' in shown or 'Cancelling turn' in shown:
            continue
        answers = answer_lines(shown)
        if count is not None and len(answers) != count:
            continue
        if answers and all(needle in answers[-1] for needle in needles):
            return shown
        if session.process.poll() is not None:
            break
    raise AssertionError(
        f'{session.name}: missing dsh echo {needles!r} count={count}\n'
        f'answers={answer_lines(shown)}\n{shown}'
    )


def pack_install(work, home):
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
    return prefix / 'node_modules/.bin/codsh'


def write_editor(path, body):
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def main():
    if sys.platform != 'darwin':
        raise SystemExit('macOS PTY evidence required')
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-prompt-', dir='/tmp'))
    dsh = dsh_bin()
    overlay = overlay_text()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-prompt-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        home.mkdir()
        cwd = work / 'workspace'
        cwd.mkdir()
        histfile = work / 'bash_history'
        histfile.write_text('ls /tmp/TOKEN_SHELL_A\nls /var/TOKEN_SHELL_B\n')
        editors = work / 'bin'
        editors.mkdir()
        visual = editors / 'visual-ed'
        editor = editors / 'editor-ed'
        fail = editors / 'fail-ed'
        write_editor(visual, '''#!/bin/sh
file="$1"
for arg in "$@"; do
  file="$arg"
done
printf '%s\\n' "$file" > "$file.seen"
printf 'TOKEN_VISUAL_SAVED 你好\\n' > "$file"
''')
        write_editor(editor, '''#!/bin/sh
file="$1"
for arg in "$@"; do
  file="$arg"
done
printf 'TOKEN_EDITOR_SHOULD_NOT_RUN\\n' > "$file.seen"
exit 1
''')
        write_editor(fail, '#!/bin/sh\nexit 7\n')
        empty_ed = editors / 'empty-ed'
        cancel_ed = editors / 'cancel-ed'
        vi_ed = editors / 'vi'
        write_editor(empty_ed, '''#!/bin/sh
file="$1"
for arg in "$@"; do
  file="$arg"
done
printf '\\n' > "$file"
''')
        write_editor(cancel_ed, '#!/bin/sh\nexit 130\n')
        write_editor(vi_ed, '''#!/bin/sh
file="$1"
for arg in "$@"; do
  file="$arg"
done
printf 'TOKEN_VI_FALLBACK\\n' > "$file"
''')
        preserve_ed = editors / 'preserve-ed'
        write_editor(preserve_ed, '''#!/bin/sh
file="$1"
for arg in "$@"; do
  file="$arg"
done
printf '%s KEEP\\n' "$(tr -d '\\n' < "$file")" > "$file"
''')
        launcher = pack_install(work, home)
        patch = work / 'overlay.yml'
        patch.write_text(overlay)
        path = os.pathsep.join([str(editors), os.environ['PATH']])
        base_env = {
            'HOME': str(home), 'PATH': path, 'TERM': 'xterm-256color',
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'GROK_PROMPT_SUGGESTIONS': 'false',
            'GROK_SUGGESTIONS': 'false',
            'HISTFILE': str(histfile),
            'VISUAL': f'{visual} --keep "quoted arg"',

            'EDITOR': str(editor),
        }
        results = []

        edit = Session('prompt-edit', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--fullscreen'])
        try:
            edit.wait_visible('Connected to dsh ACP', 25)
            edit.write('TOKEN_KEEP')
            edit.wait_visible('TOKEN_KEEP')
            edit.write('/')
            shown = edit.wait_visible('slash completion', 10)
            assert 'TOKEN_KEEP/' not in shown
            edit.write('\x1b')
            shown = edit.wait_visible('TOKEN_KEEP', 10)
            assert 'completion cancelled' in shown or 'TOKEN_KEEP' in shown
            edit.write('\x7f' * 12)
            edit.pump(0.2)
            edit.write('TOKEN_MULTI')
            edit.wait_visible('TOKEN_MULTI')
            edit.write(SHIFT_ENTER)
            edit.pump(0.3)
            edit.write('第二行')
            edit.wait_visible('第二行')
            shown = edit.visible()
            assert 'TOKEN_MULTI' in shown and '第二行' in shown
            edit.write('\r')
            shown = wait_answer(edit, 'latest=TOKEN_MULTI⏎第二行', count=1)
            echo = latest_answer(shown)
            assert 'TOKEN_KEEP' not in echo.split('latest=', 1)[-1].split(' ', 1)[0], echo
            answers_after_multi = len(answer_lines(shown))
            edit.write(PASTE_OPEN + 'TOKEN_PASTE_α'.encode() * 40 + PASTE_CLOSE)
            edit.wait_visible('TOKEN_PASTE_α', 10)
            shown = edit.visible()
            assert 'TOKEN_PASTE_α' in shown
            assert len(answer_lines(shown)) == answers_after_multi
            edit.write('\x03')
            edit.pump(0.2)
            edit.write('/multiline\r')
            edit.wait_visible('multiline on', 10)
            edit.write('TOKEN_ML')
            edit.write('\r')
            edit.pump(0.2)
            shown = edit.visible()
            assert 'TOKEN_ML' in shown
            assert len(answer_lines(shown)) == answers_after_multi
            edit.write(SHIFT_ENTER)
            shown = wait_answer(edit, 'latest=TOKEN_ML', count=2)
            echo = latest_answer(shown)
            latest = echo.split('latest=', 1)[-1].split(' ', 1)[0]
            assert latest.startswith('TOKEN_ML'), echo
            assert 'TOKEN_MULTI' not in latest, echo
            answers_after_ml = len(answer_lines(shown))
            edit.write('\x1b[A')
            shown = edit.wait_visible('history browse', 10)
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert 'TOKEN_ML' in draft or 'TOKEN_MULTI' in draft, shown
            edit.write('x')
            edit.pump(0.2)
            shown = edit.visible()
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert 'x' in draft, shown
            assert len(answer_lines(shown)) == answers_after_ml
            edit.write('\x03')
            edit.write('/history\r')
            shown = edit.wait_visible('prompt history search', 10)
            assert 'prompt history search' in shown
            edit.write('MULTI')
            shown = edit.wait_visible('TOKEN_MULTI', 10)
            assert 'prompt history search' in shown
            edit.write('\r')
            shown = edit.wait_visible('TOKEN_MULTI', 10)
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert 'TOKEN_MULTI' in draft, shown
            assert 'prompt history search' not in shown
            assert len(answer_lines(shown)) == answers_after_ml
            edit.write('\x03')
            edit.write('\x03')
            edit.write('!')
            edit.pump(0.2)
            edit.write('ls')
            edit.write('\t')
            shown = edit.wait_visible('shell completion', 10)
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert '!ls' in draft or 'ls' in draft, shown
            assert len(answer_lines(shown)) == answers_after_ml
            edit.write('\x1b')
            shown = edit.wait_visible('completion cancelled', 10)
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert '!ls' in draft or 'ls' in draft, shown
            assert 'TOKEN_SHELL_A' not in draft
            assert len(answer_lines(shown)) == answers_after_ml
            edit.write('\x03')
            grok_tmp = home / '.codsh-rust' / '.grok' / 'tmp'
            edit.write('/edit-prompt\r')
            deadline = time.monotonic() + 8
            seen = None
            while time.monotonic() < deadline:
                edit.pump(0.1)
                found = list(grok_tmp.glob('codsh-prompt-*.seen')) if grok_tmp.exists() else []
                if found:
                    seen = found[0]
                    break
            assert seen is not None, f'VISUAL did not run\n{edit.visible()}\ntmp={list(grok_tmp.glob("*")) if grok_tmp.exists() else None}'
            seen_text = seen.read_text()
            assert 'codsh-prompt-' in seen_text
            edit.wait_visible('TOKEN_VISUAL_SAVED', 10)
            shown = edit.visible()
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert 'TOKEN_VISUAL_SAVED' in draft
            assert '你好' in draft
            assert len(answer_lines(shown)) == answers_after_ml
            empty_env_session_answers = answers_after_ml
            edit.write('\x03')
        finally:
            results.append(edit.finish(expect_alt_leave=True))
            edit.close()

        fail_session = Session('prompt-editor-fail', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'VISUAL': str(fail), 'EDITOR': str(fail),
        }, output, extra=['--fullscreen'])
        try:
            fail_session.wait_visible('Connected to dsh ACP', 25)
            fail_session.write('/edit-prompt\r')
            shown = fail_session.wait_visible('original draft kept', 10)
            assert len(answer_lines(shown)) == 0
            fail_session.write('TOKEN_FAIL_KEEP\r')
            shown = wait_answer(fail_session, 'latest=TOKEN_FAIL_KEEP', count=1)
            echo = latest_answer(shown)
            assert 'TOKEN_EDITOR_SHOULD_NOT_RUN' not in echo, echo
        finally:
            results.append(fail_session.finish(expect_alt_leave=True))
            fail_session.close()

        vim_home_cfg = home / '.codsh-rust' / '.grok' / 'config.toml'
        vim_home_cfg.parent.mkdir(parents=True, exist_ok=True)
        existing = vim_home_cfg.read_text() if vim_home_cfg.exists() else ''
        vim_home_cfg.write_text('[ui]\nsimple_mode = false\n')
        vim = Session('prompt-vim', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--fullscreen'])
        try:
            vim.wait_visible('Connected to dsh ACP', 25)
            vim.write('h')
            vim.pump(0.3)
            shown = vim.visible()
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert 'TOKEN_VIM' not in draft
            vim.write('iTOKEN_VIM中')
            vim.wait_visible('TOKEN_VIM中', 10)
            vim.write('\x1b')
            vim.wait_visible('vim-normal', 10)
            vim.write('x')
            vim.pump(0.4)
            shown = vim.visible()
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert 'TOKEN_VIM' in draft
            assert '中' not in draft, shown
            vim.write('i')
            vim.pump(0.2)
            vim.write('\r')
            shown = wait_answer(vim, 'latest=TOKEN_VIM', count=1)
            echo = latest_answer(shown)
            latest = echo.split('latest=', 1)[-1].split(' ', 1)[0]
            assert latest == 'TOKEN_VIM' or latest.startswith('TOKEN_VIM '), echo
            assert '中' not in latest, echo
        finally:
            results.append(vim.finish(expect_alt_leave=True))
            vim.close()
        vim_home_cfg.write_text(existing if existing.strip() else '[ui]\nsimple_mode = true\n')

        empty_save = Session('prompt-editor-empty', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'VISUAL': str(empty_ed),
        }, output, extra=['--fullscreen'])
        try:
            empty_save.wait_visible('Connected to dsh ACP', 25)
            empty_save.write('/edit-prompt\r')
            empty_save.wait_visible('Draft (not sent)', 10)
            shown = empty_save.visible()
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert 'TOKEN_VISUAL_SAVED' not in draft
            assert len(answer_lines(shown)) == 0
        finally:
            results.append(empty_save.finish(expect_alt_leave=True))
            empty_save.close()

        cancel = Session('prompt-editor-cancel', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'VISUAL': str(cancel_ed),
        }, output, extra=['--fullscreen'])
        try:
            cancel.wait_visible('Connected to dsh ACP', 25)
            cancel.write('/edit-prompt\r')
            shown = cancel.wait_visible('original draft kept', 10)
            assert len(answer_lines(shown)) == 0
        finally:
            results.append(cancel.finish(expect_alt_leave=True))
            cancel.close()

        vi_env = {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'PATH': path,
        }
        vi_env.pop('VISUAL', None)
        vi_env.pop('EDITOR', None)
        vi_fallback = Session('prompt-editor-vi', launcher, cwd, vi_env, output, extra=['--fullscreen'])
        try:
            vi_fallback.wait_visible('Connected to dsh ACP', 25)
            vi_fallback.write('/edit-prompt\r')
            shown = vi_fallback.wait_visible('TOKEN_VI_FALLBACK', 10)
            assert len(answer_lines(shown)) == 0
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert 'TOKEN_VI_FALLBACK' in draft
        finally:
            results.append(vi_fallback.finish(expect_alt_leave=True))
            vi_fallback.close()

        hist_missing = Session('prompt-histfile-missing', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'HISTFILE': str(work / 'no-such-histfile'),
            'GROK_SUGGESTIONS': 'false',
        }, output, extra=['--fullscreen'])
        try:
            hist_missing.wait_visible('Connected to dsh ACP', 25)
            hist_missing.write('!ls')
            hist_missing.write('\t')
            shown = hist_missing.wait_visible('HISTFILE missing or unreadable', 10)
            assert len(answer_lines(shown)) == 0
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert '!ls' in draft or 'ls' in draft
        finally:
            results.append(hist_missing.finish(expect_alt_leave=True))
            hist_missing.close()

        as_you_type = Session('prompt-histfile-as-you-type', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'GROK_SUGGESTIONS': 'true',
        }, output, extra=['--fullscreen'])
        try:
            as_you_type.wait_visible('Connected to dsh ACP', 25)
            as_you_type.write('!ls')
            shown = as_you_type.wait_visible('shell completion', 10)
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert '!ls' in draft or 'ls' in draft, shown
            as_you_type.write('\x1b')
            shown = as_you_type.wait_visible('completion cancelled', 10)
            assert len(answer_lines(shown)) == 0
        finally:
            results.append(as_you_type.finish(expect_alt_leave=True))
            as_you_type.close()

        ctrlg = Session('prompt-editor-ctrlg', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
            'VISUAL': str(preserve_ed),
        }, output, extra=['--minimal'])
        try:
            ctrlg.wait_visible('Connected to dsh ACP', 25)
            ctrlg.wait_visible('mode=minimal', 10)
            ctrlg.write('TOKEN_G_DRAFT')
            ctrlg.wait_visible('TOKEN_G_DRAFT')
            ctrlg.write('\x07')
            shown = ctrlg.wait_visible('TOKEN_G_DRAFT KEEP', 10)
            assert len(answer_lines(shown)) == 0
            draft = shown.split('Draft')[-1] if 'Draft' in shown else shown
            assert 'TOKEN_G_DRAFT KEEP' in draft or 'TOKEN_G_DRAFT KEEP' in shown
        finally:
            results.append(ctrlg.finish(expect_alt_leave=False))
            ctrlg.close()

        modes = Session('prompt-mode-switch', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--fullscreen'])
        try:
            modes.wait_visible('Connected to dsh ACP', 25)
            modes.write('TOKEN_MODE_DRAFT')
            modes.wait_visible('TOKEN_MODE_DRAFT')
            modes.write('/minimal\r')
            modes.wait_visible('Switched to minimal', 25)
            modes.write('/fullscreen\r')
            deadline = time.monotonic() + 12
            shown = ''
            while time.monotonic() < deadline:
                modes.pump(0.1)
                shown = modes.visible()
                raw = bytes(modes.data).decode(errors='replace')
                if 'TOKEN_MODE_DRAFT' in shown or 'TOKEN_MODE_DRAFT' in raw.split('Switched to minimal', 1)[-1]:
                    break
            assert 'TOKEN_MODE_DRAFT' in shown or 'TOKEN_MODE_DRAFT' in bytes(modes.data).decode(errors='replace').split('Switched to minimal', 1)[-1]
            modes.write('\r')
            shown = wait_answer(modes, 'latest=TOKEN_MODE_DRAFT', count=1)
            echo = latest_answer(shown)
            assert 'latest=TOKEN_MODE_DRAFT' in echo, echo
        finally:
            results.append(modes.finish(expect_alt_leave=True))
            modes.close()

        once = Session('prompt-history-once', launcher, cwd, {
            **base_env, 'DSH_CODE_CLI_MOCK_TOOL': 'echo',
        }, output, extra=['--fullscreen'])
        try:
            once.wait_visible('Connected to dsh ACP', 25)
            once.write('HIST_ONCE_TOKEN\r')
            shown = wait_answer(once, 'latest=HIST_ONCE_TOKEN', count=1)
            echo = latest_answer(shown)
            assert 'latest=HIST_ONCE_TOKEN' in echo, echo
            history_file = home / '.codsh-rust' / '.grok' / 'prompt-history.json'
            deadline = time.monotonic() + 5
            stored = []
            while time.monotonic() < deadline:
                once.pump(0.1)
                if history_file.exists():
                    stored = json.loads(history_file.read_text())
                    if stored.count('HIST_ONCE_TOKEN') == 1:
                        break
            assert stored.count('HIST_ONCE_TOKEN') == 1, stored
            once.write('\x1b[A')
            shown = once.wait_visible('history browse', 10)
            assert '1/1' in shown, shown
            assert '2/2' not in shown, shown
        finally:
            results.append(once.finish(expect_alt_leave=True))
            once.close()

        (output / 'result.json').write_text(json.dumps({
            'results': [{'name': item['name'], 'exit': item['exit']} for item in results],
        }, indent=2) + '\n')
        assert all(item['exit'] == 0 for item in results), results
    print(f'PASS: rust prompt-edit PTY; evidence: {output}')


if __name__ == '__main__':
    main()
