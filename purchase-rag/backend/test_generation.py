import unittest
from unittest.mock import Mock, patch
import httpx
from fastapi.testclient import TestClient
from backend.app import app
from backend.generation import OllamaGenerator, GenerationError, MAX_PROMPT_BYTES
from backend.prompting import NO_EVIDENCE


def evidence():
    return {'question':'발주 1101 납품 수량?', 'evidence_status':'candidates_found',
            'retrieval_method':'structured_db', 'results':[
                {'chunk_id':'order-1101:db','parent_document_id':'order-1101',
                 'text':'발주 1101은 100개 중 40개 납품, 차이 60개.',
                 'source':{'source_refs':['orders:1101','delivery:2024']}}]}

def output(text='납품 수량은 40개입니다. [E1]', **kwargs):
    return {'model':'gemma3:4b','message':{'content':text},'done':True,
            'done_reason':'stop','prompt_eval_count':100,**kwargs}


class GenerationTest(unittest.TestCase):
    def generator(self, reply=None):
        g=OllamaGenerator()
        g.models=Mock(return_value={'models':[{'model':'gemma3:4b','installed':True,'digest':'test-digest'}]})
        g._request=Mock(return_value=reply if reply is not None else output())
        return g

    def test_answer_forwards_model_and_returns_referenced_sources(self):
        g=self.generator()
        result=g.answer(evidence(),'gemma3:4b')
        payload=g._request.call_args.args[2]
        self.assertEqual(payload['model'],'gemma3:4b')
        self.assertIn('100개 중 40개',payload['messages'][0]['content'])
        self.assertEqual(result['status'],'answered')
        self.assertEqual(result['sources'][0]['source']['source_refs'],['orders:1101','delivery:2024'])
        self.assertTrue(result['model_called'])

    def test_blocked_and_ambiguous_questions_do_not_call_ollama(self):
        for status in ['insufficient_evidence','clarification_required']:
            g=self.generator()
            data={**evidence(),'evidence_status':status,'message':'조회 날짜를 지정해 주세요.'}
            result=g.answer(data,'gemma3:4b')
            g.models.assert_not_called()
            g._request.assert_not_called()
            self.assertFalse(result['model_called'])
            self.assertEqual(result['answer'],data['message'] if status=='clarification_required' else NO_EVIDENCE)

    def test_context_limit_does_not_silently_truncate(self):
        g=self.generator()
        data=evidence();data['results'][0]['text']='가'*MAX_PROMPT_BYTES
        result=g.answer(data,'gemma3:4b')
        self.assertEqual(result['status'],'context_limit_exceeded')
        g._request.assert_not_called()

    def test_missing_invalid_citations_and_model_abstention(self):
        for text in ['40개입니다.','40개입니다. [E99]']:
            result=self.generator(output(text)).answer(evidence(),'gemma3:4b')
            self.assertEqual(result['status'],'invalid_generation')
            self.assertIsNone(result['answer'])
            self.assertTrue(result['model_called'])
        for text in [NO_EVIDENCE, '[E1] '+NO_EVIDENCE]:
            result=self.generator(output(text)).answer(evidence(),'gemma3:4b')
            self.assertEqual(result['status'],'insufficient_evidence')
            self.assertEqual(result['answer'],NO_EVIDENCE)

    def test_empty_incomplete_wrong_model_responses_are_errors(self):
        for reply in [output(''),output(done=False),output(done_reason='length'),output(model='qwen3:8b'),
                      output(prompt_eval_count=8000), output(message=None),
                      output(prompt_eval_count=None),output(prompt_eval_count='100'),
                      output(prompt_eval_count=-1),output(prompt_eval_count=True)]:
            with self.assertRaises(GenerationError) as raised:
                self.generator(reply).answer(evidence(),'gemma3:4b')
            self.assertEqual(raised.exception.status_code,502)

    def test_missing_model_is_not_downloaded(self):
        g=self.generator();g.models.return_value['models'][0]['installed']=False
        with self.assertRaises(GenerationError) as raised:g.answer(evidence(),'gemma3:4b')
        self.assertEqual(raised.exception.status_code,503)
        g._request.assert_not_called()

    def test_api_model_is_required_and_never_becomes_a_search_filter(self):
        svc=Mock();svc.search.return_value=evidence()
        g=self.generator()
        with patch('backend.app.service',return_value=svc),patch('backend.app.generator',return_value=g),TestClient(app) as api:
            self.assertEqual(api.post('/answer',json={'question':'질문'}).status_code,422)
            self.assertEqual(api.post('/answer',json={'question':'질문','model':'qwen3:14b'}).status_code,422)
            result=api.post('/answer',json={'question':'발주 1101 납품 수량?','model':'gemma3:4b','order_id':1101})
            self.assertEqual(result.status_code,200)
            svc.search.assert_called_once_with('발주 1101 납품 수량?',3,{'order_id':1101})
            g.answer=Mock(side_effect=GenerationError(504,'시간 초과',True))
            self.assertEqual(api.post('/answer',json={'question':'질문','model':'gemma3:4b'}).status_code,504)

    def test_transport_and_malformed_json_errors(self):
        g=OllamaGenerator()
        for error,expected in [(httpx.ConnectError('refused'),503),(httpx.ReadTimeout('timeout'),504)]:
            with patch('backend.generation.httpx.Client') as client:
                client.return_value.__enter__.return_value.request.side_effect=error
                with self.assertRaises(GenerationError) as raised:g._request('POST','/api/chat',{},True)
                self.assertEqual(raised.exception.status_code,expected)
        with patch('backend.generation.httpx.Client') as client:
            client.return_value.__enter__.return_value.request.return_value=httpx.Response(200,text='not json')
            with self.assertRaises(GenerationError) as raised:g._request('GET','/api/tags')
            self.assertEqual(raised.exception.status_code,502)
        for code,body,expected in [(404,{},503),(500,{},502),(200,{'error':'failed'},502)]:
            with patch('backend.generation.httpx.Client') as client:
                client.return_value.__enter__.return_value.request.return_value=httpx.Response(code,json=body)
                with self.assertRaises(GenerationError) as raised:g._request('POST','/api/chat',{},True)
                self.assertEqual(raised.exception.status_code,expected)


if __name__=='__main__':unittest.main()
