"""memory_audit.py - 一次性记忆质量巡检，扫描 Qdrant 中的重复记忆对"""
import os
import sys
import json
import numpy as np
from datetime import datetime
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue

QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
COLLECTION = os.getenv("COLLECTION_NAME", "jarvis_memories")
USER_ID = "fanchangqing"
THRESHOLD = 0.85

client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT, timeout=30)


def cosine_sim(a, b):
    a, b = np.array(a), np.array(b)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-10))


def audit():
    print(f"[audit] Scanning collection={COLLECTION} user={USER_ID} threshold={THRESHOLD}")

    # 拉取所有记忆（含向量）
    all_points = []
    offset = None
    while True:
        points, offset = client.scroll(
            collection_name=COLLECTION,
            scroll_filter=Filter(
                should=[
                    FieldCondition(key="user_id", match=MatchValue(value=USER_ID)),
                    FieldCondition(key="userId", match=MatchValue(value=USER_ID)),
                ]
            ),
            limit=100,
            offset=offset,
            with_vectors=True,
            with_payload=True,
        )
        all_points.extend(points)
        if offset is None:
            break

    print(f"[audit] Total memories: {len(all_points)}")

    # 两两比较找重复对（数据量 < 1000，O(n²) 可接受）
    duplicates = []
    for i in range(len(all_points)):
        for j in range(i + 1, len(all_points)):
            score = cosine_sim(all_points[i].vector, all_points[j].vector)
            if score >= THRESHOLD:
                pa = all_points[i].payload or {}
                pb = all_points[j].payload or {}
                ca = (pa.get("memory") or pa.get("data") or "")[:120]
                cb = (pb.get("memory") or pb.get("data") or "")[:120]
                duplicates.append({
                    "id_a": str(all_points[i].id),
                    "id_b": str(all_points[j].id),
                    "content_a": ca,
                    "content_b": cb,
                    "score": round(score, 4),
                    "suggestion": "delete_one" if score >= 0.95 else "merge",
                })

    duplicates.sort(key=lambda x: -x["score"])

    report = {
        "audit_time": datetime.now().isoformat(),
        "total_memories": len(all_points),
        "duplicate_pairs": len(duplicates),
        "threshold": THRESHOLD,
        "exact_duplicates": len([d for d in duplicates if d["score"] >= 0.95]),
        "similar_pairs": len([d for d in duplicates if d["score"] < 0.95]),
        "pairs": duplicates,
    }

    out = "/opt/jarvis-mcp/memory_audit_report.json"
    with open(out, "w") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"[audit] Found {len(duplicates)} duplicate pairs "
          f"({report['exact_duplicates']} exact, {report['similar_pairs']} similar)")
    print(f"[audit] Report saved to {out}")

    # 打印 top 15
    for d in duplicates[:15]:
        print(f"  [{d['suggestion']}] score={d['score']:.4f}")
        print(f"    A: {d['content_a'][:80]}")
        print(f"    B: {d['content_b'][:80]}")

    if len(duplicates) > 15:
        print(f"  ... and {len(duplicates) - 15} more pairs")


if __name__ == "__main__":
    audit()
