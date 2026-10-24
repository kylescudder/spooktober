"""App-owned hook commands, independent of the separately installed engine.

Expected calls were captured from the audited pre-migration hooks. The core API
is mocked here; provenance, queues, locks and rollback are tested in deploy-core.
"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

HERE=Path(__file__).resolve().parent
IMAGE='ghcr.io/kylescudder/spooktober@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
RECORD={'deployed_at':'test-time','image':IMAGE,'revision':'b'*40,
        'previous_image':'previous','previous_revision':'c'*40}
HTML=b''


def record_hooks():
    core=types.ModuleType('deploy_core');core.Error=RuntimeError;core.KEEP_BACKUPS=14
    calls=[]
    with tempfile.TemporaryDirectory() as temp:
        platform=Path(temp).resolve();core.APP=platform/'apps/app';core.BACKUPS=core.APP/'backups'
        core.BACKUPS.mkdir(parents=True)
        password=platform/'projects/spooktober/owner-password';password.parent.mkdir(parents=True)
        password.write_text('test-only-owner');password.chmod(0o600)
        core.protected_file=Mock(side_effect=lambda path, what:path)
        core.private_env=Mock(return_value={'PLATFORM_DB_NETWORK':'platform-db'})
        core.log=Mock();core.progress=types.SimpleNamespace(publish=Mock())
        core.backup_database=Mock(side_effect=lambda db:calls.append(['backup_database',db]))
        core.save_json=Mock(side_effect=lambda p,v:calls.append(['save_json',str(p),v]))
        def run(command, **kw):
            calls.append(['run',list(command),kw.get('timeout')]);return b''
        def compose(*command, **kw):
            calls.append(['compose',list(command),kw.get('image')])
            if kw.get('output') is not None:kw['output'].write(b'{"films":[]}');return b''
            if any('apple-app-site-association' in str(a) for a in command):
                return b'{"applinks":{"details":[{"appIDs":["6AAGJ9Y234.app.getmoss.moss"]}]}}'
            return HTML
        core.run=run;core.compose=compose
        with patch.dict(sys.modules,{'deploy_core':core}):
            spec=importlib.util.spec_from_file_location('app_hooks',HERE/'hooks.py')
            hooks=importlib.util.module_from_spec(spec);spec.loader.exec_module(hooks)
            for name,args in [('health',(IMAGE,)),('accept',(IMAGE,)),
                              ('prepare',(IMAGE,{'State':{'Running':True}})),('after_success',(RECORD,))]:
                function=getattr(hooks,name,None)
                if function:function(*args)
        text=json.dumps(calls).replace(str(core.APP),'{APP}').replace(str(platform),'{PLATFORM}')
        calls=json.loads(text)
        for entry in calls:
            if entry[0]=='run':entry[1]=['{MIGRATION_ENV}' if str(x).endswith('/migration.env') else x for x in entry[1]]
        return calls


class Hooks(unittest.TestCase):
    def test_backups_reject_invalid_or_partial_year_tags_before_rotating_history(self):
        for films in ([{'year': 2026}, {}], [{'year': '2026'}], [{'year': True}], [{'year': 10000}], ['invalid']):
            with self.subTest(films=films), tempfile.TemporaryDirectory() as temp:
                core = types.ModuleType('deploy_core')
                core.Error = RuntimeError; core.KEEP_BACKUPS = 1
                core.BACKUPS = Path(temp); core.log = Mock()
                previous = core.BACKUPS / 'pre-deploy-20000101.json'
                previous.write_text('{"films":[]}')
                def compose(*args, **kwargs):
                    kwargs['output'].write(json.dumps({'films': films}).encode())
                core.compose = compose
                with patch.dict(sys.modules, {'deploy_core': core}):
                    spec = importlib.util.spec_from_file_location('backup_hooks', HERE / 'hooks.py')
                    hooks = importlib.util.module_from_spec(spec); spec.loader.exec_module(hooks)
                    with self.assertRaisesRegex(RuntimeError, 'export was invalid'):
                        hooks.backup_watchlist()
                self.assertTrue(previous.exists())
                self.assertEqual(list(core.BACKUPS.glob('pre-deploy-*.json')), [previous])

    def test_backups_preserve_all_years_and_accept_the_original_release_during_upgrade(self):
        for films in ([{'id': 'old', 'year': 2020}, {'id': 'new', 'year': 2021}], [{'id': 'legacy'}], []):
            with self.subTest(films=films), tempfile.TemporaryDirectory() as temp:
                core = types.ModuleType('deploy_core')
                core.Error = RuntimeError; core.KEEP_BACKUPS = 1
                core.BACKUPS = Path(temp); core.log = Mock()
                previous = core.BACKUPS / 'pre-deploy-20000101.json'
                previous.write_text('{"films":[]}')
                def compose(*args, **kwargs):
                    kwargs['output'].write(json.dumps({'films': films}).encode())
                core.compose = compose
                with patch.dict(sys.modules, {'deploy_core': core}):
                    spec = importlib.util.spec_from_file_location('backup_hooks', HERE / 'hooks.py')
                    hooks = importlib.util.module_from_spec(spec); spec.loader.exec_module(hooks)
                    hooks.backup_watchlist()
                backups = list(core.BACKUPS.glob('pre-deploy-*.json'))
                self.assertEqual(len(backups), 1)
                self.assertEqual(json.loads(backups[0].read_text()), {'films': films})
                self.assertFalse(previous.exists())

    def test_app_owned_commands_preserve_the_audited_contract(self):
        expected=json.loads((HERE/'hook-commands.json').read_text())
        self.assertEqual(record_hooks(),expected)

    def test_only_the_installed_service_owns_the_engine(self):
        for filename in ('host-deploy.py','deploy_core.py','deploy_core.lock','test_deploy_core.py'):
            self.assertFalse((HERE/filename).exists(),filename)
        self.assertIn('worker spooktober', (HERE/'host-deploy.sh').read_text())


if __name__=='__main__':unittest.main()
