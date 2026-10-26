"""구매관리 DB를 읽어서 검색용 문서를 만듭니다.

1. DB의 6개 테이블을 읽습니다. DB는 읽기 전용으로 엽니다.
2. 숫자 ID로 협력사, 부품, 발주, 납품, 민원을 연결합니다.
3. 일정한 양식의 텍스트와 원본 ID를 담아 검색문서.jsonl에 저장합니다.

납품은 연결된 발주 문서에 포함합니다.
다시 실행하면 생성한 JSONL과 예시 JSON을 갱신합니다.
"""

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from project_paths import DATABASE, DOCUMENTS_DIR
TABLE_KEYS = {
    'supplier': 'supplier_id',
    'part': 'part_id',
    'supplier_part': 'supplier_part_id',
    'orders': 'order_id',
    'delivery': 'delivery_id',
    'complaint': 'complaint_id',
}
TYPE_LABELS = {
    'supplier': '협력사', 'part': '부품', 'supplier_part': '공급 부품',
    'order': '발주와 연결 납품', 'complaint': '민원',
}


def display(value):
    """값이 없다는 것과 숫자 0, 빈 문자열을 구분합니다."""
    if value is None:
        return '미확인(null)'
    if value == '':
        return '빈 문자열("")'
    return str(value)


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_records(database):
    """하나의 읽기 트랜잭션에서 원본 테이블과 C 계산값을 읽습니다."""
    if not database.is_file():
        raise ValueError(f'DB 파일을 찾을 수 없습니다: {database}')
    digest = file_hash(database)
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA query_only = ON')
        connection.execute('BEGIN')
        problems = connection.execute('PRAGMA foreign_key_check').fetchall()
        if problems:
            raise ValueError('DB의 ID 연결에 오류가 있습니다. 외래키를 먼저 확인하세요.')
        records = {
            table: [dict(row) for row in connection.execute(f'SELECT * FROM {table} ORDER BY {key}')]
            for table, key in TABLE_KEYS.items()
        }
        c_values = {
            row['supplier_id']: row['c_score']
            for row in connection.execute('''
                SELECT s.supplier_id, COALESCE(AVG(o.cost), 0) AS c_score
                FROM supplier s LEFT JOIN orders o ON o.supplier_id = s.supplier_id
                GROUP BY s.supplier_id ORDER BY s.supplier_id
            ''')
        }
    if file_hash(database) != digest:
        raise ValueError('읽는 동안 DB가 변경되었습니다. 다시 실행하세요.')
    return records, c_values, digest


def build_documents(records, c_values, database_name, digest):
    suppliers = {row['supplier_id']: row for row in records['supplier']}
    parts = {row['part_id']: row for row in records['part']}
    orders = {row['order_id']: row for row in records['orders']}
    deliveries = {row['delivery_id']: row for row in records['delivery']}
    supplier_orders = defaultdict(list)
    order_deliveries = defaultdict(list)
    for order in records['orders']:
        supplier_orders[order['supplier_id']].append(order)
    for delivery in records['delivery']:
        order_deliveries[delivery['order_id']].append(delivery)
    documents = []

    def add(kind, record_id, lines, references, **filters):
        references = list(dict.fromkeys(references))
        documents.append({
            'id': f'{kind}-{record_id}',
            'text': '\n'.join(lines),
            'metadata': {
                'document_type': kind,
                'source_db': database_name,
                'source_db_sha256': digest,
                'source_tables': list(dict.fromkeys(ref.split(':', 1)[0] for ref in references)),
                'source_refs': references,
                **filters,
            },
        })

    for supplier in records['supplier']:
        sid = supplier['supplier_id']
        related = supplier_orders[sid]
        lines = [
            '[협력사 정보]',
            f'협력사 ID: {sid}',
            f'협력사명: {display(supplier["name"])}',
            f'협력사 설명: {display(supplier["info"])}',
            f'Q 저장 점수: {display(supplier["q_score"])}',
            f'D 저장 점수: {display(supplier["d_score"])}',
            f'T 저장 점수: {display(supplier["t_score"])}',
            f'E 저장 점수: {display(supplier["e_score"])}',
            f'C 계산값: {display(c_values[sid])}',
            'C 계산식: 해당 협력사의 AVG(orders.cost). NULL cost는 평균에서 제외하고 대상 값이 없으면 0을 표시한다.',
            'Q/D/T/E 점수의 산출 근거와 평가기간은 현재 DB에 포함되어 있지 않다.',
            'C 계산에 연결된 발주별 비용값:',
        ]
        lines.extend(f'발주 ID {o["order_id"]}: cost={display(o["cost"])}' for o in related)
        if not related:
            lines.append('연결된 발주 기록 없음')
        add('supplier', sid, lines, [f'supplier:{sid}'] + [f'orders:{o["order_id"]}' for o in related],
            supplier_id=sid, calculation_order_ids=[o['order_id'] for o in related])

    for part in records['part']:
        pid = part['part_id']
        add('part', pid, ['[부품 정보]', f'부품 ID: {pid}', f'부품명: {display(part["part_name"])}'],
            [f'part:{pid}'], part_id=pid)

    for relation in records['supplier_part']:
        rid, sid, pid = relation['supplier_part_id'], relation['supplier_id'], relation['part_id']
        add('supplier_part', rid, [
            '[협력사별 공급 부품]',
            f'공급 관계 ID: {rid}',
            f'협력사 ID: {sid}', f'협력사명: {display(suppliers[sid]["name"])}',
            f'부품 ID: {pid}', f'부품명: {display(parts[pid]["part_name"])}',
            f'등록 단가(unit_price): {display(relation["unit_price"])}',
        ], [f'supplier_part:{rid}', f'supplier:{sid}', f'part:{pid}'],
            supplier_part_id=rid, supplier_id=sid, part_id=pid)

    for order in records['orders']:
        oid, sid, pid = order['order_id'], order['supplier_id'], order['part_id']
        related = sorted(order_deliveries[oid], key=lambda row: (row['delivery_date'] or '', row['delivery_id']))
        quantity_values = [row['delivery_quantity'] for row in related]
        delivered = sum(quantity_values) if all(value is not None for value in quantity_values) else None
        remaining = order['quantity'] - delivered if order['quantity'] is not None and delivered is not None else None
        lines = [
            '[발주 정보]', f'발주 ID: {oid}',
            f'협력사 ID: {sid}', f'협력사명: {display(suppliers[sid]["name"])}',
            f'부품 ID: {pid}', f'부품명: {display(parts[pid]["part_name"])}',
            f'발주 수량(quantity): {display(order["quantity"])}',
            f'발주 비용값(cost): {display(order["cost"])}',
            f'발주일(order_date): {display(order["order_date"])}',
            f'등록 납기 예상일(expected_date): {display(order["expected_date"])}',
            '[연결된 납품 기록]',
        ]
        for delivery in related:
            lines.extend([
                f'납품 ID: {delivery["delivery_id"]}', f'연결 발주 ID: {delivery["order_id"]}',
                f'납품일(delivery_date): {display(delivery["delivery_date"])}',
                f'납품 수량(delivery_quantity): {display(delivery["delivery_quantity"])}',
                f'납품 상태(delivery_status): {display(delivery["delivery_status"])}',
            ])
        if not related:
            lines.append('연결된 납품 기록 없음')
        lines.extend([
            '[저장된 기록의 수량 계산]',
            f'기록상 누적 납품 수량: {display(delivered)}',
            f'발주 수량과 기록상 납품 수량의 차이: {display(remaining)}',
            '누적 수량은 이 발주에 연결된 모든 저장 납품 행을 더한 값이다.',
        ])
        add('order', oid, lines,
            [f'orders:{oid}', f'supplier:{sid}', f'part:{pid}'] + [f'delivery:{d["delivery_id"]}' for d in related],
            order_id=oid, supplier_id=sid, part_id=pid,
            order_date=order['order_date'], expected_date=order['expected_date'],
            delivery_ids=[d['delivery_id'] for d in related],
            delivery_dates=[d['delivery_date'] for d in related],
            recorded_delivered_quantity=delivered, recorded_quantity_difference=remaining)

    for complaint in records['complaint']:
        cid, pid = complaint['complaint_id'], complaint['part_id']
        delivery = deliveries[complaint['delivery_id']]
        order = orders[delivery['order_id']]
        oid, sid = order['order_id'], order['supplier_id']
        if pid != order['part_id']:
            raise ValueError(f'민원 {cid}의 부품이 연결 발주의 부품과 다릅니다.')
        add('complaint', cid, [
            '[민원 정보]', f'민원 ID: {cid}',
            f'협력사 ID: {sid}', f'협력사명: {display(suppliers[sid]["name"])}',
            f'부품 ID: {pid}', f'부품명: {display(parts[pid]["part_name"])}',
            f'연결 발주 ID: {oid}', f'연결 납품 ID: {delivery["delivery_id"]}',
            f'연결 납품일(delivery_date): {display(delivery["delivery_date"])}',
            f'민원일(complaint_date): {display(complaint["complaint_date"])}',
            f'불량 유형(defect_type): {display(complaint["defect_type"])}',
            f'민원 내용: {display(complaint["complaint_message"])}',
        ], [f'complaint:{cid}', f'delivery:{delivery["delivery_id"]}', f'orders:{oid}', f'supplier:{sid}', f'part:{pid}'],
            complaint_id=cid, delivery_id=delivery['delivery_id'], order_id=oid,
            supplier_id=sid, part_id=pid, delivery_date=delivery['delivery_date'],
            complaint_date=complaint['complaint_date'], defect_type=complaint['defect_type'])

    # 모든 원본 레코드가 최소 한 문서의 출처로 연결되었는지 확인합니다.
    expected_refs = {f'{table}:{row[key]}' for table, key in TABLE_KEYS.items() for row in records[table]}
    actual_refs = {ref for document in documents for ref in document['metadata']['source_refs']}
    if actual_refs != expected_refs:
        raise ValueError('검색 문서의 원본 연결에 누락 또는 잘못된 ID가 있습니다.')
    if len({document['id'] for document in documents}) != len(documents):
        raise ValueError('검색 문서 ID가 중복되었습니다.')
    if not documents:
        raise ValueError('DB에 문서로 만들 데이터가 없습니다.')
    return documents


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='\n', dir=path.parent, suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description='구매관리 DB를 읽어서 검색용 JSONL로 변환')
    parser.add_argument('--database', type=Path, default=DATABASE)
    parser.add_argument('--output', type=Path, default=DOCUMENTS_DIR / '검색문서.jsonl')
    parser.add_argument('--preview', type=Path, default=DOCUMENTS_DIR / '검색문서_예시.json')
    args = parser.parse_args()
    database, output, preview = (path.resolve() for path in [args.database, args.output, args.preview])
    if len({database, output, preview}) != 3:
        parser.error('입력 DB와 출력 파일은 서로 다른 경로여야 합니다.')
    records, c_values, digest = load_records(database)
    documents = build_documents(records, c_values, database.name, digest)
    example = next((doc for doc in documents if doc['id'] == 'order-1101'), documents[0])
    jsonl = ''.join(json.dumps(doc, ensure_ascii=False, separators=(',', ':')) + '\n' for doc in documents)
    atomic_write(output, jsonl)
    atomic_write(preview, json.dumps(example, ensure_ascii=False, indent=2) + '\n')
    if file_hash(database) != digest:
        raise ValueError('문서 생성 중 DB가 변경되었습니다. 다시 실행하세요.')
    print(f'원본 DB 레코드: {sum(len(rows) for rows in records.values())}건')
    print(f'생성한 검색 문서: {len(documents)}개')
    counts = Counter(doc['metadata']['document_type'] for doc in documents)
    for kind, label in TYPE_LABELS.items():
        print(f'  {label}: {counts[kind]}개')
    print(f'검색용 파일: {output.name}')
    print(f'읽기 쉬운 예시: {preview.name} ({example["id"]})')
    print('원본 ID 연결 확인 완료. DB는 읽기 전용으로 조회했습니다.')


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        print(f'문서화 오류: {error}', file=sys.stderr)
        raise SystemExit(1)
