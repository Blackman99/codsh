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


def validate_output(command):
    if command['exit'] != 0 or command.get('timedOut'):
        raise ValueError('Reference command failed')
    output_format = command['args'][command['args'].index('--output-format') + 1]
    text = command['stdout']
    marker = 'REFERENCE_LOCAL_OK'
    if output_format == 'plain':
        valid = text.strip() == marker
    elif output_format == 'json':
        value = json.loads(text)
        valid = (isinstance(value, dict) and value.get('text') == marker
                 and value.get('stopReason') == 'end_turn'
                 and bool(value.get('sessionId')) and bool(value.get('requestId')))
    else:
        events = [json.loads(line) for line in text.splitlines() if line.strip()]
        if not events or any(not isinstance(event, dict) for event in events):
            raise ValueError('Expected structured stream events')
        if output_format == 'streaming-json':
            ends = [event for event in events if event.get('type') == 'end']
            valid = (len(ends) == 1 and events[-1] is ends[0]
                     and ends[0].get('stopReason') == 'end_turn'
                     and bool(ends[0].get('sessionId')) and bool(ends[0].get('requestId'))
                     and ''.join(event.get('data', '') for event in events if event.get('type') == 'text') == marker)
        elif output_format == 'streaming-messages-json':
            ends = [event for event in events if event.get('type') == 'result']
            init = events[0]
            assistants = [event for event in events if event.get('type') == 'assistant']
            valid = (init.get('type') == 'system' and init.get('subtype') == 'init'
                     and init.get('model') == 'reference-fixture' and bool(init.get('session_id'))
                     and len(ends) == 1 and events[-1] is ends[0]
                     and ends[0].get('subtype') == 'success' and ends[0].get('is_error') is False
                     and ends[0].get('result') == marker and ends[0].get('stop_reason') == 'end_turn'
                     and ends[0].get('session_id') == init.get('session_id')
                     and len(assistants) == 1
                     and assistants[0].get('session_id') == init.get('session_id')
                     and assistants[0].get('message', {}).get('role') == 'assistant'
                     and assistants[0].get('message', {}).get('model') == 'reference-fixture'
                     and assistants[0].get('message', {}).get('stop_reason') == 'end_turn'
                     and ''.join(block.get('text', '') for block in assistants[0].get('message', {}).get('content', []) if block.get('type') == 'text') == marker)
        else:
            raise ValueError('Unknown output format')
    if not valid:
        raise ValueError(f'Invalid {output_format} content or terminal record')


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
    for observation in observations:
        validate_output(observation)
    print(f'Passed {len(observations)} installed headless formats; {len(requests)} loopback requests.')


if __name__ == '__main__':
    main()
