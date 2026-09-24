#!/usr/bin/env python3
"""Process, network, and environment confinement for codsh --rust (ticket 12 / #144).

Runs the staged or debug codsh-rust. A profile with restrict_network must make
a child connect to 127.0.0.1 fail with EPERM, while a profile that allows
network still connects. A shell_environment_policy must hide a test credential
from `sh -c env` and show it when the policy allows it. Creating the cancel
path must kill the probe's process group, including a grandchild. A profile
that asks for a protection this platform cannot apply must refuse startup
instead of continuing. A macOS result does not claim Linux Landlock network.
"""

import errno
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path

# Not a *KEY* / *SECRET* / *TOKEN* name: the exclude list has to be what
# hides it. The default secret patterns are covered by the Rust unit test.
SECRET = "CODSH_TICKET12_CANARY"
SECRET_VALUE = "codsh-ticket12-not-a-real-credential"
EPERM = errno.EPERM


def fail(message):
    print(f"FAIL {message}")
    return 1


def binary_path(root):
    staged = root / "packages" / "cli" / "native" / f"{sys.platform}-{platform.machine()}" / "codsh-rust"
    debug = root / "rust" / "target" / "debug" / "codsh-rust"
    if debug.is_file() and (not staged.is_file() or debug.stat().st_mtime >= staged.stat().st_mtime):
        return debug
    return staged


def fixture_env(home, grok, dsh, secret):
    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "USERPROFILE": str(home),
        "GROK_HOME": str(grok),
        "DSH_HOME": str(dsh),
        "DSH_PROFILE": "rust",
        "TMPDIR": "/tmp" if Path("/tmp").is_dir() else tempfile.gettempdir(),
        SECRET: secret,
    })
    return env


def layout(work, name):
    base = work / name
    home = base / "home"
    grok = home / ".grok"
    dsh = home / "dsh"
    workspace = base / "workspace"
    for path in (grok, dsh, workspace):
        path.mkdir(parents=True)
    (grok / "config.toml").write_text("[ui]\npermission_mode = \"ask\"\n")
    return base, home, grok, dsh, workspace


def run_probe(binary, workspace, env, profile, script, report, cancel=None, timeout=30):
    report.unlink(missing_ok=True)
    argv = [str(binary), "--sandbox", profile, "--sandbox-report", str(report), "--sandbox-probe", str(script)]
    if cancel is not None:
        argv.extend(["--sandbox-cancel", str(cancel)])
    return subprocess.run(argv, cwd=workspace, env=env, text=True, capture_output=True, timeout=timeout)


def connect_script(marker):
    return textwrap.dedent(f"""\
        import errno, json, os, socket
        from pathlib import Path
        port = int(os.environ["CODSH_PROBE_PORT"])
        result = {{"errno": None, "connected": False}}
        sock = socket.socket()
        try:
            sock.connect(("127.0.0.1", port))
            result["connected"] = True
        except OSError as error:
            result["errno"] = error.errno
        finally:
            sock.close()
        Path({str(marker)!r}).write_text(json.dumps(result))
        """)


def probe_network(binary, work):
    """Denied connect is EPERM. Allowed connect succeeds. The listener is
    outside the sandbox, so a refusal is the child's, not a closed port."""
    results = {}
    for profile, restricted, expect in (
        ("netdeny", True, "denied"),
        ("netallow", False, "allowed"),
    ):
        base, home, grok, dsh, workspace = layout(work, profile)
        (grok / "sandbox.toml").write_text(
            f"[profiles.{profile}]\nextends = \"workspace\"\nrestrict_network = {'true' if restricted else 'false'}\n"
        )
        marker = workspace / "net.json"
        script = workspace / "net.py"
        script.write_text(connect_script(marker))
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        env = fixture_env(home, grok, dsh, SECRET_VALUE)
        env["CODSH_PROBE_PORT"] = str(port)
        completed = run_probe(binary, workspace, env, profile, script, base / "report.json")
        accepted = None
        listener.settimeout(0.2)
        try:
            accepted, _ = listener.accept()
        except OSError:
            accepted = None
        finally:
            if accepted is not None:
                accepted.close()
            listener.close()
        if completed.returncode != 0 or not marker.is_file():
            return fail(
                f"{profile}: probe did not run: status={completed.returncode} "
                f"stderr={completed.stderr.strip()} stdout={completed.stdout.strip()}"
            )
        effect = json.loads(marker.read_text())
        report = json.loads((base / "report.json").read_text())
        rules = report.get("networkRules") or ""
        if expect == "denied":
            if effect.get("connected") or effect.get("errno") != EPERM:
                return fail(f"{profile}: connect was not EPERM: {effect}")
            if "(deny network*)" not in rules or "(allow network-outbound)\n" in rules:
                return fail(f"{profile}: installed rules do not deny network: {rules!r}")
            if report.get("restrictNetwork") is not True:
                return fail(f"{profile}: report does not record the restriction: {report}")
        else:
            if not effect.get("connected"):
                return fail(f"{profile}: allowed connect failed: {effect}")
            if "(deny network*)" in rules:
                return fail(f"{profile}: allowed profile denied network: {rules!r}")
        results[profile] = effect
    return results


def env_script(marker):
    return textwrap.dedent(f"""\
        import json, subprocess
        from pathlib import Path
        text = subprocess.run(["sh", "-c", "env"], text=True, capture_output=True, check=True).stdout
        Path({str(marker)!r}).write_text(text)
        """)


def probe_env(binary, work):
    """`sh -c env` is the shell path. The secret is absent when excluded and
    present when include_only names it."""
    outcomes = {}
    cases = {
        "hidden": (
            "[shell_environment_policy]\ninherit = \"all\"\nexclude = [\"" + SECRET + "\"]\n",
            False,
        ),
        "shown": (
            # include_only filters the inherited set; it does not pull a name
            # back that inherit dropped. The secret must be inherited and then
            # opted out of the default *SECRET* exclude.
            "[shell_environment_policy]\ninherit = \"all\"\nignore_default_excludes = true\n"
            "include_only = [\"" + SECRET + "\", \"PATH\", \"CODSH_ENV_MARK\"]\n"
            "set = { CODSH_ENV_MARK = \"1\" }\n",
            True,
        ),
    }
    for name, (policy, present) in cases.items():
        base, home, grok, dsh, workspace = layout(work, name)
        (grok / "sandbox.toml").write_text(
            "[profiles.envbox]\nextends = \"workspace\"\nrestrict_network = false\n\n" + policy
        )
        marker = workspace / "env.txt"
        script = workspace / "env.py"
        script.write_text(env_script(marker))
        env = fixture_env(home, grok, dsh, SECRET_VALUE)
        completed = run_probe(binary, workspace, env, "envbox", script, base / "report.json")
        if completed.returncode != 0 or not marker.is_file():
            return fail(
                f"env {name}: probe did not run: status={completed.returncode} "
                f"stderr={completed.stderr.strip()}"
            )
        text = marker.read_text()
        found = any(line == f"{SECRET}={SECRET_VALUE}" for line in text.splitlines())
        if found != present:
            return fail(f"env {name}: secret present={found}, expected {present}")
        report = json.loads((base / "report.json").read_text())
        if report.get("shellEnvironmentFiltered") is not True:
            return fail(f"env {name}: report did not record the filter: {report}")
        if name == "shown" and "CODSH_ENV_MARK=1" not in text.splitlines():
            return fail(f"env {name}: set value missing: {text}")
        outcomes[name] = "present" if found else "absent"
    return outcomes


def grandchild_script(pidfile):
    return textwrap.dedent(f"""\
        import os, time
        from pathlib import Path
        pid = os.fork()
        if pid == 0:
            Path({str(pidfile)!r}).write_text(str(os.getpid()))
            while True:
                time.sleep(30)
        os.wait()
        """)


def probe_cancel(binary, work):
    """The cancel path kills the probe group. A forked grandchild must be
    gone, not reparented and still running."""
    base, home, grok, dsh, workspace = layout(work, "cancel")
    (grok / "sandbox.toml").write_text(
        "[profiles.hold]\nextends = \"workspace\"\nrestrict_network = false\n"
    )
    pidfile = workspace / "grandchild.pid"
    script = workspace / "hold.py"
    script.write_text(grandchild_script(pidfile))
    cancel = workspace / "cancel"
    env = fixture_env(home, grok, dsh, SECRET_VALUE)
    report = base / "report.json"
    process = subprocess.Popen(
        [str(binary), "--sandbox", "hold", "--sandbox-report", str(report),
         "--sandbox-probe", str(script), "--sandbox-cancel", str(cancel)],
        cwd=workspace, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and not pidfile.is_file():
        if process.poll() is not None:
            out, err = process.communicate()
            return fail(f"cancel: probe exited before the grandchild: {err} {out}")
        time.sleep(0.05)
    if not pidfile.is_file():
        process.kill()
        return fail("cancel: grandchild pid was not written")
    grandchild = int(pidfile.read_text().strip())
    os.kill(grandchild, 0)
    cancel.write_text("cancel")
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        return fail("cancel: client did not return after the cancel path appeared")
    time.sleep(0.2)
    try:
        os.kill(grandchild, 0)
    except OSError:
        return {"grandchild": grandchild, "status": process.returncode}
    else:
        os.kill(grandchild, signal.SIGKILL)
        return fail(f"cancel: grandchild {grandchild} still running after the group was killed")


def probe_refuse(binary, work):
    """A pattern the filter cannot express refuses startup. The report is
    written only after the profile is accepted, so a refusal leaves it absent."""
    base, home, grok, dsh, workspace = layout(work, "refuse")
    (grok / "sandbox.toml").write_text(
        "[profiles.bad]\nextends = \"workspace\"\n\n"
        "[shell_environment_policy]\ninherit = \"sometimes\"\n"
    )
    report = base / "report.json"
    script = workspace / "noop.py"
    script.write_text("raise SystemExit(0)\n")
    env = fixture_env(home, grok, dsh, SECRET_VALUE)
    completed = run_probe(binary, workspace, env, "bad", script, report)
    text = completed.stderr + completed.stdout
    if report.is_file() or completed.returncode == 0 or "inherit" not in text:
        return fail(
            f"refuse: unenforceable policy was not refused: status={completed.returncode} "
            f"report={report.is_file()} text={text.strip()}"
        )
    return {"status": completed.returncode, "text": text.strip().splitlines()[-1]}


def main():
    if platform.system() != "Darwin":
        return fail(
            f"network confinement was not verified on {platform.system()}; "
            "Linux Landlock network is not claimed from this run"
        )
    root = Path(__file__).resolve().parents[1]
    binary = binary_path(root)
    if not binary.is_file():
        return fail(f"missing native candidate at {binary}")
    work = Path(tempfile.mkdtemp(prefix=".codsh-net-sandbox-"))
    try:
        network = probe_network(binary, work)
        if isinstance(network, int):
            return network
        env = probe_env(binary, work)
        if isinstance(env, int):
            return env
        cancel = probe_cancel(binary, work)
        if isinstance(cancel, int):
            return cancel
        refused = probe_refuse(binary, work)
        if isinstance(refused, int):
            return refused
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print(
        "PASS network-env sandbox: "
        f"denied={network['netdeny']} allowed={network['netallow']} "
        f"env={env} cancel={cancel['status']} refuse={refused['status']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
