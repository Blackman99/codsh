#!/usr/bin/env python3
"""Real-terminal image generation and editing (ticket 187).

A keyless loopback image service (xAI-shaped `/v1/images/generations` and
`/v1/images/edits`, started by this script) is configured as
`[models] image_gen`. In one interactive session through the packed and
installed codsh with the native binary from `pnpm run build:rust`:

- the model is offered image_gen and image_edit;
- a call opens the approval card naming the prompt, the host and the cost
  note; `n` sends nothing, `y` sends one request and the image is saved to
  `<session>/images/1.png` and named in the transcript;
- `/imagine` alone shows its usage; `/imagine <prompt>` makes the model call
  image_gen with the prompt verbatim;
- a Ctrl+V clipboard image becomes `[Image #1]`; image_edit resolves it to
  the saved attachment, sends it as a data URL and saves `images/3.png`;
- a refusal, a non-image body, a URL-only reply and an HTTP 402 each fail
  with the service's reason and save nothing (the URL is never fetched);
- Ctrl+C while the service is still working shows the waiting line, cancels
  the turn, closes the request and saves nothing;
- `/images` lists the files and `/images open 2` runs CODSH_IMAGE_OPENER.
Then the session is resumed: `/imagine` shows as typed, `/images` still lists
the three files and `/images open 1` opens the first one. A second launch with
GROK_IMAGE_GEN=0 GROK_IMAGE_EDIT=0 offers no image tool and `/imagine` fails
explicitly; `inspect` refuses an official image host. Linux and macOS; all
homes are temp dirs; nothing leaves loopback.
"""
import base64
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import threading
import time
import zlib

ROOT = Path(__file__).resolve().parent.parent
NODE = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)


def dsh_bin():
    script = ("import { createRequire } from 'node:module'; import { dirname, join } from 'node:path'; "
              "import { readFileSync } from 'node:fs'; const r=createRequire(process.argv[1]); "
              "const m=r.resolve('@deepseek-ai/dsh/package.json'); const bin=JSON.parse(readFileSync(m,'utf8')).bin; "
              "process.stdout.write(join(dirname(m), typeof bin==='string'?bin:bin.dsh))")
    return run([NODE, '--input-type=module', '-e', script, str(ROOT / 'package.json')], cwd=ROOT).stdout


def overlay_text():
    return run([NODE, '--input-type=module', '-e',
                "import { rustAcpOverlay } from './scripts/rust-acp-overlay.mjs'; process.stdout.write(rustAcpOverlay())"],
               cwd=ROOT).stdout


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
    run(['npm', 'install', '--prefix', str(prefix), '--ignore-scripts', '--offline', '--no-audit', '--no-fund',
         str(work / pack)], env=pack_env)
    return prefix / 'node_modules/.bin/codsh'


def screen_text(data, rows, cols):
    emulator = ROOT / 'e2e/vt.ts'
    payload = json.dumps({'rows': rows, 'cols': cols, 'bytes': base64.b64encode(data).decode()})
    return run([NODE, '--import', 'tsx', '-e',
                f"import {{ Terminal }} from {json.dumps(emulator.as_uri())}; "
                "let input=''; for await (const chunk of process.stdin) input+=chunk; "
                "const spec=JSON.parse(input); const t=new Terminal(spec.rows,spec.cols); "
                "t.feed(Buffer.from(spec.bytes,'base64').toString()); console.log(t.text);"],
               input=payload, cwd=ROOT).stdout


def png(width, height, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * width for _ in range(height))

    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


class ImageService(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), ImageHandler)
        self.requests = []
        self.closed = []
        self.lock = threading.Lock()

    @property
    def base(self):
        return f'http://127.0.0.1:{self.server_address[1]}/v1'

    @property
    def host(self):
        return f'127.0.0.1:{self.server_address[1]}'


class ImageHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        with self.server.lock:
            self.server.requests.append({'method': 'GET', 'path': self.path})
        self.reply(404, {'error': 'not here'})

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(length) or b'{}')
        entry = {'method': 'POST', 'path': self.path, 'auth': self.headers.get('Authorization'), 'body': body}
        with self.server.lock:
            self.server.requests.append(entry)
        prompt = body.get('prompt', '')
        if 'HANG' in prompt:
            # Wait until the client goes away; a cancelled call closes the socket.
            self.connection.settimeout(0.2)
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                try:
                    if self.connection.recv(1) == b'':
                        break
                except TimeoutError:
                    continue
                except OSError:
                    break
            with self.server.lock:
                self.server.closed.append(prompt)
            return
        if 'REFUSE' in prompt:
            return self.reply(200, {'error': 'Generated image rejected by content moderation.'})
        if 'MALFORMED' in prompt:
            return self.reply(200, {'data': [{'b64_json': base64.b64encode(b'<html>not an image</html>').decode()}]})
        if 'URLONLY' in prompt:
            return self.reply(200, {'data': [{'url': f'http://{self.server.host}/never-fetched.png'}]})
        if 'PAYME' in prompt:
            return self.reply(402, {'error': 'insufficient credits'})
        color = (200, 30, 30) if self.path.endswith('/generations') else (30, 30, 200)
        image = png(96, 54, color) if body.get('aspect_ratio') == '16:9' else png(64, 64, color)
        return self.reply(200, {'data': [{'b64_json': base64.b64encode(image).decode(), 'revised_prompt': prompt}]})


class Session:
    def __init__(self, name, launcher, cwd, env, output, extra=(), rows=45, cols=200):
        self.name, self.output, self.rows, self.cols = name, output, rows, cols
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.process = subprocess.Popen([str(launcher), '--rust', '--trust', *extra],
                                        cwd=cwd, env=env, stdin=self.slave, stdout=self.slave,
                                        stderr=self.slave, start_new_session=True)
        self.data = bytearray()

    def pump(self, seconds=0.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], 0.03)[0]:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.data.extend(chunk)

    def screen(self):
        return screen_text(bytes(self.data), self.rows, self.cols)

    def wait(self, text, seconds=60, count=1):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump(0.3)
            shown = self.screen()
            if shown.count(text) >= count:
                return shown
            if self.process.poll() is not None:
                break
        raise AssertionError(f'{self.name}: missing {text!r} x{count}\n{self.screen()}')

    def type(self, text):
        os.write(self.master, text.encode())
        self.pump(0.3)

    def close(self):
        try:
            if self.process.poll() is None:
                os.write(self.master, b'\x11')
                try:
                    self.process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
            (self.output / f'{self.name}.txt').write_text(self.screen())
        finally:
            os.close(self.master)
            os.close(self.slave)
        return self.process.returncode


def images_in(session_dir):
    folder = session_dir / 'images'
    return sorted(path.name for path in folder.iterdir()) if folder.exists() else []


def main():
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-image-', dir='/tmp'))
    dsh = dsh_bin()
    service = ImageService()
    threading.Thread(target=service.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix='codsh-rust-image-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        (home / 'dsh').mkdir(parents=True)
        cwd = work / 'workspace'
        (cwd / '.git').mkdir(parents=True)
        launcher = pack_install(work, home)
        patch = work / 'overlay.yml'
        patch.write_text(overlay_text())
        reference = work / 'reference.png'
        reference.write_bytes(png(8, 8, (0, 200, 0)))
        opened = work / 'opened.log'
        opener = work / 'opener.sh'
        opener.write_text(f'#!/bin/sh\nprintf "%s\\n" "$1" >> {opened}\n')
        opener.chmod(0o755)
        rust_home = home / '.codsh-rust' / '.grok'
        rust_home.mkdir(parents=True)
        (rust_home / 'config.toml').write_text(
            '[models]\nimage_gen = "fake-imagine"\n'
            f'[model.fake-imagine]\nbase_url = "{service.base}"\n'
            'supports_image_generation = true\nsupports_image_edit = true\ntimeout_secs = 120\n')
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_HOME': str(home / 'dsh'),
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'image',
            'CODSH_IMAGE_OPENER': str(opener),
            'GROK_CLIPBOARD_NO_NATIVE_READ': '1',
            'CODSH_CLIPBOARD_IMAGE': str(reference),
        }
        sessions_root = rust_home / 'sessions'
        term = Session('image', launcher, cwd, env, output)
        session_dir = None
        try:
            term.wait('Connected to dsh ACP', 40)
            term.type('IMAGE_TOOLS\r')
            term.wait('RUST_ACP_IMAGE_TOOLS image_edit,image_gen')

            # Rejected card: nothing is sent.
            term.type('IMAGE_GEN ratio=16:9 a red fox in snow\r')
            shown = term.wait(f'Allow Generate image "a red fox in snow" via {service.host}? y=allow once  n=reject')
            assert f'Sends the prompt to {service.host}. codsh does not know its price' in shown, shown
            term.type('n')
            term.wait('rejected')
            assert service.requests == [], service.requests

            # Approved: one request, saved as images/1.png, named in the transcript.
            term.type('IMAGE_GEN ratio=16:9 a red fox in snow\r')
            term.wait('Sends the prompt to')
            term.type('y')
            shown = term.wait('RUST_ACP_IMAGE_DONE OK:Image saved to images/1.png (96x54)')
            session_dir = next(sessions_root.glob('*/*/images')).parent
            assert images_in(session_dir) == ['1.png'], images_in(session_dir)
            first = service.requests[-1]
            assert first['path'] == '/v1/images/generations', first
            assert first['body']['prompt'] == 'a red fox in snow', first
            assert first['body']['model'] == 'fake-imagine', first
            assert first['body']['aspect_ratio'] == '16:9', first
            assert first['auth'] is None, first

            # The completion menu takes the first Enter (imagine needs an argument).
            term.type('/imagine\r')
            term.type('\r')
            term.wait('Usage: /imagine <description>')
            term.type('/imagine a lighthouse at dusk, 水彩\r')
            term.wait('Sends the prompt to')
            term.type('y')
            term.wait('RUST_ACP_IMAGE_DONE OK:Image saved to images/2.png')
            assert service.requests[-1]['body']['prompt'] == 'a lighthouse at dusk, 水彩', service.requests[-1]

            # Ctrl+V attaches the clipboard image as [Image #1]; the text-only
            # mock model gets its saved path, which the tool resolves.
            term.type('IMAGE_EDIT ')
            term.type('\x16')
            term.wait('[Image #1]')
            term.type(' :: make it blue\r')
            term.wait(f'Sends the prompt and 1 reference image to {service.host}.')
            term.type('y')
            term.wait('RUST_ACP_IMAGE_DONE OK:Image saved to images/3.png')
            edit = service.requests[-1]
            assert edit['path'] == '/v1/images/edits', edit
            sent = json.dumps(edit['body'])
            assert base64.b64encode(reference.read_bytes()).decode() in sent, sent[:400]

            # Failures save nothing and show the reason.
            for token, reason in (('REFUSE', 'was refused by the service: Generated image rejected by content moderation'),
                                  ('MALFORMED', 'returned data that is not a png, jpeg, webp, or gif image'),
                                  ('URLONLY', 'returned a URL instead of b64_json image data'),
                                  ('PAYME', 'failed with HTTP 402')):
                before = len(service.requests)
                term.type(f'IMAGE_GEN {token} case\r')
                term.wait('Sends the prompt to')
                term.type('y')
                term.wait(reason)
                assert len(service.requests) == before + 1, service.requests[before:]
            assert not any(entry['method'] == 'GET' for entry in service.requests), service.requests
            assert images_in(session_dir) == ['1.png', '2.png', '3.png'], images_in(session_dir)

            # Ctrl+C while the service works: waiting line, cancel, nothing saved.
            term.type('IMAGE_GEN HANG slow one\r')
            term.wait('Sends the prompt to')
            term.type('y')
            term.wait(f'waiting for {service.host}')
            term.type('\x03')
            term.wait('[cancelled]', 30)
            deadline = time.monotonic() + 15
            while not service.closed and time.monotonic() < deadline:
                time.sleep(0.2)
            assert service.closed == ['HANG slow one'], service.closed
            assert images_in(session_dir) == ['1.png', '2.png', '3.png'], images_in(session_dir)
            assert not any(name.startswith('.tmp') for name in os.listdir(session_dir / 'images'))

            term.type('/images\r')
            shown = term.wait('images/3.png')
            assert 'images/1.png' in shown and '96x54' in shown, shown
            term.type('\x1b')
            term.type('/images open 2\r')
            term.wait('Opened images/2.png')
        finally:
            code = term.close()
        assert code == 0, code
        assert opened.read_text().splitlines() == [str(session_dir / 'images' / '2.png')], opened.read_text()
        assert (session_dir / 'images').stat().st_mode & 0o777 == 0o700

        session_id = session_dir.name
        resumed = Session('image-resume', launcher, cwd, env, output, extra=['--resume', session_id], rows=150)
        try:
            resumed.wait('Connected to dsh ACP', 40)
            shown = resumed.wait('/imagine a lighthouse at dusk, 水彩')
            assert 'Call the image_gen tool immediately' not in shown, shown
            assert 'Generate image "a lighthouse at dusk, 水彩"' in shown, shown
            assert 'Edit image (1 ref) "' in shown, shown
            assert '[tool tool]' not in shown, shown
            resumed.type('/images\r')
            shown = resumed.wait('images/3.png')
            resumed.type('\x1b')
            resumed.type('/images open 1\r')
            resumed.wait('Opened images/1.png')
        finally:
            code = resumed.close()
        assert code == 0, code
        assert opened.read_text().splitlines()[-1] == str(session_dir / 'images' / '1.png'), opened.read_text()

        off = Session('image-off', launcher, cwd, {**env, 'GROK_IMAGE_GEN': '0', 'GROK_IMAGE_EDIT': '0'}, output)
        try:
            off.wait('Connected to dsh ACP', 40)
            off.type('IMAGE_TOOLS\r')
            off.wait('RUST_ACP_IMAGE_TOOLS (none)')
            off.type('/imagine a cat\r')
            off.wait('/imagine needs image_gen')
        finally:
            code = off.close()
        assert code == 0, code

        official = work / 'official-home'
        (official / '.codsh-rust' / '.grok').mkdir(parents=True)
        (official / '.codsh-rust' / '.grok' / 'config.toml').write_text(
            '[models]\nimage_gen = "imagine"\n[model.imagine]\nbase_url = "https://api.x.ai/v1"\n'
            'supports_image_generation = true\n')
        inspected = subprocess.run([str(launcher), '--rust', 'inspect'], cwd=cwd, capture_output=True, text=True,
                                   env={**env, 'HOME': str(official)}, timeout=60)
        combined = inspected.stdout + inspected.stderr
        (output / 'inspect-official.txt').write_text(combined)
        assert 'image service destination refused: [model.imagine] base_url https://api.x.ai/v1 is an official host' in combined, combined
        assert 'imagine (refused; see Invalid configuration)' in combined, combined
        assert 'features.image_gen           false  (invalid)' in combined, combined
        service.shutdown()
        print(json.dumps({'output': str(output), 'imageGeneration': True,
                          'requests': len(service.requests), 'saved': images_in(session_dir)}, indent=2))


if __name__ == '__main__':
    main()
