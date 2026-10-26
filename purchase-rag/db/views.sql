-- cScore is calculated rather than stored, matching the entity's intent.
CREATE VIEW v_supplier_summary AS
SELECT s.supplier_id, s.name, s.info, s.q_score,
       COALESCE(AVG(o.cost), 0) AS c_score,
       s.d_score, s.t_score, s.e_score,
       COUNT(o.order_id) AS order_count,
       COALESCE(SUM(o.quantity), 0) AS ordered_quantity
FROM supplier AS s
LEFT JOIN orders AS o ON o.supplier_id = s.supplier_id
GROUP BY s.supplier_id, s.name, s.info, s.q_score, s.d_score, s.t_score, s.e_score;

-- Each order appears once, avoiding multiplication by delivery or complaint rows.
CREATE VIEW v_order_status AS
SELECT o.order_id, o.supplier_id, s.name AS supplier_name,
       o.part_id, p.part_name, o.quantity, o.cost,
       o.order_date, o.expected_date,
       COALESCE(d.delivered_quantity, 0) AS delivered_quantity,
       o.quantity - COALESCE(d.delivered_quantity, 0) AS remaining_quantity,
       d.last_delivery_date,
       CASE
           WHEN COALESCE(d.delivered_quantity, 0) = 0 THEN 'NOT_DELIVERED'
           WHEN d.delivered_quantity < o.quantity THEN 'PARTIAL'
           WHEN d.delivered_quantity = o.quantity THEN 'COMPLETED'
           ELSE 'OVER_DELIVERED'
       END AS quantity_state
FROM orders AS o
JOIN supplier AS s ON s.supplier_id = o.supplier_id
JOIN part AS p ON p.part_id = o.part_id
LEFT JOIN (
    SELECT order_id, SUM(delivery_quantity) AS delivered_quantity,
           MAX(delivery_date) AS last_delivery_date
    FROM delivery
    GROUP BY order_id
) AS d ON d.order_id = o.order_id;

CREATE VIEW v_complaint_details AS
SELECT c.complaint_id, c.part_id, p.part_name,
       c.delivery_id, d.order_id, o.supplier_id, s.name AS supplier_name,
       c.complaint_date, c.defect_type, c.complaint_message
FROM complaint AS c
JOIN delivery AS d ON d.delivery_id = c.delivery_id
JOIN orders AS o ON o.order_id = d.order_id
JOIN supplier AS s ON s.supplier_id = o.supplier_id
JOIN part AS p ON p.part_id = c.part_id;
