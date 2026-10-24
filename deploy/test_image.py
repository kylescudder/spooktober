"""Production migration and permission commands, run inside the real runtime image.

Uses the exact argument lists hooks.py builds for production (same flags,
read-only root, no capabilities, private database network, owner env file) against
a disposable PostgreSQL container. Set SPOOKTOBER_TEST_IMAGE to a built image, e.g.

    docker build -t spooktober:ci . && SPOOKTOBER_TEST_IMAGE=spooktober:ci \\
        python3 -B -m unittest discover -s deploy -p test_image.py -v

CI sets it, so the check cannot be skipped there.
"""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
# Only the app-specific command builder is needed for these image integration tests.
core=types.ModuleType('deploy_core');core.APP=None
with patch.dict(sys.modules,{'deploy_core':core}):
    spec=importlib.util.spec_from_file_location('app_hooks',HERE/'hooks.py')
    app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)


def run_command(command):
    result=subprocess.run(command,capture_output=True,timeout=180)
    if result.returncode:raise AssertionError('Migration command failed.')


IMAGE = os.environ.get('SPOOKTOBER_TEST_IMAGE')
POSTGRES = 'postgres:18.6-alpine'
DATABASE = 'spooktober'
OWNER = 'spooktober_owner'
RUNTIME = app.RUNTIME_ROLE


def docker(*args, check=True, **kwargs):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=180, **kwargs)
    if check and result.returncode:
        raise AssertionError(f'docker {args[0]} failed: {result.stderr[-500:]}')
    return result


@unittest.skipUnless(IMAGE, 'set SPOOKTOBER_TEST_IMAGE to a built Spooktober image')
class RuntimeImage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        suffix = secrets.token_hex(4)
        cls.network, cls.database = f'spooktober-test-{suffix}', f'spooktober-test-db-{suffix}'
        cls.owner_password, cls.runtime_password = secrets.token_hex(16), secrets.token_hex(16)
        cls.temp = tempfile.TemporaryDirectory()
        cls.app = Path(cls.temp.name)
        docker('network', 'create', '--internal', cls.network)
        docker('run', '-d', '--rm', '--name', cls.database, '--network', cls.network, '--network-alias', 'postgres',
               '-e', f'POSTGRES_DB={DATABASE}', '-e', f'POSTGRES_USER={OWNER}', '-e', f'POSTGRES_PASSWORD={cls.owner_password}', POSTGRES)
        for _ in range(60):
            ready = docker('exec', cls.database, 'pg_isready', '-h', 'postgres', '-U', OWNER, '-d', DATABASE, check=False)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise AssertionError('Disposable PostgreSQL did not become ready.')
        cls.sql(f"CREATE ROLE {RUNTIME} LOGIN PASSWORD '{cls.runtime_password}'", OWNER, cls.owner_password)
        env = cls.app / '.env.migration'
        env.write_text(f'DATABASE_URL=postgres://{OWNER}:{cls.owner_password}@postgres:5432/{DATABASE}?sslmode=disable\n')
        env.chmod(0o600)
        cls.patch = patch.object(core, 'APP', cls.app)
        cls.patch.start()

    @classmethod
    def tearDownClass(cls):
        cls.patch.stop()
        docker('rm', '-f', cls.database, check=False)
        docker('network', 'rm', cls.network, check=False)
        cls.temp.cleanup()

    @classmethod
    def sql(cls, statement, user, password):
        return docker('exec', '-e', f'PGPASSWORD={password}', cls.database, 'psql', '-h', 'postgres', '-U', user, '-d', DATABASE,
                      '-v', 'ON_ERROR_STOP=1', '-tA', '-c', statement, check=False)

    def commands(self):
        return app.migration_commands(IMAGE, self.network)

    def runtime_sql(self, statement):
        return self.sql(statement, RUNTIME, self.runtime_password)

    def test_production_commands_migrate_and_grant_only_what_the_app_needs(self):
        migrate, grant = self.commands()
        # Run this app's exact production migration/grant commands.
        run_command(migrate)
        run_command(grant)
        # Repeatable, as every release runs both again.
        run_command(migrate)
        run_command(grant)

        for statement in ("SELECT count(*) FROM public.films", "SELECT max(version) FROM public.schema_migrations",
                          "INSERT INTO films (id,title,position,created_at,updated_at,year) VALUES ('t1','Halloween',0,'now','now',2026)",
                          "UPDATE films SET watched=true, watched_at='now' WHERE id='t1'"):
            result = self.runtime_sql(statement)
            self.assertEqual(result.returncode, 0, f'{statement}: {result.stderr}')
        for statement in ("DELETE FROM films", "INSERT INTO schema_migrations (version) VALUES (2)",
                          "UPDATE schema_migrations SET version=9", "DELETE FROM schema_migrations",
                          "CREATE TABLE forbidden (id integer)"):
            result = self.runtime_sql(statement)
            self.assertNotEqual(result.returncode, 0, f'runtime role must not run: {statement}')
            self.assertIn('permission denied', result.stderr)

    def test_the_runtime_role_can_run_the_app_image_against_the_granted_database(self):
        run_command(self.commands()[0])
        run_command(self.commands()[1])
        url = f'postgres://{RUNTIME}:{self.runtime_password}@postgres:5432/{DATABASE}?sslmode=disable'
        result = self.runtime_sql("""INSERT INTO films (id,title,position,created_at,updated_at,year)
          VALUES ('backup-1900','Halloween',0,'1900-10-31T23:00:00.123456789Z','1900-10-31T23:00:00.123456789Z',1900),
                 ('backup-1901','Alien',0,'1901-10-31T23:00:00Z','1901-10-31T23:00:00Z',1901)""")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = docker('run', '--rm', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                        '--network', self.network, '-e', f'DATABASE_URL={url}', IMAGE, 'node', 'database.cjs', 'export', '-')
        films = json.loads(result.stdout)['films']
        historical = [film for film in films if film['id'].startswith('backup-')]
        self.assertEqual([(film['id'], film['year'], film['position']) for film in historical],
                         [('backup-1900', 1900, 0), ('backup-1901', 1901, 0)])
        self.assertEqual(historical[0]['updatedAt'], '1900-10-31T23:00:00.123456789Z')

    def test_a_grant_that_the_login_cannot_make_is_not_reported_as_success(self):
        run_command(self.commands()[0])
        self.sql('CREATE ROLE spooktober_other', OWNER, self.owner_password)
        url = f'postgres://{RUNTIME}:{self.runtime_password}@postgres:5432/{DATABASE}?sslmode=disable'
        # PostgreSQL only warns when a non-owner grants; the command must still fail.
        denied = docker('run', '--rm', '--read-only', '--cap-drop', 'ALL', '--network', self.network,
                        '-e', f'DATABASE_URL={url}', IMAGE, 'node', 'database.cjs', 'grant', 'spooktober_other', check=False)
        self.assertNotEqual(denied.returncode, 0)
        self.assertEqual(self.sql("SELECT has_table_privilege('spooktober_other','public.films','SELECT')", OWNER, self.owner_password).stdout.strip(), 'f')

    def test_image_needs_no_loose_dependencies_for_permission_setup(self):
        # Offline, with no credentials: the bundled CLI must carry everything it needs.
        result = docker('run', '--rm', '--read-only', '--cap-drop', 'ALL', '--network', 'none', IMAGE, 'node', 'database.cjs', 'help')
        self.assertIn('grant <runtime-role>', result.stdout)
        self.assertNotIn('MODULE_NOT_FOUND', result.stdout + result.stderr)

    def test_failures_stay_generic_and_do_not_leak_credentials(self):
        run_command(self.commands()[0])
        grant = self.commands()[1]
        grant[-1] = 'spooktober_missing_role'
        result = docker(*grant[1:], check=False)
        self.assertNotEqual(result.returncode, 0)
        combined = result.stdout + result.stderr
        self.assertIn('Database command failed', combined)
        for private in (self.owner_password, self.runtime_password, 'postgres://'):
            self.assertNotIn(private, combined)
        unsafe = self.commands()[1]
        unsafe[-1] = 'x"; DROP TABLE films; --'
        self.assertNotEqual(docker(*unsafe[1:], check=False).returncode, 0)
        self.assertEqual(self.sql('SELECT count(*) FROM films', OWNER, self.owner_password).returncode, 0)


if __name__ == '__main__':
    unittest.main()
