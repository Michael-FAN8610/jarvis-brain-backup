"""
Jarvis MCP Server（五期 5.2 升级版）
- 基于 FastMCP + 直连 Qdrant（绕过 mem0 SDK 的 LLM 调用）
- embedding 用 DashScope text-embedding-v3（1024维）
- 新增 HTTP /api/recall 端点，供微信端 exec curl 调用
- 新增 /health 端点
- 超时保护（8秒阈值）
- capture 噪音过滤：规则层（NOISE_PATTERNS + VALUE_SIGNALS）+ 数据安全黑名单（DATA_SECURITY_BLACKLIST）
- capture 去重：双档阈值（0.85 语义重复 / 0.95 完全重复）
- capture thinking 标签清洗：防止 DeepSeek 推理过程泄露到记忆
- 5.2 capture 自动分类：qwen-turbo 对新记忆分类
- 5.2 /api/config/catdesk 端点：CatDesk 拉取人格档案 + 规则
- 兼容微信端 openclaw-mem0（Node.js）写入的 camelCase 数据格式
"""
import os
import re
import uuid
import time
import json
import asyncio
from datetime import datetime

from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue, PointStruct

# ── 配置 ──────────────────────────────────────────────────────────────────────
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "sk-3c7e0b8251744161b42b8d4161420048")
QDRANT_HOST       = os.getenv("QDRANT_HOST",       "localhost")
QDRANT_PORT       = int(os.getenv("QDRANT_PORT",   "6333"))
COLLECTION_NAME   = os.getenv("COLLECTION_NAME",   "jarvis_memories")
USER_ID           = os.getenv("JARVIS_USER_ID",    "fanchangqing")
MCP_TOKEN         = os.getenv("MCP_TOKEN",         "jarvis-mcp-2026")
RECALL_TIMEOUT    = float(os.getenv("RECALL_TIMEOUT", "8.0"))  # 秒

# ── 初始化 ────────────────────────────────────────────────────────────────────
qdrant_client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT, timeout=10)
mcp = FastMCP("Jarvis Memory MCP")

# embedding 客户端
import openai
_emb_client = openai.OpenAI(
    api_key=DASHSCOPE_API_KEY,
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
)


# ── 辅助函数 ──────────────────────────────────────────────────────────────────

def _get_embedding(text: str) -> list[float]:
    """调用 DashScope embedding API，通常 0.3-0.5 秒返回"""
    resp = _emb_client.embeddings.create(
        model="text-embedding-v3",
        input=text,
    )
    return resp.data[0].embedding


# ── 噪音过滤规则 ────────────────────────────────────────────────────────────

# 闲聊/寒暄模式（命中即拦截，不写入记忆）
NOISE_PATTERNS = [
    r'^(你好|hi|hello|hey|嗨|早|晚安|早安|嗯嗯)',
    r'^(谢谢|感谢|ok|好的|嗯|哦|收到|了解|明白)',
    r'(天气|几点了|今天星期几|吃什么)',
    r'^.{0,5}$',  # 过短的消息（5字以内）
    r'^[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\s]+$',  # 纯 emoji
]

# 高价值信号（白名单，命中则直接通过，优先级高于 NOISE_PATTERNS）
VALUE_SIGNALS = [
    r'(记住|别忘了|remember|note)',
    r'(决定|选择|确定|方案)',
    r'(喜欢|偏好|习惯|prefer)',
    r'(项目|技术|架构|设计)',
]

# 数据安全硬编码黑名单（最高优先级，优先于白名单）
# 原则：宁可误拦不可泄露，与 prompt 规则形成双层防护
DATA_SECURITY_BLACKLIST = [
    r'(GMV|\bKPI\b|营收|订单量|补贴率|成交额|毛利)',
    r'(商家\w*数据|用户\w*数据|交易\w*数据)',
    r'(\bAPI[_\s]?[Kk]ey\b|\bSecret\b|密钥|凭证)',
    r'(sankuai\.com|meituan\.com|dx\.sankuai)',  # 内网域名
    r'(组织架构|人员编制|薪资|工资|HC|编制)',
    r'(TT\d{5,})',  # TT 工单号
]

# 去重阈值
DEDUP_THRESHOLD_EXACT = 0.95    # >= 0.95：完全重复，只更新 timestamp
DEDUP_THRESHOLD_SIMILAR = 0.85  # >= 0.85：语义重复，取长策略


# ── 记忆分类（5.2 新增） ────────────────────────────────────────────────────

CLASSIFY_PROMPT = """对以下记忆内容做分类，只返回一个类别标签。

可选类别：
- identity: 关于顾舟或庆哥的身份定义（名字、角色、关系）
- preference: 个人偏好和习惯（喜好、风格、工作方式）
- project: 项目进展和技术选型
- decision: 重要决策和结论
- relationship: 人际关系和互动模式
- daily: 日常记录和备忘
- summary: 对话摘要

内容：{content}

只返回类别标签，不要解释："""

VALID_CATEGORIES = {
    "identity", "preference", "project", "decision",
    "relationship", "daily", "summary",
}

_classify_client = openai.OpenAI(
    api_key=DASHSCOPE_API_KEY,
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    timeout=5.0,
)


def classify_memory(content: str) -> str:
    """对记忆内容分类，返回类别标签。失败时兜底返回 daily"""
    try:
        response = _classify_client.chat.completions.create(
            model="qwen-turbo",
            messages=[
                {"role": "user", "content": CLASSIFY_PROMPT.format(content=content)},
            ],
            max_tokens=10,
            temperature=0,
        )
        category = response.choices[0].message.content.strip().lower()
        return category if category in VALID_CATEGORIES else "daily"
    except Exception:
        return "daily"


# thinking 标签正则（兼容多种格式）
_THINK_TAG_RE = re.compile(
    r'<think(?:ing)?>[\s\S]*?</think(?:ing)?>',
    re.IGNORECASE | re.DOTALL,
)


def _clean_content(content: str) -> str:
    """
    预处理：清洗 capture 内容中的 thinking 标签。
    DeepSeek Reasoner 的推理过程可能泄露到消息中被 capture，
    这里做兜底清洗，防止 thinking 内容污染记忆库。
    """
    cleaned = _THINK_TAG_RE.sub('', content).strip()
    # 如果清洗后为空，说明整条内容都是 thinking，返回空
    if not cleaned:
        return ""
    # 清洗连续换行
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    return cleaned


def _should_capture(content: str) -> tuple:
    """
    判断内容是否值得写入记忆。
    返回 (should_capture: bool, reason: str)
    优先级：数据安全黑名单 > 高价值白名单 > 噪音黑名单 > 长度过滤 > 默认通过
    """
    # 数据安全硬编码兜底（最高优先级）
    for pattern in DATA_SECURITY_BLACKLIST:
        if re.search(pattern, content, re.IGNORECASE):
            return False, f"data_security_blocked:{pattern}"

    # 白名单优先
    for pattern in VALUE_SIGNALS:
        if re.search(pattern, content, re.IGNORECASE):
            return True, "value_signal_match"

    # 噪音黑名单拦截
    for pattern in NOISE_PATTERNS:
        if re.search(pattern, content, re.IGNORECASE):
            return False, "noise_pattern_match"

    # 长度过滤：太短的大概率没价值
    if len(content.strip()) < 10:
        return False, "too_short"

    return True, "default_pass"


def _dedup_check(embedding: list, user_id: str) -> dict:
    """
    去重检查：用 embedding 对 Qdrant 做相似度检索。
    返回 {"action": "new"/"duplicate"/"merge", "existing_point": ..., "score": ...}
    """
    try:
        # 兼容两种 user_id 字段名
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

        # 取最高分的那条
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
        return {"action": "new"}  # 去重失败时降级为正常写入


def _do_recall(query: str, user_id: str, top_k: int = 10) -> list[dict]:
    """
    直连 Qdrant 的 recall 核心逻辑。
    返回记忆列表 [{"memory": "...", "score": 0.xx}, ...]
    兼容 user_id（Python snake_case）和 userId（JS camelCase）两种字段名。
    """
    t0 = time.time()
    
    # Step 1: Embedding
    query_vector = _get_embedding(query)
    t_emb = time.time()
    
    # Step 2: Qdrant search（兼容两种 user_id 字段名）
    seen_ids = set()
    all_results = []
    
    for field_key in ["user_id", "userId"]:
        try:
            hits = qdrant_client.query_points(
                collection_name=COLLECTION_NAME,
                query=query_vector,
                query_filter=Filter(
                    must=[FieldCondition(key=field_key, match=MatchValue(value=user_id))]
                ),
                limit=top_k,
                with_payload=True,
            ).points
            for hit in hits:
                hit_id = str(hit.id)
                if hit_id not in seen_ids:
                    seen_ids.add(hit_id)
                    all_results.append(hit)
        except Exception:
            pass
    
    t_search = time.time()
    
    # Step 3: 排序 + 格式化
    all_results.sort(key=lambda x: x.score, reverse=True)
    all_results = all_results[:top_k]
    
    memories = []
    for hit in all_results:
        payload = hit.payload or {}
        mem_text = payload.get("memory") or payload.get("data") or ""
        if mem_text:
            memories.append({
                "memory": mem_text,
                "score": round(hit.score, 4),
            })
    
    t_total = time.time()
    print(
        f"[RECALL] query={query!r} | emb={t_emb-t0:.2f}s "
        f"search={t_search-t_emb:.2f}s total={t_total-t0:.2f}s "
        f"results={len(memories)}",
        flush=True
    )
    
    return memories


# ── MCP 工具（CatDesk 端通过 MCP 协议调用） ─────────────────────────────────

@mcp.tool()
def recall(query: str, user_id: str = "fanchangqing") -> str:
    """
    从 Jarvis 记忆库中搜索与 query 相关的记忆。
    在回复用户之前调用，用于获取相关背景信息。
    返回最相关的记忆条目列表。
    """
    print(f"[MCP RECALL] query={query!r} user_id={user_id!r}", flush=True)
    try:
        memories = _do_recall(query, user_id)
        if not memories:
            return "（暂无相关记忆）"
        
        lines = [f"- {m['memory']}" for m in memories]
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

        # Step 0a: thinking 标签清洗（防止 DeepSeek 推理过程泄露）
        content = _clean_content(content)
        if not content:
            print(f"[CAPTURE FILTERED] reason=thinking_only_content", flush=True)
            return "记忆已过滤（内容仅含 thinking 标签）"

        # Step 0b: 噪音过滤
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
            # 完全重复（score >= 0.95）：只更新 timestamp，不写新记录
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
            # 语义重复（0.85 <= score < 0.95）：取长策略
            existing = dedup["existing_point"]
            existing_content = (existing.payload or {}).get("memory") or (existing.payload or {}).get("data") or ""
            if len(content) > len(existing_content):
                # 新内容更详细，覆盖旧记录
                # 5.2 重新分类
                try:
                    category = classify_memory(content)
                except Exception:
                    category = (existing.payload or {}).get("category", "daily")

                payload = {
                    "memory": content,
                    "data": content,
                    "user_id": user_id,
                    "userId": user_id,
                    "category": category,
                    "created_at": (existing.payload or {}).get("created_at") or (existing.payload or {}).get("createdAt") or now_iso,
                    "createdAt": (existing.payload or {}).get("createdAt") or (existing.payload or {}).get("created_at") or now_iso,
                    "updated_at": now_iso,
                    "updatedAt": now_iso,
                    "hash": str(uuid.uuid4()),
                }
                qdrant_client.upsert(
                    collection_name=COLLECTION_NAME,
                    points=[PointStruct(id=existing.id, vector=vector, payload=payload)],
                )
                t_done = time.time()
                print(
                    f"[CAPTURE MERGED] score={dedup['score']:.3f} "
                    f"replaced_with_longer id={existing.id} total={t_done-t0:.2f}s",
                    flush=True,
                )
                return f"记忆已合并（相似度{dedup['score']:.2f}，保留更详细版本）: {content}"
            else:
                # 旧内容更详细，只更新 timestamp
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

        # 5.2 分类
        try:
            category = classify_memory(content)
        except Exception:
            category = "daily"

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
        }
        qdrant_client.upsert(
            collection_name=COLLECTION_NAME,
            points=[PointStruct(id=point_id, vector=vector, payload=payload)],
        )
        t_write = time.time()

        print(
            f"[CAPTURE OK] id={point_id} emb={t_emb-t0:.2f}s "
            f"dedup={t_emb-t0:.2f}s write={t_write-t_emb:.2f}s total={t_write-t0:.2f}s",
            flush=True
        )
        return f"记忆已存储: {content}"
    except Exception as e:
        print(f"[CAPTURE FAILED] {e}", flush=True)
        return f"capture 失败: {e}"


@mcp.tool()
def list_memories(limit: int = 20) -> str:
    """
    列出 Jarvis 记忆库中的所有记忆条目。
    用于查看当前存储了哪些记忆。
    """
    try:
        # 直连 Qdrant scroll，不走 mem0
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
                lines.append(f"{i+1}. {mem_text}")
        
        return f"共 {len(results)} 条记忆（最多显示 {limit} 条）：\n" + "\n".join(lines)
    except Exception as e:
        return f"list_memories 失败: {e}"


# ── HTTP 端点（微信端通过 exec curl 调用） ───────────────────────────────────

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
        "qdrant": {"connected": qdrant_ok, "points": points_count},
        "timestamp": datetime.now().isoformat(),
    })


@mcp.custom_route("/api/recall", methods=["POST"])
async def http_recall(request: Request) -> JSONResponse:
    """
    HTTP recall 端点，供微信端 exec curl 调用。
    
    请求体：{"query": "...", "user_id": "fanchangqing", "top_k": 10}
    响应体：{"memories": [...], "count": N, "elapsed_ms": M}
    
    内置 8 秒超时保护，超时返回空结果而不是错误（不阻塞对话）。
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            {"error": "Invalid JSON body", "memories": [], "count": 0},
            status_code=400
        )
    
    query = body.get("query", "")
    user_id = body.get("user_id", USER_ID)
    top_k = min(body.get("top_k", 10), 20)  # 上限 20
    
    if not query:
        return JSONResponse(
            {"error": "query is required", "memories": [], "count": 0},
            status_code=400
        )
    
    t0 = time.time()
    
    try:
        # 超时保护：RECALL_TIMEOUT 秒（默认 8 秒）
        memories = await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(
                None, _do_recall, query, user_id, top_k
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
        result = await asyncio.get_event_loop().run_in_executor(
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

# ── CatDesk 配置端点（5.2 三层互通） ─────────────────────────────────────────

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


# ── 启动 ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import warnings
    warnings.filterwarnings("ignore")

    host = os.getenv("MCP_HOST", "0.0.0.0")
    port = int(os.getenv("MCP_PORT", "3100"))

    print(f"Jarvis MCP Server (五期升级版) 启动中...")
    print(f"  传输方式: SSE")
    print(f"  监听地址: {host}:{port}")
    print(f"  Qdrant:   {QDRANT_HOST}:{QDRANT_PORT}/{COLLECTION_NAME}")
    print(f"  用户ID:   {USER_ID}")
    print(f"  HTTP 端点:")
    print(f"    GET  /health     - 健康检查")
    print(f"    POST /api/recall - 记忆召回（微信端 curl 调用）")
    print(f"    POST /api/capture - 记忆存储（5.2 HTTP 端点）")
    print(f"    GET  /api/config/catdesk - CatDesk 配置拉取（5.2）")
    print(f"  recall 超时: {RECALL_TIMEOUT}s")
    print(f"  capture 去重阈值: exact={DEDUP_THRESHOLD_EXACT} similar={DEDUP_THRESHOLD_SIMILAR}")
    print(f"  噪音过滤: {len(NOISE_PATTERNS)} patterns, {len(DATA_SECURITY_BLACKLIST)} security rules")
    print(f"  thinking 清洗: enabled (regex fallback)")
    print(f"  记忆分类: enabled (qwen-turbo, 5.2)")


    # 启动预热：验证 Qdrant 连接 + 预热首次查询
    try:
        info = qdrant_client.get_collection(COLLECTION_NAME)
        print(f"  Qdrant 预热: {info.points_count} points, status=ok")
    except Exception as e:
        print(f"  WARNING: Qdrant 预热失败: {e}")

    mcp.run(transport="sse", host=host, port=port)
