"""검색문서.jsonl을 세 라이브러리로 청킹합니다. DB/API는 사용하지 않습니다."""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from project_paths import ROOT, DOCUMENTS_DIR, CHUNKS_DIR, EVALUATIONS_DIR

import hashlib
import importlib.metadata
import json
import statistics
import time

from langchain_text_splitters import RecursiveCharacterTextSplitter
from llama_index.core.node_parser import SentenceSplitter
from chonkie import RecursiveChunker


def normalized(text):
    # 청커에 따라 경계의 공백을 제거하므로 내용 보존과 공백 보존을 구분합니다.
    return ''.join(text.split())

def main():
    CHUNKS_DIR.mkdir(parents=True, exist_ok=True)
    (EVALUATIONS_DIR / 'results').mkdir(parents=True, exist_ok=True)
    source = DOCUMENTS_DIR / '검색문서.jsonl'
    raw = source.read_bytes()
    docs = [json.loads(line) for line in raw.decode('utf-8-sig').splitlines() if line.strip()]
    result = {
        'input': source.name,
        'input_sha256': hashlib.sha256(raw).hexdigest(),
        'document_count': len(docs),
        'versions': {p: importlib.metadata.version(p) for p in
                     ['langchain-text-splitters', 'llama-index-core', 'chonkie']},
        'conditions': {'unit': 'Python 문자 수', 'overlap': 0, 'timing_repeats': 7,
                       'timing_excludes': '라이브러리 로딩, 초기화, 파일 저장',
                       '800': '현재 데이터용 기본 비교', '250': '분할 차이 확인용 실험'},
        'limitations': ['검색 정확도 평가가 아닙니다.',
                       '각 라이브러리의 분할 규칙은 서로 다릅니다.',
                       'metadata는 부모 문서 전체의 출처이며 개별 청크의 모든 사실을 뜻하지 않습니다.'],
        'results': []
    }
    for size in (800, 250):
        langchain = RecursiveCharacterTextSplitter(chunk_size=size, chunk_overlap=0, length_function=len)
        llamaindex = SentenceSplitter(chunk_size=size, chunk_overlap=0, tokenizer=list)
        chonkie = RecursiveChunker(tokenizer='character', chunk_size=size)
        splitters = {'langchain': langchain.split_text, 'llamaindex': llamaindex.split_text,
                     'chonkie': lambda text: [c.text for c in chonkie.chunk(text)]}
        for name, split in splitters.items():
            def run():
                return [split(doc['text']) for doc in docs]
            groups = run()  # 준비 실행
            times = []
            for _ in range(7):
                start = time.perf_counter()
                run()
                times.append((time.perf_counter() - start) * 1000)
            chunks = []
            content_ok = exact_ok = intact_lines = total_lines = 0
            for doc, texts in zip(docs, groups):
                content_ok += normalized(''.join(texts)) == normalized(doc['text'])
                exact_ok += ''.join(texts) == doc['text']
                lines = [line.strip() for line in doc['text'].splitlines() if line.strip()]
                total_lines += len(lines)
                intact_lines += sum(any(line in t for t in texts) for line in lines)
                for i, text in enumerate(texts):
                    chunks.append({'id': f"{doc['id']}:{name}:{size}:{i}",
                                   'parent_document_id': doc['id'], 'chunk_index': i,
                                   'chunk_count': len(texts), 'text': text,
                                   'metadata': dict(doc['metadata']),
                                   'metadata_scope': 'parent_document'})
            target = CHUNKS_DIR / f'청크_{name}_{size}.jsonl'
            target.write_text(''.join(json.dumps(c, ensure_ascii=False) + '\n' for c in chunks), encoding='utf-8')
            originals = {d['id']: d['metadata'] for d in docs}
            metadata_ok = all(c['metadata'] == originals[c['parent_document_id']] for c in chunks)
            row = {'library': name, 'chunk_size_chars': size, 'chunks': len(chunks),
                   'max_chunk_chars': max(len(c['text']) for c in chunks),
                   'content_preserved_documents': content_ok, 'exact_text_preserved_documents': exact_ok,
                   'whole_lines_preserved': intact_lines, 'total_lines': total_lines,
                   'parent_metadata_preserved': metadata_ok,
                   'median_ms': round(statistics.median(times), 3), 'file': target.name}
            result['results'].append(row)
            print(json.dumps(row, ensure_ascii=False))
            assert content_ok == len(docs), f'{name}: 공백 외 내용 유실 확인 필요'
            assert metadata_ok
            assert row['max_chunk_chars'] <= size
    assert source.read_bytes() == raw
    (EVALUATIONS_DIR / 'results' / '청킹_비교결과.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print('완료: 청크 파일 6개, 비교결과 JSON 1개. 원본 검색문서는 변경하지 않았습니다.')

if __name__ == '__main__':
    main()
