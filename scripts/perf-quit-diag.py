#!/usr/bin/env python3
"""Scratch (#202): where does the candidate's quit time go on macOS?"""
import importlib.util, os, sys, tempfile, time
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('b', ROOT / 'scripts/rust-perf-bench.py')
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
launcher, dsh, node = sys.argv[1], sys.argv[2], sys.argv[3]
fx = b.Fixture()
c = b.Candidate(launcher, dsh, node)
for variant in ('idle', 'idle', 'idle', 'long', 'long', 'long', 'long-expand', 'long-expand', 'long-expand'):
    for mode in ('fullscreen', 'minimal'):
        root = Path(tempfile.mkdtemp(prefix='pq'))
        (root / 'workspace').mkdir()
        env = c.prepare(root, fx.port)
        trace = root / 'exit-trace.log'
        env['CODSH_EXIT_TRACE'] = str(trace)
        s = b.Session(c.argv(mode), env, root / 'workspace')
        try:
            s.wait(lambda t: 'Connected to dsh ACP' in t, 60)
            s.drain(0.5)
            if variant.startswith('long'):
                s.send(b.LONG_PROMPT.encode()); s.drain(0.3)
                sent = s.send(b'\r')
                s.wait_all({'end': b.answer_complete}, 60, since=sent)
                s.drain(1.0)
            if variant == 'long-expand':
                s.send(c.expand_keys); s.drain(1.0)
            t0 = time.time() * 1000
            s.send(c.quit_keys)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not s.exited():
                time.sleep(0.005)
            total = time.time() * 1000 - t0
            lines = trace.read_text().splitlines() if trace.exists() else []
            steps = ' | '.join(f"{float(l.split(' ', 1)[0]) - t0:.0f} {l.split(' ', 1)[1]}" for l in lines)
            print(f'{mode:10} {variant:12} quit={total:.0f}ms :: {steps}', flush=True)
        finally:
            s.close()
fx.close()
