-- 읽기 전용 조회 예제입니다.
-- VS Code: 터미널 > 작업 실행 > DB: SQL 예제 실행

-- 1. 협력사 정보와 계산된 C 값
SELECT supplier_id, name, q_score, c_score, d_score, t_score, e_score
FROM v_supplier_summary
ORDER BY supplier_id;

-- 2. 발주별 업체명, 부품명, 납품 수량, 남은 수량
SELECT order_id, supplier_name, part_name, quantity,
       delivered_quantity, remaining_quantity, expected_date
FROM v_order_status
ORDER BY order_id;

-- 3. 민원 정보와 관련 협력사
SELECT complaint_id, supplier_name, part_name, defect_type, complaint_message
FROM v_complaint_details
ORDER BY complaint_id;
