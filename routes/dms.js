const express = require('express');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `select c.id, c.created_at,
              u.id as user_id, u.username, u.display_name, u.avatar_url
       from chats c
       join dm_members me on me.chat_id = c.id and me.user_id = $1
       join dm_members other on other.chat_id = c.id and other.user_id <> $1
       join users u on u.id = other.user_id
       where c.type = 'dm'
       order by c.created_at desc`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (e) {
    console.error('failed to list dms', e);
    res.status(500).json({ error: 'failed to list dms' });
  }
});

// open the dm with a user, creating it if needed
router.post('/', authenticateToken, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');

    const target = await client.query(
      'select id, username, display_name, avatar_url from users where username = $1',
      [username]
    );
    const other = target.rows[0];
    if (!other) {
      await client.query('rollback');
      return res.status(404).json({ error: 'user not found' });
    }
    if (other.id === req.user.id) {
      await client.query('rollback');
      return res.status(400).json({ error: 'you cannot message yourself' });
    }

    const [a, b] = [req.user.id, other.id].sort();
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`dm:${a}:${b}`]);

    const existing = await client.query(
      `select c.id from chats c
       join dm_members m1 on m1.chat_id = c.id and m1.user_id = $1
       join dm_members m2 on m2.chat_id = c.id and m2.user_id = $2
       where c.type = 'dm'
       limit 1`,
      [a, b]
    );

    let chatId = existing.rows[0]?.id;
    const created = !chatId;
    if (created) {
      const insert = await client.query(
        "insert into chats (space_id, name, type) values (null, 'dm', 'dm') returning id"
      );
      chatId = insert.rows[0].id;
      await client.query(
        'insert into dm_members (chat_id, user_id) values ($1, $2), ($1, $3)',
        [chatId, a, b]
      );
    }

    await client.query('commit');
    res.status(created ? 201 : 200).json({ id: chatId, user: other });
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.error('failed to open dm', e);
    res.status(500).json({ error: 'failed to open dm' });
  } finally {
    client.release();
  }
});

module.exports = router;