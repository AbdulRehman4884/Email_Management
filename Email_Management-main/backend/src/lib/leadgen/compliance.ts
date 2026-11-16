/**
 * Opt-out / erasure requests of data subjects (use case UC-12, GDPR).
 *
 *   1. request: only sha256(identifier) is stored (data_subject_requests), never the identifier itself
 *   2. identity check: a one-time link to that email (emails); LinkedIn URLs and domains go to an admin
 *   3. erasure: people, their contact points, social profiles and observations are deleted and removed from
 *      every workspace; a domain removes the whole company
 *   4. the email goes on suppression_list, the identifier hash on do_not_collect: daily runs never bring it back
 * A campaign unsubscribe also lands in do_not_collect (unsubscribeController).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { dbPool } from '../db.js';
import { addDoNotCollect, type Queryable } from './leadStore.js';
import { hashIdentifier, normalizeIdentifier, type IdentifierType } from './normalize.js';
import { inTransaction } from './resolve.js';

export type RequestType = 'opt_out' | 'erasure' | 'access';

const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

export interface CreatedRequest {
  id: number;
  /** One-time token for the confirmation link (email requests only). Never stored in clear. */
  token: string | null;
  needsAdmin: boolean;
}

export async function createSubjectRequest(type: RequestType, identifierType: IdentifierType, identifier: string): Promise<CreatedRequest | null> {
  const hash = hashIdentifier(identifierType, identifier);
  if (!hash) return null;
  const token = identifierType === 'email' ? randomBytes(24).toString('base64url') : null;
  const r = await dbPool.query<{ id: number }>(
    `INSERT INTO data_subject_requests (request_type, identifier_hash, identifier_type, verify_token_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
    [type, hash, identifierType, token ? tokenHash(token) : null]
  );
  return { id: r.rows[0]!.id, token, needsAdmin: identifierType !== 'email' };
}

export interface ErasureResult {
  people: number;
  contactPoints: number;
  socialProfiles: number;
  companies: number;
  workspaceLeads: number;
}

/** Deletes everything we hold about the identifier and blocks it from being collected again. */
export async function eraseIdentifier(q: Queryable, identifierType: IdentifierType, rawValue: string): Promise<ErasureResult> {
  const value = normalizeIdentifier(identifierType, rawValue);
  const res: ErasureResult = { people: 0, contactPoints: 0, socialProfiles: 0, companies: 0, workspaceLeads: 0 };
  if (!value) return res;

  let personIds: number[] = [];
  let companyIds: number[] = [];
  if (identifierType === 'email') {
    personIds = (await q.query<{ person_id: number }>(`SELECT DISTINCT person_id FROM contact_points WHERE type = 'email' AND value_normalized = $1 AND person_id IS NOT NULL`, [value])).rows.map((r) => r.person_id);
  } else if (identifierType === 'linkedin_url') {
    personIds = (await q.query<{ id: number }>(
      `SELECT id FROM people WHERE linkedin_url = $1 UNION SELECT person_id FROM social_profiles WHERE url = $1 AND person_id IS NOT NULL`,
      [value]
    )).rows.map((r) => r.id);
    companyIds = (await q.query<{ company_id: number }>(`SELECT company_id FROM social_profiles WHERE url = $1 AND company_id IS NOT NULL`, [value])).rows.map((r) => r.company_id);
  } else {
    companyIds = (await q.query<{ company_id: number }>(`SELECT company_id FROM company_domains WHERE domain = $1`, [value])).rows.map((r) => r.company_id);
  }

  if (personIds.length) {
    res.workspaceLeads += (await q.query(`DELETE FROM workspace_leads WHERE person_id = ANY($1)`, [personIds])).rowCount ?? 0;
    await q.query(`DELETE FROM observations WHERE entity_type = 'person' AND entity_id = ANY($1)`, [personIds]);
    res.contactPoints += (await q.query(`DELETE FROM contact_points WHERE person_id = ANY($1)`, [personIds])).rowCount ?? 0;
    res.socialProfiles += (await q.query(`DELETE FROM social_profiles WHERE person_id = ANY($1)`, [personIds])).rowCount ?? 0;
    res.people += (await q.query(`DELETE FROM people WHERE id = ANY($1)`, [personIds])).rowCount ?? 0;
  }
  if (companyIds.length) {
    // A company that opted out leaves every workspace (CASCADE removes its contact points, pages, leads).
    res.workspaceLeads += (await q.query(`DELETE FROM workspace_leads WHERE company_id = ANY($1)`, [companyIds])).rowCount ?? 0;
    await q.query(`DELETE FROM observations WHERE entity_type = 'company' AND entity_id = ANY($1)`, [companyIds]);
    await q.query(`UPDATE people SET current_company_id = NULL WHERE current_company_id = ANY($1)`, [companyIds]);
    res.companies += (await q.query(`DELETE FROM companies WHERE id = ANY($1)`, [companyIds])).rowCount ?? 0;
  }
  if (identifierType === 'email') {
    // A company inbox (info@...) is removed too, wherever it is stored.
    res.contactPoints += (await q.query(`DELETE FROM contact_points WHERE type = 'email' AND value_normalized = $1`, [value])).rowCount ?? 0;
    await q.query(`DELETE FROM observations WHERE field = 'email' AND (value #>> '{}') = $1`, [value]);
    await q.query(`INSERT INTO suppression_list (email, reason) VALUES ($1, 'data_subject_request') ON CONFLICT (email) DO NOTHING`, [value]);
  } else if (identifierType === 'linkedin_url') {
    res.socialProfiles += (await q.query(`DELETE FROM social_profiles WHERE url = $1`, [value])).rowCount ?? 0;
  }
  await addDoNotCollect(identifierType, value, q);
  return res;
}

/** The confirmation link was opened: checks the token, erases, closes the request. Null = bad or used link. */
export async function verifyAndProcess(requestId: number, token: string, email: string): Promise<ErasureResult | null> {
  return inTransaction(async (c: PoolClient) => {
    const r = (await c.query<{ identifier_hash: string; identifier_type: IdentifierType; verify_token_hash: string | null; status: string }>(
      `SELECT identifier_hash, identifier_type, verify_token_hash, status FROM data_subject_requests WHERE id = $1 FOR UPDATE`,
      [requestId]
    )).rows[0];
    if (!r || r.status === 'done' || r.status === 'rejected' || !r.verify_token_hash) return null;
    if (r.verify_token_hash !== tokenHash(token) || hashIdentifier(r.identifier_type, email) !== r.identifier_hash) return null;
    const result = await eraseIdentifier(c, r.identifier_type, email);
    await c.query(`UPDATE data_subject_requests SET status = 'done', verified_at = now(), processed_at = now(), verify_token_hash = NULL WHERE id = $1`, [requestId]);
    return result;
  });
}

/** Admin: the identity was checked by hand (LinkedIn URL / domain requests). */
export async function processByAdmin(requestId: number, identifier: string): Promise<ErasureResult | null> {
  return inTransaction(async (c) => {
    const r = (await c.query<{ identifier_hash: string; identifier_type: IdentifierType; status: string }>(
      `SELECT identifier_hash, identifier_type, status FROM data_subject_requests WHERE id = $1 FOR UPDATE`,
      [requestId]
    )).rows[0];
    if (!r || r.status === 'done' || r.status === 'rejected') return null;
    if (hashIdentifier(r.identifier_type, identifier) !== r.identifier_hash) return null;
    const result = await eraseIdentifier(c, r.identifier_type, identifier);
    await c.query(`UPDATE data_subject_requests SET status = 'done', verified_at = COALESCE(verified_at, now()), processed_at = now() WHERE id = $1`, [requestId]);
    return result;
  });
}
