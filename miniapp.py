"""Authenticated Telegram admin Mini App and webhook on the bot's existing port."""
import asyncio
import hashlib
import hmac
import json
import signal
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qsl

from telegram import Update
from tornado.httpserver import HTTPServer
from tornado.web import Application, RequestHandler, HTTPError


def validate_admin(data, token, admin_id):
    if not isinstance(data, str) or len(data) > 16384:
        raise ValueError('Invalid session')
    pairs = parse_qsl(data, keep_blank_values=True, strict_parsing=True)
    values = dict(pairs)
    if len(values) != len(pairs):
        raise ValueError('Duplicate fields')
    signature = values.pop('hash', '')
    secret = hmac.new(b'WebAppData', token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, '\n'.join(f'{k}={v}' for k, v in sorted(values.items())).encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise ValueError('Invalid signature')
    age = time.time() - int(values['auth_date'])
    if age < -30 or age > 3600 or json.loads(values['user'])['id'] != admin_id:
        raise ValueError('Unauthorized or expired session')


def create_server(bot_app, token, admin_id, webhook_path, pending, approve):
    secret = hashlib.sha256(('miniapp-webhook:' + token).encode()).hexdigest()
    job = {'running': False, 'result': ''}

    class Page(RequestHandler):
        def get(self):
            self.set_header('Content-Type', 'text/html; charset=utf-8')
            self.set_header('Cache-Control', 'no-store')
            self.finish(Path(__file__).with_name('miniapp.html').read_text())

    class Health(RequestHandler):
        def get(self):
            self.finish({'status': 'ok'})

    class Admin(RequestHandler):
        async def post(self, action):
            self.set_header('Cache-Control', 'no-store')
            try:
                validate_admin(self.request.headers.get('X-Telegram-Init-Data', ''), token, admin_id)
            except (ValueError, KeyError, TypeError):
                raise HTTPError(403)
            if action not in ('state', 'all', 'started'):
                raise HTTPError(404)
            try:
                rows = await pending()
                if action != 'state' and not job['running']:
                    selected = rows if action == 'all' else [row for row in rows if row[4]]
                    job.update(running=True, result='')
                    async def run():
                        try:
                            job['result'] = await approve(SimpleNamespace(bot=bot_app.bot), selected, 'Approval')
                        except Exception:
                            job['result'] = 'Approval interrupted. Refresh and retry the remaining requests.'
                        finally:
                            job['running'] = False
                    bot_app.create_task(run())
                self.finish({'adminId': admin_id, 'total': len(rows), 'started': sum(bool(r[4]) for r in rows),
                             'requests': [{'id': r[0], 'name': ' '.join(n for n in r[2:4] if n) or str(r[0]),
                                           'username': r[1], 'started': bool(r[4])} for r in rows], 'job': dict(job)})
            except Exception:
                raise HTTPError(503, reason='Storage temporarily unavailable')

    class Webhook(RequestHandler):
        async def post(self):
            if not hmac.compare_digest(self.request.headers.get('X-Telegram-Bot-Api-Secret-Token', ''), secret):
                raise HTTPError(403)
            try:
                update = Update.de_json(json.loads(self.request.body), bot_app.bot)
            except (ValueError, TypeError, KeyError):
                raise HTTPError(400)
            await bot_app.update_queue.put(update)
            self.finish('ok')

    return Application([(r'/', Health), (r'/admin', Page), (r'/api/admin/(state|all|started)', Admin),
                        ('/' + webhook_path.strip('/'), Webhook)], debug=False), secret


async def run_server(bot_app, token, admin_id, base_url, path, port, pending, approve):
    web, secret = create_server(bot_app, token, admin_id, path, pending, approve)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    async with bot_app:
        await bot_app.post_init(bot_app)
        await bot_app.start()
        server = HTTPServer(web, max_body_size=1024 * 1024)
        server.listen(port, address='0.0.0.0')
        try:
            await bot_app.bot.set_webhook(url=base_url.rstrip('/') + '/' + path.strip('/'),
                                         secret_token=secret, allowed_updates=Update.ALL_TYPES)
            await stop.wait()
        finally:
            server.stop()
            await server.close_all_connections()
            await bot_app.stop()
