"""Security gates, queue handling and rollback without production changes."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deployer', Path(__file__).with_name('herman-deploy.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
D = 'sha256:' + 'a' * 64
R = 'b' * 40


def docker_inspect(image, state, labels=None):
    # Shaped like `docker inspect <container>`: a one-element array of the full document.
    return json.dumps([{'Id':'container','Config':{'Image':image,'Labels':labels,'Env':['UNUSED=1']},'State':state}]).encode()


class Deploy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Path(self.temp.name)
        self.patches = [patch.object(module, k, self.app / v) for k,v in
                        [('APP','.'),('STATE','state'),('BACKUPS','backups'),('REQUESTS','requests'),('STATUS','status')]]
        for p in self.patches:p.start()
        for d in (module.STATE,module.BACKUPS,module.REQUESTS,module.STATUS):d.mkdir()
        for f in ('.env','.env.migration'):
            p=self.app/f;p.write_text('DATABASE_URL=private\n');p.chmod(0o600)
        self.calls=[]

    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()

    def queue(self, name, timestamp, digest=D, revision=R):
        (module.REQUESTS/name).write_text(json.dumps({'digest':digest,'revision':revision,'timestamp':timestamp}))

    def status(self, digest=D, revision=R):
        path=module.status_path(digest,revision)
        return json.loads(path.read_text()) if path.exists() else None

    def run_main(self, run, start=None):
        """Drive the real entry point so failures are reported exactly as launchd would."""
        patches=[patch.object(module,'run',run),patch.object(module,'compose',self.fake_compose),patch.object(module.sys,'argv',['herman-deploy.py'])]
        if start:patches.append(patch.object(module,'start',start))
        for p in patches:p.start()
        try:module.main()
        finally:
            for p in reversed(patches):p.stop()

    def test_newest_valid_request_wins_and_malformed_is_consumed(self):
        self.queue('old.json',10)
        self.queue('new.json',20,'sha256:'+'c'*64)
        (module.REQUESTS/'broken.json').write_text('{')
        self.assertEqual(module.take_request()['timestamp'],20)
        self.assertEqual(list(module.REQUESTS.iterdir()),[])
        self.assertIsNone(module.take_request())

    def test_symlink_cannot_read_outside_queue(self):
        private=self.app/'private';private.write_text('keep')
        (module.REQUESTS/'link.json').symlink_to(private)
        self.assertIsNone(module.take_request())
        self.assertEqual(private.read_text(),'keep')

    def test_replaced_queue_directory_is_rejected_without_touching_target(self):
        module.REQUESTS.rmdir()
        target=self.app/'other';target.mkdir()
        (target/'private.json').write_text('keep')
        module.REQUESTS.symlink_to(target)
        with self.assertRaises(module.Error):module.take_request()
        self.assertEqual((target/'private.json').read_text(),'keep')

    def test_malformed_directory_is_quarantined_without_a_launch_loop(self):
        (module.REQUESTS/'bad.json').mkdir()
        self.assertIsNone(module.take_request())
        self.assertEqual(list(module.REQUESTS.iterdir()),[])
        self.assertEqual(len(list(module.STATE.glob('rejected-directory-*'))),1)

    def test_stale_partial_is_removed_and_fresh_partial_is_left_alone(self):
        stale=module.REQUESTS/'.old.json.tmp';stale.write_text('partial');os.utime(stale,(0,0))
        fresh=module.REQUESTS/'.new.json.tmp';fresh.write_text('partial')
        self.assertIsNone(module.take_request())
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    def test_healthy_same_digest_requires_the_requested_revision(self):
        current={'Config':{'Image':module.IMAGE+'@'+D,'Labels':{'org.opencontainers.image.revision':R}},
                 'State':{'Running':True,'Health':{'Status':'healthy'}}}
        with patch.object(module,'run',return_value=docker_inspect(current['Config']['Image'],current['State'],current['Config']['Labels'])),patch.object(module,'compose',self.fake_compose),patch.object(module,'start') as start:
            with self.assertRaises(module.Error):module.deploy(D,'c'*40)
            module.deploy(D,R)
            start.assert_not_called()

    def fake_run(self, args, **kwargs):
        self.calls.append(args)
        if args[:2]==['docker','inspect']:
            return docker_inspect('previous',{'Running':True,'Health':{'Status':'healthy'}},{})
        if args[:3]==['docker','image','inspect']:
            return json.dumps({'org.opencontainers.image.revision':R}).encode()
        return b''

    def fake_compose(self,*args,**kwargs):
        if args[0]=='ps':return b'container\n'
        if args[0]=='exec':kwargs['output'].write(b'{"films":[]}')
        return b''

    def test_failed_verification_never_migrates_or_starts(self):
        def run(args,**kwargs):
            if args[0]=='gh':raise module.Error('verification rejected')
            return self.fake_run(args,**kwargs)
        with patch.object(module,'run',run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start') as start:
            with self.assertRaises(module.Error):module.deploy(D,R)
            start.assert_not_called()
        self.assertFalse(any(c[:2]==['docker','run'] for c in self.calls))

    def test_revision_mismatch_never_migrates_or_starts(self):
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start') as start:
            with self.assertRaises(module.Error):module.deploy(D,'c'*40)
            start.assert_not_called()
        self.assertFalse(any(c[:2]==['docker','run'] for c in self.calls))

    def test_failed_health_restores_previous_and_does_not_record_success(self):
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start',side_effect=[module.Error('unhealthy'),None]) as start:
            with self.assertRaises(module.Error):module.deploy(D,R)
            self.assertEqual([c.args[0] for c in start.call_args_list],[module.IMAGE+'@'+D,'previous'])
        self.assertFalse((module.STATE/'history.log').exists())
        self.assertIn('SPOOKTOBER_IMAGE=previous',(self.app/'.env').read_text())

    def test_success_is_pinned_and_new_arrival_remains_queued(self):
        def start(image):self.queue('arriving.json',30)
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start',start):module.deploy(D,R)
        self.assertIn(module.IMAGE+'@'+D,(self.app/'.env').read_text())
        self.assertTrue((module.STATE/'history.log').exists())
        self.assertTrue((module.REQUESTS/'arriving.json').exists())

    def test_permissions_use_the_bundled_cli_and_the_real_runtime_role(self):
        migrate,grant=module.migration_commands(module.IMAGE+'@'+D,'platform-db')
        self.assertEqual(migrate[-3:],['node','database.cjs','migrate'])
        self.assertEqual(grant[-4:],['node','database.cjs','grant','spooktober_runtime'])
        for command in (migrate,grant):
            self.assertNotIn('-e',command)
            self.assertNotIn('proj_spooktober_runtime',' '.join(command))
            for flag in ('--read-only','--rm'):self.assertIn(flag,command)
            self.assertEqual(command[command.index('--cap-drop')+1],'ALL')
            self.assertEqual(command[command.index('--security-opt')+1],'no-new-privileges:true')
            self.assertEqual(command[command.index('--network')+1],'platform-db')
            self.assertEqual(command[command.index('--env-file')+1],str(self.app/'.env.migration'))
        source=Path(module.__file__).read_text()
        self.assertNotIn('proj_spooktober',source)
        self.assertNotIn("require('pg')",source)

    def test_migration_failure_is_reported_promptly_and_sanitized(self):
        self.queue('request.json',50)
        def run(args,**kwargs):
            if args[:2]==['docker','run'] and 'migrate' in args:raise module.Error('docker run operation failed (exit 1).')
            return self.fake_run(args,**kwargs)
        with self.assertRaises(module.Error):self.run_main(run)
        status=self.status()
        self.assertEqual((status['status'],status['phase'],status['requested']),('failed','migrate',50))
        self.assertEqual(set(status),{'digest','revision','status','phase','updated_at','requested'})
        self.assertFalse(any('grant' in c for c in self.calls))
        self.assertFalse((module.STATE/'history.log').exists())
        self.assertIn('exit 1',json.loads((module.STATE/'last-failure.json').read_text())['error'])

    def test_grant_failure_is_reported_and_the_candidate_is_never_started(self):
        self.queue('request.json',51)
        def run(args,**kwargs):
            if args[:2]==['docker','run'] and 'grant' in args:raise module.Error('docker run operation failed (exit 1).')
            return self.fake_run(args,**kwargs)
        with self.assertRaises(module.Error):self.run_main(run,start=lambda image:self.fail('candidate started'))
        self.assertEqual(self.status()['phase'],'grant')
        self.assertEqual(self.status()['status'],'failed')

    def test_provenance_failure_is_reported_before_anything_changes(self):
        self.queue('request.json',52)
        def run(args,**kwargs):
            if args[0]=='gh':raise module.Error('gh attestation operation failed (exit 1).')
            return self.fake_run(args,**kwargs)
        with self.assertRaises(module.Error):self.run_main(run)
        self.assertEqual((self.status()['status'],self.status()['phase']),('failed','verify'))
        self.assertFalse(any(c[:2]==['docker','run'] for c in self.calls))

    def test_unexpected_exception_still_reports_failure_without_its_message(self):
        self.queue('request.json',53)
        def run(args,**kwargs):
            if args[:2]==['docker','image']:raise KeyError('secret-looking-detail')
            return self.fake_run(args,**kwargs)
        with self.assertRaises(KeyError):self.run_main(run)
        self.assertEqual(self.status()['status'],'failed')
        self.assertNotIn('secret-looking-detail',json.dumps(self.status())+(module.STATE/'last-failure.json').read_text())

    def test_failed_health_reports_the_rollback_outcome(self):
        self.queue('request.json',54)
        with self.assertRaises(module.Error):self.run_main(self.fake_run,start=lambda image:(_ for _ in ()).throw(module.Error('unhealthy')) if image!='previous' else None)
        status=self.status()
        self.assertEqual((status['status'],status['phase'],status['rollback']),('failed','health','restored'))

    def test_success_is_reported_only_for_the_requested_release_and_request(self):
        self.queue('request.json',55)
        self.run_main(self.fake_run,start=lambda image:None)
        status=self.status()
        self.assertEqual((status['status'],status['phase'],status['requested']),('succeeded','complete',55))
        self.assertIsNone(self.status('sha256:'+'c'*64))
        self.assertIsNone(self.status(D,'c'*40))

    def test_replaced_requests_are_reported_as_superseded(self):
        self.queue('old.json',10,'sha256:'+'c'*64,'d'*40)
        self.queue('same.json',11)
        self.queue('new.json',20)
        selected=module.take_request()
        self.assertEqual(selected['timestamp'],20)
        old=self.status('sha256:'+'c'*64,'d'*40)
        self.assertEqual((old['status'],old['requested']),('superseded',10))
        self.assertIsNone(self.status())

    def test_manual_deploys_without_a_revision_publish_nothing(self):
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start'):
            module.deploy(D)
        self.assertEqual(list(module.STATUS.iterdir()),[])

    def test_status_history_is_bounded(self):
        for i in range(module.KEEP_STATUS+5):
            module.write_status('sha256:'+f'{i:064x}',f'{i:040x}','succeeded','complete')
        self.assertEqual(len(list(module.STATUS.glob('*.json'))),module.KEEP_STATUS)

    def test_an_unwritable_status_directory_does_not_interrupt_a_deployment(self):
        module.STATUS.rmdir()
        module.STATUS.write_text('not a directory')
        with patch.object(module,'run',self.fake_run),patch.object(module,'compose',self.fake_compose),patch.object(module,'start'):
            module.deploy(D,R,module.Progress(D,R,1))
        self.assertTrue((module.STATE/'history.log').exists())


    def test_inspect_survives_pipes_and_newlines_in_a_failed_health_log(self):
        log=[{'ExitCode':1,'Output':'error: boom\n3 | for (const path of paths) {\n  ^\n'},{'ExitCode':1,'Output':'a|b|c\n|\n'}]
        raw=docker_inspect(module.IMAGE+'@'+D,{'Status':'exited','Running':False,'Health':{'Status':'unhealthy','Log':log}},
                           {'org.opencontainers.image.revision':R})
        with patch.object(module,'run',return_value=raw):current=module.inspect_current('container')
        self.assertEqual(current,{'Config':{'Image':module.IMAGE+'@'+D,'Labels':{'org.opencontainers.image.revision':R}},
                                  'State':{'Running':False,'Status':'exited','Health':{'Status':'unhealthy'}}})

    def test_unparseable_inspect_output_is_reported_without_echoing_it(self):
        with patch.object(module,'run',return_value=b'3 | secret-looking text'):
            with self.assertRaises(module.Error) as caught:module.inspect_current('container')
        self.assertNotIn('secret',str(caught.exception))
    def test_stopped_failed_candidate_is_replaced_and_never_restored(self):
        log=[{'ExitCode':1,'Output':'3 | for (const path of paths) {\n'}]
        stopped=docker_inspect(module.IMAGE+'@sha256:'+'c'*64,{'Status':'exited','Running':False,
                               'Health':{'Status':'unhealthy','Log':log}},{})
        def run(args,**kwargs):
            if args[:2]==['docker','inspect']:return stopped
            return self.fake_run(args,**kwargs)
        stops=[]
        def compose(*args,**kwargs):
            if args[0]=='stop':stops.append(kwargs.get('image'))
            return self.fake_compose(*args,**kwargs)
        with patch.object(module,'run',run),patch.object(module,'compose',compose),patch.object(module,'start',side_effect=module.Error('unhealthy')) as start:
            with self.assertRaises(module.Error):module.deploy(D,R)
            self.assertEqual([c.args[0] for c in start.call_args_list],[module.IMAGE+'@'+D])
        self.assertEqual(stops,[module.IMAGE+'@'+D])
        with patch.object(module,'run',run),patch.object(module,'compose',compose),patch.object(module,'start') as start:
            module.deploy(D,R)
            start.assert_called_once_with(module.IMAGE+'@'+D)
        self.assertIn('SPOOKTOBER_IMAGE='+module.IMAGE+'@'+D,(self.app/'.env').read_text())


if __name__=='__main__':unittest.main()
