import unittest
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableLambda
from .generation import GenerationError
from .negotiation import NegotiationFacts, NegotiationWriter, analyze

BASE = {'supplier': '업체 A', 'item': '실린더 라이너', 'currency': 'KRW', 'unit': 'EA', 'source': 'quote',
        'prev_price': 1250000, 'requested_price': 1400000, 'period': '2025-09 → 2026-09',
        'materials': [{'name': '선철', 'change_pct': -5.8}, {'name': '니켈', 'change_pct': 15.2}],
        'threshold_pp': 2, 'sample': True}
GOOD = '[협상 논리 보고서]\n요구 인상률 12.0%는 소재 평균 4.7%보다 7.3%p 높습니다.\n[공문 이메일 초안]\n제목: 단가 조정 요청 검토 회신'


def fake(text, model='qwen3:8b', **meta):
    reply = AIMessage(content=text, response_metadata={'model': model, 'done': True, 'done_reason': 'stop',
                                                       'prompt_eval_count': 500, **meta})
    return lambda _model: RunnableLambda(lambda _prompt: reply)


class NegotiationTest(unittest.TestCase):
    def facts(self, **change):
        return NegotiationFacts.model_validate({**BASE, **change})

    def test_code_decides_numbers_and_verdict(self):
        r = analyze(self.facts())
        self.assertEqual((r['requested_change_pct'], r['material_change_pct'], r['gap_pp'], r['verdict']), (12.0, 4.7, 7.3, 'excessive'))
        self.assertEqual(analyze(self.facts(requested_price=1300000))['verdict'], 'within')  # 4.0% - 4.7% = -0.7%p
        none = analyze(self.facts(materials=[{'name': '니켈', 'change_pct': None}]))
        self.assertEqual((none['material_change_pct'], none['gap_pp'], none['verdict']), (None, None, 'insufficient_data'))

    def test_browser_cannot_send_derived_values(self):
        with self.assertRaises(ValueError):
            NegotiationFacts.model_validate({**BASE, 'verdict': 'within'})
        with self.assertRaises(ValueError):
            NegotiationFacts.model_validate({**BASE, 'prev_price': 0})

    def test_langchain_chain_drafts_report_and_email(self):
        out = NegotiationWriter(fake(GOOD)).write('업체 A 인상 요구 검토', self.facts(), 'qwen3:8b')
        self.assertEqual(out['status'], 'drafted')
        self.assertIn('7.3%p', out['report'])
        self.assertTrue(out['email'].startswith('제목'))
        self.assertEqual(out['facts']['verdict'], 'excessive')

    def test_unknown_percent_needs_review(self):
        text = GOOD.replace('7.3%p', '9.9%p')
        out = NegotiationWriter(fake(text)).write('q', self.facts(), 'qwen3:8b')
        self.assertEqual(out['status'], 'needs_review')
        self.assertIn('9.9%', out['note'])

    def test_invented_date_needs_review(self):
        out = NegotiationWriter(fake(GOOD + '\n회신 기한: 2026년 10월 10일')).write('q', self.facts(), 'qwen3:8b')
        self.assertEqual(out['status'], 'needs_review')
        self.assertIn('2026년 10월 10일', out['note'])
        ok = NegotiationWriter(fake(GOOD + '\n비교 기간 2025-09 → 2026-09, 회신 기한 [회신 기한]')).write('q', self.facts(), 'qwen3:8b')
        self.assertEqual(ok['status'], 'drafted')

    def test_internal_verdict_in_email_needs_review(self):
        out = NegotiationWriter(fake(GOOD + '\n요구가 과도한 수준으로 판단됩니다.')).write('q', self.facts(), 'qwen3:8b')
        self.assertEqual(out['status'], 'needs_review')
        self.assertIn('내부 판정', out['note'])

    def test_bad_output_is_not_shown_as_report(self):
        out = NegotiationWriter(fake('보고서만 있음')).write('q', self.facts(), 'qwen3:8b')
        self.assertEqual(out['status'], 'invalid_generation')
        self.assertNotIn('report', out)
        for bad in ({'model': 'gemma3:4b'}, {'done_reason': 'length'}, {'prompt_eval_count': 9000}):
            with self.subTest(bad=bad), self.assertRaises(GenerationError):
                NegotiationWriter(fake(GOOD, **bad)).write('q', self.facts(), 'qwen3:8b')


if __name__ == '__main__':
    unittest.main()
