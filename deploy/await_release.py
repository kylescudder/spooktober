#!/usr/bin/env python3
"""Wait for Herman to report one release, then for the public site to run it.

Run by the release workflow after it queues a deployment:

    await_release.py preflight   # before queueing: can Herman report status at all?
    await_release.py wait        # after queueing: host success, then public readiness

Herman's receiver answers a signed GET with sanitized metadata only (status, phase,
rollback outcome). A terminal host failure fails the workflow immediately; a stalled
host or unreachable receiver fails at a bounded deadline. Status for any other
release, or for an earlier request of the same release, is treated as not yet reported.
"""
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TERMINAL_FAILURES = ('failed', 'superseded')


def env(name, default=None):
    value = os.environ.get(name, default)
    if value is None:
        raise SystemExit(f'::error::{name} is not set.')
    return value


def annotate(level, message):
    print(f'::{level}::{message}', flush=True)


def summary(message):
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if path:
        with open(path, 'a') as stream:
            stream.write(message + '\n')


def request(url, headers, timeout):
    """Return (http_status, headers, body); (None, {}, b'') when the request itself failed."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as response:
            return response.status, response.headers, response.read(4096)
    except urllib.error.HTTPError as error:
        return error.code, error.headers, b''
    except (urllib.error.URLError, OSError, ValueError):
        return None, {}, b''


def host_status(settings):
    """Fetch the signed status for the requested release; returns (document or None, problem)."""
    timestamp = str(int(time.time()))
    message = f'status\n{settings["digest"]}\n{settings["revision"]}\n{timestamp}'
    signature = hmac.new(settings['secret'].encode(), message.encode(), hashlib.sha256).hexdigest()
    query = urllib.parse.urlencode({'digest':settings['digest'], 'revision':settings['revision'], 'timestamp':timestamp})
    code, _, body = request(f'{settings["deploy_url"]}?{query}', {
        'X-Spooktober-Signature': f'sha256={signature}', 'User-Agent': 'spooktober-release/1',
        'CF-Access-Client-Id': settings['access_id'], 'CF-Access-Client-Secret': settings['access_secret'],
    }, settings['request_timeout'])
    if code is None:
        return None, 'receiver unreachable'
    if code != 200:
        return None, f'receiver returned HTTP {code}'
    try:
        document = json.loads(body)
    except ValueError:
        return None, 'receiver returned an unreadable status'
    if not isinstance(document, dict):
        return None, 'receiver returned an unreadable status'
    return document, None


def belongs_to_request(document, settings):
    if document.get('digest') != settings['digest'] or document.get('revision') != settings['revision']:
        return False
    # Pending has no request yet; any other state must come from this request, not an earlier attempt.
    requested = settings['requested']
    return document.get('status') == 'pending' or requested is None or document.get('requested') == requested


def describe(document):
    parts = [str(document.get('status')), f'phase {document.get("phase")}' if document.get('phase') else None,
             f'rollback {document["rollback"]}' if document.get('rollback') else None]
    return ', '.join(part for part in parts if part)


def preflight(settings):
    document, problem = host_status(settings)
    known = ('pending', 'running', 'succeeded', 'failed', 'superseded')
    if (document is None or document.get('status') not in known or document.get('digest') != settings['digest']
            or document.get('revision') != settings['revision']):
        annotate('error', f'Herman cannot report release status ({problem or "unexpected response"}). '
                 'Install the updated receiver and deploy tooling before releasing; see deploy/README.md. Nothing was deployed.')
        return 1
    print('Herman reports release status.')
    return 0


def wait_for_host(settings):
    deadline = time.monotonic() + settings['host_timeout']
    last, problem = None, 'no status yet'
    while True:
        document, error = host_status(settings)
        if document is not None and belongs_to_request(document, settings):
            problem = None
            if document['status'] == 'succeeded':
                print(f'Herman reports success ({describe(document)}).')
                return True
            if document['status'] in TERMINAL_FAILURES:
                annotate('error', f'Herman did not deploy {settings["revision"]}: {describe(document)}. '
                         'Production is unchanged or was rolled back. See state/deploy.log and state/last-failure.json on Herman.')
                summary(f'Herman reported `{document["status"]}` at phase `{document.get("phase")}`.')
                return False
            current = describe(document)
            if current != last:
                print(f'Herman: {current}', flush=True)
                last = current
        else:
            problem = error or 'status belongs to another release or an earlier request'
        if time.monotonic() >= deadline:
            annotate('error', f'Herman did not report success for {settings["revision"]} within {int(settings["host_timeout"])} seconds '
                     f'(last: {last or problem}). Check state/deploy.log on Herman.')
            return False
        time.sleep(settings['poll'])


def wait_for_public(settings):
    deadline = time.monotonic() + settings['ready_timeout']
    revision = None
    while True:
        code, headers, _ = request(settings['health_url'], {'User-Agent': 'spooktober-release/1'}, settings['request_timeout'])
        revision = headers.get('x-spooktober-revision') if code == 200 else None
        if revision == settings['revision']:
            print(f'Production is running {revision}.')
            summary(f'Production is running `{revision}`.')
            return True
        if time.monotonic() >= deadline:
            annotate('error', f'Herman reported success but the public site did not report {settings["revision"]} '
                     f'within {int(settings["ready_timeout"])} seconds (last: {revision or "none"}).')
            return False
        time.sleep(settings['poll'])


def main(argv):
    if len(argv) != 2 or argv[1] not in ('preflight', 'wait'):
        raise SystemExit('Usage: await_release.py preflight|wait')
    requested = os.environ.get('REQUEST_TIMESTAMP')
    settings = {
        'deploy_url': env('DEPLOY_URL'), 'health_url': env('HEALTH_URL'),
        'digest': env('DIGEST'), 'revision': env('REVISION'), 'secret': env('WEBHOOK_SECRET'),
        'access_id': env('CF_ACCESS_CLIENT_ID', ''), 'access_secret': env('CF_ACCESS_CLIENT_SECRET', ''),
        'requested': int(requested) if requested else None,
        'host_timeout': float(env('HOST_TIMEOUT', '900')), 'ready_timeout': float(env('READY_TIMEOUT', '180')),
        'request_timeout': float(env('REQUEST_TIMEOUT', '10')), 'poll': float(env('POLL_SECONDS', '5')),
    }
    if argv[1] == 'preflight':
        return preflight(settings)
    return 0 if wait_for_host(settings) and wait_for_public(settings) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
