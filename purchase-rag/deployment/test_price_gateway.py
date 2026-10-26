import copy
import threading
import time
import unittest

from fastapi.testclient import TestClient

from backend.test_price_evidence import fixture
from backend.price_evidence import price_ref
from deployment.gateway import create_app, Jobs, LocalBackend, BackendUnavailable

TOKEN = 'test-only-gateway-token-0123456789abcdef'
HEADERS = {'authorization': 'Bearer ' + TOKEN, 'x-rag-visitor': 'A' * 43}


class FakeBackend:
    def __init__(self, mismatch=False):
        self.calls = []
        self.mismatch = mismatch

    def request(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        ref = price_ref(payload['context'])
        if self.mismatch:
            ref['revision'] = 'stale'
        return dict(status='insufficient_evidence', answer='관련 근거를 찾지 못함', sources=[], price_context=ref,
                    calculation_text='코드로 계산한 결과', explanation='관련 근거를 찾지 못함', model_called=False)


class PriceGatewayTest(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBackend()
        self.client = TestClient(create_app(TOKEN, self.backend))

    def poll(self, job_id, client=None):
        client = client or self.client
        for _ in range(100):
            response = client.get('/jobs/' + job_id, headers=HEADERS)
            if response.json()['status'] != 'running':
                return response
            time.sleep(.002)
        self.fail('fake job did not finish')

    def test_fixed_price_route_echoes_context_and_owner_is_private(self):
        response = self.client.post('/price-explanations', json=fixture(), headers=HEADERS)
        self.assertEqual(response.status_code, 202)
        initial = response.json()
        self.assertEqual(initial['price_context'], price_ref(fixture()['context']))
        result = self.poll(initial['job_id']).json()
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['result']['price_context'], initial['price_context'])
        method, path, payload = self.backend.calls[0]
        self.assertEqual((method, path), ('POST', '/price/answer'))
        self.assertEqual(len(payload['owner']), 64)
        self.assertNotIn('owner', str(result))
        other = self.client.get('/jobs/' + initial['job_id'], headers={**HEADERS, 'x-rag-visitor': 'B'*43})
        self.assertEqual(other.status_code, 404)

    def test_mismatched_analysis_revision_fails_without_answer(self):
        client = TestClient(create_app(TOKEN, FakeBackend(mismatch=True)))
        response = client.post('/price-explanations', json=fixture(), headers=HEADERS)
        result = self.poll(response.json()['job_id'], client).json()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['error_status'], 502)
        self.assertNotIn('result', result)

    def test_strict_request_blocks_forged_calculation_filters_and_model(self):
        invalid = []
        value = fixture(); value['context']['computed']['benchmark']['median'] = 42; invalid.append(value)
        value = fixture(); value['supplier_id'] = 1; invalid.append(value)
        value = fixture(); value['model'] = 'gemma3:4b'; invalid.append(value)
        value = fixture(); value['owner'] = 'a'*64; invalid.append(value)
        for value in invalid:
            self.assertEqual(self.client.post('/price-explanations', json=value, headers=HEADERS).status_code, 422)
        self.assertEqual(self.backend.calls, [])

    def test_price_route_alone_has_256k_boundary_and_always_requires_auth(self):
        value = fixture()
        value['context']['computed']['rows'][0]['reasons'] = ['x'*1500]*10
        self.assertEqual(self.client.post('/price-explanations', json=value, headers=HEADERS).status_code, 202)
        self.assertEqual(self.client.post('/jobs', json=value, headers=HEADERS).status_code, 413)
        huge = ' '* (256*1024+1)
        self.assertEqual(self.client.post('/price-explanations', content=huge, headers={**HEADERS, 'content-type':'application/json'}).status_code, 413)
        self.assertEqual(self.client.post('/price-explanations', json=fixture()).status_code, 401)

    def test_localbackend_allows_only_fixed_price_path(self):
        with self.assertRaises(BackendUnavailable):
            LocalBackend().request('POST', '/price/../../admin', {})


if __name__ == '__main__':
    unittest.main()
