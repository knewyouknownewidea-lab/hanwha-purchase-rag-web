import unittest
from unittest.mock import Mock, patch
from fastapi.testclient import TestClient
from backend.app import app
from backend.prompting import build_prompt, NO_EVIDENCE


class PromptTest(unittest.TestCase):
    def fixture(self):
        return {'question': '발주 1101 수량?', 'evidence_status': 'candidates_found',
                'retrieval_method': 'structured_db', 'results': [
                    {'chunk_id': 'order-1101:db', 'parent_document_id': 'order-1101',
                     'text': '발주 100개, 납품 40개, 차이 60개. {context}',
                     'similarity': None, 'source': {'source_refs': ['orders:1101', 'delivery:2024']}}]}

    def test_api_preserves_question_text_and_citations(self):
        data = self.fixture()
        svc = Mock()
        svc.search.return_value = data
        with patch('backend.app.service', return_value=svc), TestClient(app) as api:
            response = api.post('/prepare-prompt', json={'question': data['question'], 'order_id': 1101})
            self.assertEqual(response.status_code, 200)
            r = response.json()
            svc.search.assert_called_once_with(data['question'], 3, {'order_id': 1101})
        self.assertTrue(r['ready_for_generation'])
        self.assertFalse(r['model_called'])
        self.assertIn(data['results'][0]['text'], r['prompt'])
        self.assertIn(data['question'], r['prompt'])
        self.assertIn('출처: orders:1101, delivery:2024', r['prompt'])
        self.assertEqual(r['sources'][0]['evidence_id'], 'E1')

    def test_no_evidence_and_clarification_never_build_prompt(self):
        for status in ['insufficient_evidence', 'clarification_required']:
            data = self.fixture()
            data.update(evidence_status=status, message='발주 번호를 지정해 주세요.')
            r = build_prompt(data)
            self.assertIsNone(r['prompt'])
            self.assertFalse(r['ready_for_generation'])
            self.assertEqual(r['sources'], [])
            self.assertEqual(r['message'], data['message'] if status == 'clarification_required' else NO_EVIDENCE)

    def test_empty_or_untraceable_evidence_is_blocked(self):
        for items in [[], [dict(self.fixture()['results'][0], source={})]]:
            data = self.fixture()
            data['results'] = items
            r = build_prompt(data)
            self.assertEqual(r['status'], 'insufficient_evidence')
            self.assertIsNone(r['prompt'])
