"""SQLite 테스트 DB를 읽기 전용으로 조회합니다. 추가 패키지는 필요 없습니다."""

import argparse
import sqlite3
import sys
import unicodedata
from pathlib import Path

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from project_paths import DATABASE, DB_DIR

QUERIES_DIR = DB_DIR / 'queries'
TABLES = {
    'supplier': '협력사', 'part': '부품', 'supplier_part': '공급 관계',
    'orders': '발주', 'delivery': '납품', 'complaint': '민원',
    'v_supplier_summary': '협력사 요약', 'v_order_status': '발주별 납품 현황',
    'v_complaint_details': '민원 상세',
}

def width(text):
    return sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in str(text))

def show(cursor):
    if cursor.description is None:
        return
    headers = [column[0] for column in cursor.description]
    rows = [['' if value is None else str(value) for value in row] for row in cursor.fetchall()]
    sizes = [max(width(headers[i]), *(width(row[i]) for row in rows)) if rows else width(headers[i]) for i in range(len(headers))]
    def line(row):
        return ' | '.join(value + ' ' * (sizes[i] - width(value)) for i, value in enumerate(row))
    print(line(headers))
    print('-+-'.join('-' * size for size in sizes))
    for row in rows:
        print(line(row))
    print(f'({len(rows)}건)\n')

def statements(text):
    pending = ''
    for char in text:
        pending += char
        if char == ';' and sqlite3.complete_statement(pending):
            yield pending
            pending = ''
    if pending.strip():
        yield pending

def main():
    parser = argparse.ArgumentParser(description='구매관리 SQLite 읽기 전용 조회')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--table', choices=TABLES)
    group.add_argument('--sql', type=Path, help='db/queries/ 기준 SQL 파일명 또는 절대 경로')
    args = parser.parse_args()
    if not DATABASE.is_file():
        parser.error(f'DB 파일을 찾을 수 없습니다: {DATABASE}')
    with sqlite3.connect(DATABASE.as_uri() + '?mode=ro', uri=True) as connection:
        connection.execute('PRAGMA query_only = ON')
        allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE}
        connection.set_authorizer(lambda action, _a, _b, _db, _source: sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY)
        print(f'DB: {DATABASE.name} / 읽기 전용\n')
        if args.table:
            print(TABLES[args.table])
            show(connection.execute(f'SELECT * FROM {args.table} ORDER BY 1'))
        elif args.sql:
            sql_file = args.sql if args.sql.is_absolute() else QUERIES_DIR / args.sql
            for index, sql in enumerate(statements(sql_file.read_text(encoding='utf-8-sig')), 1):
                print(f'조회 {index}')
                show(connection.execute(sql))
        else:
            print('테이블별 저장 건수')
            total = 0
            for table, label in list(TABLES.items())[:6]:
                count = connection.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                total += count
                print(f'  {table:<15} {label}: {count}건')
            print(f'  총 {total}건\n')
            print('협력사별 계산된 C 값')
            show(connection.execute('SELECT supplier_id, name, c_score, order_count FROM v_supplier_summary ORDER BY supplier_id'))
            print('발주 및 납품 수량 합계')
            show(connection.execute('SELECT SUM(quantity) AS ordered, SUM(delivered_quantity) AS delivered, SUM(remaining_quantity) AS remaining FROM v_order_status'))
            print('기준일 2026-10-23 이전 예상일 경과 및 잔량 발주')
            show(connection.execute("SELECT order_id, supplier_name, part_name, remaining_quantity, expected_date FROM v_order_status WHERE expected_date < '2026-10-23' AND remaining_quantity > 0 ORDER BY order_id"))

if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    try:
        main()
    except (OSError, sqlite3.Error) as error:
        print(f'조회 오류: {error}', file=sys.stderr)
        raise SystemExit(1)
