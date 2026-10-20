"""Spooktober deploy settings and hooks, and the vendored core's integrity."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('host_deploy', HERE / 'host-deploy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
core = module.core
IMAGE = module.APP.image + '@sha256:' + 'a' * 64

SETTINGS = {'name': 'spooktober',
 'title': 'Spooktober',
 'image': 'ghcr.io/kylescudder/spooktober',
 'repo': 'kylescudder/spooktober',
 'image_var': 'SPOOKTOBER_IMAGE',
 'service': 'spooktober',
 'workflow': 'release.yml',
 'branch': 'main',
 'compose_file': 'compose.yaml',
 'public_status': False,
 'release_status': True,
 'bind_source_digest': False,
 'backups': True,
 'require_host': False}

# Commands each hook issues, recorded when this app moved onto deploy-core and
# checked against the previous deployer. {APP} and {PLATFORM} are the checkout
# and the platform directory.
COMMANDS = {'start': [['compose',
            ['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'spooktober'],
            'ghcr.io/kylescudder/spooktober@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']],
 'accept': [],
 'prepare': [['compose', ['exec', '-T', 'spooktober', 'node', 'database.cjs', 'export', '-'], None],
             ['run',
              ['docker',
               'run',
               '--rm',
               '--read-only',
               '--cap-drop',
               'ALL',
               '--security-opt',
               'no-new-privileges:true',
               '--network',
               'platform-db',
               '--env-file',
               '{APP}/.env.migration',
               'ghcr.io/kylescudder/spooktober@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
               'node',
               'database.cjs',
               'migrate'],
              None],
             ['run',
              ['docker',
               'run',
               '--rm',
               '--read-only',
               '--cap-drop',
               'ALL',
               '--security-opt',
               'no-new-privileges:true',
               '--network',
               'platform-db',
               '--env-file',
               '{APP}/.env.migration',
               'ghcr.io/kylescudder/spooktober@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
               'node',
               'database.cjs',
               'grant',
               'spooktober_runtime'],
              None]]}


def record(hook, *args):
    log = []
    def run(command, **kwargs):
        log.append(['run', list(command), kwargs.get('timeout')])
        if kwargs.get('output') is not None:
            kwargs['output'].write(b'{"films":[]}')
        return b''
    def compose(*command, **kwargs):
        log.append(['compose', list(command), kwargs.get('image')])
        if kwargs.get('output') is not None:
            kwargs['output'].write(b'{"films":[]}')
        return b''
    with tempfile.TemporaryDirectory() as folder:
        platform = Path(folder).resolve()
        app = platform / 'apps/app'
        (app / 'backups').mkdir(parents=True)
        for name in ('.env', '.env.migration'):
            (app / name).write_text('X=1\n')
            (app / name).chmod(0o600)
        for name in ('office_tracker', 'paddock', 'suggestions', 'big_day_planner'):
            password = platform / 'projects' / name / 'owner-password'
            password.parent.mkdir(parents=True)
            password.write_text('owner')
            password.chmod(0o600)
        core.configure(module.APP)
        with patch.object(core, 'APP', app), patch.object(core, 'BACKUPS', app / 'backups'), \
             patch.object(core, 'run', run), patch.object(core, 'compose', compose):
            try:
                hook(*args)
            except core.Error as error:
                log.append(['error', str(error)])
        text = json.dumps(log).replace(str(app), '{APP}').replace(str(platform), '{PLATFORM}')
    return json.loads(text)


class Settings(unittest.TestCase):
    def test_vendored_core_matches_its_lock(self):
        # Edit kylescudder/deploy-core and run its sync.py instead of changing the vendored copy.
        lock = json.loads((HERE / 'deploy_core.lock').read_text())
        for name, digest in lock['sha256'].items():
            self.assertEqual(hashlib.sha256((HERE / name).read_bytes()).hexdigest(), digest, name)

    def test_release_identity_and_options(self):
        app = module.APP
        actual = {k: getattr(app, k) for k in SETTINGS}
        self.assertEqual(actual, SETTINGS)
        self.assertEqual(app.app_dir, HERE.parents[0])


class Hooks(unittest.TestCase):
    def test_health_acceptance_and_prepare_issue_the_recorded_commands(self):
        hooks = {'start': lambda: core.start(IMAGE), 'accept': lambda: core.accept(IMAGE),
                  'prepare': lambda: module.APP.prepare and module.APP.prepare(IMAGE, {'State': {'Running': True}})}
        for name, hook in hooks.items():
            with self.subTest(name):
                self.assertEqual(normalise(record(hook)), COMMANDS[name])


def normalise(log):
    # Temporary directory names are random; keep only their role.
    out = []
    for entry in log:
        if entry[0] in ('run', 'compose'):
            # A migration env file is written to a fresh temporary directory.
            entry = [entry[0], ['{TMPFILE}' if str(a).endswith('/migration.env') else a for a in entry[1]], entry[2]]
        out.append(entry)
    return out


if __name__ == '__main__':
    unittest.main()
