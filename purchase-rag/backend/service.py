"""원본 DB -> 문서 -> 청크 -> BGE-M3 -> Chroma, 그리고 질문 검색.

원본 DB는 읽기 전용입니다. 벡터 DB는 원본의 검색용 복사본입니다.
새 인덱스가 완성된 뒤에만 active.json을 교체하여 실패 시 기존 검색을 유지합니다.
"""
import hashlib
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from project_paths import ROOT, DATABASE, VECTOR_DIR, WORK_DIR

os.environ.setdefault('HF_HOME', str(WORK_DIR / 'huggingface'))
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')
os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

import chromadb
import numpy as np
from chromadb.config import Settings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from .documents import load_records, build_documents, file_hash, atomic_write

MODEL = 'BAAI/bge-m3'
REVISION = '5617a9f61b028005a4858fdac845db406aefb181'
PIPELINE = {'model': MODEL, 'revision': REVISION, 'dimension': 1024,
            'splitter': 'RecursiveCharacterTextSplitter', 'chunk_size': 800,
            'overlap': 0, 'metric': 'cosine', 'format_version': 1}


class RagService:
    def __init__(self, database=None, storage=None, encoder=None):
        self.database = Path(database or DATABASE).resolve()
        self.storage = Path(storage or VECTOR_DIR).resolve()
        self.storage.mkdir(parents=True, exist_ok=True)
        self.manifest = self.storage / 'active.json'
        self.client = chromadb.PersistentClient(path=str(self.storage / 'chroma'),
                                               settings=Settings(anonymized_telemetry=False))
        self._encoder = encoder
        self._model = None
        # 로컬 단일 프로세스 서버에서 동시 구축/검색이 엇갈리지 않게 합니다.
        self.lock = threading.RLock()

    def encode(self, texts):
        if self._encoder is not None:
            vectors = self._encoder(texts)
        else:
            if self._model is None:
                import torch
                from sentence_transformers import SentenceTransformer
                torch.set_num_threads(4)
                self._model = SentenceTransformer(MODEL, revision=REVISION, device='cpu',
                                                  token=False, trust_remote_code=False)
            lengths = [len(self._model.tokenizer(t, truncation=False)['input_ids']) for t in texts]
            if max(lengths) > self._model.max_seq_length:
                raise ValueError('모델 입력 길이를 초과했습니다. 문서를 더 작게 나눠야 합니다.')
            vectors = self._model.encode(texts, batch_size=8, normalize_embeddings=True,
                                          show_progress_bar=False)
        vectors = np.asarray(vectors, dtype=np.float32)
        if vectors.shape != (len(texts), 1024) or not np.isfinite(vectors).all():
            raise ValueError('임베딩 벡터의 차원 또는 값이 올바르지 않습니다.')
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if np.any(norms == 0):
            raise ValueError('빈 벡터는 저장할 수 없습니다.')
        return vectors / norms

    def active(self):
        if not self.manifest.exists():
            return None
        return json.loads(self.manifest.read_text(encoding='utf8'))

    def collection(self, state):
        if state['pipeline'] != PIPELINE:
            raise ValueError('저장한 벡터의 모델/설정이 다릅니다. 인덱스를 다시 구축하세요.')
        return self.client.get_collection(state['collection'], embedding_function=None)

    def status(self):
        with self.lock:
            state = self.active()
            if state is None:
                return {'indexed': False, 'model': MODEL, 'count': 0,
                        'message': 'POST /index를 실행하여 벡터 DB를 구축하세요.'}
            count = self.collection(state).count()
            current_hash = file_hash(self.database) if self.database.is_file() else None
            return {'indexed': True, 'count': count, 'model': MODEL,
                    'source_changed': current_hash != state['source_sha256'],
                    'index': state}

    def index(self):
        with self.lock:
            # 1. 실제 레코드를 읽고 ID를 조인하여 검색용 문서를 만듭니다.
            records, c_values, digest = load_records(self.database)
            docs = build_documents(records, c_values, self.database.name, digest)
            # 2. 비교에서 사용한 설정을 그대로 적용합니다.
            splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=0,
                                                       length_function=len)
            chunks = []
            for doc in docs:
                pieces = splitter.split_text(doc['text'])
                for i, text in enumerate(pieces):
                    chunks.append({'id': f"{doc['id']}:langchain:800:{i}",
                                   'parent_document_id': doc['id'], 'text': text,
                                   'chunk_index': i, 'chunk_count': len(pieces),
                                   'metadata': doc['metadata']})
            fingerprint = hashlib.sha256(json.dumps({'chunks': chunks, 'pipeline': PIPELINE},
                                         ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            old = self.active()
            if old and old['fingerprint'] == fingerprint and self.collection(old).count() == len(chunks):
                return {'action': 'unchanged', 'message': '변경이 없어 기존 벡터를 사용합니다.', **self.status()}
            # 3. 모델로 1024차원 벡터를 만듭니다. 파일의 예전 벡터를 재활용하지 않습니다.
            vectors = self.encode([c['text'] for c in chunks])
            if file_hash(self.database) != digest:
                raise ValueError('처리 중 원본 DB가 바뀌었습니다. 다시 구축하세요.')
            name = 'purchase_bge_' + uuid.uuid4().hex
            collection = self.client.create_collection(name, embedding_function=None,
                             configuration={'hnsw': {'space': 'cosine'}})
            activated = False
            try:
                metadata = []
                for chunk in chunks:
                    # Chroma 필터에는 숫자/문자만, 전체 출처는 JSON 문자열로 보존합니다.
                    m = {k: v for k, v in chunk['metadata'].items()
                         if isinstance(v, (str, int, float, bool))}
                    m.update(parent_document_id=chunk['parent_document_id'],
                             chunk_index=chunk['chunk_index'], chunk_count=chunk['chunk_count'],
                             metadata_scope='parent_document',
                             source_metadata_json=json.dumps(chunk['metadata'], ensure_ascii=False))
                    metadata.append(m)
                collection.add(ids=[c['id'] for c in chunks], documents=[c['text'] for c in chunks],
                               embeddings=vectors.tolist(), metadatas=metadata)
                if collection.count() != len(chunks):
                    raise RuntimeError('벡터 저장 개수가 일치하지 않습니다.')
                state = {'collection': name, 'pipeline': PIPELINE, 'fingerprint': fingerprint,
                         'source_sha256': digest, 'source_records': sum(map(len, records.values())),
                         'documents': len(docs), 'chunks': len(chunks),
                         'created_at': datetime.now(timezone.utc).isoformat()}
                atomic_write(self.manifest, json.dumps(state, ensure_ascii=False, indent=2))
                activated = True
            finally:
                if not activated:
                    self.client.delete_collection(name)
            return {'action': 'built', **self.status()}

    def search(self, question, top_k=3, filters=None):
        from .query_rules import plan
        with self.lock:
            state=self.active()
            if state is None:
                raise LookupError('아직 벡터 DB가 없습니다. POST /index를 먼저 실행하세요.')
            routed=plan(self.database,question,filters)
            changed=not self.database.is_file() or file_hash(self.database)!=state['source_sha256']
            policy=self.similarity_policy()
            common={'question':question,'model':MODEL,'filters':filters or {},
                    'source_changed':changed,'min_similarity':policy['min_similarity'],
                    'calibration_matches_index':policy['calibrated_index_fingerprint']==state['fingerprint'],
                    'calibrated_top_k':policy['calibrated_top_k'],
                    'validated_conditions':routed.get('conditions',{}),
                    'date_range':routed.get('date_range'),'date_field':routed.get('date_field'),
                    'reason':routed['reason'],'message':routed['message'],
                    'note':'검색 근거입니다. AI 답변 생성은 아직 연결하지 않았습니다.'}
            if routed['mode'] in ['reject','clarify']:
                return {**common,'retrieval_method':'rule_check','embedding_used':False,
                        'similarity_filter_applied':False,'count':0,'results':[],
                        'candidate_count':0,'discarded_count':0,
                        'evidence_status':'clarification_required' if routed['mode']=='clarify' else 'insufficient_evidence'}
            if routed['mode']=='structured':
                # 정확 조회는 원본 DB 조건으로 검증합니다. 유사도 점수를 만들어 붙이지 않습니다.
                hits=[{'chunk_id':d['id']+':db','parent_document_id':d['id'],'text':d['text'],
                       'similarity':None,'metadata_scope':'parent_document','source':d['metadata']}
                      for d in routed['documents'][:top_k]]
                return {**common,'retrieval_method':'structured_db','embedding_used':False,
                        'similarity_filter_applied':False,'count':len(hits),'results':hits,
                        'candidate_count':len(hits),'discarded_count':0,'evidence_status':'candidates_found'}
            if changed:
                return {**common,'reason':'index_stale','message':'근거 부족: 원본이 변경되어 벡터 DB를 먼저 갱신해야 합니다.',
                        'retrieval_method':'rule_check','embedding_used':False,'similarity_filter_applied':False,
                        'count':0,'results':[],'candidate_count':0,'discarded_count':0,'evidence_status':'insufficient_evidence'}
            result=self._vector_search(question,top_k,filters,
                                       allowed_parent_ids=[d['id'] for d in routed['documents']])
            result.update(retrieval_method='vector_with_validated_conditions',embedding_used=True,
                          similarity_filter_applied=True,validated_conditions=routed['conditions'],
                          date_range=routed['date_range'],date_field=routed['date_field'],reason='semantic_search')
            return result

    def _vector_search(self, question, top_k=3, filters=None, allowed_parent_ids=None):
        with self.lock:
            state = self.active()
            if state is None:
                raise LookupError('아직 벡터 DB가 없습니다. POST /index를 먼저 실행하세요.')
            collection = self.collection(state)
            policy = self.similarity_policy()
            threshold = policy['min_similarity']
            # 문서를 다시 임베딩하지 않고 질문만 같은 모델로 변환합니다.
            query_vector = self.encode([question])[0]
            conditions = [{k: {'$eq': v}} for k, v in (filters or {}).items() if v is not None]
            if allowed_parent_ids is not None:
                conditions.append({'parent_document_id':{'$in':allowed_parent_ids}})
            where = ({'$and': conditions} if len(conditions) > 1 else conditions[0]) if conditions else None
            args = {'query_embeddings': [query_vector.tolist()], 'n_results': min(top_k, collection.count()),
                    'include': ['documents', 'metadatas', 'distances']}
            if where:
                args['where'] = where
            result = collection.query(**args)
            hits = []
            for i, chunk_id in enumerate(result['ids'][0]):
                similarity = 1 - result['distances'][0][i]
                # 반올림 전 값으로 판단하며 기준 미달 문서는 답변 재료로 반환하지 않습니다.
                if similarity < threshold:
                    continue
                meta = result['metadatas'][0][i]
                hits.append({'chunk_id': chunk_id, 'parent_document_id': meta['parent_document_id'],
                             'text': result['documents'][0][i],
                             'similarity': round(similarity, 6),
                             'metadata_scope': 'parent_document',
                             'source': json.loads(meta['source_metadata_json'])})
            changed = not self.database.is_file() or file_hash(self.database) != state['source_sha256']
            return {'question': question, 'model': MODEL, 'filters': filters or {},
                    'source_changed': changed, 'count': len(hits), 'results': hits,
                    'min_similarity': threshold,
                    'candidate_count': len(result['ids'][0]),
                    'discarded_count': len(result['ids'][0]) - len(hits),
                    'evidence_status': 'candidates_found' if hits else 'insufficient_evidence',
                    'message': '유사도 기준을 통과한 검색 후보입니다.' if hits else '근거 부족: 검색 조건과 유사도 기준을 충족하는 문서가 없습니다.',
                    'calibration_matches_index': policy['calibrated_index_fingerprint'] == state['fingerprint'],
                    'calibrated_top_k': policy['calibrated_top_k'],
                    'note': '검색 근거입니다. AI 답변 생성은 아직 연결하지 않았습니다.'}

    def similarity_policy(self):
        path = Path(__file__).with_name('similarity_policy.json')
        if not path.exists():
            raise ValueError('유사도 기준 설정이 없습니다. 검증된 similarity_policy.json을 준비하세요.')
        policy = json.loads(path.read_text(encoding='utf8'))
        value = policy['min_similarity']
        if not isinstance(value, (int, float)) or not np.isfinite(value) or not -1 <= value <= 1:
            raise ValueError('유사도 기준은 -1 이상 1 이하의 유한한 숫자여야 합니다.')
        if (policy['model'], policy['revision'], policy['metric']) != (MODEL, REVISION, 'cosine'):
            raise ValueError('유사도 기준을 검증한 모델/거리 설정이 현재 모델과 다릅니다.')
        return policy
