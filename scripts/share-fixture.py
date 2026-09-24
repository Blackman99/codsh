#!/usr/bin/env python3
"""One-shot loopback share service. Writes the POST body and returns a URL."""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

captured, port_path = sys.argv[1], sys.argv[2]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(size)
        with open(captured, "wb") as handle:
            handle.write(body)
        payload = json.dumps({"url": "http://127.0.0.1/shared/selected"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        return


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(port_path, "w", encoding="utf-8") as handle:
    handle.write(str(server.server_address[1]))
# One process can prove both CODSH_SHARE_URL and an explicit --url.
server.handle_request()
server.handle_request()
