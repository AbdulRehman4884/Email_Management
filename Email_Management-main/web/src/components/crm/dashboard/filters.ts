import type { CrmContactFilters } from '../../../lib/api';

/** Dashboard filters, kept in the URL so a filtered view can be shared or reloaded. */
export interface DashboardFilters {
  pipelineId?: number;
  campaignId?: number;
  stageId?: number;
  labels: string[];
  tagIds: number[];
  scoreTiers: string[];
  needsReply: boolean;
  from?: string;
  to?: string;
  search?: string;
  sort?: CrmContactFilters['sort'];
}

export type DashboardView = 'board' | 'table';

const num = (v: string | null) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
const list = (v: string | null) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const dateOk = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const SORTS = ['recent', 'score', 'name', 'hot', 'waiting', 'added'];

export function filtersFromUrl(sp: URLSearchParams): { filters: DashboardFilters; view: DashboardView; page: number } {
  const sort = sp.get('sort');
  return {
    filters: {
      pipelineId: num(sp.get('pipelineId')),
      campaignId: num(sp.get('campaignId')),
      stageId: num(sp.get('stageId')),
      labels: list(sp.get('label')),
      tagIds: list(sp.get('tagIds')).map(Number).filter((n) => Number.isInteger(n) && n > 0),
      scoreTiers: list(sp.get('scoreTier')).filter((t) => ['hot', 'warm', 'cold'].includes(t)),
      needsReply: sp.get('needsReply') === '1',
      from: dateOk(sp.get('from')),
      to: dateOk(sp.get('to')),
      search: sp.get('search') || undefined,
      sort: sort && SORTS.includes(sort) ? (sort as DashboardFilters['sort']) : undefined,
    },
    view: sp.get('view') === 'table' ? 'table' : 'board',
    page: Math.max(1, Number(sp.get('page')) || 1),
  };
}

export function filtersToUrl(f: DashboardFilters, view: DashboardView, page = 1): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.pipelineId) out.pipelineId = String(f.pipelineId);
  if (f.campaignId) out.campaignId = String(f.campaignId);
  if (f.stageId) out.stageId = String(f.stageId);
  if (f.labels.length) out.label = f.labels.join(',');
  if (f.tagIds.length) out.tagIds = f.tagIds.join(',');
  if (f.scoreTiers.length) out.scoreTier = f.scoreTiers.join(',');
  if (f.needsReply) out.needsReply = '1';
  if (f.from) out.from = f.from;
  if (f.to) out.to = f.to;
  if (f.search) out.search = f.search;
  if (f.sort) out.sort = f.sort;
  if (view === 'table') out.view = 'table';
  if (view === 'table' && page > 1) out.page = String(page);
  return out;
}

/** For the API. `pipelineId` is the pipeline on screen (the chosen or the default one). */
export function toApiFilters(f: DashboardFilters, pipelineId: number | undefined): CrmContactFilters {
  return {
    pipelineId,
    campaignId: f.campaignId,
    stageId: f.stageId,
    label: f.labels.length ? f.labels.join(',') : undefined,
    tagIds: f.tagIds,
    scoreTier: f.scoreTiers.length ? f.scoreTiers.join(',') : undefined,
    needsReply: f.needsReply,
    from: f.from,
    to: f.to,
    search: f.search,
    sort: f.sort,
  };
}

export function hasFilters(f: DashboardFilters): boolean {
  return Boolean(f.campaignId || f.stageId || f.labels.length || f.tagIds.length || f.scoreTiers.length || f.needsReply || f.from || f.to || f.search);
}

/** "waiting 5h" / "waiting 2d" for cards. */
export function waitingShort(since: string | null | undefined): string | null {
  if (!since) return null;
  const h = (Date.now() - new Date(since).getTime()) / 3600_000;
  if (!Number.isFinite(h) || h < 0) return null;
  if (h < 1) return `waiting ${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `waiting ${Math.floor(h)}h`;
  return `waiting ${Math.floor(h / 24)}d`;
}

export function timeAgoShort(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return null;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
