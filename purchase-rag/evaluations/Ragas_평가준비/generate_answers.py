"""승인된 30문항을 같은 프롬프트로 생성하고 백엔드 32문항을 따로 검사합니다."""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from project_paths import WORK_DIR, DATABASE, EVALUATIONS_DIR, REPORTS_DIR

import hashlib
import json
import time
import urllib.request

ROOT = Path(__file__).resolve().parent

def call(base, endpoint, data=None, timeout=1800):
    request = urllib.request.Request(base + endpoint,
        data=None if data is None else json.dumps(data, ensure_ascii=False).encode('utf8'),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)

def save(path, data):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf8')
    temp.replace(path)

def main():
    plan = json.loads((ROOT/'평가계획_검토용.json').read_text(encoding='utf8'))
    db = DATABASE
    assert hashlib.sha256(db.read_bytes()).hexdigest() == plan['source_db_sha256']
    ollama = 'http://127.0.0.1:11434'
    backend = 'http://127.0.0.1:8000'
    version = call(ollama, '/api/version')
    backend_rows = []
    for row in plan['rows']:
        if row['track'] == 'generation':
            continue
        r = call(backend, '/prepare-prompt', {'question': row['question']})
        backend_rows.append({'id': row['id'], 'question': row['question'],
            'expected_status': row['expected_status'], 'response': r,
            'pass': r['status'] == row['expected_status'] and not r['ready_for_generation']
                and not r['model_called'] and r['prompt'] is None
                and (row['track'] != 'backend_abstention' or r['message'] == row['reference'])})
    save(ROOT/'backend_checks.json', backend_rows)
    for model in plan['generators']:
        folder = ROOT/model.replace(':', '_')
        folder.mkdir(exist_ok=True)
        show = call(ollama, '/api/show', {'model': model})
        tags = call(ollama, '/api/tags')['models']
        identity = next(m for m in tags if m['name'] == model)
        save(folder/'model_metadata.json', {'version': version, 'model': identity, 'show': show})
        for row in plan['rows']:
            if row['track'] != 'generation':
                continue
            target = folder/(row['id']+'.json')
            if target.exists():
                continue
            progress = {'stage': 'generation', 'model': model, 'id': row['id']}
            save(ROOT/'run_progress.json', progress)
            print(f"Generating {model} {row['id']}", flush=True)
            request = {'model': model, 'messages': [{'role':'user', 'content':row['prompt']}],
                       'options': {**plan['options_proposed'], 'num_gpu':0, 'num_thread':4}, 'stream':False, 'keep_alive':'30m'}
            if model.startswith('qwen3'):
                request['think'] = False
            started = time.monotonic()
            response = call(ollama, '/api/chat', request)
            answer = response['message']['content']
            save(target, {**progress, 'question':row['question'], 'response':answer,
                          'reference':row['reference'], 'retrieved_contexts':row['retrieved_contexts'],
                          'sources':row['sources'], 'options':request['options'],
                          'prompt_sha256':hashlib.sha256(row['prompt'].encode()).hexdigest(),
                          'model_digest':identity['digest'], 'elapsed_seconds':time.monotonic()-started,
                          'truncated':response.get('done_reason') == 'length',
                          'input_budget_warning':response.get('prompt_eval_count',0) >= 7168,
                          'raw_response':response})
        call(ollama, '/api/generate', {'model':model, 'keep_alive':0})
    save(ROOT/'run_progress.json', {'stage':'generation_complete', 'count':90,
                                  'backend_passed':sum(r['pass'] for r in backend_rows), 'backend_total':len(backend_rows)})
    print('Generation complete; backend checks saved separately.', flush=True)

if __name__ == '__main__':
    main()
