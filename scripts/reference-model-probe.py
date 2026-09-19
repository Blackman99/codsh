"""Exercise installed headless output against a loopback-only, keyless SSE fixture."""
import argparse
import http.server
import json
from pathlib import Path
import tempfile
import threading
import time
from importlib.util import spec_from_file_location, module_from_spec

spec = spec_from_file_location('reference_probe', Path(__file__).with_name('reference-probe.py'))
probe = module_from_spec(spec)
spec.loader.exec_module(probe)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    probe.validate_binary(binary)
    if args.output.exists():
        parser.error('Output must be a new file; existing evidence is never overwritten.')
    requests, observations = [], []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            requests.append({'method': 'GET', 'path': self.path})
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"data":[]}')

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
            requests.append({'method': 'POST', 'path': self.path, 'model': body.get('model'),
                             'tools': [tool['function'] for tool in body.get('tools', [])],
                             'messageCount': len(body.get('messages', []))})
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for delta, finish in [({'role': 'assistant'}, None),
                                  ({'content': 'REFERENCE_LOCAL_OK'}, None), ({}, 'stop')]:
                event = {'id': 'reference-133', 'created': 0, 'object': 'chat.completion.chunk',
                         'model': 'reference-fixture',
                         'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()
            self.wfile.write(b'data: [DONE]\n\n')

    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with tempfile.TemporaryDirectory(prefix='codsh-reference-model-133-') as tmp:
            reference = probe.Reference(binary, Path(tmp).resolve())
            reference.profile = probe.sandbox_profile(reference.root, reference.binary, Path.home(), server.server_port)
            (reference.grok / 'config.toml').write_text(probe.FIXTURE_CONFIG.replace(
                '127.0.0.1:1/', f'127.0.0.1:{server.server_port}/'))
            for output_format in ['plain', 'json', 'streaming-json', 'streaming-messages-json']:
                observation = reference.command(['-p', 'Reply with the fixture marker',
                                                  '--output-format', output_format], timeout=30)
                observations.append(observation)
            result = {'reference': probe.VERSION, 'binarySha256': probe.digest(reference.binary.read_bytes()),
                      'capturedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                      'network': 'deny all except one ephemeral loopback TCP port',
                      'fixture': 'three SSE chunks then [DONE]; no tools executed; no usage supplied',
                      'commands': observations, 'requests': requests}
            encoded = json.dumps(result, ensure_ascii=False, indent=2).replace(str(reference.root), '<ROOT>')
            encoded = encoded.replace(str(reference.root).replace('/', '%2F'), '<ENCODED_ROOT>')
            args.output.write_text(encoded + '\n')
    finally:
        server.shutdown()
        server.server_close()
        worker.join()
    if any(item['exit'] != 0 or 'REFERENCE_LOCAL_OK' not in item['stdout'] for item in observations):
        raise SystemExit('Reference output assertion failed; inspect the recorded evidence.')
    print(f'Passed {len(observations)} installed headless formats; {len(requests)} loopback requests.')


if __name__ == '__main__':
    main()
