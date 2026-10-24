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
        # Default export covers every season, with a year on each film. Keep
        # this command compatible with the original single-season image so
        # the first annual-watchlist upgrade can back up before migrating.
        core.compose('exec', '-T', 'spooktober', 'node', 'database.cjs', 'export', '-', output=stream)
    try:
        content = json.loads(partial.read_text())
        films = content.get('films')
        if not isinstance(films, list) or any(not isinstance(film, dict) for film in films):
            raise ValueError()
        # Entirely untagged snapshots come from the pre-year release (2026).
        # A new snapshot must tag every film with a valid calendar year.
        if any('year' in film for film in films) and any(
                type(film.get('year')) is not int or not 1900 <= film['year'] <= 9999 for film in films):
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
