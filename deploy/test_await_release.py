"""The release workflow's view of the host: the real receiver, status protocol fixtures and
the real wait script, with only the public health endpoint stubbed."""
import http.server
import json
import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

D = 'sha256:' + 'a' * 64
R = 'b' * 40
OTHER_D = 'sha256:' + 'c' * 64
OTHER_R = 'd' * 40
SECRET = 'isolated-test-fixture-signing-key-only'


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Health(http.server.BaseHTTPRequestHandler):
    revision = 'unknown'

    def do_GET(self):
        self.send_response(200)
        self.send_header('X-Spooktober-Revision', type(self).revision)
        self.end_headers()
        self.wfile.write(b'ok\n')

    def log_message(self, *args):
        pass


class AwaitRelease(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        for name in ('requests', 'status'):
            (root / name).mkdir()
        (root / 'secret').write_text(SECRET)
        (root / 'secret').chmod(0o600)
        self.status_dir = root / 'status'
        self.port = free_port()
        self.receiver = subprocess.Popen(
            ['node', str(HERE / 'receiver/server.mjs')], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={**os.environ, 'WEBHOOK_SECRET_FILE': str(root / 'secret'), 'SPOOL_DIR': str(root), 'PORT': str(self.port)})
        self.assertIn(b'listening', self.receiver.stdout.readline())
        Health.revision = 'unknown'
        self.health = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Health)
        threading.Thread(target=self.health.serve_forever, daemon=True).start()

    def tearDown(self):
        self.receiver.kill()
        self.receiver.wait()
        self.receiver.stdout.close()
        self.health.shutdown()
        self.health.server_close()
        self.temp.cleanup()

    def wait(self, mode='wait', timeout='3', ready='1', receiver_port=None, **extra):
        env = {**os.environ, 'DEPLOY_URL': f'http://127.0.0.1:{receiver_port or self.port}/hooks/spooktober',
               'HEALTH_URL': f'http://127.0.0.1:{self.health.server_port}/healthz', 'DIGEST': D, 'REVISION': R,
               'WEBHOOK_SECRET': SECRET, 'CF_ACCESS_CLIENT_ID': 'id', 'CF_ACCESS_CLIENT_SECRET': 'access-secret',
               'REQUEST_TIMESTAMP': '100', 'HOST_TIMEOUT': timeout, 'READY_TIMEOUT': ready,
               'REQUEST_TIMEOUT': '2', 'POLL_SECONDS': '0.1', **extra}
        started = time.monotonic()
        result = subprocess.run([sys.executable, '-I', str(HERE / 'await_release.py'), mode], env=env,
                                capture_output=True, text=True, timeout=30)
        return result, time.monotonic() - started

    def report(self, status, phase, rollback=None, digest=D, revision=R, requested=100):
        # Producer behavior is tested in deploy-core; exercise this app's wire protocol.
        value=dict(digest=digest,revision=revision,status=status,phase=phase,requested=requested)
        if rollback:value['rollback']=rollback
        (self.status_dir/f'{revision}-{digest.removeprefix("sha256:")}.json').write_text(json.dumps(value))

    def test_terminal_host_failure_fails_immediately_not_after_the_timeout(self):
        self.report('failed', 'migrate')
        result, elapsed = self.wait(timeout='60')
        self.assertEqual(result.returncode, 1)
        self.assertLess(elapsed, 5)
        self.assertIn('::error::The host did not deploy ' + R, result.stdout)
        self.assertIn('phase migrate', result.stdout)
        self.assertNotIn('access-secret', result.stdout + result.stderr)
        self.assertNotIn(SECRET, result.stdout + result.stderr)

    def test_failure_with_a_rollback_is_reported(self):
        self.report('failed', 'health', 'restored')
        result, _ = self.wait(timeout='60')
        self.assertEqual(result.returncode, 1)
        self.assertIn('rollback restored', result.stdout)

    def test_failure_that_appears_while_waiting_is_noticed_promptly(self):
        self.report('running', 'verify')
        threading.Timer(0.5, self.report, ('failed', 'grant')).start()
        result, elapsed = self.wait(timeout='60')
        self.assertEqual(result.returncode, 1)
        self.assertLess(elapsed, 8)
        self.assertIn('Host: running, phase verify', result.stdout)
        self.assertIn('phase grant', result.stdout)

    def test_superseded_request_is_a_failure(self):
        self.report('superseded', 'queued')
        result, elapsed = self.wait(timeout='60')
        self.assertEqual(result.returncode, 1)
        self.assertLess(elapsed, 5)
        self.assertIn('superseded', result.stdout)

    def test_status_from_another_release_is_ignored(self):
        self.report('failed', 'migrate', digest=OTHER_D, revision=OTHER_R)
        self.report('succeeded', 'complete', digest=OTHER_D, revision=R)
        self.report('succeeded', 'complete', digest=D, revision=OTHER_R)
        Health.revision = R
        result, _ = self.wait(timeout='1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('did not report success', result.stdout)
        self.assertNotIn('The host reports success', result.stdout)

    def test_a_proxy_replaying_another_releases_success_is_not_believed(self):
        class Replay(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = ('{"digest":"%s","revision":"%s","status":"succeeded","phase":"complete","requested":100}' % (OTHER_D, OTHER_R)).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass
        replay = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Replay)
        threading.Thread(target=replay.serve_forever, daemon=True).start()
        Health.revision = R
        try:
            result, _ = self.wait(timeout='1', receiver_port=replay.server_port)
        finally:
            replay.shutdown()
            replay.server_close()
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('The host reports success', result.stdout)

    def test_stale_status_from_an_earlier_attempt_of_the_same_release_is_ignored(self):
        self.report('failed', 'migrate', requested=50)
        Health.revision = R
        result, _ = self.wait(timeout='1', REQUEST_TIMESTAMP='100')
        self.assertEqual(result.returncode, 1)
        self.assertIn('earlier request', result.stdout)
        self.assertNotIn('The host did not deploy', result.stdout)
        # The new attempt then overwrites it and is believed.
        threading.Timer(0.5, self.report, ('succeeded', 'complete')).start()
        result, _ = self.wait(timeout='10', REQUEST_TIMESTAMP='100')
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_success_needs_the_host_report_and_the_public_revision(self):
        self.report('succeeded', 'complete')
        Health.revision = R
        result, _ = self.wait()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('The host reports success', result.stdout)
        self.assertIn(f'Production is running {R}', result.stdout)

    def test_host_success_alone_is_not_enough(self):
        self.report('succeeded', 'complete')
        Health.revision = OTHER_R
        result, _ = self.wait(ready='1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('public site did not report ' + R, result.stdout)

    def test_public_revision_alone_is_not_enough(self):
        Health.revision = R
        result, _ = self.wait(timeout='1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('The host did not report success', result.stdout)

    def test_a_stalled_host_fails_at_the_bounded_timeout(self):
        self.report('running', 'start')
        result, elapsed = self.wait(timeout='1')
        self.assertEqual(result.returncode, 1)
        self.assertLess(elapsed, 10)
        self.assertIn('within 1 seconds', result.stdout)
        self.assertIn('running, phase start', result.stdout)

    def test_an_unreachable_receiver_fails_at_the_bounded_timeout(self):
        result, elapsed = self.wait(timeout='1', receiver_port=free_port())
        self.assertEqual(result.returncode, 1)
        self.assertLess(elapsed, 10)
        self.assertIn('receiver unreachable', result.stdout)

    def test_wrong_signing_secret_never_reads_status(self):
        self.report('succeeded', 'complete')
        Health.revision = R
        result, _ = self.wait(timeout='1', WEBHOOK_SECRET='another-secret-that-is-not-the-receivers')
        self.assertEqual(result.returncode, 1)
        self.assertIn('HTTP 401', result.stdout)

    def test_preflight_passes_against_the_updated_receiver(self):
        result, _ = self.wait('preflight')
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_preflight_fails_before_queueing_against_an_old_receiver(self):
        class Old(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(404)
                self.end_headers()

            def log_message(self, *args):
                pass
        old = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Old)
        threading.Thread(target=old.serve_forever, daemon=True).start()
        try:
            result, _ = self.wait('preflight', receiver_port=old.server_port)
        finally:
            old.shutdown()
            old.server_close()
        self.assertEqual(result.returncode, 1)
        self.assertIn('Nothing was deployed', result.stdout)


if __name__ == '__main__':
    unittest.main()
