import { useCallback, useEffect, useState } from 'react';
import { crmApi, type CrmTag } from './api';

const FALLBACK_COLORS = ['#6366f1', '#22c55e', '#ef4444', '#eab308', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#6b7280'];

/**
 * The user's tags (CRM step 5) with a `create` that picks the next color.
 * `enabled = false` skips loading (user has no CRM in the plan).
 */
export function useCrmTags(enabled = true) {
  const [tags, setTags] = useState<CrmTag[]>([]);
  const [colors, setColors] = useState<string[]>(FALLBACK_COLORS);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      const r = await crmApi.listAllTags();
      setTags(r.tags);
      if (r.colors?.length) setColors(r.colors);
    } finally {
      setLoaded(true);
    }
  }, [enabled]);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const create = useCallback(
    async (name: string, scope: CrmTag['scope'] = 'both'): Promise<CrmTag> => {
      const color = colors[tags.length % colors.length];
      const tag = await crmApi.createTag({ name, color, scope });
      setTags((prev) => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)));
      return tag;
    },
    [colors, tags.length]
  );

  return { tags, setTags, colors, loaded, reload, create };
}
