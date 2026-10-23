import asyncio
import hashlib
import hmac
import json
import time
import unittest
from types import SimpleNamespace
from urllib.parse import urlencode
from unittest.mock import patch, AsyncMock

from tornado.testing import AsyncHTTPTestCase
import miniapp
import main


def signed(user=42, age=0):
    fields = {'auth_date': str(int(time.time()) - age), 'user': json.dumps({'id': user})}
    secret = hmac.new(b'WebAppData', b'test-token', hashlib.sha256).digest()
    fields['hash'] = hmac.new(secret, '\n'.join(f'{k}={v}' for k,v in sorted(fields.items())).encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


class Authentication(unittest.TestCase):
    def test_valid_and_rejected_sessions(self):
        miniapp.validate_admin(signed(), 'test-token', 42)
        for data in (signed(43), signed(age=3601), signed(age=-60), signed()+'&user=x', signed().replace('hash=', 'hash=0')):
            with self.assertRaises(ValueError):
                miniapp.validate_admin(data, 'test-token', 42)


class Server(AsyncHTTPTestCase):
    def get_app(self):
        self.calls = []
        self.storage_down = False
        async def pending():
            if self.storage_down:
                raise RuntimeError('private database diagnostics')
            return [(1, 'name', 'User', None, 1), (2, None, 'Other', None, 0)]
        async def approve(context, rows, title):
            self.calls.append(rows)
            await asyncio.sleep(.05)
            return 'Done'
        self.bot_app = SimpleNamespace(bot=None, update_queue=asyncio.Queue(), create_task=asyncio.create_task)
        web, self.secret = miniapp.create_server(self.bot_app, 'test-token', 42, 'hook', pending, approve)
        return web

    def test_auth_and_page(self):
        self.assertEqual(self.fetch('/admin').code, 200)
        self.assertEqual(self.fetch('/api/admin/state', method='POST', body='').code, 403)
        response = self.fetch('/api/admin/state', method='POST', body='', headers={'X-Telegram-Init-Data': signed()})
        self.assertEqual(json.loads(response.body)['started'], 1)
        self.assertEqual(self.fetch('/hook', method='POST', body='{}').code, 403)
        self.assertEqual(self.fetch('/hook', method='POST', body='{"update_id":1}', headers={'X-Telegram-Bot-Api-Secret-Token': self.secret}).code, 200)
        self.assertEqual(self.bot_app.update_queue.qsize(), 1)

    def test_storage_failure_returns_actionable_json(self):
        self.storage_down = True
        response = self.fetch('/api/admin/state', method='POST', body='',
                              headers={'X-Telegram-Init-Data': signed()})
        self.assertEqual(response.code, 503)
        self.assertIn('database is unavailable', json.loads(response.body)['error'])
        self.assertNotIn('private database diagnostics', response.body.decode())

    def test_duplicate_approval_and_filter(self):
        headers={'X-Telegram-Init-Data': signed()}
        self.fetch('/api/admin/started', method='POST', body='', headers=headers)
        self.fetch('/api/admin/all', method='POST', body='', headers=headers)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual([r[0] for r in self.calls[0]], [1])
        self.io_loop.run_sync(lambda: asyncio.sleep(.06))


class Refresh(unittest.IsolatedAsyncioTestCase):
    async def test_storage_failure_replies_instead_of_crashing(self):
        with patch.object(main, 'get_pending_requests', AsyncMock(side_effect=RuntimeError('private details'))):
            message = await main.build_requests_message(None)
        self.assertIn('database is unavailable', message)
        self.assertNotIn('private details', message)

    async def test_unchanged_inline_refresh_has_visible_confirmation(self):
        query = SimpleNamespace(from_user=SimpleNamespace(id=main.ADMIN_ID), data='admin_requests',
                                answer=AsyncMock(), edit_message_text=AsyncMock(side_effect=main.BadRequest('Message is not modified')),
                                message=SimpleNamespace(reply_text=AsyncMock()))
        with patch.object(main, 'get_pending_requests', AsyncMock(return_value=[])):
            await main.admin_button_handler(SimpleNamespace(callback_query=query), None)
        query.answer.assert_awaited_once_with('Refreshing request list…')
        query.message.reply_text.assert_awaited_once_with('✅ Request list is up to date.')
        self.assertIn('Refreshed:', query.edit_message_text.call_args.args[0])


class Approvals(unittest.IsolatedAsyncioTestCase):
    async def test_continuous_workers_and_bound(self):
        release = asyncio.Event()
        ninth_started = asyncio.Event()
        active = 0
        peak = 0
        async def approve(context, uid):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            if uid == 0:
                await release.wait()
            else:
                await asyncio.sleep(.001)
            if uid == 8:
                ninth_started.set()
            active -= 1
            return 'approved'
        async def pending():
            return []
        with patch.object(main, 'approve_request_api', approve), patch.object(main, 'mark_request_results', AsyncMock()), patch.object(main, 'get_pending_requests', pending):
            task = asyncio.create_task(main._approve_request_rows(None, [(i,) for i in range(40)], 'Approval'))
            await asyncio.wait_for(ninth_started.wait(), 1)
            self.assertFalse(task.done())
            release.set()
            result = await task
        self.assertEqual(peak, 32)
        self.assertIn('Approved now: 40', result)

    async def test_sections_finish_in_order_and_progress(self):
        seen = []
        async def approve(context, uid):
            if uid >= 50:
                self.assertEqual(len([i for i in seen if i < 50]), 50)
            if uid >= 100:
                self.assertEqual(len([i for i in seen if i < 100]), 100)
            await asyncio.sleep(.001)
            seen.append(uid)
            return 'approved'
        async def pending(): return []
        writer = AsyncMock()
        with patch.object(main, 'approve_request_api', approve), patch.object(main, 'mark_request_results', writer), patch.object(main, 'get_pending_requests', pending):
            result = await main.approve_request_rows(None, [(i,) for i in range(123)], 'Approval')
        self.assertEqual([len(call.args[0]) for call in writer.call_args_list], [50, 50, 23])
        self.assertEqual(len(set(seen)), 123)
        progress = main.approval_progress()
        self.assertEqual((progress['section'], progress['sections'], progress['processed']), (3, 3, 123))
        self.assertFalse(progress['running'])
        self.assertIn('Approved now: 123', result)

    async def test_batch_commit_failure_keeps_outcomes_for_retry(self):
        async def pending(): return [(1,), (2,)]
        writer = AsyncMock(side_effect=RuntimeError('database unavailable'))
        with patch.object(main, 'approve_request_api', AsyncMock(return_value='approved')), \
             patch.object(main, 'mark_request_results', writer), patch.object(main, 'get_pending_requests', pending):
            result = await main.approve_request_rows(None, [(1,), (2,)], 'Approval')
        self.assertIn('Approved now: 0', result)
        self.assertIn('Failed (kept for retry): 2', result)
        self.assertIn('Saved pending remaining: 2', result)
        writer.assert_awaited_once()

    async def test_rate_limit_pauses_all_workers(self):
        starts = []
        async def approve(context, uid):
            starts.append((uid, asyncio.get_running_loop().time()))
            if len(starts) == 1:
                raise main.RetryAfter(.04)
            return 'approved'
        writer = AsyncMock()
        with patch.object(main, 'approve_request_api', approve), patch.object(main, 'mark_request_results', writer), \
             patch.object(main, 'get_pending_requests', AsyncMock(return_value=[])):
            result = await main.approve_request_rows(None, [(i,) for i in range(40)], 'Approval')
        self.assertTrue(all(t - starts[0][1] >= .035 for _, t in starts[1:]))
        self.assertIn('Approved now: 40', result)
        self.assertEqual(len(writer.call_args.args[0]), 40)

    async def test_retry_after_keeps_requests(self):
        calls = 0
        async def approve(context, uid):
            nonlocal calls
            calls += 1
            raise main.RetryAfter(0)
        async def pending():
            return [(1,)]
        with patch.object(main, 'approve_request_api', approve), patch.object(main, 'mark_request_results', AsyncMock()), patch.object(main, 'get_pending_requests', pending):
            result = await main._approve_request_rows(None, [(1,)], 'Approval')
        self.assertEqual(calls, 3)
        self.assertIn('Failed (kept for retry): 1', result)
        self.assertIn('Saved pending remaining: 1', result)

if __name__ == '__main__':
    unittest.main()
