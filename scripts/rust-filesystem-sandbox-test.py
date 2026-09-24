#!/usr/bin/env python3
"""Kernel filesystem confinement for codsh --rust (ticket 11 / #143).

Launches the staged native candidate directly so the probe is not filtered by
the launcher environment allowlist. A requested profile must deny an outside
write, a rename of a protected file, and a symlink escape, while an allowed
sibling write still succeeds. Unavailable enforcement must refuse startup.
"""

import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TEMP_ROOTS = (
    Path("/tmp"),
    Path("/private/tmp"),
    Path("/var/tmp"),
    Path("/private/var/tmp"),
)


def fail(message):
    print(f"FAIL {message}")
    return 1


def main():
    if platform.system() not in {"Darwin", "Linux"}:
        return fail(f"filesystem confinement is not supported on {platform.system()}")
    root = Path(__file__).resolve().parents[1]
    staged = root / "packages" / "cli" / "native" / f"{sys.platform}-{platform.machine()}" / "codsh-rust"
    debug = root / "rust" / "target" / "debug" / "codsh-rust"
    binary = debug if debug.is_file() and (not staged.is_file() or debug.stat().st_mtime >= staged.stat().st_mtime) else staged
    if not binary.is_file():
        return fail(f"missing native candidate at {binary}")
    work = fixture_root()
    outside_env = Path("/tmp") / f"codsh-outside-env-{os.getpid()}"
    try:
        return probe(binary, work, outside_env)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(outside_env, ignore_errors=True)


def fixture_root():
    """The workspace, read-only, and devbox profiles write-allow the default
    temp directories. A fixture created there cannot prove an outside write."""
    candidates = []
    home = Path.home()
    if home.is_dir():
        candidates.append(home)
    repo = Path(__file__).resolve().parents[1]
    if repo.parent.is_dir():
        candidates.append(repo.parent)
    for candidate in candidates:
        if inside_temp(candidate):
            continue
        try:
            path = Path(tempfile.mkdtemp(prefix=".codsh-fs-sandbox-", dir=candidate))
        except OSError:
            continue
        if inside_temp(path):
            shutil.rmtree(path, ignore_errors=True)
            continue
        return path
    return fail_root("no fixture directory outside /tmp, /var/tmp, and TMPDIR")


def inside_temp(path):
    resolved = path.resolve()
    roots = list(TEMP_ROOTS)
    tmpdir = os.environ.get("TMPDIR")
    if tmpdir:
        roots.append(Path(tmpdir))
    for root in roots:
        try:
            root = root.resolve()
        except OSError:
            continue
        if resolved == root or root in resolved.parents:
            return True
    return False


def fail_root(message):
    raise SystemExit(fail(message))


def refuse_unsupported(binary, workspace, env):
    """A raw `.` segment and an attached `**` must refuse before any policy."""
    grok = Path(env["GROK_HOME"])
    sandbox = grok / "sandbox.toml"
    sandbox.parent.mkdir(parents=True, exist_ok=True)
    original = sandbox.read_text() if sandbox.is_file() else None
    refused = []
    try:
        for pattern in ("a/./secret.txt", "**.pem", "certs/**.pem"):
            sandbox.write_text(
                "[profiles.bad]\nextends = \"workspace\"\n"
                f"deny = [\"{pattern}\"]\n"
            )
            # The report is written only after the profile is accepted, so a
            # refused glob leaves the file absent and names the pattern.
            report = workspace / f"refuse-{pattern.replace('/', '_')}.json"
            report.unlink(missing_ok=True)
            completed = subprocess.run(
                [str(binary), "--sandbox", "bad", "--sandbox-report", str(report)],
                cwd=workspace,
                env=env,
                text=True,
                capture_output=True,
                timeout=30,
            )
            text = completed.stderr + completed.stdout
            # Headless startup also exits 1, after a report. A refused glob
            # exits before that report and names the pattern.
            if report.is_file() or completed.returncode == 0 or pattern not in text:
                return fail(
                    f"{pattern} was not refused before apply: "
                    f"status={completed.returncode} report={report.is_file()} text={text.strip()}"
                )
            if "unsupported" not in text and "malformed" not in text:
                return fail(f"{pattern} refused without a glob reason: {text.strip()}")
            refused.append(pattern)
    finally:
        if original is None:
            sandbox.unlink(missing_ok=True)
        else:
            sandbox.write_text(original)
    return refused


def probe(binary, work, outside_env):
    home = work / "home"
    # The native candidate resolves config under $HOME/.grok unless GROK_HOME
    # is set. The launcher sets GROK_HOME; this direct probe must too.
    grok = home / ".grok"
    dsh = home / "dsh"
    workspace = work / "workspace"
    outside = work / "outside"
    prefixed = Path(str(workspace) + "-evil")
    sibling = workspace / "sibling"
    for path in (grok, dsh, workspace, outside, prefixed, sibling):
        path.mkdir(parents=True)
    secret = outside / "secret.txt"
    secret.write_text("keep")
    hook = work / "hook-target"
    hook.write_text("hook")
    mid = workspace / "mid"
    nested = mid / "nested-hooks"
    nested.mkdir(parents=True)
    nested_hook = nested / "target.sh"
    nested_hook.write_text("nested")
    (workspace / "certs" / "nested").mkdir(parents=True)
    (workspace / "nested").mkdir(parents=True)
    (workspace / ".env").write_text("inside")
    (workspace / "nested" / ".env").write_text("deep")
    (workspace / "certs" / "a.pem").write_text("inside-pem")
    (workspace / "certs" / "nested" / "a.pem").write_text("deep-pem")
    (workspace / "filea.txt").write_text("a")
    (workspace / "fileb.txt").write_text("b")
    (workspace / "noteb.txt").write_text("b")
    (workspace / "notec.txt").write_text("c")
    (outside / "certs").mkdir()
    (outside / ".env").write_text("outside")
    (outside / "certs" / "a.pem").write_text("outside-pem")
    (prefixed / ".env").write_text("prefix")
    (prefixed / "certs").mkdir()
    (prefixed / "certs" / "a.pem").write_text("prefix-pem")
    (grok / "hooks").mkdir()
    (grok / "hooks-paths").write_text(f"{hook}\n{nested_hook}\n")
    (grok / "config.toml").write_text("[ui]\npermission_mode = \"ask\"\n")
    (grok / "sandbox.toml").write_text(
        "[profiles.project]\n"
        "extends = \"workspace\"\n"
        "read_write = [\"" + str(sibling) + "\"]\n"
        "deny = [\"" + str(secret) + "\", \"**/*.pem\", \"**/.env\", \"certs/**/*.pem\", \"file[!a].txt\", \"note[^b].txt\"]\n"
    )
    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "USERPROFILE": str(home),
        # The launcher would set this to <HOME>/.codsh-rust/.grok. The probe
        # calls the native candidate directly, so name the fixture home.
        "GROK_HOME": str(grok),
        "DSH_HOME": str(dsh),
        "DSH_PROFILE": "rust",
        "TMPDIR": "/tmp" if Path("/tmp").is_dir() else tempfile.gettempdir(),
    })
    report = work / "report.json"
    marker = sibling / "marker.json"
    link = workspace / "escape"
    if link.exists() or link.is_symlink():
        link.unlink()
    link.symlink_to(outside)
    script = (
        "import json, pathlib, sys\n"
        f"outside = pathlib.Path({str(outside)!r})\n"
        f"secret = pathlib.Path({str(secret)!r})\n"
        f"sibling = pathlib.Path({str(sibling)!r})\n"
        f"link = pathlib.Path({str(link)!r})\n"
        f"hook = pathlib.Path({str(hook)!r})\n"
        f"nested = pathlib.Path({str(nested)!r})\n"
        f"mid = pathlib.Path({str(mid)!r})\n"
        f"config = pathlib.Path({str(grok / 'config.toml')!r})\n"
        f"grok = pathlib.Path({str(grok)!r})\n"
        f"marker = pathlib.Path({str(marker)!r})\n"
        f"workspace = pathlib.Path({str(workspace)!r})\n"
        f"prefixed = pathlib.Path({str(prefixed)!r})\n"
        "results = {}\n"
        "try:\n"
        "    results['secret_read'] = 'allowed:' + secret.read_text()\n"
        "except OSError as error:\n"
        "    results['secret_read'] = f'denied:{error.errno}'\n"
        "try:\n"
        "    (outside / 'planted.txt').write_text('nope')\n"
        "    results['outside_write'] = 'allowed'\n"
        "except OSError as error:\n"
        "    results['outside_write'] = f'denied:{error.errno}'\n"
        "try:\n"
        "    secret.rename(sibling / 'stolen.txt')\n"
        "    results['rename'] = 'allowed'\n"
        "except OSError as error:\n"
        "    results['rename'] = f'denied:{error.errno}'\n"
        "try:\n"
        f"    grok.rename(pathlib.Path({str(Path('/tmp') / f'codsh-moved-grok-{os.getpid()}')!r}))\n"
        "    results['rename_home'] = 'allowed'\n"
        "except OSError as error:\n"
        "    results['rename_home'] = f'denied:{error.errno}'\n"
        "try:\n"
        f"    nested.rename(pathlib.Path({str(Path('/tmp') / f'codsh-moved-nested-{os.getpid()}')!r}))\n"
        "    results['rename_hook_parent'] = 'allowed'\n"
        "except OSError as error:\n"
        "    results['rename_hook_parent'] = f'denied:{error.errno}'\n"
        "try:\n"
        f"    mid.rename(pathlib.Path({str(Path('/tmp') / f'codsh-moved-mid-{os.getpid()}')!r}))\n"
        "    results['rename_hook_ancestor'] = 'allowed'\n"
        "except OSError as error:\n"
        "    results['rename_hook_ancestor'] = f'denied:{error.errno}'\n"
        "try:\n"
        "    (nested / 'sibling.txt').write_text('yes')\n"
        "    results['nested_sibling'] = 'allowed'\n"
        "except OSError as error:\n"
        "    results['nested_sibling'] = f'denied:{error.errno}'\n"
        "try:\n"
        "    (link / 'via-symlink.txt').write_text('nope')\n"
        "    results['symlink'] = 'allowed'\n"
        "except OSError as error:\n"
        "    results['symlink'] = f'denied:{error.errno}'\n"
        "try:\n"
        "    hook.write_text('changed')\n"
        "    results['hook'] = 'allowed'\n"
        "except OSError as error:\n"
        "    results['hook'] = f'denied:{error.errno}'\n"
        "try:\n"
        "    config.write_text('changed')\n"
        "    results['config'] = 'allowed'\n"
        "except OSError as error:\n"
        "    results['config'] = f'denied:{error.errno}'\n"
        "try:\n"
        "    (sibling / 'ok.txt').write_text('yes')\n"
        "    results['sibling'] = 'allowed'\n"
        "except OSError as error:\n"
        "    results['sibling'] = f'denied:{error.errno}'\n"
        "pem = sibling / 'new.pem'\n"
        "try:\n"
        "    pem.write_text('key')\n"
        "    results['glob'] = 'allowed'\n"
        "except OSError as error:\n"
        "    results['glob'] = f'denied:{error.errno}'\n"
        "def touch(path):\n"
        "    try:\n"
        "        path.write_text('new')\n"
        "        return 'allowed'\n"
        "    except OSError as error:\n"
        "        return f'denied:{error.errno}'\n"
        "def read(path):\n"
        "    try:\n"
        "        path.read_text()\n"
        "        return 'allowed'\n"
        "    except OSError as error:\n"
        "        return f'denied:{error.errno}'\n"
        "results['inside_env'] = read(workspace / '.env')\n"
        "results['deep_env'] = read(workspace / 'nested' / '.env')\n"
        "results['inside_pem'] = read(workspace / 'certs' / 'a.pem')\n"
        "results['deep_pem'] = read(workspace / 'certs' / 'nested' / 'a.pem')\n"
        "results['outside_env'] = read(outside / '.env')\n"
        "results['outside_pem'] = read(outside / 'certs' / 'a.pem')\n"
        "results['prefix_env'] = read(prefixed / '.env')\n"
        "results['prefix_pem'] = read(prefixed / 'certs' / 'a.pem')\n"
        "results['inside_env_write'] = touch(workspace / 'nested' / '.env')\n"
        "results['plain_write'] = touch(workspace / 'plain.txt')\n"
        f"allowed_outside = pathlib.Path({str(outside_env)!r})\n"
        "allowed_outside.mkdir(parents=True, exist_ok=True)\n"
        "results['outside_env_write'] = touch(allowed_outside / '.env')\n"
        "results['file_a'] = read(workspace / 'filea.txt')\n"
        "results['file_b'] = read(workspace / 'fileb.txt')\n"
        "results['note_b'] = read(workspace / 'noteb.txt')\n"
        "results['note_c'] = read(workspace / 'notec.txt')\n"
        "try:\n"
        "    results['secret_exists'] = secret.exists()\n"
        "except OSError as error:\n"
        "    results['secret_exists'] = f'denied:{error.errno}'\n"


        "marker.write_text(json.dumps(results))\n"
    )
    probe_py = work / "probe.py"
    probe_py.write_text(script)
    completed = subprocess.run(
        [
            str(binary),
            "--sandbox",
            "project",
            "--sandbox-report",
            str(report),
            "--sandbox-probe",
            str(probe_py),
        ],
        cwd=workspace,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
    )
    if completed.returncode != 0:
        return fail(
            "sandbox startup refused unexpectedly: "
            f"status={completed.returncode} stderr={completed.stderr.strip()} stdout={completed.stdout.strip()}"
        )
    if not report.is_file() or not marker.is_file():
        return fail(
            "kernel probe did not run: "
            f"stderr={completed.stderr.strip()} stdout={completed.stdout.strip()}"
        )
    payload = json.loads(report.read_text())
    effects = json.loads(marker.read_text())
    if payload.get("applied") is not True or payload.get("mechanism") not in {"Seatbelt", "Landlock"}:
        return fail(f"report does not show kernel enforcement: {payload}")
    expected_denied = (
        "outside_write",
        "rename",
        "rename_home",
        "rename_hook_parent",
        "rename_hook_ancestor",
        "symlink",
        "hook",
        "config",
        "glob",
        "secret_read",
        "inside_env",
        "deep_env",
        "inside_pem",
        "deep_pem",
        "inside_env_write",
        "file_b",
        "note_c",
    )
    for key in expected_denied:
        if not str(effects.get(key, "")).startswith("denied"):
            return fail(f"{key} was not kernel-denied: {effects}")
    allowed = (
        "sibling",
        "nested_sibling",
        "outside_env",
        "outside_pem",
        "prefix_env",
        "prefix_pem",
        "outside_env_write",
        "plain_write",
        "file_a",
        "note_b",
    )
    for key in allowed:
        if effects.get(key) != "allowed":
            return fail(f"{key} was not allowed: {effects}")
    if secret.read_text() != "keep":
        return fail(f"protected secret bytes changed: {effects}")
    if not grok.is_dir() or not (grok / "config.toml").is_file():
        return fail(f"$GROK_HOME was renamed away: {effects}")
    if not hook.is_file() or hook.read_text() != "hook":
        return fail(f"hook bytes changed: {effects}")
    if not nested.is_dir() or (nested / "target.sh").read_text() != "nested":
        return fail(f"hook parent inside the workspace was renamed away: {effects}")
    if not mid.is_dir():
        return fail(f"hook ancestor inside the workspace was renamed away: {effects}")
    if (outside / "planted.txt").exists() or (sibling / "stolen.txt").exists() or (link / "via-symlink.txt").exists():
        return fail(f"protected filesystem changed: {effects}")
    if hook.read_text() != "hook" or "changed" in (grok / "config.toml").read_text():
        return fail("hook or config bytes changed")
    refused = refuse_unsupported(binary, workspace, env)
    if refused != ["a/./secret.txt", "**.pem", "certs/**.pem"]:
        return refused if isinstance(refused, int) else fail(f"unsupported globs were not all refused: {refused}")
    print(json.dumps({
        "ok": True,
        "mechanism": payload.get("mechanism"),
        "platform": payload.get("platform"),
        "profile": payload.get("profile"),
        "refused": refused,
        "effects": effects,
    }))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.TimeoutExpired:
        sys.exit(fail("sandbox probe timed out"))
