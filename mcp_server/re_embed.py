"""
存量记忆重 embedding 脚本
- 将 Qdrant 中所有记忆的向量从 text-embedding-v3 升级为 text-embedding-v4（基于 Qwen3）
- 逐条读取 -> 提取文本 -> 调用新模型生成向量 -> upsert 回 Qdrant
- 保留所有 payload 不变，只替换向量
- 支持断点续跑（记录已处理的 point id）
"""
import os
import sys
import time
import json
import openai
from datetime import datetime
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct

# -- 配置 --
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "sk-3c7e0b8251744161b42b8d4161420048")
QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
COLLECTION_NAME = os.getenv("COLLECTION_NAME", "jarvis_memories")
BATCH_SIZE = 50  # 每次 scroll 拉取的数量
SLEEP_BETWEEN = 0.3  # 每次 embedding 调用间隔（秒），避免限流

# 断点文件
CHECKPOINT_FILE = "/tmp/re_embed_checkpoint.json"

# -- 初始化 --
qdrant = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT, timeout=30)
emb_client = openai.OpenAI(
    api_key=DASHSCOPE_API_KEY,
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
)


def get_embedding_v4(text: str) -> list[float]:
    """调用 text-embedding-v4（基于 Qwen3）生成 1024 维向量"""
    resp = emb_client.embeddings.create(
        model="text-embedding-v4",
        input=text,
        dimensions=1024,
    )
    return resp.data[0].embedding


def load_checkpoint() -> set:
    """加载已处理的 point id 集合"""
    if os.path.exists(CHECKPOINT_FILE):
        with open(CHECKPOINT_FILE, "r") as f:
            data = json.load(f)
            return set(data.get("done_ids", []))
    return set()


def save_checkpoint(done_ids: set):
    """保存已处理的 point id 集合"""
    with open(CHECKPOINT_FILE, "w") as f:
        json.dump({"done_ids": list(done_ids), "updated_at": datetime.now().isoformat()}, f)


def main():
    print(f"=== 存量记忆重 embedding 脚本 ===")
    print(f"Qdrant: {QDRANT_HOST}:{QDRANT_PORT}/{COLLECTION_NAME}")
    print(f"新模型: text-embedding-v4 (Qwen3-based, 1024 维)")
    print()

    # 获取 collection 信息
    info = qdrant.get_collection(COLLECTION_NAME)
    total = info.points_count
    print(f"总记忆数: {total}")

    # 加载断点
    done_ids = load_checkpoint()
    if done_ids:
        print(f"断点恢复: 已处理 {len(done_ids)} 条，跳过这些")

    # 遍历所有 point
    offset = None
    processed = 0
    skipped = 0
    errors = 0
    t_start = time.time()

    while True:
        points, next_offset = qdrant.scroll(
            collection_name=COLLECTION_NAME,
            limit=BATCH_SIZE,
            offset=offset,
            with_payload=True,
            with_vectors=False,  # 不需要旧向量
        )

        if not points:
            break

        for point in points:
            point_id = str(point.id)

            # 跳过已处理的
            if point_id in done_ids:
                skipped += 1
                continue

            payload = point.payload or {}
            text = payload.get("memory") or payload.get("data") or ""

            if not text.strip():
                print(f"  [{processed+1}] {point_id[:8]}... 无文本内容，跳过")
                done_ids.add(point_id)
                skipped += 1
                continue

            try:
                # 生成新向量
                new_vector = get_embedding_v4(text)

                # upsert 回 Qdrant（保留原始 payload）
                qdrant.upsert(
                    collection_name=COLLECTION_NAME,
                    points=[PointStruct(
                        id=point.id,  # 保持原始 id（可能是 str 或 uuid）
                        vector=new_vector,
                        payload=payload,  # payload 完全不变
                    )],
                )

                processed += 1
                done_ids.add(point_id)

                # 进度输出
                preview = text[:50].replace("\n", " ")
                print(f"  [{processed}/{total}] {point_id[:8]}... -> v4 OK | {preview}")

                # 限流保护
                time.sleep(SLEEP_BETWEEN)

            except Exception as e:
                errors += 1
                print(f"  [{processed+1}] {point_id[:8]}... ERROR: {e}")

            # 每 10 条保存一次断点
            if processed % 10 == 0:
                save_checkpoint(done_ids)

        offset = next_offset
        if offset is None:
            break

    # 最终保存断点
    save_checkpoint(done_ids)

    elapsed = time.time() - t_start
    print()
    print(f"=== 完成 ===")
    print(f"处理: {processed} 条")
    print(f"跳过: {skipped} 条")
    print(f"错误: {errors} 条")
    print(f"耗时: {elapsed:.1f} 秒")

    if errors == 0 and processed > 0:
        print(f"\n所有记忆已成功从 v3 升级到 v4 (Qwen3)！")
        # 清理断点文件
        if os.path.exists(CHECKPOINT_FILE):
            os.remove(CHECKPOINT_FILE)
            print(f"断点文件已清理")


if __name__ == "__main__":
    main()
