"""기존 임베딩 환경에서 평가 질문 벡터를 만듭니다. 원본 벡터DB는 수정하지 않습니다."""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from project_paths import WORK_DIR, DATABASE, EVALUATIONS_DIR, REPORTS_DIR

import json
import os

ROOT = Path(__file__).resolve().parent
os.environ['HF_HOME'] = str(WORK_DIR/'huggingface')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
import torch
from sentence_transformers import SentenceTransformer

torch.set_num_threads(4)
target = ROOT/'embedding_cache.json'
cache = json.loads(target.read_text(encoding='utf8')) if target.exists() else {}
texts = json.loads(Path(sys.argv[1]).read_text(encoding='utf8'))
missing = [t for t in dict.fromkeys(texts) if t not in cache]
if missing:
    model = SentenceTransformer('BAAI/bge-m3', revision='5617a9f61b028005a4858fdac845db406aefb181', device='cpu', local_files_only=True)
    vectors = model.encode(missing, batch_size=8, normalize_embeddings=True, show_progress_bar=False)
    cache.update(zip(missing, vectors.tolist()))
    target.write_text(json.dumps(cache, ensure_ascii=False), encoding='utf8')
print(f'BGE-M3 evaluation cache: {len(cache)} texts', flush=True)
