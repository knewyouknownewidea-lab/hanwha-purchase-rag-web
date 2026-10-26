"""원본 복사본과 임시 Chroma로 데이터 갱신·실패·API를 검증합니다."""
import hashlib
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
import json
import threading
import numpy as np
from fastapi.testclient import TestClient
from backend.service import RagService
from backend.app import app
from project_paths import DATABASE, WORK_DIR

def fake_encoder(texts):
    return np.array([np.random.default_rng(int(hashlib.sha256(t.encode()).hexdigest()[:8],16)).normal(size=1024) for t in texts])

class BackendTest(unittest.TestCase):
    def test_filtered_short_questions_use_structured_api_without_embeddings(self):
        svc=object.__new__(RagService)
        svc.lock=threading.RLock()
        svc.database=DATABASE
        svc.active=lambda:{'fingerprint':'fixture','source_sha256':hashlib.sha256(DATABASE.read_bytes()).hexdigest()}
        svc.similarity_policy=lambda:{'min_similarity':0.5,'calibrated_index_fingerprint':'fixture','calibrated_top_k':3}
        svc.encode=MagicMock()
        svc._vector_search=MagicMock()
        cases=[
            ({'question':'수량은?','document_type':'order','order_id':1101}, 'order-1101'),
            ({'question':'수량은?','order_id':1101}, 'order-1101'),
            ({'question':'unit_price','supplier_id':1,'part_id':1}, 'supplier_part-1'),
            ({'question':'C 계산값','supplier_id':1}, 'supplier-1'),
        ]
        with patch('backend.app.service',return_value=svc), TestClient(app) as api:
            for payload, expected_id in cases:
                with self.subTest(payload=payload):
                    response=api.post('/search',json=payload)
                    self.assertEqual(response.status_code,200,response.text)
                    result=response.json()
                    self.assertEqual(result['retrieval_method'],'structured_db')
                    self.assertFalse(result['embedding_used'])
                    self.assertEqual(result['count'],1)
                    self.assertEqual(result['results'][0]['parent_document_id'],expected_id)
            for payload, reason in [
                ({'question':'주말에 볼 영화 추천해줘','document_type':'supplier','supplier_id':1}, 'outside_scope'),
                ({'question':'현재 서버 상태는?','document_type':'order','order_id':1101}, 'outside_scope'),
                ({'question':'수량은?','order_id':999999}, 'unknown_id'),
                ({'question':'수량은?','document_type':'supplier','supplier_id':1}, 'conflicting_document_type'),
                ({'question':'발주 수량과 운송비는?','order_id':1101}, 'unsupported_field'),
            ]:
                with self.subTest(payload=payload):
                    response=api.post('/search',json=payload)
                    self.assertEqual(response.status_code,200,response.text)
                    result=response.json()
                    self.assertEqual(result['reason'],reason)
                    self.assertEqual(result['count'],0)
        svc.encode.assert_not_called()
        svc._vector_search.assert_not_called()

    def test_lifecycle_and_api(self):
        # 임시 폴더는 Chroma 파일 핸들 때문에 Windows에서 즉시 지우지 않습니다.
        folder=Path(tempfile.mkdtemp(prefix='rag-test-',dir=WORK_DIR))
        db=folder/'source.db';shutil.copy2(DATABASE,db)
        svc=RagService(db,folder/'vectors',fake_encoder)
        with patch('backend.app.service',return_value=svc), patch.object(svc,'similarity_policy',return_value={'min_similarity':-1,'calibrated_index_fingerprint':'test','calibrated_top_k':3}), TestClient(app) as api:
            self.assertEqual(api.get('/health').status_code,200)
            self.assertEqual(api.post('/search',json={'question':'민원'}).status_code,409)
            self.assertEqual(api.post('/search',json={'question':'  '}).status_code,422)
            self.assertEqual(api.post('/search',json={'question':'민원','top_k':0}).status_code,422)
            first=api.post('/index');self.assertEqual(first.status_code,200,first.text)
            self.assertEqual(first.json()['count'],73)
            active=svc.active()
            self.assertEqual(api.post('/index').json()['action'],'unchanged')
            self.assertEqual(svc.active(),active)
            r=api.post('/search',json={'question':'납품 수량','order_id':1101,'document_type':'order'}).json()
            self.assertEqual(r['count'],1)
            self.assertEqual(r['results'][0]['parent_document_id'],'order-1101')
            self.assertIn('delivery:2024',r['results'][0]['source']['source_refs'])
            self.assertIn('40',r['results'][0]['text'])
            self.assertEqual(api.post('/search',json={'question':'없는발주','order_id':999999}).json()['count'],0)
            # 같은 디스크 경로에서 새 서비스 객체로 재개해도 벡터가 남습니다.
            reopened=RagService(db,folder/'vectors',fake_encoder)
            self.assertEqual(reopened.status()['count'],73)
            with sqlite3.connect(db) as c:
                c.execute('delete from complaint where complaint_id=3008')
            self.assertTrue(svc.status()['source_changed'])
            # 새 인덱스 저장 후 manifest 교체에 실패해도 기존 인덱스가 유지됩니다.
            with patch('backend.service.atomic_write',side_effect=OSError('simulated write failure')):
                with self.assertRaises(OSError):svc.index()
            self.assertEqual(svc.active(),active)
            self.assertEqual(svc.status()['count'],73)
            self.assertEqual(len(svc.client.list_collections()),1)
            updated=svc.index()
            self.assertEqual(updated['count'],72)
            self.assertFalse(updated['source_changed'])
            self.assertNotIn('complaint-3008:langchain:800:0',svc.collection(svc.active()).get()['ids'])

    def test_similarity_filter_boundary_and_abstention(self):
        svc=object.__new__(RagService)
        svc.lock=threading.RLock()
        svc.database=DATABASE
        svc.active=lambda:{'fingerprint':'fixture','source_sha256':hashlib.sha256(svc.database.read_bytes()).hexdigest()}
        svc.similarity_policy=lambda:{'min_similarity':0.5,'calibrated_index_fingerprint':'fixture','calibrated_top_k':3}
        svc.encode=lambda texts:np.ones((len(texts),1024))
        collection=MagicMock();collection.count.return_value=2
        svc.collection=lambda state:collection
        metadata={'parent_document_id':'order-1101','source_metadata_json':json.dumps({'order_id':1101})}
        collection.query.return_value={'ids':[['a','b']], 'documents':[['kept','discarded']],
                                       'metadatas':[[metadata,metadata]],'distances':[[0.5,0.500001]]}
        r=svc._vector_search('질문')
        self.assertEqual([x['chunk_id'] for x in r['results']],['a'])
        self.assertEqual(r['discarded_count'],1)
        self.assertEqual(r['evidence_status'],'candidates_found')
        collection.query.return_value['distances']=[[0.500001,0.8]]
        r=svc._vector_search('질문')
        self.assertEqual(r['results'],[])
        self.assertEqual(r['evidence_status'],'insufficient_evidence')
        self.assertIn('근거 부족',r['message'])
        collection.query.return_value={'ids':[[]],'documents':[[]],'metadatas':[[]],'distances':[[]]}
        self.assertEqual(svc._vector_search('없는 ID')['candidate_count'],0)

if __name__=='__main__':unittest.main()
