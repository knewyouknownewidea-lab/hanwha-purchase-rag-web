-- 현재 로컬 DB에 저장된 가상 데이터의 ID 연결을 확인합니다.
-- 실제 회사 데이터 또는 팀원 서버 데이터와 연결된 것은 아닙니다.
-- VS Code 작업 실행 > DB: 데이터 연결 확인

-- 1. 6개 테이블에 저장된 레코드 수
SELECT '협력사' AS data_type, 'supplier' AS table_name, COUNT(*) AS record_count FROM supplier
UNION ALL SELECT '부품', 'part', COUNT(*) FROM part
UNION ALL SELECT '공급 관계', 'supplier_part', COUNT(*) FROM supplier_part
UNION ALL SELECT '발주', 'orders', COUNT(*) FROM orders
UNION ALL SELECT '납품', 'delivery', COUNT(*) FROM delivery
UNION ALL SELECT '민원', 'complaint', COUNT(*) FROM complaint;

-- 2. 발주 1101번에 연결된 협력사, 부품, 공급 관계
-- 다른 발주를 확인하려면 마지막 WHERE의 1101을 바꾸면 됩니다.
SELECT o.order_id,
       s.supplier_id, s.name AS supplier_name,
       p.part_id, p.part_name,
       sp.supplier_part_id, sp.unit_price,
       o.quantity AS order_quantity, o.cost
FROM orders AS o
JOIN supplier AS s ON s.supplier_id = o.supplier_id
JOIN part AS p ON p.part_id = o.part_id
LEFT JOIN supplier_part AS sp
       ON sp.supplier_id = o.supplier_id AND sp.part_id = o.part_id
WHERE o.order_id = 1101;

-- 3. 발주 1101번의 납품 기록
SELECT delivery_id, order_id, delivery_date, delivery_quantity, delivery_status
FROM delivery
WHERE order_id = 1101
ORDER BY delivery_id;

-- 4. 해당 납품에 연결된 민원
SELECT c.complaint_id, c.delivery_id, d.order_id, c.part_id,
       c.complaint_date, c.defect_type, c.complaint_message
FROM complaint AS c
JOIN delivery AS d ON d.delivery_id = c.delivery_id
WHERE d.order_id = 1101
ORDER BY c.complaint_id;
