"""네트워크/모델/디스크 없이 웹 스냅샷의 격리와 버전·검색 계약을 검증합니다."""
import copy
import json
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np

from backend.prompting import build_prompt
from backend.web_corpus import SCHEMAS, WebCorpusError, WebCorpusRegistry, prepare

OWNER = 'a' * 64
OTHER = 'b' * 64
MODEL = 'qwen3:8b'


def snapshot():
    data = {key: [] for key in SCHEMAS}
    data['suppliers'] = [{'supplierId': 'SUP-A', 'name': '에이업체', 'items': [], 'evalHistory': [], 'qualityScore': 81},
                         {'supplierId': 'SUP-B', 'name': '비업체', 'items': [], 'evalHistory': []}]
    data['items'] = [{'itemCode': 'ITM-B', 'name': '비부품'}]
    data['purchaseOrders'] = [{'poNo': 'PO-WEB-001', 'itemCode': 'ITM-B', 'supplierId': 'SUP-B',
                               'qty': 37, 'unitPrice': 12345, 'currency': 'KRW',
                               'orderDate': '2026-10-01', 'dueDate': '2026-10-31'}]
    data['contracts'] = [{'contractId': 'CTR-B', 'itemCode': 'ITM-B', 'supplierId': 'SUP-B', 'unitPrice': 987654}]
    return {'schema_version': 1, 'client_revision': 'browser-revision-1',
            'meta': {'asOf': '2026-10-26', 'isSample': False, 'label': '업로드 포함',
                     'sources': {'purchaseOrders': '발주.csv'}, 'uploaded': ['purchaseOrders']}, 'data': data}


def encoder(texts):
    vectors = np.zeros((len(texts), 1024), dtype=np.float32)
    for i, text in enumerate(texts):
        vectors[i, 1 if '방청' in text else 0] = 1
    return vectors


def ready(registry, value):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        state = registry.status(OWNER, value['dataset_id'])
        if state['status'] != 'indexing':
            return {'id': state['dataset_id'], 'revision': state['revision']}
        time.sleep(.002)
    raise AssertionError('fake indexing did not finish')


class FakeGenerator:
    def __init__(self):
        self.calls = 0

    def answer(self, found, model):
        prompt = build_prompt(found)
        self.calls += int(prompt['ready_for_generation'])
        return {'status': 'answered' if prompt['ready_for_generation'] else prompt['status'],
                'answer': '원본 행을 확인했습니다. [E1]' if prompt['ready_for_generation'] else prompt['message'],
                'message': prompt['message'], 'generation_model': model,
                'model_called': prompt['ready_for_generation'], 'sources': prompt['sources']}


class WebCorpusTest(unittest.TestCase):
    def setUp(self):
        self.registry = WebCorpusRegistry(encoder)
        self.created = self.registry.create(snapshot(), OWNER)
        self.handle = ready(self.registry, self.created)

    def assert_error(self, status, fn):
        with self.assertRaises(WebCorpusError) as raised:
            fn()
        self.assertEqual(raised.exception.status, status)

    def test_exact_original_key_number_and_source_snapshot_are_retained(self):
        found = self.registry.search(OWNER, self.handle, 'PO-WEB-001 발주 수량은?')
        self.assertEqual(found['retrieval_method'], 'web_exact_records')
        self.assertEqual(len(found['results']), 1)
        hit = found['results'][0]
        self.assertIn('발주 수량(qty): 37', hit['text'])
        self.assertIsNone(hit['similarity'])
        self.assertEqual(hit['source']['source_refs'], ['web:purchaseOrders:PO-WEB-001'])
        for key, value in {'source_db': '웹 화면 데이터', 'dataset_id': self.handle['id'],
                           'revision': self.handle['revision'], 'record_key': 'PO-WEB-001',
                           'dataset_key': 'purchaseOrders', 'source_file': '발주.csv',
                           'data_label': 'SAMPLE + 업로드 데이터'}.items():
            self.assertEqual(hit['source'][key], value)
        self.assertIn('개별 행', hit['source']['source_file_scope'])

    def test_other_owner_cannot_status_delete_search_or_answer(self):
        for fn in (lambda: self.registry.status(OTHER, self.handle['id']),
                   lambda: self.registry.delete(OTHER, self.handle['id']),
                   lambda: self.registry.search(OTHER, self.handle, 'PO-WEB-001 수량은?'),
                   lambda: self.registry.answer(OTHER, self.handle, 'PO-WEB-001 수량은?', MODEL, 3, FakeGenerator())):
            self.assert_error(404, fn)

    def test_revision_tamper_and_old_snapshot_after_replacement_are_rejected(self):
        self.assert_error(409, lambda: self.registry.search(OWNER, {**self.handle, 'revision': 'f' * 64}, '발주 수량'))
        value = snapshot()
        value['data']['purchaseOrders'][0]['qty'] = 999
        replacement = ready(self.registry, self.registry.create(value, OWNER))
        self.assertNotEqual(replacement['revision'], self.handle['revision'])
        self.assert_error(404, lambda: self.registry.status(OWNER, self.handle['id']))
        found = self.registry.search(OWNER, replacement, 'PO-WEB-001 수량')
        self.assertIn('999', found['results'][0]['text'])

    def test_digest_ignores_object_order_and_client_hint_but_includes_source_metadata(self):
        one = snapshot()
        two = copy.deepcopy(one)
        two['client_revision'] = 'another-browser-hint'
        two['data'] = dict(reversed(list(two['data'].items())))
        self.assertEqual(prepare(one)[0], prepare(two)[0])
        two['meta']['sources']['purchaseOrders'] = 'changed.csv'
        self.assertNotEqual(prepare(one)[0], prepare(two)[0])

    def test_delete_prevents_late_answer_from_becoming_public(self):
        entered, release = threading.Event(), threading.Event()
        generator = FakeGenerator()
        original = generator.answer
        generator.answer = lambda *args: (entered.set(), release.wait(2), original(*args))[-1]
        captured = []
        def run():
            try:
                self.registry.answer(OWNER, self.handle, 'PO-WEB-001 수량', MODEL, 3, generator)
            except WebCorpusError as error:
                captured.append(error.status)
        thread = threading.Thread(target=run)
        thread.start()
        self.assertTrue(entered.wait(2))
        self.assertEqual(self.registry.delete(OWNER, self.handle['id']), {'deleted': True})
        release.set()
        thread.join(3)
        self.assertEqual(captured, [404])

    def test_delete_during_indexing_discards_late_vectors_and_preserves_busy_gate(self):
        entered, release = threading.Event(), threading.Event()
        registry = WebCorpusRegistry(lambda texts: (entered.set(), release.wait(2), encoder(texts))[-1])
        created = registry.create(snapshot(), OWNER)
        self.assertTrue(entered.wait(2))
        registry.delete(OWNER, created['dataset_id'])
        self.assert_error(429, lambda: registry.create(snapshot(), OTHER))
        release.set()
        deadline = time.monotonic() + 3
        while registry.indexing is not None and time.monotonic() < deadline:
            time.sleep(.002)
        self.assert_error(404, lambda: registry.status(OWNER, created['dataset_id']))
        self.assertIsNone(registry.indexing)
        self.assertEqual(registry.reserved, 0)

    def test_delete_during_first_batch_skips_all_remaining_encoder_batches(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        def blocked_encoder(texts):
            calls.append(list(texts))
            entered.set()
            release.wait(2)
            return encoder(texts)
        value = snapshot()
        value['data']['industryNews'] = [{'date': '2026-10-01', 'title': f'배치 검증 {i}', 'items': [], 'materials': []} for i in range(20)]
        registry = WebCorpusRegistry(blocked_encoder)
        created = registry.create(value, OWNER)
        self.assertGreater(created['chunk_count'], 8)
        self.assertTrue(entered.wait(2))
        registry.delete(OWNER, created['dataset_id'])
        release.set()
        deadline = time.monotonic() + 3
        while registry.indexing is not None and time.monotonic() < deadline:
            time.sleep(.002)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0]), 8)
        self.assertIsNone(registry.indexing)
        self.assertEqual(registry.reserved, 0)
        self.assertEqual(registry.items, {})

    def test_ttl_expiration_invalidates_even_previously_ready_dataset(self):
        now = [0]
        registry = WebCorpusRegistry(encoder, clock=lambda: now[0], ttl=30)
        handle = ready(registry, registry.create(snapshot(), OWNER))
        now[0] = 30
        self.assert_error(404, lambda: registry.search(OWNER, handle, 'PO-WEB-001 수량'))

    def test_background_sweep_releases_idle_corpora_without_a_followup_request(self):
        now = [0]
        registry = WebCorpusRegistry(encoder, clock=lambda: now[0], ttl=30)
        self.assertIsNone(registry._cleanup_thread)
        ready(registry, registry.create(snapshot(), OWNER))
        registry.start_cleanup(interval=.01)
        self.addCleanup(registry.stop_cleanup)
        original_thread = registry._cleanup_thread
        registry.start_cleanup(interval=.01)
        self.assertIs(registry._cleanup_thread, original_thread)
        now[0] = 30
        deadline = time.monotonic() + 2
        # 상태/검색 요청을 호출하지 않아도 청소 스레드가 원문·벡터의 registry 참조를 제거한다.
        while registry.items and time.monotonic() < deadline:
            time.sleep(.005)
        self.assertEqual(registry.items, {})

    def test_unvalidated_dates_and_numeric_ranges_never_reach_generation(self):
        generator = FakeGenerator()
        for question in ('2025년 PO-WEB-001 발주 수량은?', '2025-10-01 PO-WEB-001 발주 수량은?',
                         '2025/10/01 PO-WEB-001 발주 수량은?', '1월 PO-WEB-001 발주 수량은?',
                         '올해 PO-WEB-001 발주 수량은?', '지난달 PO-WEB-001 발주 수량은?',
                         '10월 이후 PO-WEB-001 수량', 'PO-WEB-001 기간별 수량',
                         'PO-WEB-001 수량 100개 이상', 'PO-WEB-001 50 이하 수량',
                         'PO-WEB-001 단가 1,000만원 초과', 'SUP-A 품질 90점 미만'):
            result = self.registry.answer(OWNER, self.handle, question, MODEL, 3, generator)
            self.assertEqual(result['status'], 'clarification_required', question)
            self.assertFalse(result['model_called'], question)
            self.assertEqual(result['sources'], [], question)
        self.assertEqual(generator.calls, 0)

    def test_date_digits_inside_original_codes_and_plain_numeric_ids_still_work(self):
        value = snapshot()
        value['data']['purchaseOrders'] = [
            {**value['data']['purchaseOrders'][0], 'poNo': 'PO-2026-0059'},
            {**value['data']['purchaseOrders'][0], 'poNo': '7311'},
        ]
        handle = ready(self.registry, self.registry.create(value, OWNER))
        for question, expected in (('PO-2026-0059 발주 수량은?', 'PO-2026-0059'), ('발주7311수량?', '7311')):
            found = self.registry.search(OWNER, handle, question)
            self.assertEqual(found['evidence_status'], 'candidates_found', question)
            self.assertEqual(found['results'][0]['source']['record_key'], expected)

    def test_unknown_code_does_not_fall_back_to_semantic_other_record(self):
        found = self.registry.search(OWNER, self.handle, 'PO-UNKNOWN 발주 수량은?')
        self.assertEqual(found['results'], [])

    def test_supplier_name_resolves_relationship_and_never_returns_another_supplier(self):
        missing = self.registry.search(OWNER, self.handle, '에이업체 계약 단가는?')
        self.assertEqual(missing['results'], [])
        actual = self.registry.search(OWNER, self.handle, '비업체 계약 단가는?')
        self.assertEqual(actual['results'][0]['source']['record_key'], 'CTR-B')
        conflicting = self.registry.search(OWNER, self.handle, '에이업체 CTR-B 계약 단가는?')
        self.assertEqual(conflicting['results'], [])

    def test_name_boundaries_reject_prefixes_and_allow_korean_particles(self):
        value = snapshot()
        value['data']['suppliers'][1]['name'] = '업체 A'
        handle = ready(self.registry, self.registry.create(value, OWNER))
        for question in ('업체 ABC 계약 단가는?', '신업체 A 계약 단가는?', '업체 A1 계약 단가는?', '업체 A사의 계약 단가는?'):
            found = self.registry.search(OWNER, handle, question)
            self.assertEqual(found['evidence_status'], 'clarification_required', question)
            self.assertEqual(found['results'], [], question)
        for question in ('업체 A의 계약 단가는?', '업체 A 계약 단가는?', '업체 A에게 계약 단가는?'):
            found = self.registry.search(OWNER, handle, question)
            self.assertEqual(found['retrieval_method'], 'web_exact_records', question)
            self.assertEqual(found['results'][0]['source']['record_key'], 'CTR-B', question)
        value['data']['suppliers'][0]['name'] = '업체 ABC'
        handle = ready(self.registry, self.registry.create(value, OWNER))
        found = self.registry.search(OWNER, handle, '업체 ABC의 계약 단가는?')
        self.assertEqual(found['results'], [])  # 실제 등록된 ABC도 A의 계약으로 연결하지 않는다.

    def test_ambiguous_same_name_and_too_many_exact_records_require_clarification(self):
        value = snapshot()
        value['data']['suppliers'][1]['name'] = '에이업체'
        handle = ready(self.registry, self.registry.create(value, OWNER))
        self.assertEqual(self.registry.search(OWNER, handle, '에이업체 계약 단가')['evidence_status'], 'clarification_required')
        value = snapshot()
        value['data']['purchaseOrders'] *= 4
        for i, row in enumerate(value['data']['purchaseOrders']):
            value['data']['purchaseOrders'][i] = {**row, 'poNo': f'PO-{i}'}
        handle = ready(self.registry, self.registry.create(value, OWNER))
        self.assertEqual(self.registry.search(OWNER, handle, 'SUP-B 발주 내역', 3)['evidence_status'], 'clarification_required')

    def test_aggregate_requests_never_generate_from_partial_hits(self):
        generator = FakeGenerator()
        for question in ('발주 총수량은?', 'SUP-B 평균 단가', '전체 발주 건수', '업체별 단가 비교', '가장 싼 업체는?'):
            result = self.registry.answer(OWNER, self.handle, question, MODEL, 3, generator)
            self.assertEqual(result['status'], 'clarification_required')
            self.assertFalse(result['model_called'])
            self.assertEqual(result['sources'], [])
            self.assertEqual(result['dataset'], self.handle)
        self.assertEqual(generator.calls, 0)

    def test_web_semantic_threshold_excludes_unrelated_vectors(self):
        value = snapshot()
        value['data']['industryNews'] = [{'date': '2026-10-01', 'title': '방청 처리 안내', 'summary': '보관시 방청 작업이 필요합니다.', 'items': [], 'materials': []}]
        handle = ready(self.registry, self.registry.create(value, OWNER))
        hit = self.registry.search(OWNER, handle, '방청 방법 안내')
        self.assertEqual(hit['retrieval_method'], 'web_semantic')
        self.assertEqual([x['source']['dataset_key'] for x in hit['results']], ['industryNews'])

    def test_limits_duplicate_keys_types_ranges_and_unknown_fields_are_rejected(self):
        bad = []
        value = snapshot(); value['data']['purchaseOrders'][0]['qty'] = True; bad.append(value)
        value = snapshot(); value['data']['purchaseOrders'][0]['orderDate'] = '2026-02-30'; bad.append(value)
        value = snapshot(); value['data']['suppliers'][0]['qualityScore'] = 101; bad.append(value)
        value = snapshot(); value['data']['suppliers'][0]['items'] = ['x', 2]; bad.append(value)
        value = snapshot(); value['data']['suppliers'][0]['evalHistory'] = [{'year': 2026, 'half': True, 'grade': 'A', 'score': 85}]; bad.append(value)
        value = snapshot(); value['data']['contracts'][0]['private_extra'] = 'secret'; bad.append(value)
        value = snapshot(); value['data']['contracts'] *= 2; bad.append(value)
        value = snapshot(); value['data']['items'][0]['name'] = 'x' * 2001; bad.append(value)
        value = snapshot(); value['meta']['uploaded'] *= 2; bad.append(value)
        value = snapshot(); value['data']['fxRates'] = [{'month': '2026-10', 'currency': None, 'krw': 1300}]; bad.append(value)
        for value in bad:
            self.assert_error(422, lambda value=value: prepare(value))
        with patch('backend.web_corpus.MAX_ROWS', 1):
            self.assert_error(413, lambda: prepare(snapshot()))
        with patch('backend.web_corpus.MAX_CHUNKS', 1):
            self.assert_error(413, lambda: prepare(snapshot()))
        with patch('backend.web_corpus.MAX_UPLOAD_BYTES', 100):
            self.assert_error(413, lambda: prepare(snapshot()))

    def test_session_capacity_and_memory_limits_do_not_replace_valid_data(self):
        registry = WebCorpusRegistry(encoder, max_sessions=1)
        handle = ready(registry, registry.create(snapshot(), OWNER))
        self.assert_error(429, lambda: registry.create(snapshot(), OTHER))
        self.assertEqual(registry.status(OWNER, handle['id'])['status'], 'ready')
        registry = WebCorpusRegistry(encoder, max_memory=1)
        self.assert_error(429, lambda: registry.create(snapshot(), OWNER))

    def test_bad_encoder_failure_has_safe_message(self):
        registry = WebCorpusRegistry(lambda _texts: (_ for _ in ()).throw(RuntimeError('secret path and token')))
        created = registry.create(snapshot(), OWNER)
        ready(registry, created)
        status = registry.status(OWNER, created['dataset_id'])
        self.assertEqual(status['status'], 'failed')
        self.assertNotIn('secret', json.dumps(status))

    def test_real_sample_schema_and_composite_keys_can_be_prepared(self):
        value = snapshot()
        root = Path(__file__).resolve().parents[2] / 'src' / 'data' / 'sample'
        value['data'] = {key: json.loads((root / (key + '.json')).read_text(encoding='utf8')) for key in SCHEMAS}
        revision, chunks, rows, memory = prepare(value)
        self.assertGreater(rows, 1000)
        self.assertLessEqual(len(chunks), 2048)
        self.assertLess(memory, 128 * 1024 * 1024)
        self.assertEqual(len(revision), 64)


class WebApiTest(unittest.TestCase):
    def test_backend_owned_memory_routes_and_safe_errors(self):
        from fastapi.testclient import TestClient
        from backend.app import app
        registry = WebCorpusRegistry(encoder)
        with patch('backend.app.web_corpora', return_value=registry), patch('backend.app.generator', return_value=FakeGenerator()), TestClient(app) as client:
            response = client.post('/web/datasets', json={**snapshot(), 'owner': OWNER})
            self.assertEqual(response.status_code, 202)
            handle = ready(registry, response.json())
            result = client.post('/web/answer', json={'owner': OWNER, 'dataset': handle, 'question': 'PO-WEB-001 발주 수량', 'model': MODEL})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()['dataset'], handle)
            wrong = client.post('/web/answer', json={'owner': OTHER, 'dataset': handle, 'question': 'PO-WEB-001 발주 수량', 'model': MODEL})
            self.assertEqual(wrong.status_code, 404)
            invalid = client.post('/web/datasets', json={**snapshot(), 'owner': 'private-secret'})
            self.assertEqual(invalid.status_code, 422)
            self.assertNotIn('private-secret', invalid.text)
            mixed = client.post('/web/answer', json={'owner': OWNER, 'dataset': handle, 'question': '수량', 'model': MODEL, 'order_id': 1101})
            self.assertEqual(mixed.status_code, 422)
            self.assertEqual(client.post('/web/datasets/delete', json={'owner': OWNER, 'dataset_id': handle['id']}).json(), {'deleted': True})
            self.assertEqual(client.post('/web/datasets/status', json={'owner': OWNER, 'dataset_id': handle['id']}).status_code, 404)


if __name__ == '__main__':
    unittest.main()
