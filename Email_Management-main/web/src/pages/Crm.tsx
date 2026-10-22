import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Columns3, Download, GitBranch, Rows3, Tags } from 'lucide-react';
import '../components/crm/crm.css';
import { EmptyState, useToast } from '../components/ui';
import { UpgradePrompt } from '../components/UpgradePrompt';
import { ContactDrawer } from '../components/crm/ContactDrawer';
import { TagManagerModal } from '../components/crm/TagManagerModal';
import { CrmFilterBar } from '../components/crm/dashboard/CrmFilterBar';
import { KpiTiles } from '../components/crm/dashboard/KpiTiles';
import { KanbanBoard } from '../components/crm/dashboard/KanbanBoard';
import { LeadsTable } from '../components/crm/dashboard/LeadsTable';
import { FunnelChart } from '../components/crm/dashboard/FunnelChart';
import { HotLeads } from '../components/crm/dashboard/HotLeads';
import { filtersFromUrl, filtersToUrl, toApiFilters, type DashboardFilters, type DashboardView } from '../components/crm/dashboard/filters';
import { crmApi, apiErrorMessage, type CrmContact, type CrmTag } from '../lib/api';
import { useCrmEnabled } from '../lib/crmAccess';
import { useCrmTags } from '../lib/useCrmTags';
import { useCampaignStore } from '../store';
import { TABLE_PAGE, useCrmStore } from '../store/crmStore';

/**
 * CRM step 8: the CRM dashboard at /crm.
 * Filters (in the URL) → KPI tiles → Kanban board or table → funnel + Hot leads. Click a lead for the drawer.
 */
export function Crm() {
  const crmEnabled = useCrmEnabled();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const { filters, view, page } = useMemo(() => filtersFromUrl(searchParams), [searchParams]);

  const store = useCrmStore();
  const { pipelines, stages, summary, summaryLoading, columns, table, hotLeads } = store;
  const { campaigns, fetchCampaigns } = useCampaignStore();
  const { tags, colors, reload: reloadTags, create: createTag } = useCrmTags(crmEnabled);
  const [openId, setOpenId] = useState<number | null>(null);
  const [manageTags, setManageTags] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // The pipeline on screen: the chosen one, or the default one.
  const pipelineId = filters.pipelineId ?? pipelines.find((p) => p.isDefault)?.id ?? pipelines[0]?.id;
  const api = useMemo(() => toApiFilters(filters, pipelineId), [filters, pipelineId]);
  const boardStages = useMemo(() => (filters.stageId ? stages.filter((s) => s.id === filters.stageId) : stages), [stages, filters.stageId]);

  const setUrl = useCallback(
    (f: DashboardFilters, v: DashboardView = view, p = 1) => setSearchParams(filtersToUrl(f, v, p), { replace: true }),
    [setSearchParams, view]
  );
  const patch = (p: Partial<DashboardFilters>) => setUrl({ ...filters, ...p });

  // Pipelines + campaigns once.
  useEffect(() => {
    if (!crmEnabled) return;
    store.loadPipelines().catch((e) => {
      const status = (e as { response?: { status?: number } })?.response?.status;
      setBlocked(status === 403 ? apiErrorMessage(e, 'Your plan does not include the CRM.') : apiErrorMessage(e, 'Could not load the CRM'));
    });
    void fetchCampaigns().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crmEnabled]);

  useEffect(() => {
    if (pipelineId) store.loadStages(pipelineId).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineId]);

  const reloadAll = useCallback(async () => {
    if (!pipelineId) return;
    const jobs: Array<Promise<unknown>> = [store.loadSummary(api), store.loadHotLeads(api)];
    if (view === 'board') {
      if (store.stagesPipelineId === pipelineId) jobs.push(store.loadBoard(api, boardStages.map((s) => s.id)));
    } else {
      jobs.push(store.loadTable(api, page));
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) toast.error(apiErrorMessage(failed.reason, 'Could not load the CRM data'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, view, page, boardStages, pipelineId, store.stagesPipelineId]);

  useEffect(() => {
    if (crmEnabled) void reloadAll();
  }, [crmEnabled, reloadAll]);

  if (!crmEnabled) return <UpgradePrompt feature="CRM" />;
  if (blocked) return <EmptyState icon={<GitBranch className="w-8 h-8 text-gray-400" />} title="CRM is not available" description={blocked} />;

  const avgDays = new Map((summary?.stages ?? []).map((s) => [s.id, s.avgDaysInStage]));

  const move = async (contact: CrmContact, toStageId: number) => {
    try {
      await store.moveLead(contact.id, contact.stageId, toStageId);
      const to = stages.find((s) => s.id === toStageId);
      toast.success(`${contact.name || contact.email} → ${to?.name ?? 'new stage'}`);
      // Rules and the score may have changed things: refresh the numbers quietly.
      window.setTimeout(() => {
        store.loadSummary(api).catch(() => undefined);
        store.loadHotLeads(api).catch(() => undefined);
      }, 600);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not move the lead, it was put back'));
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const blob = await crmApi.exportContactsCsv(api);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `crm-leads-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not export the leads'));
    } finally {
      setExporting(false);
    }
  };

  const bulkMove = async (ids: number[], stageId: number) => {
    try {
      const r = await crmApi.bulkUpdateContacts({ contactIds: ids, moveToStageId: stageId });
      toast.success(`${r.moved} lead(s) moved to ${stages.find((s) => s.id === stageId)?.name ?? 'the stage'}`);
      await reloadAll();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not move the leads'));
    }
  };
  const bulkTag = async (ids: number[], tag: CrmTag) => {
    try {
      const r = await crmApi.bulkUpdateContacts({ contactIds: ids, addTagIds: [tag.id] });
      toast.success(r.tagsAdded ? `Tag “${tag.name}” added to ${r.tagsAdded} lead(s)` : `The selected leads already have “${tag.name}”`);
      await reloadAll();
      void reloadTags();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not add the tag'));
    }
  };

  return (
    <div className="crm-ui space-y-4">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px' }}>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--crm-text)' }}>CRM</h1>
          <p className="text-sm crm-muted">
            {summary?.pipeline ? summary.pipeline.name : 'Pipeline'} · drag a lead to another stage to move it.
          </p>
        </div>
        <div role="group" aria-label="View" style={{ display: 'inline-flex', gap: 4 }}>
          <button type="button" className="crm-btn" aria-pressed={view === 'board'} onClick={() => setUrl(filters, 'board')}>
            <Columns3 size={15} /> Board
          </button>
          <button type="button" className="crm-btn" aria-pressed={view === 'table'} onClick={() => setUrl(filters, 'table')}>
            <Rows3 size={15} /> Table
          </button>
        </div>
        <button type="button" className="crm-btn" onClick={() => void exportCsv()} disabled={exporting} title="Download the filtered leads as CSV">
          <Download size={15} /> {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
        <button type="button" className="crm-btn" onClick={() => setManageTags(true)}>
          <Tags size={15} /> <span className="crm-hide-sm">Manage tags</span>
        </button>
        <Link to="/crm/pipelines" className="crm-btn" title="Pipeline Builder">
          <GitBranch size={15} /> <span className="crm-hide-sm">Pipelines</span>
        </Link>
      </div>

      <CrmFilterBar
        filters={filters}
        onChange={patch}
        onClear={() => setUrl({ labels: [], tagIds: [], scoreTiers: [], needsReply: false, pipelineId: filters.pipelineId, sort: filters.sort })}
        pipelines={pipelines}
        pipelineId={pipelineId}
        stages={stages}
        campaigns={campaigns}
        tags={tags}
      />

      <KpiTiles
        kpis={summary?.kpis ?? null}
        loading={summaryLoading}
        onPick={(w) =>
          w === 'needsReply' ? patch({ needsReply: true }) : patch({ labels: [w === 'interested' ? 'interested' : 'meeting_booked'] })
        }
      />

      {pipelines.length === 0 && !summaryLoading ? (
        <EmptyState icon={<GitBranch className="w-8 h-8 text-gray-400" />} title="No pipeline yet" description="Leads appear here when a campaign sends its first emails." />
      ) : view === 'board' ? (
        <KanbanBoard
          stages={boardStages}
          columns={columns}
          avgDays={avgDays}
          onOpen={setOpenId}
          onMove={(c, to) => void move(c, to)}
          onLoadMore={(stageId) => void store.loadMoreColumn(api, stageId)}
        />
      ) : (
        <LeadsTable
          rows={table.rows}
          total={table.total}
          page={table.page}
          pageSize={TABLE_PAGE}
          loading={table.loading}
          stages={stages}
          tags={tags}
          onPage={(p) => setUrl(filters, 'table', p)}
          onOpen={setOpenId}
          onBulkMove={bulkMove}
          onBulkTag={bulkTag}
          onCreateTag={(name) => createTag(name)}
        />
      )}

      <div className="crm-two">
        <FunnelChart summary={summary} onPickStage={(stageId) => patch({ stageId })} />
        <HotLeads leads={hotLeads} onOpen={setOpenId} />
      </div>

      {openId != null && (
        <ContactDrawer
          contactId={openId}
          tags={tags}
          onCreateTag={(name) => createTag(name)}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            void reloadAll();
            void reloadTags();
          }}
        />
      )}
      <TagManagerModal
        isOpen={manageTags}
        onClose={() => setManageTags(false)}
        tags={tags}
        colors={colors}
        onChanged={async () => {
          await reloadTags();
          await reloadAll();
        }}
      />
    </div>
  );
}
