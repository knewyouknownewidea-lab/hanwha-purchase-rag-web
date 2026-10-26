import unittest
from backend.query_rules import plan, period
from project_paths import DATABASE

class QueryRulesTest(unittest.TestCase):
    def route(self,q,filters=None):return plan(DATABASE,q,filters or {})
    def test_natural_ids_and_exact_conditions(self):
        for text in ['발주 번호: 1104의 수량 차이는?','1104번 발주의 남은 수량은?','발주ID 1104 납품 수량']:
            r=self.route(text)
            self.assertEqual(r['mode'],'structured')
            self.assertEqual([d['id'] for d in r['documents']],['order-1104'])
        self.assertEqual(self.route('발주 110의 수량')['reason'],'unknown_id')
        self.assertEqual(self.route('발주 1104 수량',{'order_id':1101})['reason'],'conflicting_conditions')
        self.assertEqual(self.route('가상 B사의 발주 1104 수량')['reason'],'no_matching_records')
        self.assertEqual(self.route('가상 Z사의 베어링 단가')['reason'],'unknown_supplier')
    def test_dates(self):
        self.assertEqual(period('2026-05-01부터 2026-05-31까지'),['2026-05-01','2026-05-31'])
        self.assertEqual(period('2026-05 발주'),['2026-05-01','2026-05-31'])
        r=self.route('2026년 5월 가상 A사의 연료 분사 밸브 발주 수량은?')
        self.assertEqual([d['id'] for d in r['documents']],['order-1004'])
        self.assertEqual(self.route('2025년 5월 가상 A사의 연료 분사 밸브 발주 수량')['reason'],'no_matching_records')
        for q in ['2026년 13월 발주 수량','5월 발주 수량','지난달 가상 A사 발주 수량','2026-05-31부터 2026-05-01까지 발주 수량']:
            self.assertEqual(self.route(q)['mode'],'clarify')
        r=self.route('2026년 6월 베어링 표면 찍힘 민원을 찾아줘')
        self.assertEqual(r['mode'],'semantic');self.assertEqual([d['id'] for d in r['documents']],['complaint-3004'])
        self.assertEqual(self.route('2026년 10월 18일 납품 관련 민원')['reason'],'ambiguous_date_field')
        self.assertEqual([d['id'] for d in self.route('납품일 2026년 10월 18일의 민원')['documents']],['complaint-3007'])
    def test_absence_and_ambiguity(self):
        self.assertEqual(self.route('발주 1101의 결제 완료일')['reason'],'unsupported_field')
        self.assertEqual(self.route('가상 A사의 베어링 제조사 보증 기간')['reason'],'unsupported_field')
        self.assertEqual(self.route('가상 A사의 베어링 등록 단가')['mode'],'structured')
        self.assertEqual(self.route('베어링 단가 알려줘')['mode'],'clarify')
        self.assertEqual(self.route('발주 1101과 발주 1104의 수량')['reason'],'multiple_ids')
        self.assertEqual(self.route('발주 1101 승인 담당 조직')['mode'],'clarify')
        # 민원에 원인 확인 요청이 있다는 것과 실제 근본 원인을 아는 것은 다릅니다.
        self.assertEqual(self.route('실린더 라이너 긁힘 원인 확인을 요청한 민원 찾아줘')['mode'],'semantic')
    def test_scope_is_not_tied_to_evaluation_wording(self):
        # 평가셋(calibrate_threshold.py)에 없는 표현으로 규칙이 일반화되는지 확인합니다.
        for q in ['주말에 볼 영화 추천해줘','엑셀 VLOOKUP 쓰는 법 알려줘','영어 이메일 번역해줘','신입사원 연봉은 얼마야?']:
            self.assertEqual(self.route(q)['reason'],'outside_scope',q)
        for q in ['가상 A사 팩스 번호 알려줘','베어링 규격 알려줘','발주 1101의 운송비는?','가상 C사 리드타임은?','민원 3002 처리 결과는?']:
            self.assertEqual(self.route(q)['reason'],'unsupported_field',q)
        # 민원 본문에 있는 단어(치수·포장)는 없는 속성으로 막지 않습니다.
        for q in ['실린더 라이너 치수 확인 요청 민원 찾아줘','베어링 포장 불량 민원']:
            self.assertEqual(self.route(q)['mode'],'semantic',q)

    def test_explicit_filters_supply_context_for_short_questions(self):
        cases = [
            ('수량은?', {'document_type':'order','order_id':1101}, 'order-1101'),
            ('수량은?', {'order_id':1101}, 'order-1101'),
            ('수량 좀 알려줘', {'order_id':1101}, 'order-1101'),
            ('상태는?', {'order_id':1101}, 'order-1101'),
            ('수량은?', {'delivery_id':2024}, 'order-1101'),
            ('unit_price', {'supplier_id':1,'part_id':1}, 'supplier_part-1'),
            ('C 계산값', {'document_type':'supplier','supplier_id':1}, 'supplier-1'),
            ('C 계산값', {'supplier_id':1}, 'supplier-1'),
        ]
        for question, filters, expected_id in cases:
            with self.subTest(question=question, filters=filters):
                result = self.route(question, filters)
                self.assertEqual(result['mode'], 'structured')
                self.assertEqual([doc['id'] for doc in result['documents']], [expected_id])

    def test_filters_do_not_admit_unrelated_questions(self):
        for filters in [{'document_type':'order','order_id':1101},
                        {'document_type':'supplier','supplier_id':1},
                        {'document_type':'complaint','part_id':1}]:
            for question in ['주말에 볼 영화 추천해줘','영화 정보 알려줘','영어 이메일 번역해줘',
                             '현재 서버 상태는?','사용자 계정 수량은?']:
                with self.subTest(question=question, filters=filters):
                    self.assertEqual(self.route(question, filters)['reason'], 'outside_scope')
        for filters in [{}, {'order_id':None}, {'document_type':None},
                        {'unknown_filter':1101}, {'document_type':'unknown'}]:
            with self.subTest(filters=filters):
                self.assertEqual(self.route('수량은?', filters)['reason'], 'outside_scope')

    def test_filtered_short_questions_keep_condition_validation(self):
        cases = [
            ('수량은?', {'order_id':999999}, 'unknown_id'),
            ('수량은?', {'order_id':1101,'supplier_id':2}, 'no_matching_records'),
            ('수량은?', {'document_type':'supplier','order_id':1101}, 'conflicting_document_type'),
            ('수량은?', {'document_type':'supplier','supplier_id':1}, 'conflicting_document_type'),
            ('unit_price', {'document_type':'order','supplier_id':1,'part_id':1}, 'conflicting_document_type'),
            ('C 계산값', {'document_type':'order','supplier_id':1}, 'conflicting_document_type'),
            ('unit_price', {'supplier_id':1}, 'missing_price_conditions'),
            ('C 계산값', {'document_type':'supplier'}, 'missing_supplier'),
            ('협력사 전화번호는?', {'supplier_id':1}, 'unsupported_field'),
            ('발주 수량과 운송비는?', {'order_id':1101}, 'unsupported_field'),
            ('2026년 5월 C 계산값', {'supplier_id':1}, 'unsupported_history'),
        ]
        for question, filters, expected_reason in cases:
            with self.subTest(question=question, filters=filters):
                self.assertEqual(self.route(question, filters)['reason'], expected_reason)

if __name__=='__main__':unittest.main()
