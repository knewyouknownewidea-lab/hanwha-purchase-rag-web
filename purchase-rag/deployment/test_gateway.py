import asyncio
import hashlib
import json
import threading
import time
import unittest
from unittest.mock import Mock, patch

import httpx
from fastapi.testclient import TestClient

from .gateway import (BackendUnavailable, Jobs, LocalBackend, MAX_BODY_BYTES,
                      create_app)

TOKEN = 'test-only-not-a-production-secret-0123456789'
BEARER = {'Authorization': 'Bearer ' + TOKEN}
VISITOR = 'A' * 43
OWNER = hashlib.sha256(VISITOR.encode('ascii')).hexdigest()
AUTH = {**BEARER, 'X-Rag-Visitor': VISITOR}
PAYLOAD = {'question': '발주 1101 납품 수량은?', 'model': 'gemma3:4b', 'order_id': 1101}


def completed(jobs, job_id, owner=OWNER):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        value = jobs.get(job_id, owner)
        if value and value['status'] != 'running':
            return value
        time.sleep(.005)
    raise AssertionError('mocked job did not finish')


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.backend = Mock()
        self.backend.request.return_value = {'status': 'answered', 'answer': '40개 [E1]',
                                             'sources': [{'evidence_id': 'E1'}]}
        self.app = create_app(TOKEN, self.backend)
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()

    def test_secret_required_and_not_read_from_query(self):
        for token in ('', 'short', ' ' + TOKEN):
            with self.assertRaises(RuntimeError):
                create_app(token=token)
        for headers in ({}, {'Authorization': 'Bearer wrong'}, {'Authorization': 'Basic ' + TOKEN}):
            r = self.client.get('/health?token=' + TOKEN, headers=headers)
            self.assertEqual(r.status_code, 401)
            self.assertNotIn(TOKEN, r.text)
        duplicate = [('Authorization', 'Bearer ' + TOKEN), ('Authorization', 'Bearer ' + TOKEN)]
        self.assertEqual(self.client.get('/health', headers=duplicate).status_code, 401)
        self.backend.request.assert_not_called()
        self.assertFalse(self.app.state.jobs.global_usage)
        self.assertFalse(self.app.state.jobs.visitor_usage)

    def test_auth_covers_unknown_routes_and_no_arbitrary_forwarding(self):
        for path in ('/index', '/docs', '/redoc', '/openapi.json', '/answer', '/api/chat',
                     '/http://example.com', '/jobs/not-a-uuid'):
            for method in ('GET', 'POST'):
                self.assertEqual(self.client.request(method, path).status_code, 401)
                r = self.client.request(method, path, headers=AUTH)
                self.assertIn(r.status_code, (404, 405))
        self.backend.request.assert_not_called()

    def test_health_models_whitelist_and_no_cors(self):
        self.backend.request.return_value = {'status': 'ok', 'secret_path': 'not forwarded'}
        r = self.client.get('/health', headers={**AUTH, 'Origin': 'https://outside.invalid'})
        self.assertEqual(r.json(), {'status': 'ok'})
        self.assertNotIn('access-control-allow-origin', r.headers)
        self.assertEqual(r.headers['cache-control'], 'no-store')
        self.backend.request.assert_called_with('GET', '/health')
        self.backend.request.return_value = {'models': [
            {'model': 'gemma3:4b', 'installed': True, 'digest': 'hidden'},
            {'model': 'qwen3:14b', 'installed': True},
            {'model': 'http://evil', 'installed': True}]}
        r = self.client.get('/models', headers=AUTH)
        self.assertEqual(r.json(), {'models': [{'model': 'gemma3:4b', 'installed': True}]})

    def test_malformed_input_is_rejected_without_echo_or_upstream(self):
        for data in ('{', '[]', 'null', '"private-question"'):
            r = self.client.post('/jobs', content=data, headers={**AUTH, 'Content-Type': 'application/json'})
            self.assertEqual(r.status_code, 422)
            self.assertNotIn('private-question', r.text)
        self.assertEqual(self.client.post('/jobs', content='{}', headers=AUTH).status_code, 415)
        invalid = [
            {**PAYLOAD, 'model': 'qwen3:14b'}, {**PAYLOAD, 'model': 'https://evil'},
            {**PAYLOAD, 'url': 'http://evil'}, {**PAYLOAD, 'path': '/index'},
            {**PAYLOAD, 'question': ' '}, {**PAYLOAD, 'question': 'a' * 1001},
            {**PAYLOAD, 'top_k': 11}, {**PAYLOAD, 'top_k': 0}, {**PAYLOAD, 'top_k': '3'},
            {**PAYLOAD, 'order_id': -1}, {**PAYLOAD, 'order_id': True},
            {**PAYLOAD, 'supplier_id': 0}, {**PAYLOAD, 'document_type': 'delivery'},
        ]
        for value in invalid:
            self.assertEqual(self.client.post('/jobs', json=value, headers=AUTH).status_code, 422)
        self.backend.request.assert_not_called()

    def test_content_length_limit_and_actual_stream_limit(self):
        r = self.client.post('/jobs', content=b'x' * (MAX_BODY_BYTES + 1), headers=AUTH)
        self.assertEqual(r.status_code, 413)
        self.assertEqual(self.client.post('/jobs', content='{}',
                         headers={**AUTH, 'Content-Length': 'bad'}).status_code, 400)
        self.assertEqual(self.client.post('/jobs', content='{}',
                         headers={**AUTH, 'Content-Length': '9' * 5000}).status_code, 413)
        self.assertEqual(self.client.post('/jobs', content='{}',
                         headers={**AUTH, 'Content-Length': '1'}).status_code, 400)

        async def direct_stream(headers):
            parts = iter([{'type': 'http.request', 'body': b'x' * 5000, 'more_body': True},
                          {'type': 'http.request', 'body': b'x' * 5000, 'more_body': False}])
            messages = []
            scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
                     'method': 'POST', 'scheme': 'http', 'path': '/jobs', 'raw_path': b'/jobs',
                     'query_string': b'', 'root_path': '', 'server': ('127.0.0.1', 8010),
                     'client': ('127.0.0.1', 1234), 'headers': headers}
            async def receive():
                return next(parts)
            async def send(value):
                messages.append(value)
            await self.app(scope, receive, send)
            return next(m['status'] for m in messages if m['type'] == 'http.response.start')

        base = [(b'authorization', ('Bearer ' + TOKEN).encode()), (b'content-type', b'application/json')]
        self.assertEqual(asyncio.run(direct_stream(base)), 413)
        # Lying Content-Length cannot bypass the actual byte counter.
        self.assertEqual(asyncio.run(direct_stream(base + [(b'content-length', b'10')])), 413)
        self.backend.request.assert_not_called()

    def test_job_async_one_active_then_full_result_and_filters(self):
        entered, release = threading.Event(), threading.Event()
        result = {'status': 'answered', 'answer': '납품40개 [E1]',
                  'sources': [{'evidence_id': 'E1', 'source': {'source_refs': ['orders:1101']}}]}
        def upstream(method, path, payload):
            entered.set()
            if not release.wait(3):
                raise AssertionError('test did not release')
            return result
        self.backend.request.side_effect = upstream
        try:
            r = self.client.post('/jobs', json={**PAYLOAD, 'supplier_id': 1, 'part_id': 2,
                'document_type': 'order', 'top_k': 5}, headers=AUTH)
            self.assertEqual(r.status_code, 202)
            self.assertTrue(entered.wait(1))
            job_id = r.json()['job_id']
            self.assertEqual(r.headers['location'], '/jobs/' + job_id)
            self.assertEqual(self.client.get('/jobs/' + job_id, headers=AUTH).json()['status'], 'running')
            self.assertEqual(self.client.get('/jobs/' + job_id).status_code, 401)
            busy = self.client.post('/jobs', json=PAYLOAD, headers=AUTH)
            self.assertEqual(busy.status_code, 429)
            self.assertEqual(busy.headers['retry-after'], '5')
            self.assertEqual(len(self.app.state.jobs.global_usage), 1)
            self.assertEqual(len(self.app.state.jobs.visitor_usage[OWNER]), 1)
        finally:
            release.set()
        done = completed(self.app.state.jobs, job_id)
        self.assertEqual(done['result'], result)
        self.assertEqual(self.client.get('/jobs/' + job_id, headers=AUTH).json(), done)
        self.backend.request.assert_called_once_with('POST', '/answer', {**PAYLOAD,
            'supplier_id': 1, 'part_id': 2, 'document_type': 'order', 'top_k': 5})

    def test_negotiation_job_goes_to_negotiate_with_only_its_fields(self):
        facts = {'supplier': '업체 A', 'item': '실린더 라이너', 'currency': 'KRW', 'unit': 'EA', 'source': 'contract',
                 'prev_price': 1210000, 'requested_price': 1250000, 'period': '2025-09 → 2026-09',
                 'materials': [{'name': '니켈', 'change_pct': 15.2}], 'threshold_pp': 2, 'sample': True}
        body = {'question': '업체 A 인상 검토', 'model': 'qwen3:8b', 'negotiation': facts}
        r = self.client.post('/jobs', json=body, headers=AUTH)
        self.assertEqual(r.status_code, 202)
        completed(self.app.state.jobs, r.json()['job_id'])
        self.backend.request.assert_called_once_with('POST', '/negotiate', body)
        for bad in ({**body, 'order_id': 1101}, {**body, 'negotiation': {**facts, 'verdict': 'within'}},
                    {**body, 'negotiation': {**facts, 'prev_price': '1210000'}}):
            with self.subTest(bad=bad):
                self.assertEqual(self.client.post('/jobs', json=bad, headers=AUTH).status_code, 422)

    def test_finished_ttl_capacity_and_running_job_never_expires(self):
        now = [10.0]
        entered, release = threading.Event(), threading.Event()
        def upstream(*args):
            entered.set()
            release.wait(3)
            return {'answer': 'ok'}
        backend = Mock(); backend.request.side_effect = upstream
        jobs = Jobs(backend, clock=lambda: now[0], ttl=10, capacity=1)
        app = create_app(TOKEN, backend, jobs)
        with TestClient(app) as api:
            job_id = api.post('/jobs', json=PAYLOAD, headers=AUTH).json()['job_id']
            self.assertTrue(entered.wait(1))
            now[0] = 100
            self.assertEqual(api.get('/jobs/' + job_id, headers=AUTH).json()['status'], 'running')
            release.set(); completed(jobs, job_id)
            # Finished job remains for its full TTL, with bounded capacity.
            self.assertEqual(api.post('/jobs', json=PAYLOAD, headers=AUTH).status_code, 429)
            now[0] = 111
            self.assertEqual(api.get('/jobs/' + job_id, headers=AUTH).status_code, 404)
            new = api.post('/jobs', json=PAYLOAD, headers=AUTH)
            self.assertEqual(new.status_code, 202)
            completed(jobs, new.json()['job_id'])

    def test_failure_is_pollable_sanitized_and_releases_slot(self):
        self.backend.request.side_effect = RuntimeError('private-path/private-question')
        job_id = self.client.post('/jobs', json=PAYLOAD, headers=AUTH).json()['job_id']
        value = completed(self.app.state.jobs, job_id)
        self.assertEqual(value['status'], 'failed')
        self.assertEqual(value['error_status'], 502)
        self.assertNotIn('private-', json.dumps(value))
        self.backend.request.side_effect = BackendUnavailable(504, '답변 생성 시간이 초과되었습니다.')
        r = self.client.post('/jobs', json=PAYLOAD, headers=AUTH)
        self.assertEqual(r.status_code, 202)
        value = completed(self.app.state.jobs, r.json()['job_id'])
        self.assertEqual(value['error_status'], 504)

    def test_fixed_backend_transport_does_not_follow_redirects_or_leak_error(self):
        backend = LocalBackend()
        with self.assertRaises(BackendUnavailable):
            backend.request('POST', '/index', {})
        with patch('deployment.gateway.httpx.Client') as cls:
            client = cls.return_value.__enter__.return_value
            client.request.return_value = httpx.Response(500, json={'detail': 'C:/private/path'})
            with self.assertRaises(BackendUnavailable) as caught:
                backend.request('POST', '/answer', PAYLOAD)
            self.assertNotIn('private', caught.exception.message)
            self.assertEqual(cls.call_args.kwargs['base_url'], 'http://127.0.0.1:8000')
            self.assertIs(cls.call_args.kwargs['trust_env'], False)
            self.assertIs(cls.call_args.kwargs['follow_redirects'], False)
            client.request.assert_called_once_with('POST', '/answer', json=PAYLOAD)
            client.request.return_value = httpx.Response(302, json={'status': 'ok'},
                                                        headers={'Location': 'https://evil'})
            with self.assertRaises(BackendUnavailable):
                backend.request('GET', '/health')

    def test_job_visitor_required_validated_and_health_does_not_require_it(self):
        self.backend.request.return_value = {'status': 'ok'}
        self.assertEqual(self.client.get('/health', headers=BEARER).status_code, 200)
        job_path = '/jobs/00000000-0000-0000-0000-000000000000'
        for value in (None, '', 'short', 'A' * 42, 'A' * 44, '.' * 43, 'null', ' ' + VISITOR):
            headers = BEARER if value is None else {**BEARER, 'X-Rag-Visitor': value}
            for method, path in (('POST', '/jobs'), ('GET', job_path)):
                response = self.client.request(method, path, json=PAYLOAD if method == 'POST' else None,
                                               headers=headers)
                self.assertEqual(response.status_code, 400)
                self.assertNotIn(value or 'not-a-real-identity', response.text)
        duplicate = list(BEARER.items()) + [('X-Rag-Visitor', VISITOR), ('X-Rag-Visitor', VISITOR)]
        self.assertEqual(self.client.post('/jobs', json=PAYLOAD, headers=duplicate).status_code, 400)
        self.assertFalse(self.app.state.jobs.global_usage)

    def test_cross_visitor_cannot_poll_job_and_owner_hash_is_never_returned(self):
        response = self.client.post('/jobs', json=PAYLOAD, headers=AUTH)
        job_id = response.json()['job_id']
        done = completed(self.app.state.jobs, job_id)
        own = self.client.get('/jobs/' + job_id, headers=AUTH)
        self.assertEqual(own.json(), done)
        other = {**BEARER, 'X-Rag-Visitor': 'B' * 43}
        hidden = self.client.get('/jobs/' + job_id, headers=other)
        missing = self.client.get('/jobs/00000000-0000-0000-0000-000000000000', headers=other)
        self.assertEqual((hidden.status_code, hidden.json()), (missing.status_code, missing.json()))
        self.assertEqual(hidden.status_code, 404)
        for content in (response.text, own.text, hidden.text):
            self.assertNotIn(OWNER, content)
            self.assertNotIn(VISITOR, content)
            self.assertNotIn('owner_hash', content)
        self.assertEqual(self.app.state.jobs.items[job_id].owner_hash, OWNER)

    def test_visitor_quota_counts_accepted_no_evidence_and_expires(self):
        now = [10.0]
        backend = Mock()
        backend.request.return_value = {'status': 'insufficient_evidence', 'answer': '근거 부족'}
        jobs = Jobs(backend, clock=lambda: now[0], visitor_limit=2, global_limit=10)
        with TestClient(create_app(TOKEN, backend, jobs)) as api:
            for _ in range(2):
                response = api.post('/jobs', json=PAYLOAD, headers=AUTH)
                self.assertEqual(response.status_code, 202)
                completed(jobs, response.json()['job_id'])
            rejected = api.post('/jobs', json=PAYLOAD, headers=AUTH)
            self.assertEqual(rejected.status_code, 429)
            self.assertEqual(rejected.headers['retry-after'], '600')
            self.assertEqual(len(jobs.global_usage), 2)
            self.assertEqual(len(jobs.visitor_usage[OWNER]), 2)
            now[0] = 610
            response = api.post('/jobs', json=PAYLOAD, headers=AUTH)
            self.assertEqual(response.status_code, 202)
            completed(jobs, response.json()['job_id'])
            self.assertEqual(len(jobs.global_usage), 1)
            self.assertEqual(len(jobs.visitor_usage[OWNER]), 1)

    def test_global_quota_cannot_be_bypassed_by_new_visitor_cookie(self):
        backend = Mock(); backend.request.return_value = {'answer': 'ok'}
        jobs = Jobs(backend, global_limit=3)
        with TestClient(create_app(TOKEN, backend, jobs)) as api:
            for letter in ('A', 'B', 'C'):
                visitor = letter * 43
                owner = hashlib.sha256(visitor.encode()).hexdigest()
                response = api.post('/jobs', json=PAYLOAD, headers={**BEARER, 'X-Rag-Visitor': visitor})
                self.assertEqual(response.status_code, 202)
                completed(jobs, response.json()['job_id'], owner)
            response = api.post('/jobs', json=PAYLOAD, headers={**BEARER, 'X-Rag-Visitor': 'D' * 43})
            self.assertEqual(response.status_code, 429)
            self.assertIn('전체', response.json()['message'])
            self.assertEqual(len(jobs.global_usage), 3)
            self.assertEqual(len(jobs.visitor_usage), 3)

    def test_visitor_quota_entries_have_hard_capacity_and_ttl(self):
        now = [0.0]
        backend = Mock(); backend.request.return_value = {'answer': 'ok'}
        jobs = Jobs(backend, clock=lambda: now[0], global_limit=100, max_quota_visitors=2)
        with TestClient(create_app(TOKEN, backend, jobs)) as api:
            for letter in ('A', 'B'):
                visitor = letter * 43
                response = api.post('/jobs', json=PAYLOAD, headers={**BEARER, 'X-Rag-Visitor': visitor})
                completed(jobs, response.json()['job_id'], hashlib.sha256(visitor.encode()).hexdigest())
            headers = {**BEARER, 'X-Rag-Visitor': 'C' * 43}
            self.assertEqual(api.post('/jobs', json=PAYLOAD, headers=headers).status_code, 429)
            self.assertEqual(len(jobs.visitor_usage), 2)
            now[0] = 600
            response = api.post('/jobs', json=PAYLOAD, headers=headers)
            self.assertEqual(response.status_code, 202)
            completed(jobs, response.json()['job_id'], hashlib.sha256(('C' * 43).encode()).hexdigest())
            self.assertEqual(len(jobs.visitor_usage), 1)

    def test_inadmissible_and_busy_requests_do_not_charge_quota(self):
        self.assertEqual(self.client.post('/jobs', json={**PAYLOAD, 'top_k': True}, headers=AUTH).status_code, 422)
        self.assertFalse(self.app.state.jobs.global_usage)
        self.assertFalse(self.app.state.jobs.visitor_usage)
        with patch('deployment.gateway.threading.Thread') as thread:
            thread.return_value.start.side_effect = RuntimeError('cannot start thread')
            self.assertEqual(self.client.post('/jobs', json=PAYLOAD, headers=AUTH).status_code, 429)
        self.assertFalse(self.app.state.jobs.global_usage)
        self.assertFalse(self.app.state.jobs.visitor_usage)
        self.assertIsNone(self.app.state.jobs.active)

    def test_admitted_job_still_counts_if_backend_later_fails(self):
        self.backend.request.side_effect = BackendUnavailable()
        job_id = self.client.post('/jobs', json=PAYLOAD, headers=AUTH).json()['job_id']
        self.assertEqual(completed(self.app.state.jobs, job_id)['status'], 'failed')
        self.assertEqual(len(self.app.state.jobs.global_usage), 1)
        self.assertEqual(len(self.app.state.jobs.visitor_usage[OWNER]), 1)


if __name__ == '__main__':
    unittest.main()
