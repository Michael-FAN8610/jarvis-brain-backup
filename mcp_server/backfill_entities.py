"""
Jarvis 六期 6.3：存量记忆回填 entities + event_date。
对已有记忆中缺失 entities 的条目，调用 classify_and_extract 补充。
预计 ~200 条 * qwen-turbo = 约 2-3 分钟 + 0.2 元成本。

用法：
    python backfill_entities.py --dry-run   # 预览，不修改
    python backfill_entities.py             # 实际执行
"""
import os
import re
import sys
import json
import time
import argparse
from datetime import datetime

import openai
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue

# -- 配置 --
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "sk-3c7e0b8251744161b42b8d4161420048")
QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
COLLECTION_NAME = os.getenv("COLLECTION_NAME", "jarvis_memories")
USER_ID = os.getenv("JARVIS_USER_ID", "fanchangqing")

VALID_CATEGORIES = {
    "identity", "preference", "project", "decision",
    "relationship", "daily", "summary",
}

CLASSIFY_EXTRACT_PROMPT = """分析以下内容，返回 JSON 格式结果。

内容：{content}

请提取：
1. category: 从以下七类中选一个：identity / preference / project / decision / relationship / daily / summary
2. entities: 提取关键实体（人名、项目名、技术名词、地点），最多 5 个，返回列表
3. event_date: 如果内容提到了具体时间（"上周"、"昨天"、"4月15日"），推算出 ISO 格式日期(YYYY-MM-DD)。如果没有明确时间信息，返回 null

只返回 JSON，不要其他文字：
{{"category": "...", "entities": [...], "event_date": "..." or null}}"""

# -- 初始化 --
client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT, timeout=10)
llm_client = openai.OpenAI(
    api_key=DASHSCOPE_API_KEY,
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    timeout=10.0,
)


def classify_and_extract(content: str) -> dict:
    """调用 qwen-turbo 完成分类 + 实体提取 + 时间标记。"""
    today = datetime.now().strftime("%Y-%m-%d")
    prompt = CLASSIFY_EXTRACT_PROMPT.format(content=content)
    prompt += f"\n\n（今天是 {today}）"

    response = llm_client.chat.completions.create(
        model="qwen-turbo",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=200,
        temperature=0,
    )
    raw = response.choices[0].message.content.strip()

    # 移除 markdown 代码块包裹
    if raw.startswith("```"):
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
    # 提取第一个 JSON 对象
    json_match = re.search(r'\{[^{}]*\}', raw, re.DOTALL)
    if json_match:
        raw = json_match.group(0)

    result = json.loads(raw)

    if result.get("category") not in VALID_CATEGORIES:
        result["category"] = "daily"
    if not isinstance(result.get("entities"), list):
        result["entities"] = []
    ed = result.get("event_date")
    if ed and not re.match(r'^\d{4}-\d{2}-\d{2}$', str(ed)):
        result["event_date"] = None

    return result


def backfill(dry_run: bool = False):
    """遍历所有记忆，回填缺失的 entities 和 event_date。"""
    print(f"=== Jarvis 6.3 存量回填 {'(DRY RUN)' if dry_run else ''} ===")
    print(f"Qdrant: {QDRANT_HOST}:{QDRANT_PORT}/{COLLECTION_NAME}")
    print(f"User: {USER_ID}")
    print()

    # 分批遍历
    offset = None
    total = 0
    skipped_archived = 0
    skipped_has_entities = 0
    skipped_no_content = 0
    processed = 0
    failed = 0

    while True:
        results, next_offset = client.scroll(
            collection_name=COLLECTION_NAME,
            scroll_filter=Filter(
                should=[
                    FieldCondition(key="user_id", match=MatchValue(value=USER_ID)),
                    FieldCondition(key="userId", match=MatchValue(value=USER_ID)),
                ]
            ),
            limit=50,
            offset=offset,
            with_payload=True,
            with_vectors=False,
        )

        if not results:
            break

        for point in results:
            total += 1
            payload = point.payload or {}

            # 跳过 archived
            if payload.get("tier") == "archived":
                skipped_archived += 1
                continue

            # 跳过已有 entities 的
            existing_entities = payload.get("entities")
            if existing_entities and isinstance(existing_entities, list) and len(existing_entities) > 0:
                skipped_has_entities += 1
                continue

            # 获取内容
            content = payload.get("memory") or payload.get("data") or ""
            if not content or len(content.strip()) < 5:
                skipped_no_content += 1
                continue

            # 调用 LLM 提取
            try:
                result = classify_and_extract(content)
                entities = result.get("entities", [])
                event_date = result.get("event_date")

                if dry_run:
                    print(f"  [DRY] {str(point.id)[:8]}... entities={entities} event_date={event_date} | {content[:60]}")
                else:
                    update_payload = {"entities": entities}
                    if event_date:
                        update_payload["event_date"] = event_date

                    client.set_payload(
                        collection_name=COLLECTION_NAME,
                        payload=update_payload,
                        points=[point.id],
                    )
                    print(f"  [OK] {str(point.id)[:8]}... entities={entities} event_date={event_date}")

                processed += 1

                # 限流：qwen-turbo 限速
                time.sleep(0.3)

            except Exception as e:
                failed += 1
                print(f"  [ERR] {str(point.id)[:8]}... {e}")
                time.sleep(1.0)  # 出错后多等一会

        if next_offset is None:
            break
        offset = next_offset

    # 统计报告
    print()
    print(f"=== 回填完成 ===")
    print(f"总记忆数:       {total}")
    print(f"已跳过(archived): {skipped_archived}")
    print(f"已跳过(有entities): {skipped_has_entities}")
    print(f"已跳过(无内容):  {skipped_no_content}")
    print(f"已处理:         {processed}")
    print(f"失败:           {failed}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Jarvis 6.3 存量记忆回填 entities + event_date")
    parser.add_argument("--dry-run", action="store_true", help="预览模式，不修改数据")
    args = parser.parse_args()

    backfill(dry_run=args.dry_run)
