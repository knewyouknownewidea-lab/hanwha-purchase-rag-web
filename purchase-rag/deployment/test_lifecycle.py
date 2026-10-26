"""프로세스 시작/종료를 모의 객체로 대체하는 안전 검사. 실행 중인 서비스에 접근하지 않습니다."""
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from . import lifecycle as life


def process(pid, kind='gateway', parent=0):
    proc = Mock()
    proc.pid = pid
    proc.ppid.return_value = parent
    proc.create_time.return_value = float(pid)
    proc.children.return_value = []
    if kind == 'tunnel':
        proc.exe.return_value = str(life.CLOUDFLARED)
        proc.cwd.return_value = str(life.ROOT)
        proc.cmdline.return_value = [str(life.CLOUDFLARED), *life.TUNNEL_ARGS]
    else:
        module = 'deployment' if kind == 'gateway' else 'backend'
        proc.exe.return_value = str(life.PYTHON)
        proc.cwd.return_value = str(life.OUTPUTS)
        proc.cmdline.return_value = [str(life.PYTHON), '-m', module]
    return proc


class LifecycleTest(unittest.TestCase):
    def test_owned_requires_executable_arguments_and_cwd(self):
        proc = process(11)
        self.assertTrue(life.owned(proc, 'gateway'))
        proc.cwd.return_value = str(life.ROOT)
        self.assertFalse(life.owned(proc, 'gateway'))
        proc = process(11)
        proc.exe.return_value = 'C:/Windows/python.exe'
        self.assertFalse(life.owned(proc, 'gateway'))
        proc = process(11)
        proc.cmdline.return_value += ['--arbitrary']
        self.assertFalse(life.owned(proc, 'gateway'))
        proc = process(12, 'tunnel')
        self.assertTrue(life.owned(proc, 'tunnel'))
        proc.cmdline.return_value[3] = 'http://127.0.0.1:11434'
        self.assertFalse(life.owned(proc, 'tunnel'))

    def test_foreign_or_nonloopback_listener_is_not_reused(self):
        listener = SimpleNamespace(status=life.psutil.CONN_LISTEN,
                                   laddr=SimpleNamespace(port=8010, ip='0.0.0.0'), pid=11)
        with patch.object(life.psutil, 'net_connections', return_value=[listener]):
            with self.assertRaises(RuntimeError):
                life.check_listener(8010, 'gateway')
        listener.laddr.ip = '127.0.0.1'
        proc = process(11, 'backend')
        with patch.object(life.psutil, 'net_connections', return_value=[listener]), \
                patch.object(life.psutil, 'Process', return_value=proc):
            with self.assertRaises(RuntimeError):
                life.check_listener(8010, 'gateway')

    def test_stop_refuses_unrelated_child_before_termination(self):
        parent = process(11)
        child = process(12, 'backend', parent=11)
        parent.children.return_value = [child]
        with patch.object(life, 'owned_processes', return_value=[parent]):
            with self.assertRaises(RuntimeError):
                life.stop_kind('gateway')
        parent.terminate.assert_not_called()
        child.terminate.assert_not_called()

    def test_stop_checks_tree_then_terminates_only_its_verified_processes(self):
        parent, child = process(11), process(12, parent=11)
        parent.children.return_value = [child]
        with patch.object(life, 'owned_processes', return_value=[parent, child]), \
                patch.object(life.psutil, 'wait_procs', return_value=([parent, child], [])):
            life.stop_kind('gateway')
        parent.terminate.assert_called_once()
        child.terminate.assert_called_once()
        parent.kill.assert_not_called()
        child.kill.assert_not_called()

    def test_stop_does_not_manage_backend_or_ollama_and_preserves_nonsecret_origin(self):
        with patch.object(life, 'stop_kind') as stop_kind, \
                patch.object(life, 'load_status', return_value={'origin': 'https://example.trycloudflare.com'}), \
                patch.object(life, 'write_status') as write_status, patch('builtins.print'):
            life.stop()
        self.assertEqual([x.args[0] for x in stop_kind.call_args_list], ['tunnel', 'gateway'])
        state = write_status.call_args.args[0]
        self.assertEqual(state['status'], 'stopped')
        self.assertEqual(state['origin'], 'https://example.trycloudflare.com')
        self.assertNotIn('token', state)

    def test_checked_paths_and_token_removal(self):
        self.assertEqual(life.checked_path(life.RUNTIME), life.RUNTIME.resolve())
        for target in (life.ROOT, life.ROOT.parent, Path('C:/Windows')):
            with self.assertRaises(RuntimeError):
                life.checked_path(target)
        with patch.dict(life.os.environ, {'RAG_GATEWAY_TOKEN': 'not-to-be-forwarded'}):
            self.assertNotIn('RAG_GATEWAY_TOKEN', life.without_token())

    def test_start_reuses_running_owned_services_without_spawning(self):
        tunnel, gateway = process(35, 'tunnel'), process(77)
        origin = 'https://example.trycloudflare.com'
        with patch.dict(life.os.environ, {'RAG_GATEWAY_TOKEN': 'x' * 40}), \
                patch.object(Path, 'is_file', return_value=True), \
                patch.object(life, 'load_deployment', return_value={'status': 'succeeded', 'published_origin': origin}), \
                patch.object(life, 'check_listener', return_value=True), \
                patch.object(life, 'wait_health'), \
                patch.object(life, 'owned_processes', side_effect=lambda kind: [tunnel] if kind == 'tunnel' else [gateway]), \
                patch.object(life, 'last_origin', return_value=origin), \
                patch.object(life, 'spawn') as spawn, \
                patch.object(life.subprocess, 'run') as run, \
                patch.object(life, 'write_status') as write_status, patch('builtins.print'):
            life.start()
        spawn.assert_not_called()
        run.assert_not_called()
        self.assertFalse(write_status.call_args.args[0]['origin_changed'])
        self.assertEqual(write_status.call_args.args[0]['gateway_pids'], [77])

    def test_new_tunnel_with_same_published_origin_does_not_require_update(self):
        tunnel, gateway = process(35, 'tunnel'), process(77)
        origin = 'https://example.trycloudflare.com'
        tunnel_checks = [0]
        def processes(kind):
            if kind != 'tunnel':
                return [gateway]
            tunnel_checks[0] += 1
            return [] if tunnel_checks[0] == 1 else [tunnel]
        with patch.dict(life.os.environ, {'RAG_GATEWAY_TOKEN': 'x' * 40}), \
                patch.object(Path, 'is_file', return_value=True), \
                patch.object(life, 'load_deployment', return_value={'status': 'succeeded', 'published_origin': origin}), \
                patch.object(life, 'check_listener', return_value=True), \
                patch.object(life, 'wait_health'), \
                patch.object(life, 'owned_processes', side_effect=processes), \
                patch.object(life, 'last_origin', return_value=origin), \
                patch.object(life, 'spawn') as spawn, \
                patch.object(life, 'write_status') as write_status, patch('builtins.print') as output:
            life.start()
        spawn.assert_called_once()
        self.assertNotIn('RAG_GATEWAY_TOKEN', spawn.call_args.args[3])
        self.assertFalse(write_status.call_args.args[0]['needs_sites_origin_update'])
        self.assertFalse(any('RAG_ORIGIN' in str(call.args) for call in output.call_args_list))

    def test_origin_update_unknown_matching_and_mismatching_published_records(self):
        origin = 'https://current.trycloudflare.com'
        for record in (None, {}, {'status': 'pending', 'published_origin': origin},
                       {'status': 'succeeded'}, {'status': 'succeeded', 'published_origin': 3},
                       {'status': 'succeeded', 'published_origin': 'http://unsafe.invalid'},
                       {'status': 'succeeded', 'published_origin': 'https://old.trycloudflare.com'}):
            with self.subTest(record=record):
                self.assertTrue(life.needs_origin_update(origin, record))
        self.assertFalse(life.needs_origin_update(origin, {'status': 'succeeded', 'published_origin': origin}))

    def test_warning_survives_repeated_observations_until_success_record_changes(self):
        tunnel, gateway = process(35, 'tunnel'), process(77)
        origin = 'https://current.trycloudflare.com'
        published = {'status': 'succeeded', 'published_origin': 'https://old.trycloudflare.com'}
        observed = {'origin': origin, 'origin_changed': False}
        with patch.dict(life.os.environ, {'RAG_GATEWAY_TOKEN': 'x' * 40}), \
                patch.object(Path, 'is_file', return_value=True), \
                patch.object(life, 'load_status', return_value=observed) as load_observed, \
                patch.object(life, 'load_deployment', return_value=published), \
                patch.object(life, 'check_listener', return_value=True), \
                patch.object(life, 'wait_health'), \
                patch.object(life, 'owned_processes', side_effect=lambda kind: [tunnel] if kind == 'tunnel' else [gateway]), \
                patch.object(life, 'last_origin', return_value=origin), \
                patch.object(life, 'spawn') as spawn, \
                patch.object(life, 'write_status') as write_status, patch('builtins.print') as output:
            for _ in range(3):
                life.start()
                self.assertTrue(write_status.call_args.args[0]['needs_sites_origin_update'])
            # 관측 상태가 같거나 경고가 false였어도 성공 배포 기록이 바뀌기 전까지 해제하지 않습니다.
            self.assertEqual(sum('RAG_ORIGIN' in str(call.args) for call in output.call_args_list), 3)
            published['published_origin'] = origin
            life.start()
            self.assertFalse(write_status.call_args.args[0]['needs_sites_origin_update'])
        load_observed.assert_not_called()
        spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
