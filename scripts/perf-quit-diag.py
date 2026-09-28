#!/usr/bin/env python3
"""Scratch (#202): where does the candidate's quit time go on macOS (full bench session)?"""
import importlib.util, sys, tempfile, time
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('b', ROOT / 'scripts/rust-perf-bench.py')
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
launcher, dsh, node = sys.argv[1], sys.argv[2], sys.argv[3]
fx = b.Fixture()
c = b.Candidate(launcher, dsh, node)
orig_send = b.Session.send
log = []
def send(self, data):
    at = orig_send(self, data)
    log.append((at, data[:12]))
    return at
b.Session.send = send
for i in range(4):
    for mode in ('fullscreen', 'minimal'):
        root = Path(tempfile.mkdtemp(prefix='pq'))
        (root / 'workspace').mkdir()
        env = c.prepare(root, fx.port)
        trace = root / 'exit-trace.log'
        env['CODSH_EXIT_TRACE'] = str(trace)
        log.clear()
        run = b.session_run(c, mode, env, root / 'workspace', fx)
        lines = trace.read_text().splitlines() if trace.exists() else []
        quit_sent = (log[-1][0] if log else 0) + (time.time() * 1000 - b.now_ms())
        steps = ' | '.join(f"{float(l.split(' ', 1)[0]) - quit_sent:.0f} {l.split(' ', 1)[1]}" for l in lines)
        print(f'{mode:10} run{i} quit={run.get("quit:exit")} missing={run["missing"]} keys={[k for _, k in log[-4:]]} :: {steps}', flush=True)
fx.close()
