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

# --- Step 1: Qdrant snapshot ---
echo "[Step 1] Creating Qdrant snapshot for collection: $COLLECTION"
SNAP_RESP=$(curl -sf -X POST "$QDRANT_API/collections/$COLLECTION/snapshots")
SNAP_NAME=$(echo "$SNAP_RESP" | jq -r '.result.name')
if [ -z "$SNAP_NAME" ] || [ "$SNAP_NAME" = "null" ]; then
    echo "ERROR: Failed to create Qdrant snapshot"
    echo "Response: $SNAP_RESP"
    exit 1
fi
echo "Snapshot created: $SNAP_NAME"

# Download snapshot
echo "Downloading snapshot..."
SNAP_DIR="$REPO_DIR/qdrant_snapshots"
curl -sf -o "$SNAP_DIR/latest.snapshot" \
    "$QDRANT_API/collections/$COLLECTION/snapshots/$SNAP_NAME"
echo "Snapshot saved: $(du -h "$SNAP_DIR/latest.snapshot" | cut -f1)"

# Export points as JSON (human-readable, for diffing)
echo "Exporting points as JSON..."
TOTAL=$(curl -sf "$QDRANT_API/collections/$COLLECTION" | jq '.result.points_count')
echo "Total points: $TOTAL"

# Scroll all points (without vectors for readability)
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
# Core config file
cp "$OPENCLAW_CONFIG/openclaw.json" "$REPO_DIR/openclaw_config/openclaw.json"
# Extensions (including patched mem0 plugin)
if [ -d "$OPENCLAW_CONFIG/extensions" ]; then
    rsync -a --delete \
        --exclude='node_modules' \
        "$OPENCLAW_CONFIG/extensions/" "$REPO_DIR/openclaw_config/extensions/"
fi
echo "OpenClaw config synced"

# --- Step 4: Metadata ---
echo "[Step 4] Writing backup metadata"
cat > "$REPO_DIR/backup_metadata.json" << METAEOF
{
    "timestamp": "$(date -Iseconds)",
    "qdrant_collection": "$COLLECTION",
    "qdrant_points": $TOTAL,
    "snapshot_file": "latest.snapshot",
    "mcp_server_path": "$MCP_DIR",
    "openclaw_config_path": "$OPENCLAW_CONFIG",
    "hostname": "$(hostname)",
    "kernel": "$(uname -r)"
}
METAEOF
echo "Metadata written"

# --- Step 5: Git commit & push ---
echo "[Step 5] Committing and pushing to GitHub"
cd "$REPO_DIR"

# Configure SSH for this git operation
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

# --- Cleanup: delete Qdrant snapshot from server ---
echo "[Cleanup] Deleting Qdrant snapshot from server storage"
curl -sf -X DELETE "$QDRANT_API/collections/$COLLECTION/snapshots/$SNAP_NAME" > /dev/null || true

echo "========================================"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup completed successfully"
echo "========================================"
