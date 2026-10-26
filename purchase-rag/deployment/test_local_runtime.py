"""실제 서비스·터널·실제 비밀 생성 없이 공개 실행기의 경계를 검증합니다."""
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from deployment import local_runtime as runtime

TEST_ONLY_TOKEN = 'test-only-runtime-not-a-real-secret-0123456789'


class LocalRuntimeTest(unittest.TestCase):
    def test_existing_dpapi_file_is_required_and_never_generated_or_replaced(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'gateway-token.dat'
            with self.assertRaises(RuntimeError):
                runtime.load_token(path)
            self.assertFalse(path.exists())
            path.write_text('01020304', encoding='ascii')
            with patch.object(runtime, 'decrypt_dpapi', return_value=TEST_ONLY_TOKEN) as decrypt:
                self.assertEqual(runtime.load_token(path), TEST_ONLY_TOKEN)
                decrypt.assert_called_once_with(bytes([1, 2, 3, 4]))
            self.assertEqual(path.read_text(), '01020304')
            with patch.object(runtime, 'decrypt_dpapi', return_value='short'):
                with self.assertRaises(RuntimeError) as error:
                    runtime.load_token(path)
                self.assertNotIn(TEST_ONLY_TOKEN, str(error.exception))

    def test_token_only_reaches_gateway_and_web_environment(self):
        with patch.dict(runtime.os.environ, {'RAG_GATEWAY_TOKEN': 'old-value', 'ANTHROPIC_API_KEY': 'test-private', 'PORT': '9999', 'TUNNEL_LOGLEVEL': 'debug', 'TUNNEL_URL': 'http://127.0.0.1:8000'}):
            for kind in ('gateway', 'web'):
                self.assertEqual(runtime.child_env(TEST_ONLY_TOKEN, kind)['RAG_GATEWAY_TOKEN'], TEST_ONLY_TOKEN)
            for kind in ('backend', 'tunnel'):
                env = runtime.child_env(TEST_ONLY_TOKEN, kind)
                self.assertNotIn('RAG_GATEWAY_TOKEN', env)
                self.assertNotIn('ANTHROPIC_API_KEY', env)
            self.assertEqual(runtime.child_env(TEST_ONLY_TOKEN, 'web')['RAG_ORIGIN'], 'http://127.0.0.1:8010')
            self.assertNotIn('TUNNEL_URL', runtime.child_env(TEST_ONLY_TOKEN, 'tunnel'))
            self.assertNotIn('TUNNEL_LOGLEVEL', runtime.child_env(TEST_ONLY_TOKEN, 'tunnel'))

    def test_only_authenticated_gateway_is_tunneled_and_node_is_loopback(self):
        with patch.object(runtime.shutil, 'which', return_value='C:/node.exe'):
            public = runtime.specs(True)
            local = runtime.specs(False)
        self.assertEqual([item[0] for item in public], ['backend', 'gateway', 'web', 'tunnel'])
        self.assertNotIn('ollama', [item[0] for item in public])
        self.assertNotIn('tunnel', [item[0] for item in local])
        tunnel = public[-1][1]
        self.assertEqual(tunnel[tunnel.index('--url') + 1], 'http://127.0.0.1:8010')
        self.assertNotIn(TEST_ONLY_TOKEN, json.dumps(public, default=str))
        self.assertIn("listen(5173, '127.0.0.1')", public[2][1][-1])
        self.assertNotIn('0.0.0.0', public[2][1][-1])

    def test_existing_listener_refuses_start_without_touching_process(self):
        listener = SimpleNamespace(status=runtime.psutil.CONN_LISTEN, laddr=SimpleNamespace(port=8010))
        with patch.object(runtime.psutil, 'net_connections', return_value=[listener]), patch.object(runtime.subprocess, 'Popen') as start:
            with self.assertRaises(RuntimeError):
                runtime.ensure_ports_free()
            start.assert_not_called()

    def test_official_digest_mismatch_blocks_tunnel_binary(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'cloudflared.exe'
            path.write_bytes(b'test-binary-only')
            with self.assertRaises(RuntimeError):
                runtime.verify_cloudflared(path)
            with patch.object(runtime, 'CLOUDFLARED_SHA256', hashlib.sha256(path.read_bytes()).hexdigest()):
                runtime.verify_cloudflared(path)

    def test_origin_parser_only_accepts_public_quick_tunnel_hostname(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'tunnel.log'
            path.write_text('http://127.0.0.1:8010 https://private.internal https://demo-public.trycloudflare.com', encoding='utf8')
            self.assertEqual(runtime.tunnel_origin(path), 'https://demo-public.trycloudflare.com')

    def test_check_validates_files_without_starting_or_stopping_services(self):
        with patch.object(runtime, 'load_token', return_value=TEST_ONLY_TOKEN), patch.object(runtime, 'specs'), patch.object(runtime, 'verify_cloudflared'), patch.object(runtime, 'run') as run:
            self.assertEqual(runtime.main(['--public', '--check']), 0)
            run.assert_not_called()

    def test_shutdown_refuses_foreign_descendant_before_any_termination(self):
        child = Mock(pid=123)
        child.poll.return_value = None
        root, foreign = Mock(), Mock()
        root.children.return_value = [foreign]
        foreign.exe.return_value = 'C:/unrelated.exe'
        with patch.object(runtime.psutil, 'Process', return_value=root):
            with self.assertRaises(RuntimeError):
                runtime.stop_children([(child, [str(Path(runtime.sys.executable)), '-m', 'backend'], runtime.RAG)])
        root.terminate.assert_not_called()
        foreign.terminate.assert_not_called()


if __name__ == '__main__':
    unittest.main()
