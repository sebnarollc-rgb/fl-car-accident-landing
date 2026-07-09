#!/usr/bin/env bash
# =====================================================================
# Off-server, encrypted backup of captured leads + audit log.
# Protects against VPS loss/compromise and gives a recovery point.
#
# Encrypts with GPG (symmetric, passphrase in env) so client PII is
# never stored or transmitted in plaintext, then ships the blob to a
# remote you control (rclone remote, or scp target).
#
# Setup (once):
#   - Set BACKUP_PASSPHRASE (store it in a password manager, NOT here).
#   - Either configure rclone (`rclone config`) and set RCLONE_REMOTE,
#     or set SCP_TARGET=user@host:/path for scp.
# Run from cron daily — see HARDENING.md.
# =====================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lead-server}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE (do not hard-code it)}"

ARCHIVE="$WORK/leads-backup-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$APP_DIR" \
  $( [ -f "$APP_DIR/leads.csv" ] && echo leads.csv ) \
  $( [ -f "$APP_DIR/audit.log" ] && echo audit.log )

ENC="$ARCHIVE.gpg"
gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase "$BACKUP_PASSPHRASE" -o "$ENC" "$ARCHIVE"

if [ -n "${RCLONE_REMOTE:-}" ]; then
  rclone copy "$ENC" "$RCLONE_REMOTE" && echo "==> uploaded to rclone remote: $RCLONE_REMOTE"
elif [ -n "${SCP_TARGET:-}" ]; then
  scp "$ENC" "$SCP_TARGET" && echo "==> copied to $SCP_TARGET"
else
  echo "!! Neither RCLONE_REMOTE nor SCP_TARGET set — encrypted backup left at:"
  echo "   $ENC  (copy it somewhere off-box)"
  cp "$ENC" "$APP_DIR/" && echo "   (also placed in $APP_DIR for now)"
fi

echo "==> backup complete: $(basename "$ENC")"
echo "    Restore with:  gpg --decrypt FILE.gpg > leads.tar.gz && tar -xzf leads.tar.gz"
