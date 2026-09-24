#!/usr/bin/env python3
"""Kernel filesystem confinement for codsh --rust (ticket 11 / #143).

Launches the staged native candidate directly so the probe is not filtered by
the launcher environment allowlist. A requested profile must deny an outside
write, a rename of a protected file, and a symlink escape, while an allowed
sibling write still succeeds. Unavailable enforcement must refuse startup.

It also proves the glob literal-prefix rename is pinned, and probes the
launchd escape (`launchctl submit` / `bootstrap gui/$UID`) with a unique
user-domain job label and strict teardown, asserting a sandboxed child cannot
get an unconfined process to read a denied file.
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


PROBE_HELPERS = (
    "import json, os, pathlib, sys\n"
    "def attempt(action):\n"
    "    try:\n"
    "        value = action()\n"
    "        return 'allowed' if value is None else f'allowed:{value}'\n"
    "    except OSError as error:\n"
    "        return f'denied:{error.errno}'\n"
    "ops = {\n"
    "    'read': lambda path, _: attempt(lambda: pathlib.Path(path).read_text()),\n"
    "    'write': lambda path, _: attempt(lambda: pathlib.Path(path).write_text('changed') and None),\n"
    "    'rename': lambda path, dest: attempt(lambda: os.rename(path, dest)),\n"
    "}\n"
)


def run_checks(binary, cwd, env, profile, checks, marker, report):
    """Run one sandboxed probe child and return (status, report, effects).

    `checks` is a list of (key, op, path, dest). The probe runs as a child of
    the sandboxed client, so every result is a real kernel effect."""
    lines = [PROBE_HELPERS, "results = {}\n"]
    for key, op, path, dest in checks:
        lines.append(f"results[{key!r}] = ops[{op!r}]({str(path)!r}, {str(dest) if dest else ''!r})\n")
    lines.append(f"pathlib.Path({str(marker)!r}).write_text(json.dumps(results))\n")
    script = marker.with_suffix(".py")
    script.write_text("".join(lines))
    marker.unlink(missing_ok=True)
    report.unlink(missing_ok=True)
    completed = subprocess.run(
        [str(binary), "--sandbox", profile, "--sandbox-report", str(report), "--sandbox-probe", str(script)],
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
    )
    payload = json.loads(report.read_text()) if report.is_file() else None
    effects = json.loads(marker.read_text()) if marker.is_file() else None
    return completed, payload, effects


def expect_effects(label, completed, payload, effects, denied, allowed):
    if completed.returncode != 0 or payload is None or effects is None:
        return fail(
            f"{label}: sandbox probe did not run: status={completed.returncode} "
            f"stderr={completed.stderr.strip()} stdout={completed.stdout.strip()}"
        )
    if payload.get("applied") is not True:
        return fail(f"{label}: report does not show kernel enforcement: {payload}")
    for key in denied:
        if not str(effects.get(key, "")).startswith("denied"):
            return fail(f"{label}: {key} was not kernel-denied: {effects} report={payload}")
    for key in allowed:
        if not str(effects.get(key, "")).startswith("allowed"):
            return fail(f"{label}: {key} was not allowed: {effects}")
    return 0


def fixture_env(home, grok, dsh):
    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "USERPROFILE": str(home),
        "GROK_HOME": str(grok),
        "DSH_HOME": str(dsh),
        "DSH_PROFILE": "rust",
        "TMPDIR": "/tmp" if Path("/tmp").is_dir() else tempfile.gettempdir(),
    })
    return env


def probe_devbox_deny(binary, work):
    """`extends = "devbox"` keeps the user's deny list. Only the global
    hook/config write protection is skipped, as the reference documents."""
    base = work / "devbox"
    home = base / "home"
    grok = home / ".grok"
    dsh = home / "dsh"
    workspace = base / "workspace"
    for path in (grok, dsh, workspace / "keep"):
        path.mkdir(parents=True)
    secret = workspace / "keep" / "secret.txt"
    secret.write_text("keep")
    config = grok / "config.toml"
    config.write_text("[ui]\npermission_mode = \"ask\"\n")
    (grok / "sandbox.toml").write_text(
        "[profiles.devdeny]\nextends = \"devbox\"\n"
        f"deny = [\"{secret}\", \"**/*.key\"]\n"
    )
    (workspace / "id.key").write_text("key")
    env = fixture_env(home, grok, dsh)
    completed, payload, effects = run_checks(
        binary, workspace, env, "devdeny",
        [
            ("secret_read", "read", secret, None),
            ("secret_write", "write", secret, None),
            ("secret_rename", "rename", secret, workspace / "stolen.txt"),
            ("parent_rename", "rename", workspace / "keep", workspace / "moved"),
            ("glob_read", "read", workspace / "id.key", None),
            ("plain_write", "write", workspace / "plain.txt", None),
            # devbox is documented not to write-protect global config.
            ("config_write", "write", config, None),
        ],
        workspace / "devbox-marker.json",
        base / "devbox-report.json",
    )
    status = expect_effects(
        "devbox+deny", completed, payload, effects,
        denied=("secret_read", "secret_write", "secret_rename", "parent_rename", "glob_read"),
        allowed=("plain_write", "config_write"),
    )
    if status:
        return status
    if not any(str(secret) in str(item) for item in payload.get("readDenied", [])):
        return fail(f"devbox+deny: report readDenied omits the user deny: {payload}")
    if secret.read_text() != "keep" or (workspace / "stolen.txt").exists() or not (workspace / "keep").is_dir():
        return fail(f"devbox+deny: protected bytes or names changed: {effects}")
    return {"profile": "devdeny", "effects": effects}


def probe_symlinked_prefix(binary, work):
    """Seatbelt matches resolved paths. A deny under /tmp (a symlink to
    /private/tmp) or under any symlinked directory must still hold."""
    base = work / "symlinked"
    home = base / "home"
    grok = home / ".grok"
    dsh = home / "dsh"
    workspace = base / "workspace"
    real = base / "real"
    link = base / "link"
    for path in (grok, dsh, workspace, real / "nested"):
        path.mkdir(parents=True)
    link.symlink_to(real)
    (real / "nested" / "x.key").write_text("key")
    (real / "ok.txt").write_text("ok")
    tmp = Path("/tmp") / f"codsh-glob-{os.getpid()}"
    shutil.rmtree(tmp, ignore_errors=True)
    (tmp / "nested").mkdir(parents=True)
    (tmp / "nested" / "a.key").write_text("key")
    (tmp / "ok.txt").write_text("ok")
    try:
        (grok / "sandbox.toml").write_text(
            "[profiles.linked]\nextends = \"workspace\"\n"
            f"deny = [\"{tmp}/**/*.key\", \"{tmp}/late.txt\", \"{link}/**/*.key\"]\n"
        )
        env = fixture_env(home, grok, dsh)
        private = Path("/private") / tmp.relative_to("/")
        completed, payload, effects = run_checks(
            binary, workspace, env, "linked",
            [
                ("tmp_glob_read", "read", tmp / "nested" / "a.key", None),
                ("private_glob_read", "read", private / "nested" / "a.key", None),
                ("tmp_glob_create", "write", tmp / "new.key", None),
                ("tmp_late_exact_create", "write", tmp / "late.txt", None),
                ("tmp_sibling_read", "read", tmp / "ok.txt", None),
                ("tmp_sibling_write", "write", tmp / "other.txt", None),
                ("link_glob_read", "read", link / "nested" / "x.key", None),
                ("real_glob_read", "read", real / "nested" / "x.key", None),
                ("real_sibling_read", "read", real / "ok.txt", None),
            ],
            workspace / "linked-marker.json",
            base / "linked-report.json",
        )
        status = expect_effects(
            "symlinked prefix", completed, payload, effects,
            denied=("tmp_glob_read", "private_glob_read", "tmp_glob_create", "tmp_late_exact_create",
                    "link_glob_read", "real_glob_read"),
            allowed=("tmp_sibling_read", "tmp_sibling_write", "real_sibling_read"),
        )
        if status:
            return status
        if (tmp / "new.key").exists() or (tmp / "late.txt").exists():
            return fail(f"symlinked prefix: a denied path was created: {effects}")
        return {"profile": "linked", "effects": effects}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def probe_metachar_workspace(binary, work):
    """A workspace named with glob metacharacters is a literal prefix. It must
    not be read as a class or wildcard that misses itself and hits a sibling."""
    base = work / "metachar"
    home = base / "home"
    grok = home / ".grok"
    dsh = home / "dsh"
    workspace = base / "ws[12]*?"
    sibling = base / "ws1ab"
    for path in (grok, dsh, workspace, sibling):
        path.mkdir(parents=True)
    (workspace / "a.pem").write_text("pem")
    (sibling / "a.pem").write_text("pem")
    (workspace / "ok.txt").write_text("ok")
    (grok / "sandbox.toml").write_text(
        "[profiles.meta]\nextends = \"workspace\"\ndeny = [\"**/*.pem\"]\n"
    )
    env = fixture_env(home, grok, dsh)
    completed, payload, effects = run_checks(
        binary, workspace, env, "meta",
        [
            ("workspace_pem", "read", workspace / "a.pem", None),
            ("workspace_new_pem", "write", workspace / "b.pem", None),
            ("workspace_ok", "read", workspace / "ok.txt", None),
            ("sibling_pem", "read", sibling / "a.pem", None),
        ],
        workspace / "meta-marker.json",
        base / "meta-report.json",
    )
    status = expect_effects(
        "metachar workspace", completed, payload, effects,
        denied=("workspace_pem", "workspace_new_pem"),
        allowed=("workspace_ok", "sibling_pem"),
    )
    if status:
        return status
    return {"profile": "meta", "effects": effects}


def refuse_unresolvable(binary, work):
    """A protection whose path cannot be resolved or expressed refuses
    startup before any report, instead of starting with a dead rule."""
    base = work / "unresolvable"
    home = base / "home"
    grok = home / ".grok"
    dsh = home / "dsh"
    workspace = base / "workspace"
    for path in (grok, dsh, workspace):
        path.mkdir(parents=True)
    dangling = base / "dangling"
    dangling.symlink_to(base / "no-such-target")
    env = fixture_env(home, grok, dsh)
    cases = {
        "dangling-glob": (f"{dangling}/**/*.key", str(dangling)),
        "dangling-exact": (f"{dangling}/secret.txt", str(dangling)),
        "control-char": ("sec\\u0007ret.txt", "control"),
    }
    refused = []
    for label, (entry, needle) in cases.items():
        (grok / "sandbox.toml").write_text(
            f"[profiles.bad]\nextends = \"workspace\"\ndeny = [\"{entry}\"]\n"
        )
        report = base / f"{label}.json"
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
        if report.is_file() or completed.returncode == 0 or "refusing sandbox" not in text or needle not in text:
            return fail(
                f"{label} was not refused before apply: status={completed.returncode} "
                f"report={report.is_file()} text={text.strip()}"
            )
        refused.append(label)
    return refused


def probe_glob_parent_rename(binary, work):
    """A deny glob is anchored at its literal prefix. Renaming that prefix
    directory would move the matched subtree out from under the runtime regex,
    so the literal prefix and its ancestors up to the write root are pinned.
    A rename inside the glob tail still matches the regex and stays allowed."""
    base = work / "glob-rename"
    home = base / "home"
    grok = home / ".grok"
    dsh = home / "dsh"
    workspace = base / "workspace"
    for path in (grok, dsh, workspace / "secrets" / "sub"):
        path.mkdir(parents=True)
    (workspace / "secrets" / "a.key").write_text("KEY")
    (workspace / "secrets" / "sub" / "deep.key").write_text("DEEP")
    (grok / "sandbox.toml").write_text(
        "[profiles.gr]\nextends = \"workspace\"\ndeny = [\"secrets/**/*.key\"]\n"
    )
    env = fixture_env(home, grok, dsh)
    completed, payload, effects = run_checks(
        binary, workspace, env, "gr",
        [
            ("glob_read", "read", workspace / "secrets" / "a.key", None),
            ("deep_read", "read", workspace / "secrets" / "sub" / "deep.key", None),
            # Renaming the glob root out of the anchor must be denied.
            ("rename_glob_root", "rename", workspace / "secrets", workspace / "public"),
            # A rename inside the tail keeps matching the regex, so it is
            # allowed and does not expose the key.
            ("rename_intermediate", "rename", workspace / "secrets" / "sub", workspace / "secrets" / "moved"),
            ("deep_read_after", "read", workspace / "secrets" / "moved" / "deep.key", None),
        ],
        workspace / "glob-rename-marker.json",
        base / "glob-rename-report.json",
    )
    status = expect_effects(
        "glob parent rename", completed, payload, effects,
        denied=("glob_read", "deep_read", "rename_glob_root", "deep_read_after"),
        allowed=("rename_intermediate",),
    )
    if status:
        return status
    if not (workspace / "secrets" / "a.key").is_file() or (workspace / "public").exists():
        return fail(f"glob parent rename: the glob root was moved: {effects}")
    return {"profile": "gr", "effects": effects}


def launchctl_present():
    return Path("/bin/launchctl").is_file()


def sweep_launchd(label):
    """Authoritative cleanup from the unsandboxed harness. No sudo, no system
    domain; only the throwaway user-domain job this probe may have created."""
    uid = os.getuid()
    for argv in (
        ["/bin/launchctl", "remove", label],
        ["/bin/launchctl", "bootout", f"gui/{uid}/{label}"],
    ):
        try:
            subprocess.run(argv, capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        listed = subprocess.run(["/bin/launchctl", "list"], capture_output=True, text=True, timeout=10)
        return label not in listed.stdout
    except (OSError, subprocess.SubprocessError):
        return True


def probe_launchd_escape(binary, work):
    """Item 4 (#143). A sandboxed child must not use launchd to get an
    unconfined process to read a denied file. Unsandboxed both `launchctl
    submit` and `launchctl bootstrap gui/$UID` do exactly that; under the
    applied Seatbelt profile they must not. The job label is unique and the
    job is torn down here and swept by the harness — no persistent launchd
    job is left behind."""
    if platform.system() != "Darwin" or not launchctl_present():
        return {"skipped": "launchctl unavailable"}
    base = work / "launchd"
    home = base / "home"
    grok = home / ".grok"
    dsh = home / "dsh"
    workspace = base / "workspace"
    for path in (grok, dsh, workspace):
        path.mkdir(parents=True)
    secret = workspace / "secret.txt"
    secret.write_text("LAUNCHD_SECRET")
    (grok / "sandbox.toml").write_text(
        "[profiles.ld]\nextends = \"workspace\"\ndeny = [\"secret.txt\"]\n"
    )
    label = f"codsh.sandboxprobe.{os.getpid()}.{int.from_bytes(os.urandom(3), 'big')}"
    exfil = Path("/tmp") / f"{label}.exfil"
    plist = workspace / "job.plist"
    exfil.unlink(missing_ok=True)
    uid = os.getuid()
    plist.write_text(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>"
        f"<key>Label</key><string>{label}</string>"
        "<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>"
        f"<string>cat {secret} > {exfil}</string></array>"
        "<key>RunAtLoad</key><true/></dict></plist>\n"
    )
    marker = workspace / "launchd-marker.json"
    report = base / "launchd-report.json"
    script = workspace / "launchd-probe.py"
    script.write_text(
        "import json, os, pathlib, subprocess, time\n"
        f"label = {label!r}\n"
        f"secret = {str(secret)!r}\n"
        f"exfil = {str(exfil)!r}\n"
        f"plist = {str(plist)!r}\n"
        f"uid = {uid}\n"
        "res = {}\n"
        "def attempt(argv):\n"
        "    try:\n"
        "        c = subprocess.run(argv, capture_output=True, text=True, timeout=15)\n"
        "        return {'rc': c.returncode, 'err': (c.stderr or c.stdout).strip()[:200]}\n"
        "    except OSError as e:\n"
        "        return {'rc': 'oserr', 'err': str(e)}\n"
        "try:\n"
        "    res['direct'] = 'allowed:' + open(secret).read()\n"
        "except OSError as e:\n"
        "    res['direct'] = f'denied:{e.errno}'\n"
        "res['submit'] = attempt(['/bin/launchctl', 'submit', '-l', label, '--', '/bin/sh', '-c', f'cat {secret} > {exfil}'])\n"
        "time.sleep(2)\n"
        "res['bootstrap'] = attempt(['/bin/launchctl', 'bootstrap', f'gui/{uid}', plist])\n"
        "time.sleep(2)\n"
        "try:\n"
        "    res['exfil'] = 'read:' + open(exfil).read()\n"
        "except OSError as e:\n"
        "    res['exfil'] = f'absent:{e.errno}'\n"
        "# Best-effort teardown from inside the sandbox; the harness sweeps too.\n"
        "attempt(['/bin/launchctl', 'remove', label])\n"
        "attempt(['/bin/launchctl', 'bootout', f'gui/{uid}/{label}'])\n"
        "pathlib.Path(os.environ['PROBE_OUT']).write_text(json.dumps(res))\n"
    )
    env = fixture_env(home, grok, dsh)
    env["PROBE_OUT"] = str(marker)
    try:
        completed = subprocess.run(
            [str(binary), "--sandbox", "ld", "--sandbox-report", str(report), "--sandbox-probe", str(script)],
            cwd=workspace,
            env=env,
            text=True,
            capture_output=True,
            timeout=60,
        )
        if completed.returncode != 0 or not marker.is_file():
            return fail(
                f"launchd probe did not run: status={completed.returncode} "
                f"stderr={completed.stderr.strip()} stdout={completed.stdout.strip()}"
            )
        res = json.loads(marker.read_text())
        if not str(res.get("direct", "")).startswith("denied"):
            return fail(f"launchd probe: the denied secret was directly readable: {res}")
        # The escape is blocked when the exfil file never receives the secret.
        if not str(res.get("exfil", "")).startswith("absent") or "LAUNCHD_SECRET" in str(res.get("exfil", "")):
            return fail(f"launchd escape succeeded: an unconfined job exfiltrated the secret: {res}")
        if exfil.exists() and "LAUNCHD_SECRET" in exfil.read_text():
            return fail(f"launchd escape succeeded: exfil file holds the secret: {res}")
        return {"profile": "ld", "submit": res.get("submit"), "bootstrap": res.get("bootstrap"), "exfil": res.get("exfil")}
    finally:
        exfil.unlink(missing_ok=True)
        if not sweep_launchd(label):
            return fail(f"launchd probe left a job behind: {label}")


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
    extra = {}
    for name, scenario in (
        ("devbox", probe_devbox_deny),
        ("symlinked", probe_symlinked_prefix),
        ("metachar", probe_metachar_workspace),
        ("glob_rename", probe_glob_parent_rename),
        ("launchd", probe_launchd_escape),
    ):
        result = scenario(binary, work)
        if isinstance(result, int):
            return result
        extra[name] = result
    unresolvable = refuse_unresolvable(binary, work)
    if isinstance(unresolvable, int):
        return unresolvable
    print(json.dumps({
        "ok": True,
        "mechanism": payload.get("mechanism"),
        "platform": payload.get("platform"),
        "profile": payload.get("profile"),
        "refused": refused + unresolvable,
        "effects": effects,
        "scenarios": extra,
    }))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.TimeoutExpired:
        sys.exit(fail("sandbox probe timed out"))
