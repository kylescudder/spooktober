#!/usr/bin/env bash
# Deploys a Spooktober release on Herman. Started by spooktober-deploy.path when
# the webhook receiver queues a request, or by hand with an exact digest:
#
#   herman-deploy.sh                    deploy the newest queued request
#   herman-deploy.sh sha256:<digest>    deploy (or roll back to) a main build
#
# It verifies the image's provenance attestation, backs up the list, migrates,
# recreates the container pinned to the digest and restores the previous image
# if the new one does not become healthy.
set -Eeuo pipefail
umask 077

APP_DIR=${APP_DIR:-/srv/apps/spooktober}
IMAGE=${IMAGE:-ghcr.io/kylescudder/spooktober}
REPO=kylescudder/spooktober
SIGNER_WORKFLOW=$REPO/.github/workflows/release.yml
STATE_DIR=${STATE_DIR:-$APP_DIR/state}
BACKUP_DIR=${BACKUP_DIR:-$APP_DIR/backups}
REQUEST_DIR=${REQUEST_DIR:-$APP_DIR/deploy-spool/requests}
KEEP_BACKUPS=${KEEP_BACKUPS:-14}

log() { echo "[spooktober-deploy] $*"; }
compose() { docker compose --project-directory "$APP_DIR" -f "$APP_DIR/compose.yaml" "$@"; }
env_value() { sed -n "s/^$1=//p" "$APP_DIR/.env" | tail -n 1; }

# Optional GH_TOKEN for gh attestation verify.
if [[ -r "$APP_DIR/.env.deploy" ]]; then set -a; . "$APP_DIR/.env.deploy"; set +a; fi

mkdir -p "$STATE_DIR" "$BACKUP_DIR"
exec 9>"$STATE_DIR/deploy.lock"
flock 9

if [[ $# -gt 0 ]]; then
  [[ $1 =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "usage: $0 [sha256:<digest>]" >&2; exit 2; }
  digest=$1
else
  # Newest request wins; older queued requests are superseded.
  shopt -s nullglob
  requests=("$REQUEST_DIR"/*.json)
  [[ ${#requests[@]} -gt 0 ]] || { log "no queued requests"; exit 0; }
  newest=$(printf '%s\n' "${requests[@]}" | sort | tail -n 1)
  digest=$(sed -n 's/.*"digest":"\(sha256:[0-9a-f]\{64\}\)".*/\1/p' "$newest")
  rm -f -- "${requests[@]}"
  [[ -n $digest ]] || { log "ignored malformed request $(basename "$newest")"; exit 1; }
fi
candidate="$IMAGE@$digest"
trap 'log "deploy of $candidate stopped at line $LINENO; the running container was not changed"' ERR

running_id=$(compose ps -q spooktober 2>/dev/null || true)
running=""
[[ -n $running_id ]] && running=$(docker inspect --format '{{.Config.Image}}' "$running_id")
if [[ $running == "$candidate" ]]; then
  log "already running $candidate"
  exit 0
fi
log "deploying $candidate (currently ${running:-not running})"

docker pull --quiet "$candidate" >/dev/null
# Only images built by release.yml from main on GitHub-hosted runners pass.
gh attestation verify "oci://$candidate" --bundle-from-oci \
  --repo "$REPO" --signer-workflow "$SIGNER_WORKFLOW" \
  --source-ref refs/heads/main --deny-self-hosted-runners >/dev/null
log "provenance verified"

if [[ -n $running_id ]]; then
  backup="$BACKUP_DIR/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).json"
  compose exec -T spooktober node database.cjs export - >"$backup.partial"
  [[ -s "$backup.partial" ]] || { log "backup was empty"; exit 1; }
  mv "$backup.partial" "$backup"
  log "backed up list to $backup"
  ls -1t "$BACKUP_DIR"/pre-deploy-*.json | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm --
else
  log "no running container; skipping pre-deploy backup"
fi

db_network=$(env_value PLATFORM_DB_NETWORK)
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --network "${db_network:-platform-db}" \
  --env-file "$APP_DIR/.env.migration" "$candidate" node database.cjs migrate
log "migrations applied"

start() { SPOOKTOBER_IMAGE=$1 compose up -d --no-build --pull never --wait --wait-timeout 120 spooktober; }

if start "$candidate"; then
  echo "$(date -u +%FT%TZ) $candidate" >>"$STATE_DIR/history.log"
  log "healthy on $candidate"
  exit 0
fi

trap - ERR
log "new release failed its health check"
if [[ -n $running && $running != "$candidate" ]]; then
  log "rolling back to $running (migrations are not reverted)"
  start "$running" && log "rollback healthy" || log "ROLLBACK FAILED; check: docker compose logs spooktober"
fi
exit 1
