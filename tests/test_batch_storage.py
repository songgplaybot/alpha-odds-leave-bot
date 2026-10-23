import os
import tempfile
import unittest
from unittest.mock import patch

import storage


class BatchStorage(unittest.TestCase):
    def test_mixed_results_commit_without_touching_resolved_records(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = {key: value for key, value in os.environ.items()
                           if key not in ('DATABASE_URL', 'RENDER', 'RENDER_EXTERNAL_URL')}
            environment['SQLITE_PATH'] = directory + '/test.db'
            with patch.dict(os.environ, environment, clear=True):
                storage.init_db()
                with storage.connection() as (conn, _):
                    conn.executemany('INSERT INTO join_requests(user_id,status,approved_at) VALUES (?,?,?)',
                                     [(1, 'pending', None), (2, 'pending', None), (3, 'pending', None),
                                      (4, 'approved', 'original')])
                storage.mark_request_results([(1, 'approved'), (2, 'already_inside'), (3, 'resolved'), (4, 'resolved')])
                with storage.connection() as (conn, _):
                    rows = conn.execute('SELECT user_id,status,approved_at FROM join_requests ORDER BY user_id').fetchall()
                self.assertEqual([r[1] for r in rows], ['approved', 'approved', 'resolved', 'approved'])
                self.assertTrue(rows[0][2])
                self.assertTrue(rows[1][2])
                self.assertIsNone(rows[2][2])
                self.assertEqual(rows[3][2], 'original')
                with self.assertRaises(ValueError):
                    storage.mark_request_results([(1, 'failed')])

if __name__ == '__main__':
    unittest.main()
