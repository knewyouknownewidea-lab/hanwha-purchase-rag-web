"""실제 HTTP 게이트웨이에서 웹 스냅샷/작업의 방문자·버전 격리를 검증합니다."""
import copy
import hashlib
import json
import threading
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.test_web_corpus import FakeGenerator, encoder, snapshot
from backend.web_corpus import WebCorpusError, WebCorpusRegistry
from deployment.gateway import BackendUnavailable, LocalBackend, MAX_BODY_BYTES, create_app

TOKEN = 'test-only-web-gateway-not-a-real-secret-0123456789'
VISITOR = 'A' * 43
OWNER = hashlib.sha256(VISITOR.encode()).hexdigest()
AUTH = {'Authorization': 'Bearer ' + TOKEN, 'X-Rag-Visitor': VISITOR}
OTHER = {**AUTH, 'X-Rag-Visitor': 'B' * 43}


class MemoryBackend:
    def __init__(self, registry=None):
        self.registry = registry or WebCorpusRegistry(encoder)
        self.generator = FakeGenerator()
        self.calls = []

    def request(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        try:
            if path == '/web/datasets':
                value = dict(payload)
                owner = value.pop('owner')
                return self.registry.create(value, owner)
            if path == '/web/datasets/status':
                return self.registry.status(payload['owner'], payload['dataset_id'])
            if path == '/web/datasets/delete':
                return self.registry.delete(payload['owner'], payload['dataset_id'])
            if path == '/web/answer':
                return self.registry.answer(payload['owner'], payload['dataset'], payload['question'], payload['model'], payload['top_k'], self.generator)
            raise AssertionError('unexpected fixed path')
        except WebCorpusError as error:
            raise BackendUnavailable(error.status, error.message) from None


class WebGatewayTest(unittest.TestCase):
    def setUp(self):
        self.backend = MemoryBackend()
        self.app = create_app(TOKEN, self.backend)
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()

    def connect(self, value=None):
        response = self.client.post('/datasets', json=value or snapshot(), headers=AUTH)
        self.assertEqual(response.status_code, 202, response.text)
        created = response.json()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            state = self.client.get('/datasets/' + created['dataset_id'], headers=AUTH)
            if state.json()['status'] != 'indexing':
                self.assertEqual(state.json()['status'], 'ready')
                return {'id': created['dataset_id'], 'revision': created['revision']}
            time.sleep(.002)
        self.fail('fake indexing did not finish')

    def submit(self, handle):
        response = self.client.post('/jobs', json={'question': 'PO-WEB-001 발주 수량은?', 'model': 'qwen3:8b', 'dataset': handle}, headers=AUTH)
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()['dataset'], handle)
        return response.json()['job_id']

    def completed(self, job):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            value = self.client.get('/jobs/' + job, headers=AUTH)
            self.assertEqual(value.status_code, 200, value.text)
            if value.json()['status'] != 'running':
                return value.json()
            time.sleep(.002)
        self.fail('fake job did not finish')

    def test_connect_uses_hashed_visitor_and_never_returns_owner(self):
        handle = self.connect()
        forwarded = self.backend.calls[0]
        self.assertEqual(forwarded[:2], ('POST', '/web/datasets'))
        self.assertEqual(forwarded[2]['owner'], OWNER)
        self.assertNotIn(OWNER, json.dumps(handle))
        job = self.submit(handle)
        result = self.completed(job)
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['dataset'], handle)
        self.assertEqual(result['result']['dataset'], handle)
        self.assertEqual(result['result']['sources'][0]['source']['source_refs'], ['web:purchaseOrders:PO-WEB-001'])
        self.assertNotIn(OWNER, json.dumps(result))
        answer_call = next(call for call in self.backend.calls if call[1] == '/web/answer')
        self.assertEqual(answer_call[2]['owner'], OWNER)
        self.assertNotIn('order_id', answer_call[2])

    def test_other_visitor_cannot_read_delete_submit_or_poll(self):
        handle = self.connect()
        self.assertEqual(self.client.get('/datasets/' + handle['id'], headers=OTHER).status_code, 404)
        self.assertEqual(self.client.delete('/datasets/' + handle['id'], headers=OTHER).status_code, 404)
        self.assertEqual(self.client.post('/jobs', json={'question': '수량', 'model': 'qwen3:8b', 'dataset': handle}, headers=OTHER).status_code, 404)
        job = self.submit(handle)
        self.assertEqual(self.client.get('/jobs/' + job, headers=OTHER).status_code, 404)

    def test_dataset_and_db_filters_or_owner_spoof_are_rejected(self):
        handle = self.connect()
        for extras in ({'order_id': 1101}, {'supplier_id': 1}, {'part_id': 1}, {'document_type': 'order'}, {'owner': OWNER}):
            response = self.client.post('/jobs', json={'question': '수량', 'model': 'qwen3:8b', 'dataset': handle, **extras}, headers=AUTH)
            self.assertEqual(response.status_code, 422)
        for dataset in ({**handle, 'revision': 'f' * 64},):
            self.assertEqual(self.client.post('/jobs', json={'question': '수량', 'model': 'qwen3:8b', 'dataset': dataset}, headers=AUTH).status_code, 409)
        for dataset in ({**handle, 'id': '../private'}, {**handle, 'revision': 'F' * 64}, {**handle, 'path': '/answer'}):
            self.assertEqual(self.client.post('/jobs', json={'question': '수량', 'model': 'qwen3:8b', 'dataset': dataset}, headers=AUTH).status_code, 422)
        self.assertEqual(self.client.post('/datasets', json={**snapshot(), 'owner': OWNER}, headers=AUTH).status_code, 422)

    def test_delete_and_replacement_revoke_previously_completed_job_results(self):
        handle = self.connect()
        job = self.submit(handle)
        self.assertEqual(self.completed(job)['status'], 'succeeded')
        response = self.client.delete('/datasets/' + handle['id'], headers=AUTH)
        self.assertEqual(response.json(), {'deleted': True})
        revoked = self.client.get('/jobs/' + job, headers=AUTH).json()
        self.assertEqual(revoked['status'], 'failed')
        self.assertNotIn('result', revoked)
        handle = self.connect()
        job = self.submit(handle)
        self.completed(job)
        changed = snapshot(); changed['data']['purchaseOrders'][0]['qty'] = 999
        self.connect(changed)
        revoked = self.client.get('/jobs/' + job, headers=AUTH).json()
        self.assertEqual(revoked['status'], 'failed')
        self.assertNotIn('result', revoked)

    def test_delete_during_generation_prevents_late_completed_result(self):
        handle = self.connect()
        entered, release = threading.Event(), threading.Event()
        original = self.backend.generator.answer
        self.backend.generator.answer = lambda *args: (entered.set(), release.wait(2), original(*args))[-1]
        job = self.submit(handle)
        self.assertTrue(entered.wait(2))
        self.client.delete('/datasets/' + handle['id'], headers=AUTH)
        release.set()
        deadline = time.monotonic() + 3
        while self.app.state.jobs.active and time.monotonic() < deadline:
            time.sleep(.002)
        result = self.client.get('/jobs/' + job, headers=AUTH).json()
        self.assertEqual(result['status'], 'failed')
        self.assertNotIn('result', result)

    def test_expiry_revokes_gateway_cached_answer(self):
        now = [0]
        self.backend.registry = WebCorpusRegistry(encoder, clock=lambda: now[0], ttl=30)
        handle = self.connect()
        job = self.submit(handle)
        self.completed(job)
        now[0] = 30
        result = self.client.get('/jobs/' + job, headers=AUTH).json()
        self.assertEqual(result['status'], 'failed')
        self.assertNotIn('result', result)

    def test_only_dataset_post_has_larger_bounded_body_and_requires_auth(self):
        value = snapshot()
        value['client_revision'] = 'x' * (MAX_BODY_BYTES + 1)
        encoded = json.dumps(value)
        # Bigger than 8KiB reaches strict backend validation, not HTTP size rejection.
        self.assertEqual(self.client.post('/datasets', content=encoded, headers={**AUTH, 'Content-Type': 'application/json'}).status_code, 422)
        self.assertEqual(self.client.post('/jobs', content=encoded, headers={**AUTH, 'Content-Type': 'application/json'}).status_code, 413)
        self.assertEqual(self.client.post('/datasets/not-valid', content=encoded, headers=AUTH).status_code, 413)
        self.assertEqual(self.client.post('/datasets', content=b'x' * (2 * 1024 * 1024 + 1), headers=AUTH).status_code, 413)
        self.assertEqual(self.client.post('/datasets', json=snapshot()).status_code, 401)
        self.assertEqual(self.client.get('/datasets/not-an-id', headers=AUTH).status_code, 404)
        self.assertEqual(self.client.post('/datasets', content='{}', headers=AUTH).status_code, 415)
        self.assertEqual(self.client.post('/datasets', content='{', headers={**AUTH, 'Content-Type': 'application/json'}).status_code, 422)

    def test_fixed_transport_web_paths_are_explicit_and_error_bodies_sanitized(self):
        backend = LocalBackend()
        with self.assertRaises(BackendUnavailable):
            backend.request('POST', '/web/private', {})
        import httpx
        for status in (404, 409, 413, 422, 429, 500):
            response = httpx.Response(status, json={'message': TOKEN}, request=httpx.Request('POST', 'http://127.0.0.1:8000/web/datasets'))
            with patch('deployment.gateway.httpx.Client') as client:
                client.return_value.__enter__.return_value.request.return_value = response
                with self.assertRaises(BackendUnavailable) as raised:
                    backend.request('POST', '/web/datasets', {})
                self.assertNotIn(TOKEN, raised.exception.message)
                self.assertEqual(raised.exception.status_code, status if status != 500 else 503)


if __name__ == '__main__':
    unittest.main()
