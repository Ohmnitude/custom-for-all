import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
const databasePath = join(dataDir, 'inquiries.sqlite');

if (!existsSync(databasePath)) {
  console.error(`No inquiry database found at ${databasePath}`);
  process.exit(1);
}

const limitArgument = Number.parseInt(process.argv[2] || '20', 10);
const limit = Number.isFinite(limitArgument) ? Math.min(Math.max(limitArgument, 1), 100) : 20;
const db = new DatabaseSync(databasePath, { readOnly: true });
const inquiries = db.prepare(`
  SELECT id, created_at, name, email, business, email_status, smtp_message_id, delivery_error
  FROM inquiries
  ORDER BY created_at DESC
  LIMIT ?
`).all(limit);

console.table(inquiries);
db.close();
