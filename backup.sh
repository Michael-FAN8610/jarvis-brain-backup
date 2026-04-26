#!/bin/bash
# =============================================================================
# Jarvis Brain Backup Script
# 每日自动备份 Qdrant 记忆、MCP Server 代码、OpenClaw 配置到 GitHub
# Cron: 0 3 * * *
# =============================================================================
set -euo pipefail

# --- Configuration ---
REPO_DIR="/opt/jarvis/backup-repo"
QDRANT_API="http://localhost:6333"
COLLECTION="jarvis_memories"
MCP_DIR="/opt/jarvis-mcp"
OPENCLAW_CONFIG="/var/lib/docker/volumes/openclaw_openclaw-config/_data"
LOG_FILE="/var/log/jarvis-backup.log"
SSH_KEY="/root/.ssh/jarvis_backup_deploy"
DATE=$(date +%Y-%m-%d_%H%M%S)

# --- Logging ---
exec > >(tee -a "$LOG_FILE") 2>&1
echo "========================================"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup started"
echo "========================================"

# --- Step 1: Qdrant snapshot (only if points changed) ---
echo "[Step 1] Checking Qdrant collection: $COLLECTION"
TOTAL=$(curl -sf "$QDRANT_API/collections/$COLLECTION" | jq '.result.points_count')
echo "Current points: $TOTAL"

# Read previous point count from metadata
PREV_POINTS=0
if [ -f "$REPO_DIR/backup_metadata.json" ]; then
    PREV_POINTS=$(jq -r '.qdrant_points // 0' "$REPO_DIR/backup_metadata.json")
fi

if [ "$TOTAL" != "$PREV_POINTS" ] || [ ! -f "$REPO_DIR/qdrant_snapshots/latest.snapshot" ]; then
    echo "Points changed ($PREV_POINTS -> $TOTAL) or snapshot missing, creating new snapshot..."
    SNAP_RESP=$(curl -sf -X POST "$QDRANT_API/collections/$COLLECTION/snapshots")
    SNAP_NAME=$(echo "$SNAP_RESP" | jq -r '.result.name')
    if [ -z "$SNAP_NAME" ] || [ "$SNAP_NAME" = "null" ]; then
        echo "ERROR: Failed to create Qdrant snapshot"
        echo "Response: $SNAP_RESP"
        exit 1
    fi
    echo "Snapshot created: $SNAP_NAME"

    curl -sf -o "$REPO_DIR/qdrant_snapshots/latest.snapshot" \
        "$QDRANT_API/collections/$COLLECTION/snapshots/$SNAP_NAME"
    echo "Snapshot saved: $(du -h "$REPO_DIR/qdrant_snapshots/latest.snapshot" | cut -f1)"

    # Cleanup server-side snapshot
    curl -sf -X DELETE "$QDRANT_API/collections/$COLLECTION/snapshots/$SNAP_NAME" > /dev/null || true
else
    echo "Points unchanged ($TOTAL), skipping snapshot"
fi

# Export points as JSON (human-readable, for diffing)
echo "Exporting points as JSON..."
curl -sf -X POST "$QDRANT_API/collections/$COLLECTION/points/scroll" \
    -H 'Content-Type: application/json' \
    -d "{\"limit\": $TOTAL, \"with_payload\": true, \"with_vector\": false}" \
    | jq '.result.points | sort_by(.id) | .[] | {id, payload}' \
    > "$REPO_DIR/qdrant_snapshots/memories_export.json"
EXPORT_COUNT=$(grep -c '"id"' "$REPO_DIR/qdrant_snapshots/memories_export.json" || echo 0)
echo "Exported $EXPORT_COUNT memories to JSON"

# --- Step 2: MCP Server code ---
echo "[Step 2] Copying MCP Server files"
rsync -a --delete \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.venv' \
    --exclude='venv' \
    "$MCP_DIR/" "$REPO_DIR/mcp_server/"
echo "MCP Server files synced"

# --- Step 3: OpenClaw config ---
echo "[Step 3] Copying OpenClaw configuration"
mkdir -p "$REPO_DIR/openclaw_config"
cp "$OPENCLAW_CONFIG/openclaw.json" "$REPO_DIR/openclaw_config/openclaw.json"
if [ -d "$OPENCLAW_CONFIG/extensions" ]; then
    rsync -a --delete \
        --exclude='node_modules' \
        "$OPENCLAW_CONFIG/extensions/" "$REPO_DIR/openclaw_config/extensions/"
fi
echo "OpenClaw config synced"

# --- Step 4: Metadata (stable fields only, no timestamp) ---
echo "[Step 4] Writing backup metadata"
cat > "$REPO_DIR/backup_metadata.json" << METAEOF
{
    "qdrant_collection": "$COLLECTION",
    "qdrant_points": $TOTAL,
    "snapshot_file": "latest.snapshot",
    "mcp_server_path": "$MCP_DIR",
    "openclaw_config_path": "$OPENCLAW_CONFIG",
    "hostname": "$(hostname)"
}
METAEOF
echo "Metadata written"

# --- Step 5: Git commit & push ---
echo "[Step 5] Committing and pushing to GitHub"
cd "$REPO_DIR"
export GIT_SSH_COMMAND="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new"

git add -A
if git diff --cached --quiet; then
    echo "No changes detected, skipping commit"
else
    COMMIT_MSG="backup: $DATE | ${TOTAL} memories"
    git commit -m "$COMMIT_MSG"
    git push -u origin master
    echo "Pushed to GitHub successfully"
fi

echo "========================================"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup completed successfully"
echo "========================================"

# [5.6 运维加固] systemd 服务清单快照（2026-04-26 追加）
systemctl list-unit-files 'jarvis-*' > /opt/jarvis/backup/systemd_snapshot.txt
