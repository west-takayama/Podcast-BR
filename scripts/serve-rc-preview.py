"""Run the local RC preview on two authenticated TLS origins. No network calls."""
import argparse
import base64
import hmac
import os
import ssl
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class ProtectedPreview(SimpleHTTPRequestHandler):
    def __init__(self, *args, expected, directory, **kwargs):
        self.expected = expected
        self.root = Path(directory).resolve()
        super().__init__(*args, directory=str(directory), **kwargs)

    def log_message(self, _format, *_args):
        pass

    def allowed(self):
        given = self.headers.get("Authorization", "").encode("utf-8")
        if hmac.compare_digest(given, self.expected):
            path = Path(self.translate_path(self.path)).resolve()
            if path.is_relative_to(self.root):
                return True
            self.send_error(403)
            return False
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="AI STUDIO RC test"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, private")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self):
        if self.allowed():
            super().do_GET()

    def do_HEAD(self):
        if self.allowed():
            super().do_HEAD()

    def list_directory(self, _path):
        self.send_error(403)
        return None


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--studio-port", type=int, default=8443)
    parser.add_argument("--audio-port", type=int, default=8444)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    args = parser.parse_args()

    password = os.environ.get("BRIDGE_RC_PASSWORD", "")
    if len(password) < 16 or not password.isascii():
        parser.error("Set BRIDGE_RC_PASSWORD to a unique ASCII password of at least 16 characters.")
    expected = b"Basic " + base64.b64encode(("bridge:" + password).encode("ascii"))

    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_cert_chain(args.cert, args.key)
    servers = []
    try:
        for name, port in (("studio", args.studio_port), ("audio", args.audio_port)):
            path = args.root / name
            if not (path / "index.html").is_file():
                parser.error(f"Missing {name}/index.html")
            handler = partial(ProtectedPreview, expected=expected, directory=path)
            server = ThreadingHTTPServer((args.bind, port), handler)
            servers.append(server)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
        worker = threading.Thread(target=servers[1].serve_forever, daemon=True)
        worker.start()
        print(f"Authenticated TLS preview ports: Studio {args.studio_port}; AUDIO {args.audio_port}.", flush=True)
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for server in servers:
            server.server_close()


if __name__ == "__main__":
    run()
