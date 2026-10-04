"""Durable PostgreSQL storage, with SQLite only for local development."""
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')


_pool = None
_pool_lock = threading.Lock()


def postgres_pool(url):
    global _pool
    with _pool_lock:
        if _pool is None:
            from psycopg_pool import ConnectionPool
            _pool = ConnectionPool(
                url, min_size=1, max_size=4, timeout=12,
                kwargs={"sslmode": "require", "connect_timeout": 10,
                        "options": "-c statement_timeout=15000", "prepare_threshold": None},
                check=ConnectionPool.check_connection,
            )
    return _pool


@contextmanager
def connection():
    url = os.getenv('DATABASE_URL', '').strip()
    if url:
        # Connection errors never fall back to temporary storage.
        with postgres_pool(url).connection() as conn:
            yield conn, '%s'
        return
    if os.getenv('RENDER') or os.getenv('RENDER_EXTERNAL_URL'):
        raise RuntimeError('DATABASE_URL must be configured on Render before deployment.')
    conn = sqlite3.connect(os.getenv('SQLITE_PATH', 'alpha_odds_bot.db'))
    try:
        yield conn, '?'
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def execute(conn, placeholder, sql, parameters=()):
    # All SQL is authored here; user input is passed separately as parameters.
    return conn.execute(sql.replace('?', placeholder), parameters)


def init_db():
    with connection() as (conn, placeholder):
        conn.execute('''CREATE TABLE IF NOT EXISTS users (
            user_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT,
            last_name TEXT, started_bot INTEGER DEFAULT 1, created_at TEXT)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS join_requests (
            user_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT,
            last_name TEXT, user_chat_id BIGINT, status TEXT DEFAULT 'pending',
            requested_at TEXT, approved_at TEXT)''')
        conn.execute('CREATE INDEX IF NOT EXISTS join_requests_pending_idx ON join_requests(status, requested_at)')
        if placeholder == '%s':
            # These tables contain private bot records, not public API data.
            conn.execute('ALTER TABLE users ENABLE ROW LEVEL SECURITY')
            conn.execute('ALTER TABLE join_requests ENABLE ROW LEVEL SECURITY')
            # Supabase API roles do not exist on other PostgreSQL providers.
            for role in ('anon', 'authenticated'):
                if conn.execute(
                    'SELECT 1 FROM pg_roles WHERE rolname = %s', (role,)
                ).fetchone():
                    conn.execute(f'REVOKE ALL ON users, join_requests FROM {role}')


def save_user(user):
    with connection() as (conn, ph):
        execute(conn, ph, '''INSERT INTO users
            (user_id, username, first_name, last_name, started_bot, created_at)
            VALUES (?, ?, ?, ?, 1, ?)
            ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,
            first_name=excluded.first_name, last_name=excluded.last_name, started_bot=1''',
            (user.id, user.username, user.first_name, user.last_name, now()))


def save_join_request(user, user_chat_id):
    with connection() as (conn, ph):
        execute(conn, ph, '''INSERT INTO join_requests
            (user_id, username, first_name, last_name, user_chat_id, status, requested_at, approved_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)
            ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,
            first_name=excluded.first_name, last_name=excluded.last_name,
            user_chat_id=excluded.user_chat_id, status='pending',
            requested_at=excluded.requested_at, approved_at=NULL''',
            (user.id, user.username, user.first_name, user.last_name, user_chat_id, now()))


def get_pending_requests():
    with connection() as (conn, ph):
        return conn.execute('''SELECT jr.user_id, jr.username, jr.first_name, jr.last_name,
            CASE WHEN u.started_bot=1 THEN 1 ELSE 0 END
            FROM join_requests jr LEFT JOIN users u ON jr.user_id=u.user_id
            WHERE jr.status='pending' ORDER BY jr.requested_at, jr.user_id''').fetchall()


def get_started_pending_requests():
    with connection() as (conn, ph):
        return conn.execute('''SELECT jr.user_id, jr.username, jr.first_name, jr.last_name
            FROM join_requests jr INNER JOIN users u ON jr.user_id=u.user_id
            WHERE jr.status='pending' AND u.started_bot=1
            ORDER BY jr.requested_at, jr.user_id''').fetchall()


def mark_request_approved(user_id):
    with connection() as (conn, ph):
        execute(conn, ph, '''UPDATE join_requests SET status='approved', approved_at=?
            WHERE user_id=? AND status='pending' ''', (now(), user_id))


def mark_request_resolved(user_id, status):
    with connection() as (conn, ph):
        execute(conn, ph, "UPDATE join_requests SET status=? WHERE user_id=? AND status='pending'",
                (status, user_id))
