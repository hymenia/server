const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://hymenia:hymenia@localhost:5432/hymenia',
  connectionTimeoutMillis: 5000
});

async function resetDb() {
  try {
    console.log('[reset-db] Truncating all tables...');
    await pool.query('TRUNCATE TABLE messages, chats, spaces, passkey_challenges, passkeys, users CASCADE;');
    console.log('[reset-db] All tables truncated successfully.');
    await pool.end();
    console.log('[reset-db] Reset complete.');
    process.exit(0);
  } catch (err) {
    console.error('[reset-db] Error resetting database:', err);
    await pool.end();
    process.exit(1);
  }
}

resetDb();

