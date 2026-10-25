import { create } from 'zustand';
import { crmApi, type CrmContact, type CrmContactFilters, type CrmPipelineSummary, type CrmStage, type CrmSummary } from '../lib/api';

/**
 * CRM dashboard state (step 8): pipelines, the summary, the Kanban columns, the table and Hot Leads.
 * The filters themselves live in the URL (pages/Crm.tsx) and are passed in.
 */

export const COLUMN_PAGE = 20;
export const TABLE_PAGE = 50;

export interface BoardColumn {
  contacts: CrmContact[];
  total: number;
  loading: boolean;
  error: string | null;
}

interface CrmState {
  pipelines: CrmPipelineSummary[];
  stages: CrmStage[];
  stagesPipelineId: number | null;
  summary: CrmSummary | null;
  summaryLoading: boolean;
  columns: Record<number, BoardColumn>;
  table: { rows: CrmContact[]; total: number; page: number; loading: boolean };
  hotLeads: CrmContact[];
  error: string | null;

  loadPipelines: () => Promise<CrmPipelineSummary[]>;
  loadStages: (pipelineId: number) => Promise<CrmStage[]>;
  loadSummary: (filters: CrmContactFilters) => Promise<void>;
  loadHotLeads: (filters: CrmContactFilters) => Promise<void>;
  loadBoard: (filters: CrmContactFilters, stageIds: number[]) => Promise<void>;
  loadMoreColumn: (filters: CrmContactFilters, stageId: number) => Promise<void>;
  loadTable: (filters: CrmContactFilters, page: number, sort?: CrmContactFilters['sort']) => Promise<void>;
  /** Drag and drop: moves the card right away, saves, and moves it back if saving fails. */
  moveLead: (contactId: number, fromStageId: number | null, toStageId: number) => Promise<void>;
  /** After a change somewhere else (drawer, bulk action): reload what is on screen. */
  reset: () => void;
}

/** Newer requests win: an old response that arrives late is ignored. */
let boardGen = 0;
let tableGen = 0;
let summaryGen = 0;

const emptyColumn = (): BoardColumn => ({ contacts: [], total: 0, loading: true, error: null });

export const useCrmStore = create<CrmState>((set, get) => ({
  pipelines: [],
  stages: [],
  stagesPipelineId: null,
  summary: null,
  summaryLoading: false,
  columns: {},
  table: { rows: [], total: 0, page: 1, loading: false },
  hotLeads: [],
  error: null,

  loadPipelines: async () => {
    const pipelines = await crmApi.getPipelines();
    set({ pipelines });
    return pipelines;
  },

  loadStages: async (pipelineId) => {
    if (get().stagesPipelineId === pipelineId && get().stages.length) return get().stages;
    const p = await crmApi.getPipeline(pipelineId);
    set({ stages: p.stages, stagesPipelineId: pipelineId });
    return p.stages;
  },

  loadSummary: async (filters) => {
    const gen = ++summaryGen;
    set({ summaryLoading: true });
    try {
      const summary = await crmApi.getSummary(filters);
      if (gen === summaryGen) set({ summary, summaryLoading: false, error: null });
    } catch (e) {
      if (gen === summaryGen) set({ summaryLoading: false, error: (e as Error)?.message ?? 'Could not load the summary' });
      throw e;
    }
  },

  loadHotLeads: async (filters) => {
    const r = await crmApi.listContacts({ ...filters, hotOnly: true, sort: 'hot', limit: 8, page: 1 });
    set({ hotLeads: r.contacts });
  },

  loadBoard: async (filters, stageIds) => {
    const gen = ++boardGen;
    set({ columns: Object.fromEntries(stageIds.map((id) => [id, { ...(get().columns[id] ?? emptyColumn()), loading: true, error: null }])) });
    await Promise.all(
      stageIds.map(async (stageId) => {
        try {
          const r = await crmApi.listContacts({ ...filters, stageId, sort: filters.sort ?? 'recent', limit: COLUMN_PAGE, page: 1 });
          if (gen !== boardGen) return;
          set((s) => ({ columns: { ...s.columns, [stageId]: { contacts: r.contacts, total: r.total, loading: false, error: null } } }));
        } catch (e) {
          if (gen !== boardGen) return;
          set((s) => ({
            columns: { ...s.columns, [stageId]: { ...(s.columns[stageId] ?? emptyColumn()), loading: false, error: (e as Error)?.message ?? 'Could not load' } },
          }));
        }
      })
    );
  },

  loadMoreColumn: async (filters, stageId) => {
    const col = get().columns[stageId];
    if (!col || col.loading || col.contacts.length >= col.total) return;
    const gen = boardGen;
    set((s) => ({ columns: { ...s.columns, [stageId]: { ...col, loading: true } } }));
    try {
      const r = await crmApi.listContacts({ ...filters, stageId, sort: filters.sort ?? 'recent', limit: COLUMN_PAGE, offset: col.contacts.length });
      if (gen !== boardGen) return;
      set((s) => {
        const cur = s.columns[stageId] ?? col;
        const seen = new Set(cur.contacts.map((c) => c.id));
        return { columns: { ...s.columns, [stageId]: { contacts: [...cur.contacts, ...r.contacts.filter((c) => !seen.has(c.id))], total: r.total, loading: false, error: null } } };
      });
    } catch (e) {
      set((s) => ({ columns: { ...s.columns, [stageId]: { ...(s.columns[stageId] ?? col), loading: false, error: (e as Error)?.message ?? 'Could not load' } } }));
    }
  },

  loadTable: async (filters, page, sort) => {
    const gen = ++tableGen;
    set((s) => ({ table: { ...s.table, loading: true, page } }));
    try {
      const r = await crmApi.listContacts({ ...filters, sort: sort ?? filters.sort ?? 'recent', limit: TABLE_PAGE, page });
      if (gen === tableGen) set({ table: { rows: r.contacts, total: r.total, page, loading: false } });
    } catch (e) {
      if (gen === tableGen) set((s) => ({ table: { ...s.table, loading: false } }));
      throw e;
    }
  },

  moveLead: async (contactId, fromStageId, toStageId) => {
    if (fromStageId === toStageId) return;
    const before = { columns: get().columns, summary: get().summary };
    const stage = get().stages.find((s) => s.id === toStageId);
    // Optimistic: take the card out of its column and put it on top of the new one.
    set((s) => {
      const columns = { ...s.columns };
      let card: CrmContact | undefined;
      if (fromStageId != null && columns[fromStageId]) {
        const from = columns[fromStageId]!;
        card = from.contacts.find((c) => c.id === contactId);
        columns[fromStageId] = { ...from, contacts: from.contacts.filter((c) => c.id !== contactId), total: Math.max(0, from.total - 1) };
      }
      if (card && columns[toStageId]) {
        const to = columns[toStageId]!;
        const moved = { ...card, stageId: toStageId, stageName: stage?.name ?? card.stageName, stageColor: stage?.color ?? card.stageColor, stageType: stage?.type ?? card.stageType };
        columns[toStageId] = { ...to, contacts: [moved, ...to.contacts], total: to.total + 1 };
      }
      const summary = s.summary
        ? {
            ...s.summary,
            stages: s.summary.stages.map((st) =>
              st.id === fromStageId ? { ...st, count: Math.max(0, st.count - 1) } : st.id === toStageId ? { ...st, count: st.count + 1 } : st
            ),
          }
        : s.summary;
      return { columns, summary };
    });
    try {
      await crmApi.moveContactStage(contactId, toStageId);
    } catch (e) {
      set(before); // put the card back
      throw e;
    }
  },

  reset: () =>
    set({ summary: null, columns: {}, table: { rows: [], total: 0, page: 1, loading: false }, hotLeads: [], error: null }),
}));
