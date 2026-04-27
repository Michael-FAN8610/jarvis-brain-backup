#!/usr/bin/env python3
"""
Jarvis 六期 Dreaming Lite V2：每日记忆整理任务（沙盒版）。

由 cron 触发：30 3 * * * python3 /opt/jarvis-mcp/dreaming_lite.py
              python3 /opt/jarvis-mcp/dreaming_lite.py --dry-run

6.4 沙盒模式（默认）：
- 整理结果写入 /opt/jarvis-mcp/sandbox/pending_changes.json
- 不直接修改正式库，等待庆哥通过 HTTP 端点确认后才 apply
- 通过 /api/sandbox/report 查看变更报告
- 通过 /api/sandbox/apply 确认执行
- 通过 /api/sandbox/discard 放弃

三种运行模式：
- 默认（无参数）：sandbox 模式，生成变更计划文件
- --dry-run：只打印将要执行的操作，不写入任何文件
- --force-apply：跳过沙盒直接执行（向后兼容，紧急情况用）

三项操作：
1. TTL 过期清理：短期(7天)/中期(90天)过期的记忆标记为 archived
2. 批量晋升检查：对所有非 archived 记忆做晋升条件检查
3. 统计报告：打印整理结果（archived 数量、晋升数量、各 tier 分布）

技术要求：
- 直连 Qdrant，与 server.py 使用相同配置
- 使用 scroll API 遍历（不需要 embedding）
- 用 set_payload 更新字段，不重写整个 point
- 分批处理（每批 100 条），避免内存爆炸
- 脚本独立运行，不依赖 server.py 运行时
"""

import os
import sys
import time
import json
import argparse
import math
from datetime import datetime
from collections import Counter
from pathlib import Path

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Filter, FieldCondition, MatchValue, MatchExcept,
)


# -- 配置（与 server.py 保持一致）----------------------------------------------
QDRANT_HOST     = os.getenv("QDRANT_HOST",     "localhost")
QDRANT_PORT     = int(os.getenv("QDRANT_PORT", "6333"))
COLLECTION_NAME = os.getenv("COLLECTION_NAME", "jarvis_memories")
USER_ID         = os.getenv("JARVIS_USER_ID",  "fanchangqing")

# -- 六期常量（与 server.py 保持一致）------------------------------------------
LONG_TERM_CATEGORIES = {"identity", "preference", "decision"}
TIER_TTL_MAP = {"short-term": 7, "mid-term": 90, "long-term": -1}
TIER_BONUS   = {"short-term": 1.0, "mid-term": 1.5, "long-term": 2.0}

# -- 6.4 沙盒配置 --------------------------------------------------------------
SANDBOX_DIR  = os.getenv("SANDBOX_DIR", "/opt/jarvis-mcp/sandbox")
SANDBOX_FILE = os.path.join(SANDBOX_DIR, "pending_changes.json")

# -- 分批处理配置 ---------------------------------------------------------------
SCROLL_BATCH_SIZE  = 100   # 每次 scroll 拉取的数量
UPDATE_BATCH_LIMIT = 100   # 每批更新的数量上限


# -- 工具函数 ------------------------------------------------------------------

def log(msg: str):
    """带时间戳的日志输出"""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def parse_iso_date(iso_str) -> datetime | None:
    """解析 ISO 日期字符串，兼容 server.py 的 +08:00 格式。返回 naive datetime。"""
    if not iso_str or not isinstance(iso_str, str):
        return None
    try:
        # server.py 写入格式：2026-04-27T03:30:00+08:00
        # fromisoformat 在 Python 3.11+ 可以解析 +08:00
        # 为兼容性，手动处理
        cleaned = iso_str.replace("+08:00", "+0800") if "+08:00" in iso_str else iso_str
        dt = datetime.fromisoformat(cleaned)
        return dt.replace(tzinfo=None)
    except Exception:
        return None


def days_since(iso_str) -> int | None:
    """计算从 iso_str 到现在经过了多少天。解析失败返回 None。"""
    dt = parse_iso_date(iso_str)
    if dt is None:
        return None
    return max(0, (datetime.now() - dt).days)


def within_days(iso_str, days: int) -> bool:
    """判断 iso_str 是否在最近 days 天内。"""
    elapsed = days_since(iso_str)
    if elapsed is None:
        return False
    return elapsed <= days


# -- 晋升逻辑（与 server.py 的 _check_promotion 完全一致）-----------------------

def check_promotion(payload: dict) -> str | None:
    """检查记忆是否应该晋升。返回目标 tier 或 None（不晋升）。

    晋升规则：
    - short-term -> mid-term: access_count >= 3 或 category 在 LONG_TERM_CATEGORIES 中
    - mid-term -> long-term: (access_count >= 7 且 30天内有访问) 或 (category 在 LONG_TERM_CATEGORIES 且 access_count >= 3)
    """
    current_tier = payload.get("tier", "short-term")
    access_count = payload.get("access_count", 0)
    category = payload.get("category", "unknown")
    last_accessed = payload.get("last_accessed")

    if current_tier == "long-term":
        return None  # 已在最高层

    if current_tier == "short-term":
        if access_count >= 3:
            return "mid-term"
        if category in LONG_TERM_CATEGORIES:
            return "mid-term"

    if current_tier == "mid-term":
        if access_count >= 7 and within_days(last_accessed, 30):
            return "long-term"
        if category in LONG_TERM_CATEGORIES and access_count >= 3:
            return "long-term"

    return None


# -- TTL 过期判断 ---------------------------------------------------------------

def is_ttl_expired(payload: dict) -> bool:
    """判断记忆是否 TTL 过期。

    规则：
    - long-term (ttl_days=-1)：永不过期
    - 已经是 archived：跳过
    - short-term (ttl_days=7) / mid-term (ttl_days=90)：
      从 updated_at（优先）或 created_at 起算，超过 ttl_days 天即过期
    """
    tier = payload.get("tier", "short-term")

    # 已归档或长期记忆不处理
    if tier in ("archived", "long-term"):
        return False

    ttl_days = payload.get("ttl_days")
    if ttl_days is None:
        ttl_days = TIER_TTL_MAP.get(tier, 7)
    if ttl_days < 0:
        return False  # 永不过期

    # 取 updated_at 优先，回退 created_at
    anchor = payload.get("updated_at") or payload.get("updatedAt") \
             or payload.get("created_at") or payload.get("createdAt")
    elapsed = days_since(anchor)

    if elapsed is None:
        return False  # 无法判断，保守不归档

    return elapsed > ttl_days


# -- Qdrant 滚动遍历 -----------------------------------------------------------

def scroll_all_memories(client: QdrantClient) -> list:
    """使用 scroll API 分批拉取所有用户记忆，返回完整列表。

    Qdrant scroll 返回 (points, next_offset)，next_offset 为 None 时遍历完成。
    """
    all_points = []
    offset = None  # 首次 scroll 不传 offset

    while True:
        scroll_kwargs = dict(
            collection_name=COLLECTION_NAME,
            scroll_filter=Filter(
                should=[
                    FieldCondition(key="user_id", match=MatchValue(value=USER_ID)),
                    FieldCondition(key="userId", match=MatchValue(value=USER_ID)),
                ]
            ),
            limit=SCROLL_BATCH_SIZE,
            with_payload=True,
            with_vectors=False,
        )
        if offset is not None:
            scroll_kwargs["offset"] = offset

        points, next_offset = client.scroll(**scroll_kwargs)
        all_points.extend(points)

        if next_offset is None or len(points) == 0:
            break
        offset = next_offset

    return all_points


# -- 核心整理逻辑 ---------------------------------------------------------------

class DreamingLite:
    """每日记忆整理任务（6.4 沙盒版）。"""

    def __init__(self, mode: str = "sandbox"):
        """
        mode:
        - "sandbox": 生成变更计划文件，不修改正式库（默认）
        - "dry-run": 只打印，不写入任何文件
        - "force-apply": 直接执行，跳过沙盒（紧急情况用）
        """
        self.mode = mode
        self.client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT, timeout=30)

        # 整理统计
        self.archived_count = 0
        self.promoted_count = 0
        self.archived_details = []   # [(point_id_short, content_short, tier)]
        self.promoted_details = []   # [(point_id_short, content_short, from_tier, to_tier)]
        self.tier_distribution = Counter()  # 整理后的 tier 分布
        self.total_count = 0

        # 6.4 沙盒：变更计划列表
        self.pending_changes = []  # [{"action": ..., "point_id": ..., "details": ...}]

    def run(self):
        """执行完整的整理流程。"""
        t_start = time.time()
        log(f"=== Dreaming Lite V2 START (mode={self.mode}) ===")

        # Step 0: 拉取所有记忆
        log("Loading all memories...")
        t0 = time.time()
        all_points = scroll_all_memories(self.client)
        self.total_count = len(all_points)
        log(f"Loaded {self.total_count} memories in {time.time()-t0:.2f}s")

        if self.total_count == 0:
            log("No memories found, exiting.")
            return

        # Step 1: TTL 过期清理
        self._step_ttl_archive(all_points)

        # Step 2: 批量晋升检查（对所有非 archived 记忆）
        self._step_promotion(all_points)

        # Step 3: 统计 tier 分布（反映整理后的状态）
        self._count_tier_distribution(all_points)

        # Step 4: 沙盒模式写入变更计划
        if self.mode == "sandbox" and self.pending_changes:
            self._write_sandbox()

        # Step 5: 打印统计报告
        t_total = time.time() - t_start
        self._print_report(t_total)

        log(f"=== Dreaming Lite V2 END (mode={self.mode}, {t_total:.2f}s) ===")

    def _step_ttl_archive(self, all_points: list):
        """Step 1: TTL 过期清理。遍历所有记忆，过期的标记为 archived。"""
        log("[Step 1] TTL expiry check...")
        t0 = time.time()

        to_archive = []
        for point in all_points:
            payload = point.payload or {}
            if is_ttl_expired(payload):
                to_archive.append(point)

        log(f"  Found {len(to_archive)} expired memories")

        # 分批执行归档
        now_iso = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")
        for i in range(0, len(to_archive), UPDATE_BATCH_LIMIT):
            batch = to_archive[i:i + UPDATE_BATCH_LIMIT]
            for point in batch:
                payload = point.payload or {}
                pid_short = str(point.id)[:8]
                content_short = (payload.get("memory") or payload.get("data") or "")[:50]
                old_tier = payload.get("tier", "short-term")

                if self.mode == "dry-run":
                    log(f"  [DRY-RUN] Would archive {pid_short} "
                        f"(tier={old_tier}, content={content_short}...)")
                elif self.mode == "sandbox":
                    # 记录变更计划，不直接执行
                    self.pending_changes.append({
                        "action": "archive",
                        "point_id": str(point.id),
                        "details": {
                            "old_tier": old_tier,
                            "reason": "ttl_expired",
                            "content_preview": content_short,
                        }
                    })
                    # P1-1 修复：更新内存态，确保后续统计和晋升检查基于整理后的状态
                    payload["tier"] = "archived"
                    log(f"  [SANDBOX] Plan archive {pid_short} "
                        f"(tier={old_tier}, content={content_short}...)")
                else:
                    # force-apply 模式：直接执行
                    self.client.set_payload(
                        collection_name=COLLECTION_NAME,
                        payload={
                            "tier": "archived",
                            "archived_at": now_iso,
                            "archived_reason": "ttl_expired",
                        },
                        points=[point.id],
                    )
                    # 更新内存中的 payload，确保后续步骤不会重复处理
                    payload["tier"] = "archived"
                    log(f"  Archived {pid_short} (tier={old_tier}, content={content_short}...)")

                self.archived_count += 1
                self.archived_details.append((pid_short, content_short, old_tier))

        log(f"  Archive plan: {self.archived_count} memories in {time.time()-t0:.2f}s")

    def _step_promotion(self, all_points: list):
        """Step 2: 批量晋升检查。对所有非 archived 记忆做晋升条件检查。"""
        log("[Step 2] Promotion check...")
        t0 = time.time()

        to_promote = []  # [(point, new_tier)]
        for point in all_points:
            payload = point.payload or {}
            tier = payload.get("tier", "short-term")

            # 跳过已归档和 long-term
            if tier in ("archived", "long-term"):
                continue

            new_tier = check_promotion(payload)
            if new_tier:
                to_promote.append((point, new_tier))

        log(f"  Found {len(to_promote)} memories eligible for promotion")

        # 分批执行晋升
        now_iso = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")
        for i in range(0, len(to_promote), UPDATE_BATCH_LIMIT):
            batch = to_promote[i:i + UPDATE_BATCH_LIMIT]
            for point, new_tier in batch:
                payload = point.payload or {}
                pid_short = str(point.id)[:8]
                content_short = (payload.get("memory") or payload.get("data") or "")[:50]
                old_tier = payload.get("tier", "short-term")
                new_ttl = TIER_TTL_MAP[new_tier]

                if self.mode == "dry-run":
                    log(f"  [DRY-RUN] Would promote {pid_short} "
                        f"{old_tier} -> {new_tier} (content={content_short}...)")
                elif self.mode == "sandbox":
                    self.pending_changes.append({
                        "action": "promote",
                        "point_id": str(point.id),
                        "details": {
                            "old_tier": old_tier,
                            "new_tier": new_tier,
                            "new_ttl": new_ttl,
                            "content_preview": content_short,
                        }
                    })
                    # P1-1 修复：更新内存态，确保后续统计基于整理后的状态
                    payload["tier"] = new_tier
                    payload["ttl_days"] = new_ttl
                    log(f"  [SANDBOX] Plan promote {pid_short} "
                        f"{old_tier} -> {new_tier} (content={content_short}...)")
                else:
                    self.client.set_payload(
                        collection_name=COLLECTION_NAME,
                        payload={
                            "tier": new_tier,
                            "ttl_days": new_ttl,
                            "promoted_at": now_iso,
                        },
                        points=[point.id],
                    )
                    # 更新内存中的 payload
                    payload["tier"] = new_tier
                    payload["ttl_days"] = new_ttl
                    log(f"  Promoted {pid_short} {old_tier} -> {new_tier} "
                        f"(content={content_short}...)")

                self.promoted_count += 1
                self.promoted_details.append((pid_short, content_short, old_tier, new_tier))

        log(f"  Promotion plan: {self.promoted_count} memories in {time.time()-t0:.2f}s")

    def _count_tier_distribution(self, all_points: list):
        """统计整理后的 tier 分布（内存中 payload 已在前两步更新）。"""
        for point in all_points:
            payload = point.payload or {}
            tier = payload.get("tier", "short-term")
            self.tier_distribution[tier] += 1

    def _write_sandbox(self):
        """6.4: 将变更计划写入 sandbox JSON 文件。"""
        # P0-2/P1-2 修复：写入前检查是否已有未处理的 pending 变更
        if os.path.exists(SANDBOX_FILE):
            try:
                with open(SANDBOX_FILE, "r", encoding="utf-8") as f:
                    existing = json.load(f)
                if existing.get("status") == "pending":
                    log(f"[Sandbox] WARNING: 已存在未处理的 pending 变更计划 "
                        f"(created_at={existing.get('created_at')})")
                    log(f"[Sandbox] 拒绝覆盖。请先通过 /api/sandbox/apply 或 "
                        f"/api/sandbox/discard 处理后重试")
                    return
            except (json.JSONDecodeError, IOError):
                pass  # 文件损坏或无法读取，允许覆盖

        log(f"[Sandbox] Writing {len(self.pending_changes)} changes to {SANDBOX_FILE}")

        sandbox_data = {
            "version": "6.4",
            "created_at": datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00"),
            "created_by": "dreaming_lite_v2",
            "status": "pending",  # pending -> applied / discarded
            "summary": {
                "total_changes": len(self.pending_changes),
                "archives": self.archived_count,
                "promotions": self.promoted_count,
                "total_memories": self.total_count,
            },
            "tier_distribution": dict(self.tier_distribution),
            "changes": self.pending_changes,
        }

        # 确保目录存在
        Path(SANDBOX_DIR).mkdir(parents=True, exist_ok=True)

        with open(SANDBOX_FILE, "w", encoding="utf-8") as f:
            json.dump(sandbox_data, f, ensure_ascii=False, indent=2)

        log(f"[Sandbox] Written to {SANDBOX_FILE}")

    def _print_report(self, elapsed: float):
        """打印整理报告。"""
        mode_label = {
            "dry-run": "DRY-RUN",
            "sandbox": "SANDBOX",
            "force-apply": "FORCE-APPLY",
        }[self.mode]
        date_str = datetime.now().strftime("%Y-%m-%d")

        print()
        print("=" * 60)
        print(f"  Dreaming Lite V2 Report  {date_str}  ({mode_label})")
        print("=" * 60)
        print(f"  Total memories:  {self.total_count}")
        print(f"  Archived (TTL):  {self.archived_count}")
        print(f"  Promoted:        {self.promoted_count}")
        print(f"  Elapsed:         {elapsed:.2f}s")
        if self.mode == "sandbox" and self.pending_changes:
            print(f"  Sandbox file:    {SANDBOX_FILE}")
            print(f"  Status:          PENDING (等待确认)")
        print()

        # Tier 分布
        print("  Tier Distribution (after):")
        for tier in ["short-term", "mid-term", "long-term", "archived"]:
            count = self.tier_distribution.get(tier, 0)
            bar = "█" * min(count, 50)
            print(f"    {tier:12s}  {count:4d}  {bar}")

        # 其余未知 tier
        known = {"short-term", "mid-term", "long-term", "archived"}
        for tier, count in sorted(self.tier_distribution.items()):
            if tier not in known:
                print(f"    {tier:12s}  {count:4d}")

        # 详细列表（最多各列 10 条）
        if self.archived_details:
            print()
            print(f"  Archived Details (showing up to 10/{len(self.archived_details)}):")
            for pid, content, old_tier in self.archived_details[:10]:
                print(f"    [{pid}] tier={old_tier} | {content}")

        if self.promoted_details:
            print()
            print(f"  Promoted Details (showing up to 10/{len(self.promoted_details)}):")
            for pid, content, from_t, to_t in self.promoted_details[:10]:
                print(f"    [{pid}] {from_t} -> {to_t} | {content}")

        print("=" * 60)
        print(flush=True)


# -- 入口 ----------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Jarvis Dreaming Lite V2: 每日记忆整理任务（沙盒版）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只打印将要执行的操作，不写入任何文件",
    )
    parser.add_argument(
        "--force-apply",
        action="store_true",
        help="跳过沙盒直接执行（紧急情况用，不推荐）",
    )
    args = parser.parse_args()

    if args.dry_run:
        mode = "dry-run"
    elif args.force_apply:
        mode = "force-apply"
    else:
        mode = "sandbox"

    try:
        dl = DreamingLite(mode=mode)
        dl.run()
    except Exception as e:
        log(f"FATAL ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
