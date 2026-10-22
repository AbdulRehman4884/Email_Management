/**
 * CRM step 7: lead scoring settings. Mounted in crmRouter at /api/crm (auth + crmEnabled plan check).
 *
 *   GET  /crm/scoring                 weights, thresholds, defaults, the user's tags and custom field names
 *   PUT  /crm/scoring {weights?, hotThreshold?, warmThreshold?}
 *   POST /crm/scoring/recalculate     recalculate every lead of the user (background, in batches)
 *   GET  /crm/scoring/recalculate     progress of that job
 */
import type { Request, Response } from 'express';
import { dbPool } from '../lib/db.js';
import {
  DEFAULT_HOT,
  DEFAULT_WARM,
  DEFAULT_WEIGHTS,
  getRecalcJob,
  loadScoringSettings,
  normalizeWeights,
  startRecalcJob,
} from '../lib/crm/leadScoring.js';

class HttpError extends Error {
  constructor(public status: number, message: string, public details: string[] = []) {
    super(message);
  }
}

function userIdOf(req: Request): number {
  const id = req.user?.id;
  if (!id) throw new HttpError(401, 'Unauthorized');
  return id;
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message, ...(err.details.length ? { errors: err.details } : {}) });
        return;
      }
      console.error('[crm scoring]', err);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };
}

async function readScoring(userId: number) {
  await dbPool.query(`INSERT INTO crm_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  const s = await loadScoringSettings(dbPool, userId);
  const [tags, fields] = await Promise.all([
    dbPool.query<{ id: number; name: string; color: string }>(
      `SELECT id, name, color FROM crm_tags WHERE user_id = $1 AND scope <> 'campaign' ORDER BY lower(name)`,
      [userId]
    ),
    dbPool.query<{ key: string }>(
      `SELECT DISTINCT k AS key
         FROM crm_contacts cc, jsonb_object_keys(CASE WHEN jsonb_typeof(cc.custom_fields) = 'object' THEN cc.custom_fields ELSE '{}'::jsonb END) k
        WHERE cc.user_id = $1
        ORDER BY 1
        LIMIT 100`,
      [userId]
    ),
  ]);
  return {
    weights: s.weights,
    hotThreshold: s.hot,
    warmThreshold: s.warm,
    defaults: { weights: DEFAULT_WEIGHTS, hotThreshold: DEFAULT_HOT, warmThreshold: DEFAULT_WARM },
    tags: tags.rows,
    customFieldNames: fields.rows.map((r) => r.key),
    job: getRecalcJob(userId),
  };
}

/** GET /crm/scoring */
export const getScoring = handle(async (req, res) => {
  res.json(await readScoring(userIdOf(req)));
});

/** PUT /crm/scoring {weights?, hotThreshold?, warmThreshold?} — then call POST /crm/scoring/recalculate. */
export const saveScoring = handle(async (req, res) => {
  const userId = userIdOf(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const current = await loadScoringSettings(dbPool, userId);
  const errors: string[] = [];

  let weights = current.weights;
  if ('weights' in body) {
    const n = normalizeWeights(body.weights, true);
    errors.push(...n.errors);
    weights = n.weights;
    const tagIds = Object.keys(weights.tags).map(Number);
    if (tagIds.length) {
      const own = await dbPool.query<{ id: number }>(`SELECT id FROM crm_tags WHERE user_id = $1 AND id = ANY($2::int[])`, [userId, tagIds]);
      const ownIds = new Set(own.rows.map((r) => String(r.id)));
      for (const id of Object.keys(weights.tags)) if (!ownIds.has(id)) errors.push(`Tag ${id} is not one of your tags`);
    }
  }

  const threshold = (key: string, fallback: number) => {
    if (!(key in body)) return fallback;
    const n = Number(body[key]);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      errors.push(`${key === 'hotThreshold' ? 'Hot' : 'Warm'} from: a whole number from 1 to 100`);
      return fallback;
    }
    return n;
  };
  const hot = threshold('hotThreshold', current.hot);
  const warm = threshold('warmThreshold', current.warm);
  if (warm >= hot) errors.push('Warm must start below Hot');

  if (errors.length) throw new HttpError(400, errors[0]!, errors);

  await dbPool.query(
    `INSERT INTO crm_settings (user_id, score_weights, hot_threshold, warm_threshold)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET score_weights = EXCLUDED.score_weights, hot_threshold = EXCLUDED.hot_threshold,
           warm_threshold = EXCLUDED.warm_threshold, updated_at = now()`,
    [userId, JSON.stringify(weights), hot, warm]
  );
  res.json({ ...(await readScoring(userId)), recalculateNeeded: true });
});

/** POST /crm/scoring/recalculate: starts the background job (or returns the one already running). */
export const startRecalculation = handle(async (req, res) => {
  const job = await startRecalcJob(userIdOf(req));
  res.status(202).json({ job });
});

/** GET /crm/scoring/recalculate: progress. */
export const getRecalculation = handle(async (req, res) => {
  res.json({ job: getRecalcJob(userIdOf(req)) });
});
