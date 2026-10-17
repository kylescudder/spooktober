#!/usr/bin/env python3
"""Deploy independently verified main images, consuming the newest queued request."""
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

IMAGE = 'ghcr.io/kylescudder/spooktober'
REPO = 'kylescudder/spooktober'
DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
REVISION = re.compile(r'[0-9a-f]{40}\Z')
APP = Path(os.environ.get('APP_DIR', Path(__file__).resolve().parents[1]))
STATE = APP / 'state'
BACKUPS = APP / 'backups'
REQUESTS = APP / 'deploy-spool/requests'


class Error(RuntimeError):
    pass


def log(message):
    print(f'[spooktober-deploy] {datetime.now(timezone.utc).isoformat()} {message}', flush=True)


def run(args, *, output=None, input_data=None, env=None, timeout=300):
    try:
        result = subprocess.run(args, cwd=APP, input=input_data, env=env,
                                stdout=output if output is not None else subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Error(f'{args[0]} operation timed out.') from None
    if result.returncode:
        # Command stderr and resolved environment can contain production credentials.
        raise Error(f'{args[0]} {args[1]} operation failed (exit {result.returncode}).')
    return result.stdout or b''


def compose(*args, image=None, output=None):
    env = os.environ.copy()
    if image:
        env['SPOOKTOBER_IMAGE'] = image
    return run(['docker', 'compose', '--project-directory', str(APP), '-f', str(APP / 'compose.yaml'),
                '--env-file', str(APP / '.env'), *args], env=env, output=output, timeout=180)


def private_env(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise Error(f'{path.name} must be a protected regular file (0600).')
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise Error(f'{path.name} contains an invalid environment entry.')
        values[key] = value.strip().strip('"\'')
    return values


def save_json(path, value):
    temp = path.with_name(path.name + '.next')
    with temp.open('w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temp.chmod(0o600)
    temp.replace(path)


def take_request():
    # Consume this snapshot only. Arrivals during deployment start the next run.
    if REQUESTS.is_symlink() or REQUESTS.parent.is_symlink():
        raise Error('Queue directories must not be symlinks.')
    # A receiver crash can leave a partial file. Remove old partials so launchd
    # does not keep restarting on a nonempty directory with no ready requests.
    for partial in REQUESTS.glob('.*.json.tmp'):
        if not partial.is_symlink() and partial.is_file() and time.time() - partial.stat().st_mtime > 30:
            partial.unlink()
    paths = sorted(REQUESTS.glob('*.json'))
    if not paths:
        return None
    valid = []
    for path in paths:
        try:
            if path.is_symlink() or path.stat().st_size > 1024:
                raise ValueError()
            value = json.loads(path.read_text())
            if not DIGEST.fullmatch(value.get('digest', '')) or not REVISION.fullmatch(value.get('revision', '')):
                raise ValueError()
            if type(value.get('timestamp')) is not int:
                raise ValueError()
            valid.append((value['timestamp'], path.name, value))
        except (ValueError, TypeError, OSError, AttributeError):
            log('discarded malformed queue entry')
    selected = max(valid, key=lambda entry:entry[:2])[2] if valid else None
    if selected:
        save_json(STATE / 'last-request.json', selected)
    for path in paths:
        if path.is_dir() and not path.is_symlink():
            path.rename(STATE / ('rejected-directory-' + uuid.uuid4().hex))
        else:
            path.unlink(missing_ok=True)
    return selected


def pin(image):
    path = APP / '.env'
    lines = [line for line in path.read_text().splitlines() if not line.startswith('SPOOKTOBER_IMAGE=')]
    temp = path.with_name('.env.next')
    temp.write_text('\n'.join(lines) + f'\nSPOOKTOBER_IMAGE={image}\n')
    temp.chmod(0o600)
    temp.replace(path)


def start(image):
    compose('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'spooktober', image=image)


def deploy(digest, requested_revision=None):
    if not DIGEST.fullmatch(digest):
        raise Error('Use an exact sha256 digest.')
    runtime = private_env(APP / '.env')
    private_env(APP / '.env.migration')
    candidate = f'{IMAGE}@{digest}'
    ids = compose('ps', '-a', '-q', 'spooktober').decode().strip().splitlines()
    if len(ids) > 1:
        raise Error('Expected a single Spooktober container.')
    current = json.loads(run(['docker', 'inspect', '--format', '{{json .}}', ids[0]])) if ids else None
    running = current['Config']['Image'] if current else None
    if running == candidate and current['State'].get('Health', {}).get('Status') == 'healthy':
        revision = (current['Config'].get('Labels') or {}).get('org.opencontainers.image.revision', '')
        if not REVISION.fullmatch(revision) or requested_revision and requested_revision != revision:
            raise Error('Running image revision does not match the request.')
        log('requested digest is already healthy')
        pin(candidate)
        return
    log(f'verifying {candidate}')
    run(['gh', 'attestation', 'verify', f'oci://{candidate}', '--bundle-from-oci', '--repo', REPO,
         '--signer-workflow', REPO + '/.github/workflows/release.yml', '--source-ref', 'refs/heads/main',
         '--deny-self-hosted-runners'], timeout=180)
    run(['docker', 'pull', '--quiet', candidate], timeout=300)
    labels = json.loads(run(['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', candidate])) or {}
    revision = labels.get('org.opencontainers.image.revision', '')
    if not REVISION.fullmatch(revision) or requested_revision and requested_revision != revision:
        raise Error('Verified image revision does not match the request.')
    log(f'provenance verified for {revision}')
    if current and current['State']['Running']:
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = BACKUPS / f'pre-deploy-{stamp}.json'
        partial = backup.with_suffix('.json.partial')
        with partial.open('wb') as stream:
            compose('exec', '-T', 'spooktober', 'node', 'database.cjs', 'export', '-', output=stream)
        try:
            content = json.loads(partial.read_text())
            if not isinstance(content.get('films'), list):
                raise ValueError()
        except (ValueError, AttributeError):
            raise Error('Pre-deploy watchlist export was invalid.') from None
        partial.replace(backup)
        for old in sorted(BACKUPS.glob('pre-deploy-*.json'), reverse=True)[14:]:
            old.unlink()
        log('saved pre-deploy watchlist backup')
    db_network = runtime.get('PLATFORM_DB_NETWORK', 'platform-db')
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', db_network):
        raise Error('Invalid database network.')
    migration = ['docker', 'run', '--rm', '--read-only', '--cap-drop', 'ALL', '--security-opt',
                 'no-new-privileges:true', '--network', db_network, '--env-file', str(APP / '.env.migration'), candidate]
    run([*migration, 'node', 'database.cjs', 'migrate'])
    grants = "GRANT USAGE ON SCHEMA public TO spooktober_runtime; GRANT SELECT ON public.schema_migrations TO spooktober_runtime; REVOKE INSERT, UPDATE, DELETE ON public.schema_migrations FROM spooktober_runtime; GRANT SELECT, INSERT, UPDATE ON public.films TO spooktober_runtime; REVOKE DELETE ON public.films FROM spooktober_runtime;"
    js = "const {Client}=require('pg'); const c=new Client({connectionString:process.env.DATABASE_URL}); (async()=>{await c.connect();try{await c.query(process.argv[1])}finally{await c.end()}})().catch(()=>process.exit(1));"
    run([*migration, 'node', '-e', js, grants])
    log('migrations and runtime grants applied')
    try:
        start(candidate)
    except Error:
        log('candidate failed health check')
        if running and running != candidate:
            try:
                start(running)
                pin(running)
                log('previous image restored; migrations are not reverted')
            except Error:
                raise Error('ROLLBACK FAILED; inspect the private deployment logs.') from None
        else:
            compose('stop', 'spooktober', image=candidate)
        raise Error('Candidate was not healthy; deploy failed.') from None
    pin(candidate)
    stamp = datetime.now(timezone.utc).isoformat()
    with (STATE / 'history.log').open('a') as stream:
        stream.write(f'{stamp} {candidate} {revision}\n')
    save_json(STATE / 'deployment.json', {'deployed_at':stamp, 'image':candidate, 'revision':revision})
    log(f'healthy on {candidate}')


def main():
    os.umask(0o077)
    for folder in (STATE, BACKUPS, REQUESTS):
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if len(sys.argv) > 2:
            raise Error('Usage: herman-deploy.sh [sha256:<digest>]')
        request = {'digest':sys.argv[1]} if len(sys.argv) == 2 else take_request()
        if request is None:
            log('no queued requests')
            return
        try:
            deploy(request['digest'], request.get('revision'))
        except Error as error:
            save_json(STATE / 'last-failure.json', {'failed_at':datetime.now(timezone.utc).isoformat(),
                      'digest':request['digest'], 'error':str(error)})
            raise


if __name__ == '__main__':
    try:
        main()
    except (Error, OSError, ValueError, KeyError) as error:
        log(str(error) if isinstance(error, Error) else f'Deploy failed: {type(error).__name__}.')
        sys.exit(1)
