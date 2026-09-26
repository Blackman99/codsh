#!/usr/bin/env python3
"""Real-terminal video generation and media job states (ticket 188).

Two keyless loopback video services started by this script, faithful to the
two supported protocols: the reference async API (`xai`: POST
`/v1/videos/generations` -> `request_id`, poll `GET /v1/videos/{id}` until
`done` with `video.url`, `failed` or `expired`) and stable-diffusion.cpp's
sd-server (`sdcpp`: `/sdcpp/v1/capabilities`, `POST /sdcpp/v1/vid_gen` ->
202 queued job, `GET /sdcpp/v1/jobs/{id}` queued/generating/completed with
base64 video, `POST /sdcpp/v1/jobs/{id}/cancel`). Through the packed and
installed codsh with the native binary from `pnpm run build:rust`:

xai session:
- the model is offered image_to_video and reference_to_video, and their
  descriptions carry what the configured service accepts;
- a call opens the approval card naming the clip, the prompt, the host, the
  image count and the unknown price; `n` sends nothing; `y` starts one job,
  the row shows the live remote job state, and the file is saved as
  `<session>/videos/1.mp4` and named in the transcript;
- `/imagine-video` alone shows its usage; with a Ctrl+V image it makes the
  model call image_to_video with `[Image #1]` resolved to the attachment;
- an unsupported duration is refused before any request; a failed, expired,
  unpaid (402), non-video, and foreign-host result each fail with the reason
  and save nothing (the foreign URL is never fetched);
- a local timeout says the remote job may still finish; Ctrl+C while a job
  runs cancels the turn, says this service has no cancel request, and saves
  nothing;
- `/videos` lists files and jobs with distinct states; `/videos open 1` runs
  CODSH_VIDEO_OPENER.
Resume: the transcript shows `/imagine-video` as typed, a notice says which
jobs have no saved result, and `/videos status N` asks the service about the
timed-out job, which has since finished, and saves it (recovered).
sdcpp session: capabilities are checked, a queued -> generating -> completed
job saves `videos/1.webm`, an input the protocol cannot take is refused
before any request, and Ctrl+C on a queued job asks the service to cancel it
and records the confirmation. A launch with GROK_VIDEO_GEN=0 offers no video
tool and `/imagine-video` fails explicitly; `inspect` refuses an official
video host. Linux and macOS; all homes are temp dirs; nothing leaves loopback.
"""
import base64
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('image_pty', HERE / 'rust-image-gen-pty-test.py')
image_pty = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(image_pty)
NODE, Session, pack_install, overlay_text, dsh_bin, png = (
    image_pty.NODE, image_pty.Session, image_pty.pack_install, image_pty.overlay_text, image_pty.dsh_bin, image_pty.png)

MP4 = b'\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41' + b'\x00' * 64
STILL = 'still_frame'
WEBM = b'\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm' + b'\x00' * 64


class Service(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, handler):
        super().__init__(('127.0.0.1', 0), handler)
        self.requests = []
        self.jobs = {}
        self.release = threading.Event()
        self.lock = threading.Lock()

    @property
    def host(self):
        return f'127.0.0.1:{self.server_address[1]}'

    @property
    def port(self):
        return self.server_address[1]


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, body, kind='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def record(self, body=None):
        entry = {'method': self.command, 'path': self.path, 'auth': self.headers.get('Authorization'), 'body': body}
        with self.server.lock:
            self.server.requests.append(entry)

    def read_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(length) or b'{}')


class XaiHandler(Handler):
    """The reference async video API; the prompt picks the job's fate."""

    def do_POST(self):
        body = self.read_body()
        self.record(body)
        if self.path != '/v1/videos/generations':
            return self.send(404, {'error': 'not here'})
        prompt = body.get('prompt', '')
        if 'PAYME' in prompt:
            return self.send(402, {'error': {'message': 'insufficient credits'}})
        with self.server.lock:
            job_id = f'vid-{len(self.server.jobs) + 1}'
            self.server.jobs[job_id] = {'prompt': prompt, 'polls': 0}
        return self.send(200, {'request_id': job_id})

    def do_GET(self):
        self.record()
        port = self.server.port
        if self.path.startswith('/files/'):
            if self.path.endswith('.mp4'):
                return self.send(200, MP4, 'video/mp4')
            return self.send(200, b'<html>not a video</html>', 'text/html')
        match = re.fullmatch(r'/v1/videos/([\w-]+)', self.path)
        job = self.server.jobs.get(match.group(1)) if match else None
        if job is None:
            return self.send(404, {'error': {'message': 'no such job'}})
        job['polls'] += 1
        prompt, job_id = job['prompt'], match.group(1)
        done = {'status': 'done', 'video': {'url': f'http://127.0.0.1:{port}/files/{job_id}.mp4', 'duration': 6}}
        if 'FAIL' in prompt:
            return self.send(200, {'status': 'failed', 'error': {'message': 'content rejected'}})
        if 'EXPIRE' in prompt:
            return self.send(200, {'status': 'expired'})
        if 'HANG' in prompt or ('SLOW' in prompt and not self.server.release.is_set()):
            return self.send(200, {'status': 'pending'})
        if 'GARBAGE' in prompt:
            return self.send(200, {'status': 'done', 'video': {'url': f'http://127.0.0.1:{port}/files/{job_id}.bin'}})
        if 'FOREIGN' in prompt:
            return self.send(200, {'status': 'done', 'video': {'url': f'http://localhost:{port}/files/{job_id}.mp4'}})
        if job['polls'] < 3 and 'SLOW' not in prompt:
            return self.send(200, {'status': 'pending'})
        return self.send(200, done)


class SdcppHandler(Handler):
    """stable-diffusion.cpp sd-server's native async video API."""

    CAPS = {
        'model': {'name': 'fake-animatediff', 'stem': 'fake'},
        'supported_modes': ['img_gen', 'vid_gen'],
        'features_by_mode': {'vid_gen': {'init_image': True, 'end_image': False, 'cancel_queued': True, 'cancel_generating': False}},
        'output_formats_by_mode': {'vid_gen': ['webm', 'webp', 'avi']},
        'limits': {'min_width': 64, 'max_width': 1024, 'min_height': 64, 'max_height': 1024},
    }

    def do_GET(self):
        self.record()
        if self.path == '/sdcpp/v1/capabilities':
            return self.send(200, self.CAPS)
        match = re.fullmatch(r'/sdcpp/v1/jobs/([\w-]+)', self.path)
        job = self.server.jobs.get(match.group(1)) if match else None
        if job is None:
            return self.send(404, {'error': {'code': 'not_found', 'message': 'job not found'}})
        job['polls'] += 1
        base = {'id': match.group(1), 'kind': 'vid_gen', 'created': 1, 'started': None, 'completed': None}
        if job['status'] == 'cancelled':
            return self.send(200, {**base, 'status': 'cancelled', 'queue_position': 0, 'result': None, 'error': None})
        if 'HANG' in job['prompt'] or job['polls'] == 1:
            return self.send(200, {**base, 'status': 'queued', 'queue_position': 1, 'result': None, 'error': None})
        if job['polls'] == 2:
            job['status'] = 'generating'
            return self.send(200, {**base, 'status': 'generating', 'queue_position': 0, 'result': None, 'error': None})
        job['status'] = 'completed'
        result = {'output_format': 'webm', 'mime_type': 'video/webm', 'fps': job['fps'], 'frame_count': job['frames'],
                  'b64_json': base64.b64encode(WEBM).decode()}
        return self.send(200, {**base, 'status': 'completed', 'queue_position': 0, 'result': result, 'error': None})

    def do_POST(self):
        body = self.read_body()
        self.record(body)
        if self.path == '/sdcpp/v1/vid_gen':
            with self.server.lock:
                job_id = f'job_{len(self.server.jobs) + 1}'
                self.server.jobs[job_id] = {'prompt': body.get('prompt', ''), 'polls': 0, 'status': 'queued',
                                            'fps': body.get('fps'), 'frames': body.get('video_frames')}
            return self.send(202, {'id': job_id, 'kind': 'vid_gen', 'status': 'queued', 'created': 1,
                                   'poll_url': f'/sdcpp/v1/jobs/{job_id}'})
        match = re.fullmatch(r'/sdcpp/v1/jobs/([\w-]+)/cancel', self.path)
        job = self.server.jobs.get(match.group(1)) if match else None
        if job is None:
            return self.send(404, {'error': {'code': 'not_found', 'message': 'job not found'}})
        if job['status'] == 'queued':
            job['status'] = 'cancelled'
            return self.send(200, {'id': match.group(1), 'kind': 'vid_gen', 'status': 'cancelled'})
        return self.send(409, {'error': {'code': 'conflict', 'message': 'job is generating and cannot be interrupted yet'}})


def videos_in(session_dir):
    folder = session_dir / 'videos'
    return sorted(path.name for path in folder.iterdir()) if folder.exists() else []


def job_records(session_dir):
    folder = session_dir / 'video-jobs'
    if not folder.exists():
        return []
    records = [json.loads(path.read_text()) for path in folder.glob('*.json')]
    return sorted(records, key=lambda record: (record['created'], record['name']))


def call(term, args, tool='I2V'):
    term.type(f'VIDEO_{tool} {json.dumps(args, ensure_ascii=False)}\r')


def serve(handler):
    service = Service(handler)
    threading.Thread(target=service.serve_forever, daemon=True).start()
    return service


def write_config(home, text):
    rust_home = home / '.codsh-rust' / '.grok'
    rust_home.mkdir(parents=True, exist_ok=True)
    (rust_home / 'config.toml').write_text(text)
    return rust_home


def xai_session(launcher, cwd, env, output, service, rust_home, still, opened):
    host = service.host
    term = Session('video', launcher, cwd, env, output)
    session_dir = None
    try:
        term.wait('Connected to dsh ACP', 40)
        term.type('VIDEO_TOOLS\r')
        shown = term.wait('RUST_ACP_VIDEO_TOOLS image_to_video[image_to_video duration 6 or 10 s')
        assert 'reference_to_video[' in shown, shown

        # Rejected card: nothing is sent.
        call(term, {'prompt': 'a red fox runs', 'image': STILL, 'duration': 6})
        shown = term.wait(f'Allow Animate image (6s, default resolution) "a red fox runs" via {host}? y=allow once  n=reject')
        assert (f'Starts one video job on {host} with the prompt and 1 image. codsh does not know its price; '
                'any charge is set by that service.') in shown, shown
        term.type('n')
        term.wait('rejected')
        assert service.requests == [], service.requests

        # Approved: one job, live state on the row, saved as videos/1.mp4.
        call(term, {'prompt': 'a red fox runs', 'image': STILL, 'duration': 6})
        term.wait('Starts one video job on')
        term.type('y')
        shown = term.wait(f'video: job vid-1 pending on {host}')
        assert 'Ctrl+C cancels; nothing is saved until the video arrives' in shown, shown
        shown = term.wait('RUST_ACP_VIDEO_DONE OK:Video saved to videos/1.mp4 (mp4')
        assert 'remote job vid-1' in shown, shown
        session_dir = next((rust_home / 'sessions').glob('*/*/videos')).parent
        assert videos_in(session_dir) == ['1.mp4'], videos_in(session_dir)
        assert (session_dir / 'videos' / '1.mp4').read_bytes() == MP4
        start = service.requests[0]
        assert start['path'] == '/v1/videos/generations', start
        assert start['body']['model'] == 'clips' and start['body']['duration'] == 6, start
        assert start['body']['resolution'] == '480p', start
        assert start['body']['image']['url'].startswith('data:image/png;base64,'), start
        assert start['auth'] is None, start
        record = job_records(session_dir)[0]
        assert record['status'] == 'completed' and record['remote_id'] == 'vid-1', record
        assert record['call_id'] == 'rust-acp-video-2', record  # call 1 was rejected

        # /imagine-video: usage alone; with a Ctrl+V image the attachment is sent.
        term.type('/imagine-video\r')
        term.type('\r')
        term.wait('Usage: /imagine-video <description>')
        term.type('/imagine-video ')
        term.type('\x16')
        term.wait('[Image #1]')
        term.type(' the fox blinks, 眨眼\r')
        term.wait('Animate image (default length, default resolution) "the fox blinks, 眨眼"')
        term.type('y')
        term.wait('RUST_ACP_VIDEO_DONE OK:Video saved to videos/2.mp4')
        posts = [entry for entry in service.requests if entry['method'] == 'POST']
        assert posts[-1]['body']['prompt'] == 'the fox blinks, 眨眼', posts[-1]
        assert base64.b64encode(still.read_bytes()).decode() in posts[-1]['body']['image']['url'], posts[-1]['body']['image']['url'][:80]

        # Refused before any request: an unsupported duration.
        before = len(service.requests)
        call(term, {'prompt': 'too long', 'image': STILL, 'duration': 7})
        term.wait('Starts one video job on')
        term.type('y')
        term.wait(f'`duration` 7s is not supported by the video service {host} for image_to_video; supported: 6 or 10 s')
        assert len(service.requests) == before, service.requests[before:]

        # Remote failures save nothing and each says what happened.
        for token, reason in (('FAIL', 'failed on the service (remote job vid-3): content rejected'),
                              ('EXPIRE', 'request expired (remote job vid-4)'),
                              ('PAYME', 'The service asked for payment'),
                              ('GARBAGE', 'not an mp4, webm, avi, or animated webp video'),
                              ('FOREIGN', 'neither the configured service host')):
            call(term, {'prompt': f'{token} case', 'image': STILL})
            term.wait('Starts one video job on')
            term.type('y')
            term.wait(reason)
        assert not any('localhost' in (entry['path'] or '') for entry in service.requests)
        assert videos_in(session_dir) == ['1.mp4', '2.mp4'], videos_in(session_dir)

        # Local timeout: the remote job may still finish (asked again after resume).
        call(term, {'prompt': 'SLOW sunset', 'image': STILL})
        term.wait('Starts one video job on')
        term.type('y')
        term.wait('did not complete within 6s (remote job vid-7', 40)

        # Ctrl+C while the job runs: this service has no cancel request.
        call(term, {'prompt': 'HANG forever', 'image': STILL})
        term.wait('Starts one video job on')
        term.type('y')
        term.wait(f'video: job vid-8 pending on {host}')
        term.type('\x03')
        term.wait('[cancelled]', 30)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and job_records(session_dir)[-1]['status'] != 'cancelled':
            time.sleep(0.2)
        hang = job_records(session_dir)[-1]
        assert hang['status'] == 'cancelled' and hang['cancel'] == 'not_supported', hang
        assert videos_in(session_dir) == ['1.mp4', '2.mp4'], videos_in(session_dir)
        assert not any(name.startswith('.tmp') for name in os.listdir(session_dir / 'videos'))

        # The listing ends with the newest jobs; each state reads differently.
        term.type('/videos\r')
        shown = term.wait('stopped waiting; this service has no cancel request')
        assert 'timed out locally; the remote job may still be running' in shown, shown
        term.type('\x1b')
        for number, text in ((1, 'completed → videos/1.mp4'), (3, 'failed: content rejected'),
                             (4, 'expired on the service'), (5, 'refused, no job started'),
                             (6, 'failed: the service returned data that is not a video container')):
            term.type(f'/videos status {number}\r')
            term.wait(f'Video job {number} (image_to_video')
            shown = term.wait(text)
            term.type('\x1b')
        term.type('/videos open 1\r')
        term.wait('Opened videos/1.mp4')
    finally:
        code = term.close()
    assert code == 0, code
    assert opened.read_text().splitlines() == [str(session_dir / 'videos' / '1.mp4')], opened.read_text()
    assert (session_dir / 'videos').stat().st_mode & 0o777 == 0o700
    assert (session_dir / 'video-jobs').stat().st_mode & 0o777 == 0o700
    return session_dir


def resume_session(launcher, cwd, env, output, service, session_dir, opened):
    host = service.host
    resumed = Session('video-resume', launcher, cwd, env, output, extra=['--resume', session_dir.name], rows=150)
    try:
        resumed.wait('Connected to dsh ACP', 40)
        shown = resumed.wait('2 video jobs of this session have no saved result yet')
        assert 'the conversation was restored, not the work' in shown, shown
        shown = resumed.wait('/imagine-video [Image #1] the fox blinks, 眨眼')
        assert '# Imagine Video' not in shown, shown
        assert 'Animate image (6s, default resolution) "a red fox runs"' in shown, shown
        assert '[tool tool]' not in shown, shown
        numbers = [index + 1 for index, record in enumerate(job_records(session_dir)) if record['remote_id'] == 'vid-7']
        assert len(numbers) == 1, job_records(session_dir)
        # Still running on the service: nothing is saved yet.
        resumed.type(f'/videos status {numbers[0]}\r')
        resumed.wait(f'still pending on {host} (remote job vid-7)')
        resumed.type('\x1b')
        assert videos_in(session_dir) == ['1.mp4', '2.mp4'], videos_in(session_dir)
        # The service finishes it; the post-resume query saves it.
        service.release.set()
        resumed.type(f'/videos status {numbers[0]}\r')
        resumed.wait(f'finished on {host}; saved videos/3.mp4 (mp4')
        resumed.type('\x1b')
        record = job_records(session_dir)[numbers[0] - 1]
        assert record['status'] == 'completed' and record['saved'] == 'videos/3.mp4', record
        resumed.type('/videos open 3\r')
        resumed.wait('Opened videos/3.mp4')
    finally:
        code = resumed.close()
    assert code == 0, code
    assert videos_in(session_dir) == ['1.mp4', '2.mp4', '3.mp4'], videos_in(session_dir)
    assert opened.read_text().splitlines()[-1] == str(session_dir / 'videos' / '3.mp4'), opened.read_text()


def sdcpp_session(launcher, cwd, env, output, service, rust_home, still):
    host = service.host
    term = Session('video-sdcpp', launcher, cwd, env, output)
    try:
        term.wait('Connected to dsh ACP', 40)
        term.type('VIDEO_TOOLS\r')
        term.wait('RUST_ACP_VIDEO_TOOLS image_to_video[image_to_video duration 1 or 2 s; reference_to_video duration 1 or 2 s; resolution_name 256p; reference_to_video inputs: first_frame (required)')
        call(term, {'prompt': 'waves roll', 'image': STILL, 'duration': 2})
        term.wait(f'Allow Animate image (2s, default resolution) "waves roll" via {host}?')
        term.type('y')
        shown = term.wait('RUST_ACP_VIDEO_DONE OK:Video saved to videos/1.webm (webm')
        assert '9 frames @ 4 fps' in shown or '8 frames @ 4 fps' in shown, shown
        session_dir = next((rust_home / 'sessions').glob('*/*/videos')).parent
        paths = [entry['path'] for entry in service.requests]
        assert paths[:2] == ['/sdcpp/v1/capabilities', '/sdcpp/v1/vid_gen'], paths
        start = service.requests[1]['body']
        assert (start['width'], start['height'], start['video_frames'], start['fps']) == (256, 256, 8, 4), start
        assert start['init_image'].startswith('data:image/png;base64,'), start

        before = len(service.requests)
        call(term, {'prompt': 'duo', 'aspect_ratio': '1:1', 'first_frame': STILL, 'images': [STILL]}, 'R2V')
        term.wait('Allow Reference video (1 ref, first frame;')
        term.type('y')
        term.wait(f'is not supported by the video service {host} (sdcpp protocol')
        assert len(service.requests) == before, service.requests[before:]

        call(term, {'prompt': 'HANG queued', 'image': STILL, 'duration': 1})
        term.wait('Starts one video job on')
        term.type('y')
        term.wait(f'video: job job_2 queued on {host} (position 1)')
        term.type('\x03')
        term.wait('[cancelled]', 30)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and job_records(session_dir)[-1].get('cancel') is None:
            time.sleep(0.2)
        record = job_records(session_dir)[-1]
        assert record['status'] == 'cancelled' and record['cancel'] == 'confirmed', record
        assert any(entry['path'] == '/sdcpp/v1/jobs/job_2/cancel' for entry in service.requests), service.requests
        term.type('/videos\r')
        shown = term.wait('cancelled (the service confirmed it)')
        assert 'videos/1.webm (webm' in shown, shown
        term.type('\x1b')
    finally:
        code = term.close()
    assert code == 0, code
    assert videos_in(session_dir) == ['1.webm'], videos_in(session_dir)
    return session_dir


def main():
    output = Path(tempfile.mkdtemp(prefix='codsh-rust-video-', dir='/tmp'))
    dsh = dsh_bin()
    xai = serve(XaiHandler)
    sdcpp = serve(SdcppHandler)
    with tempfile.TemporaryDirectory(prefix='codsh-rust-video-home-', dir='/tmp') as temporary:
        work = Path(temporary)
        home = work / 'home'
        (home / 'dsh').mkdir(parents=True)
        cwd = work / 'workspace'
        (cwd / '.git').mkdir(parents=True)
        launcher = pack_install(work, home)
        patch = work / 'overlay.yml'
        patch.write_text(overlay_text())
        # Typed image paths would be taken as a dropped attachment, so the
        # model names a workspace file without a path or extension.
        still = cwd / STILL
        still.write_bytes(png(64, 64, (0, 160, 0)))
        opened = work / 'opened.log'
        opener = work / 'opener.sh'
        opener.write_text(f'#!/bin/sh\nprintf "%s\\n" "$1" >> {opened}\n')
        opener.chmod(0o755)
        rust_home = write_config(home, (
            '[models]\nvideo_gen = "clips"\n'
            f'[model.clips]\nbase_url = "http://{xai.host}/v1"\n'
            'supports_video_generation = true\npoll_secs = 1\ntimeout_secs = 6\n'))
        env = {
            'HOME': str(home), 'PATH': os.environ['PATH'], 'TERM': 'xterm-256color',
            'DSH_HOME': str(home / 'dsh'),
            'DSH_BIN': dsh, 'CODSH_NODE': NODE, 'CODSH_ACP_PATCH': str(patch),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_TELEMETRY_MODE': 'OFF',
            'DEEPSEEK_API_KEY': '', 'CODSH_UPDATE_CHECK': 'off',
            'DSH_CODE_CLI_MOCK_TOOL': 'video',
            'CODSH_VIDEO_OPENER': str(opener),
            'GROK_CLIPBOARD_NO_NATIVE_READ': '1',
            'CODSH_CLIPBOARD_IMAGE': str(still),
        }
        session_dir = xai_session(launcher, cwd, env, output, xai, rust_home, still, opened)
        resume_session(launcher, cwd, env, output, xai, session_dir, opened)

        sdcpp_home = work / 'sdcpp-home'
        (sdcpp_home / 'dsh').mkdir(parents=True)
        sdcpp_rust = write_config(sdcpp_home, (
            '[models]\nvideo_gen = "local"\n'
            f'[model.local]\nbase_url = "http://{sdcpp.host}"\nprotocol = "sdcpp"\n'
            'supports_video_generation = true\npoll_secs = 1\nvideo_durations = [1, 2]\n'
            'video_resolutions = ["256p"]\nvideo_fps = 4\n'))
        sdcpp_env = {**env, 'HOME': str(sdcpp_home), 'DSH_HOME': str(sdcpp_home / 'dsh')}
        sdcpp_dir = sdcpp_session(launcher, cwd, sdcpp_env, output, sdcpp, sdcpp_rust, still)

        off = Session('video-off', launcher, cwd, {**env, 'GROK_VIDEO_GEN': '0'}, output)
        try:
            off.wait('Connected to dsh ACP', 40)
            off.type('VIDEO_TOOLS\r')
            off.wait('RUST_ACP_VIDEO_TOOLS (none)')
            off.type('/imagine-video a cat\r')
            off.wait('/imagine-video needs image_to_video')
        finally:
            code = off.close()
        assert code == 0, code

        official = work / 'official-home'
        write_config(official, '[models]\nvideo_gen = "clips"\n[model.clips]\nbase_url = "https://api.x.ai/v1"\n'
                               'supports_video_generation = true\n')
        inspected = subprocess.run([str(launcher), '--rust', 'inspect'], cwd=cwd, capture_output=True, text=True,
                                   env={**env, 'HOME': str(official)}, timeout=60)
        combined = inspected.stdout + inspected.stderr
        (output / 'inspect-official.txt').write_text(combined)
        assert 'video service destination refused: [model.clips] base_url https://api.x.ai/v1 is an official host' in combined, combined
        assert 'clips (refused; see Invalid configuration)' in combined, combined
        assert re.search(r'features\.video_gen\s+false\s+\(invalid\)', combined), combined
        xai.shutdown()
        sdcpp.shutdown()
        print(json.dumps({'output': str(output), 'videoGeneration': True,
                          'xaiRequests': len(xai.requests), 'sdcppRequests': len(sdcpp.requests),
                          'saved': videos_in(session_dir), 'sdcppSaved': videos_in(sdcpp_dir),
                          'jobs': [record['status'] for record in job_records(session_dir)]}, indent=2))


if __name__ == '__main__':
    main()
