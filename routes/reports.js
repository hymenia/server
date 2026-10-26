const express = require('express');
const { pool } = require('../db');
const {
  authenticateToken,
  blockApps,
  requireAdmin,
  canAccessChat,
  getSpaceMembership
} = require('../middleware/auth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_TYPES = new Set(['message', 'user', 'space']);
const REASONS = new Set([
  'spam',
  'harassment',
  'hate',
  'nsfw',
  'self_harm',
  'illegal',
  'impersonation',
  'other'
]);
const STATUSES = new Set(['open', 'resolved', 'dismissed']);
const MAX_REPORTS_PER_HOUR = 10;

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

const router = express.Router();

router.post('/', authenticateToken, blockApps, async (req, res) => {
  const targetType = req.body?.targetType;
  const targetId = req.body?.targetId;
  const reason = req.body?.reason;
  const details = typeof req.body?.details === 'string' ? req.body.details.trim().slice(0, 500) || null : null;

  if (!TARGET_TYPES.has(targetType)) return res.status(400).json({ error: 'invalid report target' });
  if (typeof targetId !== 'string' || !UUID_RE.test(targetId)) return res.status(400).json({ error: 'invalid target id' });
  if (!REASONS.has(reason)) return res.status(400).json({ error: 'pick a reason for the report' });

  try {
    const recent = await pool.query(
      "select count(*)::int as n from reports where reporter_id = $1 and created_at > now() - interval '1 hour'",
      [req.user.id]
    );
    if (recent.rows[0].n >= MAX_REPORTS_PER_HOUR) {
      return res.status(429).json({ error: 'you are sending reports too quickly, try again later' });
    }

    let reportedUserId = null;
    let snapshot = {};

    if (targetType === 'message') {
      const r = await pool.query('select * from messages where id = $1 and deleted_at is null', [targetId]);
      const m = r.rows[0];
      if (!m || !(await canAccessChat(m.chat_id, req.user.id))) {
        return res.status(404).json({ error: 'message not found' });
      }
      if (m.sender_id === req.user.id) {
        return res.status(400).json({ error: 'you cannot report your own message' });
      }
      reportedUserId = m.sender_id;
      snapshot = {
        content: String(m.content ?? '').slice(0, 2000),
        chatId: m.chat_id,
        sentAt: m.created_at
      };
    } else if (targetType === 'user') {
      const r = await pool.query('select id, username, display_name from users where id = $1', [targetId]);
      const u = r.rows[0];
      if (!u) return res.status(404).json({ error: 'user not found' });
      if (u.id === req.user.id) return res.status(400).json({ error: 'you cannot report yourself' });
      reportedUserId = u.id;
      snapshot = { username: u.username, displayName: u.display_name };
    } else {
      const r = await pool.query('select id, name, visibility, owner_id from spaces where id = $1', [targetId]);
      const s = r.rows[0];
      if (!s) return res.status(404).json({ error: 'space not found' });
      if (s.visibility !== 'public' && !(await getSpaceMembership(s.id, req.user.id))) {
        return res.status(404).json({ error: 'space not found' });
      }
      reportedUserId = s.owner_id;
      snapshot = { name: s.name };
    }

    // keeps the evidence even if the content is edited or deleted later
    await pool.query(
      `insert into reports (reporter_id, target_type, target_id, reported_user_id, reason, details, snapshot)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (reporter_id, target_type, target_id) where status = 'open' do nothing`,
      [req.user.id, targetType, targetId, reportedUserId, reason, details, JSON.stringify(snapshot)]
    );

    res.status(201).json({ message: 'report submitted' });
  } catch (e) {
    console.error('failed to create report', e);
    res.status(500).json({ error: 'failed to submit report' });
  }
});

const adminRouter = express.Router();

adminRouter.get('/', authenticateToken, requireAdmin, async (req, res) => {
  const status = typeof req.query.status === 'string' && (STATUSES.has(req.query.status) || req.query.status === 'all')
    ? req.query.status
    : 'open';
  const limit = parseInteger(req.query.limit, 50, 1, 100);
  const offset = parseInteger(req.query.offset, 0, 0, 1000000);

  try {
    const [rowsResult, totalResult, countsResult] = await Promise.all([
      pool.query(
        `select r.id, r.target_type, r.target_id, r.reason, r.details, r.snapshot, r.status,
                r.created_at, r.resolved_at,
                reporter.username as reporter_username,
                reported.id as reported_user_id,
                reported.username as reported_username,
                resolver.username as resolved_by_username
           from reports r
           left join users reporter on reporter.id = r.reporter_id
           left join users reported on reported.id = r.reported_user_id
           left join users resolver on resolver.id = r.resolved_by
          where ($1::text = 'all' or r.status = $1::text)
          order by r.created_at desc
          limit $2 offset $3`,
        [status, limit, offset]
      ),
      pool.query(
        "select count(*)::int as total from reports r where ($1::text = 'all' or r.status = $1::text)",
        [status]
      ),
      pool.query('select status, count(*)::int as n from reports group by status')
    ]);

    const counts = { open: 0, resolved: 0, dismissed: 0 };
    for (const row of countsResult.rows) counts[row.status] = row.n;

    res.json({
      reports: rowsResult.rows,
      total: totalResult.rows[0]?.total || 0,
      counts
    });
  } catch (e) {
    console.error('failed to load reports', e);
    res.status(500).json({ error: 'failed to load reports' });
  }
});

adminRouter.patch('/:reportId', authenticateToken, requireAdmin, async (req, res) => {
  const { reportId } = req.params;
  const status = req.body?.status;
  if (!UUID_RE.test(reportId)) return res.status(400).json({ error: 'invalid report id' });
  if (!STATUSES.has(status)) return res.status(400).json({ error: 'status must be open, resolved or dismissed' });

  try {
    const r = await pool.query(
      `update reports
          set status = $1::text,
              resolved_by = case when $1::text = 'open' then null else $2::uuid end,
              resolved_at = case when $1::text = 'open' then null else now() end
        where id = $3
        returning id, status, resolved_at`,
      [status, req.user.id, reportId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'report not found' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('failed to update report', e);
    res.status(500).json({ error: 'failed to update report' });
  }
});

module.exports = { router, adminRouter };