#!/usr/bin/env node
/**
 * CL2-G — Seed workspace_project_settings for the pulseboard workspace so
 * every Healix run skips the config UI ("config_auto_applied" phase fires).
 *
 * Usage:
 *   node scripts/seed-pulseboard-settings.mjs
 *
 * Reads:
 *   - webapp/.env.local for DATABASE_URL + HEALIX_WORKSPACE_SECRET_KEY
 *   - pulseboard/PRD.md  as the default PRD
 *
 * Writes one row into workspace_project_settings keyed on (workspace_id,
 * project_key). Credentials are encrypted at rest via the same AES-256-GCM
 * helper the webapp uses. Idempotent: re-running updates the row in place.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import postgres from 'postgres';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WEBAPP_ENV = resolve(ROOT, 'webapp', '.env.local');
const PULSEBOARD_PRD = resolve(ROOT, '..', 'pulseboard', 'PRD.md');

dotenv.config({ path: WEBAPP_ENV });

const DATABASE_URL = process.env.DATABASE_URL;
const SECRET = process.env.HEALIX_WORKSPACE_SECRET_KEY;
if (!DATABASE_URL) throw new Error('DATABASE_URL missing in webapp/.env.local');
if (!SECRET) throw new Error('HEALIX_WORKSPACE_SECRET_KEY missing in webapp/.env.local');

// AES-256-GCM mirroring webapp/src/lib/crypto-aes.ts shape.
function encryptJson(obj) {
  const key = Buffer.from(SECRET, 'base64');
  if (key.length !== 32) throw new Error('HEALIX_WORKSPACE_SECRET_KEY must decode to 32 bytes');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

const WORKSPACE_ID = '013285b2-ab7e-4591-bbb8-67bfc69f7dc2';
const PROJECT_KEY = '6877217226256c91b2ce37f5db3c0d59b3bca7a3fdad2e33020194873a2342c3'; // sha256('pulseboard')

const credentials = [
  { role: 'admin',  username: 'admin@pulseboard.test',  password: 'Admin123!' },
  { role: 'member', username: 'member@pulseboard.test', password: 'Member123!' },
  { role: 'viewer', username: 'viewer@pulseboard.test', password: 'Viewer123!' },
];

const prdText = readFileSync(PULSEBOARD_PRD, 'utf8');

const sql = postgres(DATABASE_URL);
const enc = encryptJson(credentials);

const [me] = await sql`
  SELECT created_by FROM project_workspaces WHERE id = ${WORKSPACE_ID} LIMIT 1
`;
if (!me) throw new Error(`workspace ${WORKSPACE_ID} not found`);
const createdBy = me.created_by;

// Upsert by (workspace_id, project_key) using the schema's unique constraint.
await sql`
  INSERT INTO workspace_project_settings (
    workspace_id, project_key, project_name,
    default_start_command, default_base_url, default_port, default_test_type,
    default_prd, default_acs,
    credentials_encrypted, credentials_iv, credentials_tag,
    auto_apply, created_by, updated_at
  )
  VALUES (
    ${WORKSPACE_ID}, ${PROJECT_KEY}, 'pulseboard',
    'npm run start', 'http://localhost:8080', 8080, 'both',
    ${prdText}, ${null}::jsonb,
    ${enc.ciphertext}, ${enc.iv}, ${enc.tag},
    true, ${createdBy}, NOW()
  )
  ON CONFLICT (workspace_id, project_key)
  DO UPDATE SET
    project_name = EXCLUDED.project_name,
    default_start_command = EXCLUDED.default_start_command,
    default_base_url = EXCLUDED.default_base_url,
    default_port = EXCLUDED.default_port,
    default_test_type = EXCLUDED.default_test_type,
    default_prd = EXCLUDED.default_prd,
    credentials_encrypted = EXCLUDED.credentials_encrypted,
    credentials_iv = EXCLUDED.credentials_iv,
    credentials_tag = EXCLUDED.credentials_tag,
    auto_apply = EXCLUDED.auto_apply,
    updated_at = NOW()
`;

const [row] = await sql`
  SELECT id, project_name, default_test_type, length(default_prd) AS prd_chars,
         auto_apply, updated_at
  FROM workspace_project_settings
  WHERE workspace_id = ${WORKSPACE_ID} AND project_key = ${PROJECT_KEY}
`;
console.log('Seeded pulseboard workspace_project_settings:', row);

await sql.end();
