CREATE TABLE supplier (
    supplier_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    info TEXT,
    q_score INTEGER,
    d_score INTEGER,
    t_score INTEGER,
    e_score INTEGER
);

CREATE TABLE part (
    part_id INTEGER PRIMARY KEY,
    part_name TEXT NOT NULL
);

CREATE TABLE supplier_part (
    supplier_part_id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES supplier(supplier_id),
    part_id INTEGER NOT NULL REFERENCES part(part_id),
    unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
    UNIQUE (supplier_id, part_id)
);

CREATE TABLE orders (
    order_id INTEGER PRIMARY KEY,
    supplier_id INTEGER NOT NULL REFERENCES supplier(supplier_id),
    part_id INTEGER NOT NULL REFERENCES part(part_id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    cost INTEGER NOT NULL CHECK (cost >= 0),
    order_date TEXT NOT NULL,
    expected_date TEXT NOT NULL
);

CREATE TABLE delivery (
    delivery_id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(order_id),
    delivery_date TEXT NOT NULL,
    delivery_quantity INTEGER NOT NULL CHECK (delivery_quantity > 0),
    delivery_status TEXT NOT NULL
);

CREATE TABLE complaint (
    complaint_id INTEGER PRIMARY KEY,
    part_id INTEGER NOT NULL REFERENCES part(part_id),
    delivery_id INTEGER NOT NULL REFERENCES delivery(delivery_id),
    complaint_date TEXT NOT NULL,
    defect_type TEXT NOT NULL,
    complaint_message TEXT NOT NULL
);

CREATE INDEX idx_supplier_part_part ON supplier_part(part_id);
CREATE INDEX idx_orders_supplier ON orders(supplier_id);
CREATE INDEX idx_orders_part ON orders(part_id);
CREATE INDEX idx_orders_order_date ON orders(order_date);
CREATE INDEX idx_orders_expected_date ON orders(expected_date);
CREATE INDEX idx_delivery_order ON delivery(order_id);
CREATE INDEX idx_complaint_delivery ON complaint(delivery_id);
CREATE INDEX idx_complaint_part ON complaint(part_id);

-- 웹 화면 SAMPLE과 같은 가상 시세·임금 (실제 기관 자료 아님)
CREATE TABLE material_price (
    material_price_id INTEGER PRIMARY KEY,
    month TEXT NOT NULL,
    material TEXT NOT NULL,
    market TEXT NOT NULL,
    price REAL NOT NULL CHECK (price >= 0),
    unit TEXT NOT NULL,
    currency TEXT NOT NULL,
    UNIQUE (material, market, month)
);

CREATE TABLE labor_wage (
    labor_wage_id INTEGER PRIMARY KEY,
    month TEXT NOT NULL,
    major TEXT NOT NULL,
    mid TEXT NOT NULL,
    minor TEXT NOT NULL,
    wage INTEGER NOT NULL CHECK (wage >= 0),
    UNIQUE (minor, month)
);
