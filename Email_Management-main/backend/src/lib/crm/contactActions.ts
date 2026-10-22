/**
 * CRM step 5: changes a user makes to leads by hand (bulk actions, the lead drawer).
 * Rules never call these; the rule engine has its own move (ruleEngine.moveContact).
 */
import type { PoolClient } from 'pg';
import { cancelPendingFollowUps } from './followUps.js';

export interface ManualMoveResult {
  contactId: number;
  fromStageId: number | null;
  toStageId: number;
}

/**
 * Moves leads to a stage chosen by the user. A person may move a lead anywhere (also into or out of
 * manual-only and Won/Lost stages). When the stage is in another pipeline, the lead changes pipeline.
 * Leads already in the stage are skipped. Writes crm_stage_history with the user's id.
 * Call inside a transaction; emit 'manual_move' events after COMMIT.
 */
export async function moveContactsManually(
  client: PoolClient,
  userId: number,
  contactIds: number[],
  stage: { id: number; pipelineId: number; name: string; stopFollowUps: boolean }
): Promise<ManualMoveResult[]> {
  if (contactIds.length === 0) return [];
  const moved = await client.query<{ id: number; from_stage_id: number | null }>(
    `UPDATE crm_contacts cc
        SET stage_id = $3, pipeline_id = $4, stage_entered_at = now(), updated_at = now()
       FROM (SELECT id, stage_id AS from_stage_id FROM crm_contacts
              WHERE user_id = $1 AND id = ANY($2::int[]) AND stage_id IS DISTINCT FROM $3
              FOR UPDATE) old
      WHERE cc.id = old.id
      RETURNING cc.id, old.from_stage_id`,
    [userId, contactIds, stage.id, stage.pipelineId]
  );
  if (moved.rows.length === 0) return [];
  await client.query(
    `INSERT INTO crm_stage_history (contact_id, from_stage_id, to_stage_id, changed_by_user_id, reason)
     SELECT m.id, m.from_stage_id, $2, $3, 'manual'
       FROM unnest($1::int[], $4::int[]) AS m(id, from_stage_id)`,
    [moved.rows.map((m) => m.id), stage.id, userId, moved.rows.map((m) => m.from_stage_id)]
  );
  if (stage.stopFollowUps) {
    for (const m of moved.rows) await cancelPendingFollowUps(client, m.id, `moved to stage "${stage.name}"`);
  }
  return moved.rows.map((m) => ({ contactId: m.id, fromStageId: m.from_stage_id, toStageId: stage.id }));
}
