const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://hymenia:hymenia@localhost:5432/hymenia',
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
});

async function ensureDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query(schema);
    console.log('[db] schema is up to date');
  } catch (error) {
    console.error('[db] schema setup failed:', error.code || 'unknown', error.message);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, ensureDb };
