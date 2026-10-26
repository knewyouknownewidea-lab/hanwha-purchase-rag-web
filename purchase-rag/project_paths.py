"""Shared paths for the purchasing RAG project, resolved independently of cwd."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORK_DIR = ROOT.parent / 'work'
DB_DIR = ROOT / 'db'
DATABASE = DB_DIR / '구매관리_테스트.db'
DATA_DIR = ROOT / 'data'
DOCUMENTS_DIR = DATA_DIR / 'documents'
CHUNKS_DIR = DATA_DIR / 'chunks'
EMBEDDINGS_DIR = DATA_DIR / 'embeddings'
VECTOR_DIR = DATA_DIR / 'vector_store'
EVALUATIONS_DIR = ROOT / 'evaluations'
REPORTS_DIR = ROOT / 'reports'
