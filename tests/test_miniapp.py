import asyncio
import hashlib
import hmac
import json
import time
import unittest
from types import SimpleNamespace
from urllib.parse import urlencode
from unittest.mock import patch

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
        async def pending():
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

    def test_duplicate_approval_and_filter(self):
        headers={'X-Telegram-Init-Data': signed()}
        self.fetch('/api/admin/started', method='POST', body='', headers=headers)
        self.fetch('/api/admin/all', method='POST', body='', headers=headers)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual([r[0] for r in self.calls[0]], [1])
        self.io_loop.run_sync(lambda: asyncio.sleep(.06))


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
        with patch.object(main, 'approve_one_request', approve), patch.object(main, 'get_pending_requests', pending):
            task = asyncio.create_task(main._approve_request_rows(None, [(i,) for i in range(20)], 'Approval'))
            await asyncio.wait_for(ninth_started.wait(), 1)
            self.assertFalse(task.done())
            release.set()
            result = await task
        self.assertLessEqual(peak, 8)
        self.assertIn('Approved now: 20', result)

    async def test_retry_after_keeps_requests(self):
        calls = 0
        async def approve(context, uid):
            nonlocal calls
            calls += 1
            raise main.RetryAfter(0)
        async def pending():
            return [(1,)]
        with patch.object(main, 'approve_one_request', approve), patch.object(main, 'get_pending_requests', pending):
            result = await main._approve_request_rows(None, [(1,)], 'Approval')
        self.assertEqual(calls, 3)
        self.assertIn('Failed (kept for retry): 1', result)
        self.assertIn('Saved pending remaining: 1', result)

if __name__ == '__main__':
    unittest.main()
