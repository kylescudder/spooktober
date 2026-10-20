#!/usr/bin/env python3
"""Spooktober application-owned hooks for the installed deployment service."""
from datetime import datetime, timezone
import json
from pathlib import Path
import re

import deploy_core as core

# Database `spooktober` has roles spooktober_owner (migrations) and spooktober_runtime (the app).
RUNTIME_ROLE = 'spooktober_runtime'


def migration_commands(candidate, db_network):
    """Owner commands run inside the candidate image; every dependency is in the bundled CLI."""
    base = ['docker', 'run', '--rm', '--read-only', '--cap-drop', 'ALL', '--security-opt',
            'no-new-privileges:true', '--network', db_network, '--env-file', str(core.APP / '.env.migration'), candidate]
    return [[*base, 'node', 'database.cjs', 'migrate'], [*base, 'node', 'database.cjs', 'grant', RUNTIME_ROLE]]


def backup_watchlist():
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = core.BACKUPS / f'pre-deploy-{stamp}.json'
    partial = backup.with_suffix('.json.partial')
    with partial.open('wb') as stream:
        core.compose('exec', '-T', 'spooktober', 'node', 'database.cjs', 'export', '-', output=stream)
    try:
        content = json.loads(partial.read_text())
        if not isinstance(content.get('films'), list):
            raise ValueError()
    except (ValueError, AttributeError):
        raise core.Error('Pre-deploy watchlist export was invalid.') from None
    partial.replace(backup)
    for old in sorted(core.BACKUPS.glob('pre-deploy-*.json'), reverse=True)[core.KEEP_BACKUPS:]:
        old.unlink()
    core.log('saved pre-deploy watchlist backup')


def prepare(candidate, current):
    runtime = core.private_env(core.APP / '.env')
    core.private_env(core.APP / '.env.migration')
    if current and current['State']['Running']:
        core.progress.publish('running', 'backup')
        backup_watchlist()
    db_network = runtime.get('PLATFORM_DB_NETWORK', 'platform-db')
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', db_network):
        raise core.Error('Invalid database network.')
    core.progress.publish('running', 'migrate')
    migrate, grant = migration_commands(candidate, db_network)
    core.run(migrate)
    core.progress.publish('running', 'grant')
    core.run(grant)
    core.log('migrations and runtime grants applied')
