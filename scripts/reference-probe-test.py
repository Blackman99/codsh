"""Safety and command-discovery checks for the reference probe driver."""
import importlib.util
from pathlib import Path
import platform
import socket
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('reference_probe', Path(__file__).with_name('reference-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


model_spec = importlib.util.spec_from_file_location('reference_model_probe', Path(__file__).with_name('reference-model-probe.py'))
model_probe = importlib.util.module_from_spec(model_spec)
model_spec.loader.exec_module(model_probe)


class ReferenceProbeTests(unittest.TestCase):
    def test_structured_formats_reject_marker_only_and_missing_terminator(self):
        for output_format in ['json', 'streaming-json', 'streaming-messages-json']:
            command = {'args': ['--output-format', output_format], 'exit': 0, 'timedOut': False,
                       'stdout': 'REFERENCE_LOCAL_OK\nNOT JSON'}
            with self.assertRaises(ValueError):
                model_probe.validate_output(command)
        import json
        capture = json.loads((Path(__file__).parent.parent / 'docs/rewrite/reference/model-observations.json').read_text())
        for command in capture['commands']:
            model_probe.validate_output(command)
            if command['args'][-1].startswith('streaming'):
                broken = dict(command, stdout='\n'.join(command['stdout'].splitlines()[:-1]))
                with self.assertRaises(ValueError):
                    model_probe.validate_output(broken)

    def test_help_tree_excludes_options(self):
        self.assertEqual(probe.help_commands('Commands:\n  list  List\n  help  Help\n\nOptions:\n  --json  JSON\n'), ['list', 'help'])

    def test_environment_is_allowlisted(self):
        with tempfile.TemporaryDirectory() as tmp:
            reference = probe.Reference(Path('/bin/cat'), Path(tmp).resolve())
            self.assertEqual(reference.env['HOME'], str(reference.home))
            self.assertEqual(reference.env['GROK_HOME'], str(reference.grok))
            self.assertNotIn('GITHUB_TOKEN', reference.env)
            self.assertNotIn('SSH_AUTH_SOCK', reference.env)
            self.assertEqual(reference.env['XAI_API_KEY'], 'synthetic-reference-key')

    def test_sandbox_rejects_profile_injection(self):
        with self.assertRaises(ValueError):
            probe.sandbox_profile('/tmp/"escape', '/bin/cat', '/tmp/private')

    @unittest.skipUnless(platform.system() == 'Darwin', 'macOS enforcement probe')
    def test_actual_read_write_and_network_denial(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            allowed, protected = root / 'allowed', root / 'protected'
            allowed.mkdir()
            protected.mkdir()
            canary = protected / 'canary'
            canary.write_text('synthetic-private-canary')
            profile = probe.sandbox_profile(allowed, Path('/bin/cat'), protected)
            def run(*command):
                return subprocess.run(['/usr/bin/sandbox-exec', '-p', profile, *command],
                                      env={'PATH': '/usr/bin:/bin', 'HOME': str(allowed)},
                                      cwd=allowed, capture_output=True, timeout=5)
            self.assertNotEqual(run('/bin/cat', str(canary)).returncode, 0)
            self.assertEqual(run('/usr/bin/touch', str(allowed / 'permitted')).returncode, 0)
            self.assertNotEqual(run('/usr/bin/touch', str(protected / 'forbidden')).returncode, 0)
            self.assertFalse((protected / 'forbidden').exists())
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                listener.listen()
                listener.settimeout(0.1)
                result = run('/usr/bin/curl', '--noproxy', '*', '--max-time', '1',
                             f'http://127.0.0.1:{listener.getsockname()[1]}/')
                self.assertNotEqual(result.returncode, 0)
                with self.assertRaises(TimeoutError):
                    listener.accept()


if __name__ == '__main__':
    unittest.main()
