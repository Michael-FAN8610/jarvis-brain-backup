"""memory_cleanup.py - 基于巡检报告的自动清理：删除完全重复记忆 (score >= 0.95)
策略：对同一条记忆的所有副本（联通分量），保留 payload 内容最长的一条，删除其余。
"""
import os
import json
from collections import defaultdict
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue

QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
COLLECTION = os.getenv("COLLECTION_NAME", "jarvis_memories")

client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT, timeout=30)


def load_report(path="/opt/jarvis-mcp/memory_audit_report.json"):
    with open(path) as f:
        return json.load(f)


def find_clusters(pairs):
    """Union-Find: 把 score >= 0.95 的 id 对连成联通分量"""
    parent = {}

    def find(x):
        while parent.get(x, x) != x:
            parent[x] = parent.get(parent[x], parent[x])
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for p in pairs:
        if p["score"] >= 0.95:
            union(p["id_a"], p["id_b"])

    clusters = defaultdict(set)
    all_ids = set()
    for p in pairs:
        if p["score"] >= 0.95:
            all_ids.add(p["id_a"])
            all_ids.add(p["id_b"])

    for uid in all_ids:
        clusters[find(uid)].add(uid)

    return dict(clusters)


def get_content_length(point):
    """获取 payload 中记忆内容的长度"""
    payload = point.payload or {}
    content = payload.get("memory") or payload.get("data") or ""
    return len(content)


def cleanup(dry_run=True):
    report = load_report()
    exact_pairs = [p for p in report["pairs"] if p["score"] >= 0.95]

    if not exact_pairs:
        print("[cleanup] No exact duplicates found. Nothing to do.")
        return

    clusters = find_clusters(exact_pairs)
    print(f"[cleanup] Found {len(clusters)} duplicate clusters from {len(exact_pairs)} pairs")

    # 收集所有需要查询的 id
    all_ids = set()
    for ids in clusters.values():
        all_ids.update(ids)

    # 批量查询 payload
    points_map = {}
    id_list = list(all_ids)
    for i in range(0, len(id_list), 50):
        batch = id_list[i:i+50]
        pts = client.retrieve(
            collection_name=COLLECTION,
            ids=batch,
            with_payload=True,
            with_vectors=False,
        )
        for pt in pts:
            points_map[str(pt.id)] = pt

    to_delete = []
    to_keep = []

    for root, ids in clusters.items():
        # 找到内容最长的作为保留项
        best_id = None
        best_len = -1
        for uid in ids:
            pt = points_map.get(uid)
            if pt:
                clen = get_content_length(pt)
                if clen > best_len:
                    best_len = clen
                    best_id = uid

        if best_id is None:
            continue

        to_keep.append(best_id)
        for uid in ids:
            if uid != best_id:
                to_delete.append(uid)

    print(f"[cleanup] Plan: keep {len(to_keep)}, delete {len(to_delete)}")

    for uid in to_delete:
        pt = points_map.get(uid)
        content_preview = ""
        if pt and pt.payload:
            content_preview = (pt.payload.get("memory") or pt.payload.get("data") or "")[:80]
        print(f"  {'[DRY-RUN] ' if dry_run else ''}DELETE {uid}: {content_preview}")

    print()
    for uid in to_keep:
        pt = points_map.get(uid)
        content_preview = ""
        if pt and pt.payload:
            content_preview = (pt.payload.get("memory") or pt.payload.get("data") or "")[:80]
        print(f"  KEEP   {uid}: {content_preview}")

    if dry_run:
        print(f"\n[cleanup] DRY RUN complete. {len(to_delete)} points would be deleted.")
        print("[cleanup] Run with --execute to actually delete.")
    else:
        # 执行删除
        if to_delete:
            client.delete(
                collection_name=COLLECTION,
                points_selector=to_delete,
            )
            print(f"\n[cleanup] DONE. Deleted {len(to_delete)} duplicate points.")

        # 验证
        remaining = client.count(
            collection_name=COLLECTION,
            count_filter=Filter(
                should=[
                    FieldCondition(key="user_id", match=MatchValue(value="fanchangqing")),
                    FieldCondition(key="userId", match=MatchValue(value="fanchangqing")),
                ]
            ),
        )
        print(f"[cleanup] Remaining memories: {remaining.count}")


if __name__ == "__main__":
    import sys
    execute = "--execute" in sys.argv
    cleanup(dry_run=not execute)
