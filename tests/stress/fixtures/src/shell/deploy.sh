#!/bin/bash
# deploy.sh — primary Shell fixture.
# Defines deployment functions.

set -euo pipefail

DEPLOY_DIR="/opt/app"
BACKUP_DIR="/opt/backups"
LOG_FILE="/var/log/deploy.log"

log_message() {
    local level="$1"
    local msg="$2"
    echo "[$(date -Iseconds)] [$level] $msg" >> "$LOG_FILE"
}

check_prerequisites() {
    local missing=0
    for cmd in docker node npm; do
        if ! command -v "$cmd" &>/dev/null; then
            log_message "ERROR" "Missing required command: $cmd"
            missing=$((missing + 1))
        fi
    done
    return "$missing"
}

create_backup() {
    local timestamp
    timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_path="$BACKUP_DIR/backup_$timestamp.tar.gz"
    tar -czf "$backup_path" -C "$DEPLOY_DIR" .
    log_message "INFO" "Backup created: $backup_path"
    echo "$backup_path"
}

deploy_application() {
    local version="$1"
    local env="${2:-production}"

    log_message "INFO" "Starting deployment of v$version to $env"

    create_backup
    cd "$DEPLOY_DIR" || exit 1
    npm ci --production
    npm run build

    log_message "INFO" "Deployment complete: v$version"
}

rollback_deployment() {
    local backup_path="$1"
    if [ ! -f "$backup_path" ]; then
        log_message "ERROR" "Backup not found: $backup_path"
        return 1
    fi
    tar -xzf "$backup_path" -C "$DEPLOY_DIR"
    log_message "INFO" "Rollback complete from: $backup_path"
}
