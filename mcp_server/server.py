"""
Jarvis MCP Server（六期 6.4 升级版）
- 基于六期 6.1，新增 6.2 反馈闭环 + 6.3 时序知识图谱 + 6.4 记忆沙盒
- 6.2 新增：
  - memory_feedback MCP 工具（显式正/负反馈）
  - 负反馈：weight -0.2 惩罚，>=3 次降级 short-term + ttl=3天加速淘汰
  - 正反馈：access_count +2 强化，触发晋升检查
  - HTTP 端点 /api/memories/feedback（供微信端调用）
- 6.3 新增：
  - classify_and_extract：一次 LLM 调用同时完成分类 + 实体提取 + 时间标记
  - recall 支持 date_from / date_to / entity_filter 结构化过滤
  - Qdrant payload index 初始化（entities, event_date）
- 6.4 新增：
  - 记忆沙盒：dreaming_lite 批量操作先写入 JSON 变更计划，经确认后才 apply
  - HTTP 端点：/api/sandbox/report, /api/sandbox/apply, /api/sandbox/discard
- 六期 6.1 功能完整保留：权重重排、晋升机制、Ebbinghaus 衰减、dreaming cron
- 五期功能完整保留：噪音过滤、去重、thinking 清洗、HTTP 端点
"""
import os
import re
import uuid
import time
import json
import math
import asyncio
from datetime import datetime, timedelta

from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Filter, FieldCondition, MatchValue, PointStruct,
    PayloadSchemaType,
)

# -- 配置 ----------------------------------------------------------------------
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "sk-3c7e0b8251744161b42b8d4161420048")
QDRANT_HOST       = os.getenv("QDRANT_HOST",       "localhost")
QDRANT_PORT       = int(os.getenv("QDRANT_PORT",   "6333"))
COLLECTION_NAME   = os.getenv("COLLECTION_NAME",   "jarvis_memories")
USER_ID           = os.getenv("JARVIS_USER_ID",    "fanchangqing")
MCP_TOKEN         = os.getenv("MCP_TOKEN",         "jarvis-mcp-2026")
RECALL_TIMEOUT    = float(os.getenv("RECALL_TIMEOUT", "8.0"))  # 秒

# -- 六期常量 ------------------------------------------------------------------
# 去重阈值（6.0 校准结果：A_min=0.8872, B_max=0.7923, gap=0.095）
DEDUP_THRESHOLD_EXACT   = 0.93  # 五期 0.95 -> 六期 0.93
DEDUP_THRESHOLD_SIMILAR = 0.85  # 维持不变

# 分层相关
LONG_TERM_CATEGORIES = {"identity", "preference", "decision"}
TIER_BONUS = {"short-term": 1.0, "mid-term": 1.5, "long-term": 2.0}

# 6.2 反馈常量
FEEDBACK_WEIGHT_PENALTY = 0.2   # 每次负反馈权重惩罚
FEEDBACK_DEMOTE_THRESHOLD = 3   # 累计负反馈达此值触发降级
FEEDBACK_DEMOTE_TTL = 3         # 降级后 TTL（天）

# -- 初始化 --------------------------------------------------------------------
qdrant_client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT, timeout=10)
mcp = FastMCP("Jarvis Memory MCP")

# embedding 客户端
import openai
_emb_client = openai.OpenAI(
    api_key=DASHSCOPE_API_KEY,
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
)


# -- 辅助函数 ------------------------------------------------------------------

def _get_embedding(text: str) -> list[float]:
    """调用 DashScope embedding API（text-embedding-v4，基于 Qwen3，跨语言能力显著增强）"""
    resp = _emb_client.embeddings.create(
        model="text-embedding-v4",
        input=text,
        dimensions=1024,
    )
    return resp.data[0].embedding


# -- 六期：时间解析工具（P0-2 修复：统一时区处理） ----------------------------

def _parse_iso_date(iso_str) -> datetime | None:
    """解析 ISO 日期字符串，兼容多种格式。返回 naive datetime（当地时间）。"""
    if not iso_str or not isinstance(iso_str, str):
        return None
    try:
        # 兼容 Python < 3.11：+08:00 -> +0800
        cleaned = iso_str
        if "+08:00" in cleaned:
            cleaned = cleaned.replace("+08:00", "+0800")
        elif cleaned.endswith("Z"):
            cleaned = cleaned.replace("Z", "+0000")
        dt = datetime.fromisoformat(cleaned)
        return dt.replace(tzinfo=None)
    except Exception:
        return None


def _days_since(iso_str) -> int:
    """计算从 iso_str 到现在经过了多少天。解析失败返回 30（保守默认值）。"""
    dt = _parse_iso_date(iso_str)
    if dt is None:
        return 30
    return max(0, (datetime.now() - dt).days)


# -- 六期：权重计算 + 晋升机制 --------------------------------------------------

def _calculate_effective_weight(payload: dict) -> float:
    """计算记忆的有效权重，用于 recall 排序。
    公式：effective_weight = base_weight * decay_factor * tier_bonus
    其中 decay_factor = e^(-days / strength), strength = 1 + access_count * 2
    """
    base_weight = payload.get("weight", 1.0)
    tier = payload.get("tier", "short-term")
    access_count = payload.get("access_count", 0)
    last_accessed = payload.get("last_accessed")

    days = _days_since(last_accessed)

    # Ebbinghaus 衰减
    strength = 1 + access_count * 2
    decay_factor = math.exp(-days / strength)

    # tier 加成
    tier_bonus = TIER_BONUS.get(tier, 1.0)

    return round(base_weight * decay_factor * tier_bonus, 4)


def _check_promotion(payload: dict):
    """检查记忆是否应该晋升。返回目标 tier 或 None。"""
    current_tier = payload.get("tier", "short-term")
    access_count = payload.get("access_count", 0)
    category = payload.get("category", "unknown")
    last_accessed = payload.get("last_accessed")

    if current_tier == "long-term":
        return None

    if current_tier == "short-term":
        if access_count >= 3:
            return "mid-term"
        if category in LONG_TERM_CATEGORIES:
            return "mid-term"

    if current_tier == "mid-term":
        if access_count >= 7 and _within_days(last_accessed, 30):
            return "long-term"
        if category in LONG_TERM_CATEGORIES and access_count >= 3:
            return "long-term"

    return None


def _apply_promotion(point_id, new_tier: str):
    """执行晋升：更新 tier 和 ttl_days。"""
    ttl_map = {"short-term": 7, "mid-term": 90, "long-term": -1}
    qdrant_client.set_payload(
        collection_name=COLLECTION_NAME,
        payload={
            "tier": new_tier,
            "ttl_days": ttl_map[new_tier],
            "promoted_at": datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        },
        points=[point_id],
    )
    print(f"[PROMOTION] {str(point_id)[:8]} -> {new_tier}", flush=True)


def _within_days(iso_date, days: int) -> bool:
    dt = _parse_iso_date(iso_date)
    if dt is None:
        return False
    return (datetime.now() - dt).days <= days


# -- 噪音过滤规则（五期，不变） ------------------------------------------------

NOISE_PATTERNS = [
    r'^(你好|hi|hello|hey|嗨|早|晚安|早安|嗯嗯)',
    r'^(谢谢|感谢|ok|好的|嗯|哦|收到|了解|明白)',
    r'(天气|几点了|今天星期几|吃什么)',
    r'^.{0,5}$',
    r'^[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\s]+$',
]

VALUE_SIGNALS = [
    r'(记住|别忘了|remember|note)',
    r'(决定|选择|确定|方案)',
    r'(喜欢|偏好|习惯|prefer)',
    r'(项目|技术|架构|设计)',
]

DATA_SECURITY_BLACKLIST = [
    r'(GMV|\bKPI\b|营收|订单量|补贴率|成交额|毛利)',
    r'(商家\w*数据|用户\w*数据|交易\w*数据)',
    r'(\bAPI[_\s]?[Kk]ey\b|\bSecret\b|密钥|凭证)',
    r'(sankuai\.com|meituan\.com|dx\.sankuai)',
    r'(组织架构|人员编制|薪资|工资|HC|编制)',
    r'(TT\d{5,})',
]


# -- 6.3：分类 + 实体提取 + 时间标记（一次 LLM 调用） -------------------------

CLASSIFY_EXTRACT_PROMPT = """分析以下内容，返回 JSON 格式结果。

内容：{content}

请提取：
1. category: 从以下七类中选一个：identity / preference / project / decision / relationship / daily / summary
2. entities: 提取关键实体（人名、项目名、技术名词、地点），最多 5 个，返回列表
3. event_date: 如果内容提到了具体时间（"上周"、"昨天"、"4月15日"），推算出 ISO 格式日期(YYYY-MM-DD)。如果没有明确时间信息，返回 null

只返回 JSON，不要其他文字：
{{"category": "...", "entities": [...], "event_date": "..." or null}}"""

VALID_CATEGORIES = {
    "identity", "preference", "project", "decision",
    "relationship", "daily", "summary",
}

_classify_client = openai.OpenAI(
    api_key=DASHSCOPE_API_KEY,
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    timeout=5.0,
)


def classify_and_extract(content: str) -> dict:
    """6.3：一次 LLM 调用同时完成分类、实体提取、时间标记。
    返回 {"category": str, "entities": list, "event_date": str|None}
    """
    today = datetime.now().strftime("%Y-%m-%d")
    prompt = CLASSIFY_EXTRACT_PROMPT.format(content=content)
    prompt += f"\n\n（今天是 {today}）"

    try:
        response = _classify_client.chat.completions.create(
            model="qwen-turbo",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=200,
            temperature=0,
        )
        raw = response.choices[0].message.content.strip()
        # P1-2 修复：增强 JSON 提取容错
        # 1) 移除 markdown 代码块包裹
        if raw.startswith("```"):
            raw = re.sub(r'^```(?:json)?\s*', '', raw)
            raw = re.sub(r'\s*```$', '', raw)
        # 2) 提取第一个完整 JSON 对象（处理 LLM 在 JSON 前后输出额外文本）
        json_match = re.search(r'\{[^{}]*\}', raw, re.DOTALL)
        if json_match:
            raw = json_match.group(0)
        result = json.loads(raw)

        # 校验 category 合法性
        if result.get("category") not in VALID_CATEGORIES:
            result["category"] = "daily"
        # 校验 entities 类型
        if not isinstance(result.get("entities"), list):
            result["entities"] = []
        # 校验 event_date 格式
        ed = result.get("event_date")
        if ed and not re.match(r'^\d{4}-\d{2}-\d{2}$', str(ed)):
            result["event_date"] = None

        return result
    except Exception as e:
        print(f"[CLASSIFY_EXTRACT ERROR] {e}", flush=True)
        return {"category": "daily", "entities": [], "event_date": None}


# 向后兼容：保留 classify_memory 函数签名（dreaming_lite 可能调用）
def classify_memory(content: str) -> str:
    """兼容旧接口：只返回 category。"""
    return classify_and_extract(content)["category"]


# thinking 标签清洗（五期，不变）
_THINK_TAG_RE = re.compile(
    r'<think(?:ing)?>[\s\S]*?</think(?:ing)?>',
    re.IGNORECASE | re.DOTALL,
)


def _clean_content(content: str) -> str:
    cleaned = _THINK_TAG_RE.sub('', content).strip()
    if not cleaned:
        return ""
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    return cleaned


def _is_mostly_chinese(text: str) -> bool:
    """判断文本是否以中文为主（中文字符占比 > 30% 视为中文内容）"""
    if not text:
        return True
    cjk_count = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    # 只统计字母和汉字，排除空格标点数字
    alpha_count = sum(1 for c in text if c.isalpha())
    if alpha_count == 0:
        return True
    return cjk_count / alpha_count > 0.3


def _ensure_chinese(content: str) -> str:
    """六期：将非中文记忆翻译为中文存储，统一语言降低跨语言召回依赖。
    翻译失败时返回原文（降级，不阻塞写入流程）。"""
    if _is_mostly_chinese(content):
        return content
    try:
        t0 = time.time()
        resp = _classify_client.chat.completions.create(
            model="qwen-turbo",
            messages=[
                {"role": "system", "content": "你是翻译助手。将以下英文内容翻译为简洁准确的中文。只输出翻译结果，不加解释。保留人名、专有名词、数字、日期原样。"},
                {"role": "user", "content": content},
            ],
            max_tokens=500,
            temperature=0,
        )
        translated = resp.choices[0].message.content.strip()
        elapsed = time.time() - t0
        if translated and len(translated) > 5:
            print(f"[CAPTURE TRANSLATE] {elapsed:.2f}s en→zh: {content[:80]} → {translated[:80]}", flush=True)
            return translated
        return content
    except Exception as e:
        print(f"[CAPTURE TRANSLATE FAILED] {e}, using original content", flush=True)
        return content


def _should_capture(content: str) -> tuple:
    for pattern in DATA_SECURITY_BLACKLIST:
        if re.search(pattern, content, re.IGNORECASE):
            return False, f"data_security_blocked:{pattern}"
    for pattern in VALUE_SIGNALS:
        if re.search(pattern, content, re.IGNORECASE):
            return True, "value_signal_match"
    for pattern in NOISE_PATTERNS:
        if re.search(pattern, content, re.IGNORECASE):
            return False, "noise_pattern_match"
    if len(content.strip()) < 10:
        return False, "too_short"
    return True, "default_pass"


def _dedup_check(embedding: list, user_id: str) -> dict:
    try:
        all_hits = []
        for field_key in ["user_id", "userId"]:
            try:
                hits = qdrant_client.query_points(
                    collection_name=COLLECTION_NAME,
                    query=embedding,
                    query_filter=Filter(
                        must=[FieldCondition(key=field_key, match=MatchValue(value=user_id))]
                    ),
                    limit=3,
                    score_threshold=DEDUP_THRESHOLD_SIMILAR,
                    with_payload=True,
                ).points
                all_hits.extend(hits)
            except Exception:
                pass

        if not all_hits:
            return {"action": "new"}

        all_hits.sort(key=lambda x: x.score, reverse=True)
        top = all_hits[0]
        score = top.score

        if score >= DEDUP_THRESHOLD_EXACT:
            return {"action": "duplicate", "existing_point": top, "score": score}
        elif score >= DEDUP_THRESHOLD_SIMILAR:
            return {"action": "merge", "existing_point": top, "score": score}
        else:
            return {"action": "new"}
    except Exception as e:
        print(f"[DEDUP CHECK ERROR] {e}", flush=True)
        return {"action": "new"}


# -- 核心逻辑 ------------------------------------------------------------------

def _do_recall(query: str, user_id: str, top_k: int = 10,
               date_from: str = None, date_to: str = None,
               entity_filter: str = None) -> list[dict]:
    """
    六期增强版 recall：向量检索 + 权重重排 + access_count 更新 + 晋升检查。
    6.3 新增：可选 date_from/date_to/entity_filter 结构化过滤。
    """
    t0 = time.time()

    # Step 1: Embedding
    query_vector = _get_embedding(query)
    t_emb = time.time()

    # Step 2: Qdrant search（扩大候选集 3x，排除 archived）
    candidate_k = top_k * 3
    seen_ids = set()
    all_results = []

    for field_key in ["user_id", "userId"]:
        try:
            # 构建 must 条件
            must_conditions = [
                FieldCondition(key=field_key, match=MatchValue(value=user_id)),
            ]

            # 6.3：时间范围过滤（event_date 存储为 YYYY-MM-DD keyword，利用字典序比较）
            # P0-1 修复：keyword 类型不支持 Range filter，改用 Python 侧后过滤
            # Qdrant 的 keyword index 不支持 Range，所以时间范围过滤在 Step 3 后过滤

            # 6.3：实体过滤（entities 是 keyword[] 数组，MatchValue 匹配任意元素）
            if entity_filter:
                must_conditions.append(
                    FieldCondition(key="entities", match=MatchValue(value=entity_filter))
                )

            hits = qdrant_client.query_points(
                collection_name=COLLECTION_NAME,
                query=query_vector,
                query_filter=Filter(must=must_conditions),
                limit=candidate_k,
                score_threshold=0.30,
                with_payload=True,
            ).points
            for hit in hits:
                hit_id = str(hit.id)
                if hit_id not in seen_ids:
                    seen_ids.add(hit_id)
                    # 排除 archived
                    if (hit.payload or {}).get("tier") != "archived":
                        all_results.append(hit)
        except Exception:
            pass

    t_search = time.time()

    # Step 3: 权重重排（同时缓存 payload 供 Step 4 使用，P0-1 修复）
    # P0-1 修复(6.3)：date_from/date_to 改为 Python 侧后过滤（keyword 不支持 Range）
    scored_results = []
    for hit in all_results:
        payload = hit.payload or {}
        mem_text = payload.get("memory") or payload.get("data") or ""
        if not mem_text:
            continue

        # 6.3 时间范围后过滤
        if date_from or date_to:
            ed = payload.get("event_date") or ""
            if not ed:
                continue  # 无 event_date 的记忆不参与时间过滤结果
            if date_from and ed < date_from:
                continue
            if date_to and ed > date_to:
                continue

        ew = _calculate_effective_weight(payload)
        final_score = hit.score * ew

        scored_results.append({
            "id": hit.id,
            "memory": mem_text,
            "vector_score": round(hit.score, 4),
            "effective_weight": ew,
            "final_score": round(final_score, 4),
            "tier": payload.get("tier", ""),
            "_payload": payload,  # 缓存完整 payload，Step 4 直接用，省掉 retrieve
        })

    scored_results.sort(key=lambda x: x["final_score"], reverse=True)
    top_results = scored_results[:top_k]

    # Step 4: 更新 access_count + last_accessed，检查晋升
    # P0-1 修复：直接用 Step 3 缓存的 _payload，不再逐条 retrieve
    now_iso = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")
    promotions = 0
    for r in top_results:
        try:
            current_payload = r["_payload"]
            new_count = current_payload.get("access_count", 0) + 1

            qdrant_client.set_payload(
                collection_name=COLLECTION_NAME,
                payload={
                    "access_count": new_count,
                    "last_accessed": now_iso,
                },
                points=[r["id"]],
            )

            # 检查晋升
            updated = {**current_payload, "access_count": new_count, "last_accessed": now_iso}
            new_tier = _check_promotion(updated)
            if new_tier:
                _apply_promotion(r["id"], new_tier)
                promotions += 1
        except Exception as e:
            print(f"[RECALL UPDATE WARN] {r['id']}: {e}", flush=True)

    t_total = time.time()

    # 返回格式：P0-3 修复：包含 id 供 memory_feedback 使用
    memories = [{"id": str(r["id"]), "memory": r["memory"], "score": r["final_score"]} for r in top_results]

    filter_info = ""
    if date_from or date_to:
        filter_info += f" date=[{date_from or '*'},{date_to or '*'}]"
    if entity_filter:
        filter_info += f" entity={entity_filter}"

    print(
        f"[RECALL] query={query!r}{filter_info} | emb={t_emb-t0:.2f}s "
        f"search={t_search-t_emb:.2f}s rerank+update={t_total-t_search:.2f}s "
        f"total={t_total-t0:.2f}s results={len(memories)} promotions={promotions}",
        flush=True
    )

    return memories


# -- MCP 工具 ------------------------------------------------------------------

@mcp.tool()
def recall(query: str, user_id: str = "fanchangqing",
           date_from: str = "", date_to: str = "",
           entity_filter: str = "") -> str:
    """
    从 Jarvis 记忆库中搜索与 query 相关的记忆。
    在回复用户之前调用，用于获取相关背景信息。
    可选参数：
    - date_from / date_to: ISO 日期（如 2026-04-20），按事件时间过滤
    - entity_filter: 实体名（如 "Jarvis"），只返回包含该实体的记忆
    返回最相关的记忆条目列表。
    """
    print(f"[MCP RECALL] query={query!r} user_id={user_id!r} "
          f"date_from={date_from!r} date_to={date_to!r} entity={entity_filter!r}", flush=True)
    try:
        memories = _do_recall(
            query, user_id,
            date_from=date_from or None,
            date_to=date_to or None,
            entity_filter=entity_filter or None,
        )
        if not memories:
            return "（暂无相关记忆）"

        # P0-3/P1-5 修复：recall 输出包含 id，供 memory_feedback 使用
        lines = [f"- [id={m['id']}] {m['memory']}" for m in memories]
        header = "以下是从记忆库中召回的相关信息（可能为英文，请理解后融入回复）：\n"
        result = header + "\n".join(lines)
        print(f"[MCP RECALL OK] {len(lines)} items", flush=True)
        return result
    except Exception as e:
        print(f"[MCP RECALL FAILED] {e}", flush=True)
        return f"recall 失败: {e}"


@mcp.tool()
def capture(content: str, user_id: str = "fanchangqing") -> str:
    """
    将重要信息存入 Jarvis 记忆库。
    当对话中出现值得长期记住的信息时调用：
    用户的偏好、习惯、重要决定、项目进展等。
    content 应是简洁的陈述句，描述需要记住的事实。
    """
    print(f"[CAPTURE CALLED] content={content!r} user_id={user_id!r}", flush=True)
    try:
        t0 = time.time()

        # Step 0a: thinking 标签清洗
        content = _clean_content(content)
        if not content:
            print(f"[CAPTURE FILTERED] reason=thinking_only_content", flush=True)
            return "记忆已过滤（内容仅含 thinking 标签）"

        # Step 0b: 统一中文存储（六期）
        content = _ensure_chinese(content)

        # Step 0c: 噪音过滤
        should, reason = _should_capture(content)
        if not should:
            print(f"[CAPTURE FILTERED] reason={reason} content={content!r}", flush=True)
            return f"记忆已过滤（{reason}）: {content}"

        # Step 1: Embedding
        vector = _get_embedding(content)
        t_emb = time.time()

        # Step 2: 去重检查
        dedup = _dedup_check(vector, user_id)
        now_iso = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")

        if dedup["action"] == "duplicate":
            existing = dedup["existing_point"]
            qdrant_client.set_payload(
                collection_name=COLLECTION_NAME,
                payload={"updated_at": now_iso, "updatedAt": now_iso},
                points=[existing.id],
            )
            t_done = time.time()
            print(
                f"[CAPTURE DEDUP] score={dedup['score']:.3f} "
                f"updated_ts_only id={existing.id} total={t_done-t0:.2f}s",
                flush=True,
            )
            return f"记忆已存在（相似度{dedup['score']:.2f}），已刷新时间戳: {content}"

        if dedup["action"] == "merge":
            existing = dedup["existing_point"]
            existing_content = (existing.payload or {}).get("memory") or (existing.payload or {}).get("data") or ""
            if len(content) > len(existing_content):
                try:
                    extract = classify_and_extract(content)
                    category = extract["category"]
                    entities = extract["entities"]
                    event_date = extract["event_date"]
                except Exception:
                    category = (existing.payload or {}).get("category", "daily")
                    entities = (existing.payload or {}).get("entities", [])
                    event_date = (existing.payload or {}).get("event_date")

                # P1-1 修复：以旧 payload 为基础全量继承，再覆盖需要更新的字段
                old_payload = existing.payload or {}
                payload = {**old_payload}  # 继承所有字段
                payload.update({
                    "memory": content,
                    "data": content,
                    "user_id": user_id,
                    "userId": user_id,
                    "category": category,
                    "created_at": old_payload.get("created_at") or old_payload.get("createdAt") or now_iso,
                    "createdAt": old_payload.get("createdAt") or old_payload.get("created_at") or now_iso,
                    "updated_at": now_iso,
                    "updatedAt": now_iso,
                    "hash": str(uuid.uuid4()),
                    "last_accessed": now_iso,
                    "entities": entities,
                    "event_date": event_date,
                })
                qdrant_client.upsert(
                    collection_name=COLLECTION_NAME,
                    points=[PointStruct(id=existing.id, vector=vector, payload=payload)],
                )
                t_done = time.time()
                print(
                    f"[CAPTURE MERGED] score={dedup['score']:.3f} "
                    f"replaced_with_longer id={existing.id} entities={entities} total={t_done-t0:.2f}s",
                    flush=True,
                )
                return f"记忆已合并（相似度{dedup['score']:.2f}，保留更详细版本）: {content}"
            else:
                qdrant_client.set_payload(
                    collection_name=COLLECTION_NAME,
                    payload={"updated_at": now_iso, "updatedAt": now_iso},
                    points=[existing.id],
                )
                t_done = time.time()
                print(
                    f"[CAPTURE MERGED] score={dedup['score']:.3f} "
                    f"kept_existing(longer) id={existing.id} total={t_done-t0:.2f}s",
                    flush=True,
                )
                return f"记忆已合并（相似度{dedup['score']:.2f}，已有版本更详细）: {content}"

        # Step 3: 正常新增
        point_id = str(uuid.uuid4())

        # 6.3：用 classify_and_extract 替代 classify_memory
        try:
            extract = classify_and_extract(content)
            category = extract["category"]
            entities = extract["entities"]
            event_date = extract["event_date"]
        except Exception:
            category = "daily"
            entities = []
            event_date = None

        # 六期：确定初始 tier
        if category in LONG_TERM_CATEGORIES:
            initial_tier = "mid-term"
            ttl_days = 90
        else:
            initial_tier = "short-term"
            ttl_days = 7

        payload = {
            "memory": content,
            "data": content,
            "user_id": user_id,
            "userId": user_id,
            "category": category,
            "created_at": now_iso,
            "createdAt": now_iso,
            "updated_at": now_iso,
            "updatedAt": now_iso,
            "hash": str(uuid.uuid4()),
            # 六期新增字段
            "tier": initial_tier,
            "access_count": 0,
            "last_accessed": now_iso,
            "ttl_days": ttl_days,
            "weight": 1.0,
            "source_ids": [],
            "feedback_negative": 0,
            # 6.3 新增字段
            "entities": entities,
            "event_date": event_date,
        }
        qdrant_client.upsert(
            collection_name=COLLECTION_NAME,
            points=[PointStruct(id=point_id, vector=vector, payload=payload)],
        )
        t_write = time.time()

        print(
            f"[CAPTURE OK] id={point_id} tier={initial_tier} cat={category} "
            f"entities={entities} event_date={event_date} "
            f"emb={t_emb-t0:.2f}s write={t_write-t_emb:.2f}s total={t_write-t0:.2f}s",
            flush=True
        )
        return f"记忆已存储: {content}"
    except Exception as e:
        print(f"[CAPTURE FAILED] {e}", flush=True)
        return f"capture 失败: {e}"


@mcp.tool()
def memory_feedback(memory_id: str, feedback_type: str,
                    reason: str = "", user_id: str = "fanchangqing") -> str:
    """
    对 recall 召回的记忆进行反馈。
    - feedback_type="negative": 标记记忆不准确/不相关（权重惩罚，累计3次降级加速淘汰）
    - feedback_type="positive": 显式确认记忆准确（access_count +2，可触发晋升）
    - memory_id: 被反馈的记忆条目 ID
    - reason: 可选，用户说的反馈原因
    当用户表达"这条记忆不对/不相关/记错了"时调用 negative。
    当用户表达"这条记忆对/没错/很有用"时调用 positive。
    """
    print(f"[FEEDBACK] id={memory_id} type={feedback_type} reason={reason!r}", flush=True)

    try:
        # 查询当前记忆
        points = qdrant_client.retrieve(
            collection_name=COLLECTION_NAME,
            ids=[memory_id],
            with_payload=True,
        )
        if not points:
            return f"记忆未找到: {memory_id}"

        payload = points[0].payload or {}

        # P0-2 修复：校验 user_id 归属，防止操作他人记忆
        mem_owner = payload.get("user_id") or payload.get("userId") or ""
        if mem_owner and mem_owner != user_id:
            print(f"[FEEDBACK DENIED] user={user_id} tried to access memory owned by {mem_owner}", flush=True)
            return f"无权操作此记忆（归属用户不匹配）"

        now_iso = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")

        if feedback_type == "negative":
            neg_count = payload.get("feedback_negative", 0) + 1
            current_weight = payload.get("weight", 1.0)
            new_weight = max(0.0, round(current_weight - FEEDBACK_WEIGHT_PENALTY, 2))

            update_payload = {
                "feedback_negative": neg_count,
                "weight": new_weight,
                "last_accessed": now_iso,
            }

            # 累计负反馈达到阈值：降级加速淘汰
            demoted = False
            if neg_count >= FEEDBACK_DEMOTE_THRESHOLD:
                update_payload["tier"] = "short-term"
                update_payload["ttl_days"] = FEEDBACK_DEMOTE_TTL
                demoted = True
                print(f"[FEEDBACK DEMOTE] {memory_id} demoted after {neg_count} negatives", flush=True)

            qdrant_client.set_payload(
                collection_name=COLLECTION_NAME,
                payload=update_payload,
                points=[memory_id],
            )

            mem_text = payload.get("memory") or payload.get("data") or ""
            result = (f"已标记负反馈（第{neg_count}次），权重 {current_weight} -> {new_weight}")
            if demoted:
                result += f"，已降级为 short-term（TTL={FEEDBACK_DEMOTE_TTL}天，加速淘汰）"
            print(f"[FEEDBACK OK] negative #{neg_count} weight={new_weight} demoted={demoted}", flush=True)
            return result

        elif feedback_type == "positive":
            new_count = payload.get("access_count", 0) + 2

            qdrant_client.set_payload(
                collection_name=COLLECTION_NAME,
                payload={
                    "access_count": new_count,
                    "last_accessed": now_iso,
                },
                points=[memory_id],
            )

            # 检查晋升
            updated = {**payload, "access_count": new_count, "last_accessed": now_iso}
            new_tier = _check_promotion(updated)
            promoted = False
            if new_tier:
                _apply_promotion(memory_id, new_tier)
                promoted = True

            result = f"已标记正反馈，access_count -> {new_count}"
            if promoted:
                result += f"，已晋升为 {new_tier}"
            print(f"[FEEDBACK OK] positive ac={new_count} promoted={promoted}", flush=True)
            return result

        else:
            return f"未知的反馈类型: {feedback_type}（支持 negative / positive）"

    except Exception as e:
        print(f"[FEEDBACK FAILED] {e}", flush=True)
        return f"反馈处理失败: {e}"


@mcp.tool()
def list_memories(limit: int = 20) -> str:
    """
    列出 Jarvis 记忆库中的所有记忆条目。
    用于查看当前存储了哪些记忆。
    """
    try:
        results, _ = qdrant_client.scroll(
            collection_name=COLLECTION_NAME,
            scroll_filter=Filter(
                should=[
                    FieldCondition(key="user_id", match=MatchValue(value=USER_ID)),
                    FieldCondition(key="userId", match=MatchValue(value=USER_ID)),
                ]
            ),
            limit=limit,
            with_payload=True,
        )
        if not results:
            return "（记忆库为空）"

        lines = []
        for i, point in enumerate(results):
            payload = point.payload or {}
            mem_text = payload.get("memory") or payload.get("data") or ""
            if mem_text:
                tier = payload.get("tier", "?")
                ac = payload.get("access_count", 0)
                entities = payload.get("entities", [])
                entity_str = f" entities={entities}" if entities else ""
                lines.append(f"{i+1}. [{tier}|ac={ac}]{entity_str} {mem_text}")

        return f"共 {len(results)} 条记忆（最多显示 {limit} 条）：\n" + "\n".join(lines)
    except Exception as e:
        return f"list_memories 失败: {e}"


# -- HTTP 端点 -----------------------------------------------------------------

@mcp.custom_route("/health", methods=["GET"])
async def health_check(request: Request) -> JSONResponse:
    """健康检查"""
    try:
        info = qdrant_client.get_collection(COLLECTION_NAME)
        qdrant_ok = True
        points_count = info.points_count
    except Exception:
        qdrant_ok = False
        points_count = -1

    return JSONResponse({
        "status": "ok" if qdrant_ok else "degraded",
        "service": "jarvis-mcp-server",
        "version": "6.4",
        "qdrant": {"connected": qdrant_ok, "points": points_count},
        "timestamp": datetime.now().isoformat(),
    })


@mcp.custom_route("/api/recall", methods=["POST"])
async def http_recall(request: Request) -> JSONResponse:
    """HTTP recall 端点，供微信端 exec curl 调用。6.3 新增结构化过滤参数。"""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            {"error": "Invalid JSON body", "memories": [], "count": 0},
            status_code=400
        )

    query = body.get("query", "")
    user_id = body.get("user_id", USER_ID)
    top_k = min(body.get("top_k", 10), 20)
    # 6.3 新增
    date_from = body.get("date_from")
    date_to = body.get("date_to")
    entity_filter = body.get("entity_filter")

    if not query:
        return JSONResponse(
            {"error": "query is required", "memories": [], "count": 0},
            status_code=400
        )

    t0 = time.time()

    try:
        # P1-4 修复：get_event_loop -> get_running_loop
        memories = await asyncio.wait_for(
            asyncio.get_running_loop().run_in_executor(
                None, lambda: _do_recall(query, user_id, top_k,
                                         date_from=date_from, date_to=date_to,
                                         entity_filter=entity_filter)
            ),
            timeout=RECALL_TIMEOUT
        )
        elapsed_ms = int((time.time() - t0) * 1000)

        return JSONResponse({
            "memories": memories,
            "count": len(memories),
            "elapsed_ms": elapsed_ms,
        })

    except asyncio.TimeoutError:
        elapsed_ms = int((time.time() - t0) * 1000)
        print(
            f"[HTTP RECALL TIMEOUT] query={query!r} after {elapsed_ms}ms",
            flush=True
        )
        return JSONResponse({
            "memories": [],
            "count": 0,
            "elapsed_ms": elapsed_ms,
            "warning": f"recall timeout after {elapsed_ms}ms, returning empty",
        })

    except Exception as e:
        elapsed_ms = int((time.time() - t0) * 1000)
        print(f"[HTTP RECALL ERROR] {e}", flush=True)
        return JSONResponse(
            {"error": str(e), "memories": [], "count": 0, "elapsed_ms": elapsed_ms},
            status_code=500
        )


@mcp.custom_route("/api/capture", methods=["POST"])
async def http_capture(request: Request) -> JSONResponse:
    """
    HTTP capture 端点，供微信端和测试脚本调用。
    请求体：{"content": "...", "user_id": "fanchangqing"}
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    content = body.get("content", "")
    user_id = body.get("user_id", USER_ID)

    if not content:
        return JSONResponse({"error": "content is required"}, status_code=400)

    t0 = time.time()

    try:
        result = await asyncio.get_running_loop().run_in_executor(
            None, capture, content, user_id
        )
        elapsed_ms = int((time.time() - t0) * 1000)
        return JSONResponse({
            "result": result,
            "elapsed_ms": elapsed_ms,
        })
    except Exception as e:
        elapsed_ms = int((time.time() - t0) * 1000)
        return JSONResponse(
            {"error": str(e), "elapsed_ms": elapsed_ms},
            status_code=500
        )


@mcp.custom_route("/api/memories/feedback", methods=["POST"])
async def http_feedback(request: Request) -> JSONResponse:
    """
    6.2: HTTP 记忆反馈端点，供微信端调用。
    请求体：{"memory_id": "...", "feedback_type": "negative"|"positive", "reason": "..."}
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    mid = body.get("memory_id", "")
    ftype = body.get("feedback_type", "")
    reason = body.get("reason", "")

    if not mid or not ftype:
        return JSONResponse(
            {"error": "memory_id and feedback_type are required"},
            status_code=400
        )

    user_id = body.get("user_id", USER_ID)

    t0 = time.time()
    try:
        # P0-4 修复：传递 user_id 给 memory_feedback
        result = await asyncio.get_running_loop().run_in_executor(
            None, lambda: memory_feedback(mid, ftype, reason, user_id)
        )
        elapsed_ms = int((time.time() - t0) * 1000)
        return JSONResponse({
            "result": result,
            "elapsed_ms": elapsed_ms,
        })
    except Exception as e:
        elapsed_ms = int((time.time() - t0) * 1000)
        return JSONResponse(
            {"error": str(e), "elapsed_ms": elapsed_ms},
            status_code=500
        )


# -- 6.4：记忆沙盒 HTTP 端点 ---------------------------------------------------

SANDBOX_DIR  = os.getenv("SANDBOX_DIR", "/opt/jarvis-mcp/sandbox")
SANDBOX_FILE = os.path.join(SANDBOX_DIR, "pending_changes.json")


@mcp.custom_route("/api/sandbox/report", methods=["GET"])
async def sandbox_report(request: Request) -> JSONResponse:
    """6.4: 查看沙盒中的待确认变更报告。"""
    try:
        if not os.path.exists(SANDBOX_FILE):
            return JSONResponse({
                "status": "empty",
                "message": "没有待确认的变更（沙盒为空）",
            })

        with open(SANDBOX_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        # 检查是否已被处理过
        if data.get("status") != "pending":
            return JSONResponse({
                "status": data.get("status", "unknown"),
                "message": f"沙盒变更已{data.get('status', '处理')}，无待确认项",
            })

        return JSONResponse({
            "status": "pending",
            "created_at": data.get("created_at"),
            "summary": data.get("summary", {}),
            "tier_distribution": data.get("tier_distribution", {}),
            "changes": data.get("changes", []),
        })
    except Exception as e:
        print(f"[SANDBOX REPORT ERROR] {e}", flush=True)
        return JSONResponse({"error": str(e)}, status_code=500)


@mcp.custom_route("/api/sandbox/apply", methods=["POST"])
async def sandbox_apply(request: Request) -> JSONResponse:
    """6.4: 确认执行沙盒中的所有变更。"""
    try:
        if not os.path.exists(SANDBOX_FILE):
            return JSONResponse({
                "status": "error",
                "message": "沙盒为空，没有待确认的变更",
            }, status_code=404)

        with open(SANDBOX_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        if data.get("status") != "pending":
            return JSONResponse({
                "status": "error",
                "message": f"沙盒变更已{data.get('status', '处理')}，不可重复执行",
            }, status_code=400)

        changes = data.get("changes", [])
        now_iso = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")

        applied = 0
        errors = []
        for change in changes:
            action = change.get("action")
            point_id = change.get("point_id")
            details = change.get("details", {})

            try:
                if action == "archive":
                    qdrant_client.set_payload(
                        collection_name=COLLECTION_NAME,
                        payload={
                            "tier": "archived",
                            "archived_at": now_iso,
                            "archived_reason": details.get("reason", "sandbox_apply"),
                        },
                        points=[point_id],
                    )
                elif action == "promote":
                    qdrant_client.set_payload(
                        collection_name=COLLECTION_NAME,
                        payload={
                            "tier": details["new_tier"],
                            "ttl_days": details["new_ttl"],
                            "promoted_at": now_iso,
                        },
                        points=[point_id],
                    )
                else:
                    errors.append({"point_id": point_id, "action": action, "error": f"unknown action: {action}"})
                    print(f"[SANDBOX APPLY WARN] unknown action: {action} for {point_id}", flush=True)
                    continue
                applied += 1
            except Exception as e:
                errors.append({"point_id": point_id, "action": action, "error": str(e)})
                print(f"[SANDBOX APPLY ERROR] {action} {point_id}: {e}", flush=True)

        # 更新沙盒文件状态
        data["status"] = "applied"
        data["applied_at"] = now_iso
        data["apply_result"] = {"applied": applied, "errors": len(errors)}
        with open(SANDBOX_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        print(f"[SANDBOX APPLY] {applied}/{len(changes)} changes applied, {len(errors)} errors", flush=True)

        return JSONResponse({
            "status": "applied",
            "applied": applied,
            "total": len(changes),
            "errors": errors,
        })
    except Exception as e:
        print(f"[SANDBOX APPLY ERROR] {e}", flush=True)
        return JSONResponse({"error": str(e)}, status_code=500)


@mcp.custom_route("/api/sandbox/discard", methods=["POST"])
async def sandbox_discard(request: Request) -> JSONResponse:
    """6.4: 放弃沙盒中的所有变更。"""
    try:
        if not os.path.exists(SANDBOX_FILE):
            return JSONResponse({
                "status": "empty",
                "message": "沙盒为空，没有待确认的变更",
            })

        with open(SANDBOX_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        if data.get("status") != "pending":
            return JSONResponse({
                "status": "info",
                "message": f"沙盒变更已{data.get('status', '处理')}",
            })

        # 更新状态为 discarded
        data["status"] = "discarded"
        data["discarded_at"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")
        with open(SANDBOX_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        change_count = len(data.get("changes", []))
        print(f"[SANDBOX DISCARD] {change_count} changes discarded", flush=True)

        return JSONResponse({
            "status": "discarded",
            "discarded_changes": change_count,
        })
    except Exception as e:
        print(f"[SANDBOX DISCARD ERROR] {e}", flush=True)
        return JSONResponse({"error": str(e)}, status_code=500)



# -- CatDesk MEMORY.md 拉取端点（带 token 认证） --------------------------------

MEMORY_MD_PATH = "/opt/jarvis/memory/MEMORY.md"

@mcp.custom_route("/api/memory", methods=["GET"])
async def get_memory_md(request: Request) -> JSONResponse:
    """CatDesk 端拉取纯 MEMORY.md 内容，带 token 认证。
    Header: Authorization: Bearer <MCP_TOKEN>
    返回: {"content": "...", "last_modified": "...", "size": N}
    """
    # Token 认证
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        return JSONResponse({"error": "Missing Authorization header"}, status_code=401)
    token = auth_header[7:]
    if token != MCP_TOKEN:
        return JSONResponse({"error": "Invalid token"}, status_code=403)

    try:
        from pathlib import Path
        mem_path = Path(MEMORY_MD_PATH)
        if not mem_path.exists():
            return JSONResponse(
                {"error": "MEMORY.md not found, run generate_memory.py first"},
                status_code=404
            )
        mem_content = mem_path.read_text(encoding="utf-8")
        last_modified = datetime.fromtimestamp(mem_path.stat().st_mtime).isoformat()
        return JSONResponse({
            "content": mem_content,
            "size": len(mem_content),
            "last_modified": last_modified,
        })
    except Exception as e:
        print(f"[MEMORY ENDPOINT ERROR] {e}", flush=True)
        return JSONResponse({"error": str(e)}, status_code=500)


# -- CatDesk 配置端点（5.2 三层互通） -----------------------------------------

CATDESK_FRAGMENT_PATH = "/opt/jarvis/master/dist/catdesk_agents_fragment.md"

@mcp.custom_route("/api/config/catdesk", methods=["GET"])
async def get_catdesk_config(request: Request) -> JSONResponse:
    """CatDesk 端配置拉取端点：返回 MEMORY.md + catdesk_rules.md 组装的配置片段"""
    try:
        from pathlib import Path
        fragment_path = Path(CATDESK_FRAGMENT_PATH)

        if not fragment_path.exists():
            return JSONResponse(
                {"error": "配置片段尚未生成，请先执行 sync.py"},
                status_code=404
            )

        content = fragment_path.read_text(encoding="utf-8")
        last_modified = datetime.fromtimestamp(
            fragment_path.stat().st_mtime
        ).isoformat()

        return JSONResponse({
            "content": content,
            "length": len(content),
            "last_modified": last_modified,
            "source": "sync.py -> catdesk_agents_fragment.md",
        })
    except Exception as e:
        print(f"[CONFIG ENDPOINT ERROR] {e}", flush=True)
        return JSONResponse({"error": str(e)}, status_code=500)


# -- 6.3：Payload Index 初始化 ------------------------------------------------

def _ensure_payload_indexes():
    """确保 entities 和 event_date 字段有 payload index，加速过滤查询。"""
    try:
        qdrant_client.create_payload_index(
            collection_name=COLLECTION_NAME,
            field_name="entities",
            field_schema=PayloadSchemaType.KEYWORD,
        )
        print("[INDEX] Created payload index: entities (keyword)", flush=True)
    except Exception as e:
        # 已存在则忽略
        if "already exists" in str(e).lower():
            print("[INDEX] entities index already exists", flush=True)
        else:
            print(f"[INDEX WARN] entities: {e}", flush=True)

    try:
        qdrant_client.create_payload_index(
            collection_name=COLLECTION_NAME,
            field_name="event_date",
            field_schema=PayloadSchemaType.KEYWORD,
        )
        print("[INDEX] Created payload index: event_date (keyword, for exact match)", flush=True)
    except Exception as e:
        if "already exists" in str(e).lower():
            print("[INDEX] event_date index already exists", flush=True)
        else:
            print(f"[INDEX WARN] event_date: {e}", flush=True)


# -- 启动 ---------------------------------------------------------------------

if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore")

    host = os.getenv("MCP_HOST", "0.0.0.0")
    port = int(os.getenv("MCP_PORT", "3100"))

    print(f"Jarvis MCP Server (六期 6.4) 启动中...")
    print(f"  传输方式: SSE")
    print(f"  监听地址: {host}:{port}")
    print(f"  Qdrant:   {QDRANT_HOST}:{QDRANT_PORT}/{COLLECTION_NAME}")
    print(f"  用户ID:   {USER_ID}")
    print(f"  HTTP 端点:")
    print(f"    GET  /health               - 健康检查")
    print(f"    POST /api/recall           - 记忆召回（六期权重重排 + 6.3 结构化过滤）")
    print(f"    POST /api/capture          - 记忆存储（六期分层字段 + 6.3 实体/时间）")
    print(f"    POST /api/memories/feedback - 记忆反馈（6.2 正/负反馈）")
    print(f"    GET  /api/sandbox/report   - 沙盒变更报告（6.4）")
    print(f"    POST /api/sandbox/apply    - 沙盒确认执行（6.4）")
    print(f"    POST /api/sandbox/discard  - 沙盒放弃变更（6.4）")
    print(f"    GET  /api/config/catdesk   - CatDesk 配置拉取（5.2）")
    print(f"  recall 超时: {RECALL_TIMEOUT}s")
    print(f"  capture 去重阈值: exact={DEDUP_THRESHOLD_EXACT} similar={DEDUP_THRESHOLD_SIMILAR}")
    print(f"  噪音过滤: {len(NOISE_PATTERNS)} patterns, {len(DATA_SECURITY_BLACKLIST)} security rules")
    print(f"  thinking 清洗: enabled (regex fallback)")
    print(f"  记忆分类: enabled (qwen-turbo, 6.3 classify_and_extract)")
    print(f"  六期增强: 分层 + 权重重排 + 晋升 + 反馈闭环(6.2) + 时序知识图谱(6.3) + 记忆沙盒(6.4)")
    print(f"  沙盒目录: {SANDBOX_DIR}")

    # 启动预热：验证 Qdrant 连接 + 创建 payload index
    try:
        info = qdrant_client.get_collection(COLLECTION_NAME)
        print(f"  Qdrant 预热: {info.points_count} points, status=ok")
    except Exception as e:
        print(f"  WARNING: Qdrant 预热失败: {e}")

    # 6.3: 确保 payload index 存在
    _ensure_payload_indexes()

    mcp.run(transport="sse", host=host, port=port)
