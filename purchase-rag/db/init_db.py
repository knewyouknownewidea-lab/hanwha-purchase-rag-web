"""스키마·뷰·가상 데이터를 사용해 새 SQLite DB를 생성합니다."""

import argparse
import sqlite3
import sys
from pathlib import Path

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from project_paths import DB_DIR


def initialize(output: Path) -> None:
    """기존 파일을 덮어쓰지 않고 트랜잭션 안에서 새 DB를 구성합니다."""
    scripts = [
        (DB_DIR / name).read_text(encoding='utf-8-sig')
        for name in ('schema.sql', 'views.sql', 'seed.sql')
    ]
    # Exclusive creation also protects against another process creating the file
    # after a prior existence check. Only this newly created file may be removed.
    with output.open('xb'):
        pass
    connection = None
    try:
        connection = sqlite3.connect(output, isolation_level=None)
        connection.execute('PRAGMA foreign_keys = ON')
        connection.executescript('BEGIN IMMEDIATE;\n' + '\n'.join(scripts))
        violations = connection.execute('PRAGMA foreign_key_check').fetchall()
        if violations:
            raise sqlite3.IntegrityError(f'외래키 연결 오류: {violations}')
        connection.execute('COMMIT')
    except BaseException:
        if connection is not None:
            if connection.in_transaction:
                connection.rollback()
            connection.close()
        output.unlink(missing_ok=True)
        raise
    else:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description='새 구매관리 SQLite DB 생성 (기존 파일 덮어쓰기 금지)')
    parser.add_argument('--output', type=Path, required=True, help='존재하지 않는 새 DB 파일 경로')
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    if output.exists():
        parser.error(f'기존 파일은 덮어쓸 수 없습니다: {output}')
    if not output.parent.is_dir():
        parser.error(f'출력 폴더가 없습니다: {output.parent}')
    initialize(output)
    print(f'새 DB 생성 완료: {output}')


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    try:
        main()
    except (OSError, sqlite3.Error) as error:
        print(f'DB 생성 오류: {error}', file=sys.stderr)
        raise SystemExit(1)
