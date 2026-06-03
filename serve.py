"""
Static file server + /shutdown endpoint.
On /shutdown: creates shutdown.trigger file then exits.
The bat monitors that file to start the shutdown sequence.
"""
import os, sys, threading, signal
from http.server import SimpleHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
HOST = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TRIGGER_FILE = os.path.join(BASE_DIR, "shutdown.trigger")

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/shutdown":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"ok")
            self.wfile.flush()
            # Write trigger file so the bat detects shutdown request
            try:
                with open(TRIGGER_FILE, "w") as f:
                    f.write("shutdown")
            except Exception:
                pass
            threading.Timer(0.3, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "X-Requested-With, Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, format, *args):
        pass

# Clean up any leftover trigger file on startup
if os.path.exists(TRIGGER_FILE):
    os.remove(TRIGGER_FILE)

os.chdir(BASE_DIR)
server = HTTPServer((HOST, PORT), Handler)
print(f"[serve] Listening on http://{HOST}:{PORT}")
try:
    server.serve_forever()
except (KeyboardInterrupt, SystemExit):
    pass
