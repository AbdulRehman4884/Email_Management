# Deprecated API fields: `recieptCount`, `delieveredAt` (N-21)

The API now sends correctly spelled copies **next to** the old misspelled fields. The old fields are
**deprecated but unchanged**: same name, same value, still in every response. Nothing was renamed or removed, and no
database column changed.

| Old field (deprecated) | New field | Same value | Responses |
|---|---|---|---|
| `recieptCount` | `recipientCount` | yes | `GET /api/campaigns` (each item), `GET /api/campaigns/:id`, `POST /api/campaigns`, `PUT /api/campaigns/:id`, `PATCH /api/campaigns/:id/follow-up-settings` |
| `delieveredAt` | `deliveredAt` | yes | `GET /api/campaigns/:id/recipients` (each item in `recipients`) |

No other response contains these two fields (all other endpoints select explicit fields without them).

**Not done yet, same kind of typo:** `delieveredCount` in `GET /api/campaigns/:id/stats` (from `stats.delivered_count`,
Drizzle property `delieveredCount`). Read by the web (`CampaignDetail.tsx` "Delivered" card) and by the agent
(`Email_agent/mailflow-mcp-server/src/lib/mailflowApiClient.ts`, `normalizeCampaignStats`). Can get a
`deliveredCount` copy the same way, if wanted.

Where it is done:
- backend: `backend/src/lib/apiFieldAliases.ts`, used in `backend/src/controllers/campaignController.ts` at the
  responses above. Response-only; the Drizzle property names `recieptCount` / `delieveredAt` and the DB columns
  `reciept_count` / `delivered_at` are unchanged.
- web: reads `recipientCount` first, falls back to `recieptCount` (`web/src/lib/apiFields.ts`). The web never reads
  `delieveredAt`.

## Who still reads the old fields

AI agent module (agent developer's code, not changed):
- `Email_agent/agent-service/src/graph/nodes/finalResponse.node.ts` (and its test `graph/__tests__/finalResponse.node.test.ts`)
- `Email_agent/mailflow-mcp-server/src/lib/mailflowApiClient.ts` (campaign normalizer; test: `src/tests/lib/normalizeCampaign.test.ts`)

## Removing the old fields later

Only after the agent developer has switched to `recipientCount` / `deliveredAt` and that is deployed:
1. Search all clients (`web/`, `Email_agent/`, any scripts) for `recieptCount` / `delieveredAt`: no reads left.
2. Remove the old keys in `apiFieldAliases.ts` (return only the new ones) and the deprecated fields in
   `web/src/types/index.ts`.
3. Renaming the Drizzle properties / DB column `reciept_count` is a separate, optional step (needs a migration).
