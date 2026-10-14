# Static dev server that makes the browser revalidate every file, so edited
# modules (including the ones the mesh worker imports) are never served stale.
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
print(f'Serving on http://localhost:{port}')
ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
