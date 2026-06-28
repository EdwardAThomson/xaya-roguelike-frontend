#!/usr/bin/env python3
"""Static file server for the frontend with browser caching disabled.

Plain `python3 -m http.server` sends no Cache-Control header, so the
browser caches the dist/*.js ES-module graph and a normal refresh keeps
showing stale code.  This server sends no-store on every response, so a
normal reload always picks up the latest build.

Usage:  python3 serve.py [port]   (default 8000)
"""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serving (no-cache) on http://localhost:{port}")
    HTTPServer(("", port), NoCacheHandler).serve_forever()
