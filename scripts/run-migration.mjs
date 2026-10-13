import { readFileSync } from 'fs'
import pg from 'pg'

const sql = readFileSync('supabase/migrations/00001_schema.sql', 'utf-8')

const client = new pg.Client({
  host: '2a05:d018:10e0:3300:8e33:4021:3a5f:a6ad',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'Y73lINjGrZHeCCV1',
  ssl: { rejectUnauthorized: false }
})

try {
  await client.connect()
  console.log('Connected. Running migration...')
  await client.query(sql)
  console.log('Migration complete.')
} catch (err) {
  console.error('Migration failed:', err.message)
  process.exit(1)
} finally {
  await client.end()
}
