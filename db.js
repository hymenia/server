const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://hymenia:hymenia@localhost:5432/hymenia',
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
});

async function ensureDb() {
  const migrations = [{
    name: '001_schema.sql',
    filePath: path.join(__dirname, 'schema.sql')
  }];
  const migrationsPath = path.join(__dirname, 'migrations');

  if (fs.existsSync(migrationsPath)) {
    const additionalMigrations = fs.readdirSync(migrationsPath)
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
      .map((name) => ({ name, filePath: path.join(migrationsPath, name) }));
    migrations.push(...additionalMigrations);
  }

  migrations.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));

  const duplicateNames = migrations
    .map((migration) => migration.name)
    .filter((name, index, names) => names.indexOf(name) !== index);
  if (duplicateNames.length > 0) {
    throw new Error(`duplicate database migration names: ${duplicateNames.join(', ')}`);
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', ['hymenia-schema-migrations']);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const appliedResult = await client.query('select name, checksum from schema_migrations');
    const applied = new Map(appliedResult.rows.map((row) => [row.name, row.checksum]));

    for (const migration of migrations) {
      if (!fs.existsSync(migration.filePath)) {
        throw new Error(`database migration not found: ${migration.filePath}`);
      }

      const sql = fs.readFileSync(migration.filePath, 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const previousChecksum = applied.get(migration.name);

      if (previousChecksum) {
        if (previousChecksum !== checksum) {
          throw new Error(`applied database migration was modified: ${migration.name}`);
        }
        continue;
      }

      console.log('[db] applying migration %s', migration.name);
      await client.query(sql);
      await client.query(
        'insert into schema_migrations (name, checksum) values ($1, $2)',
        [migration.name, checksum]
      );
    }

    await client.query('commit');
    console.log('[db] database migrations are up to date');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    console.error('[db] database migration failed:', error.code || 'unknown', error.message);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, ensureDb };
