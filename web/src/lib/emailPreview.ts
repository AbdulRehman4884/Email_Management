import type { TemplateId } from '../types';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapHtml(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">${body}</body></html>`;
}

function buildSimple(data: Record<string, string>): string {
  const ctaText = data.ctaText ?? '';
  const ctaUrl = data.ctaUrl ?? '';
  const cta =
    ctaText && ctaUrl
      ? `<p style="margin:24px 0;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;">${escapeHtml(ctaText)}</a></p>`
      : '';
  const body = (data.body || '').replace(/\n/g, '<br>');
  const headingHtml = data.heading?.trim()
    ? escapeHtml(data.heading)
    : '<span style="color:#9ca3af;">Your heading</span>';
  return wrapHtml(
    `<h1 style="font-size:24px;margin-bottom:16px;">${headingHtml}</h1><div style="line-height:1.6;">${body || '<span style="color:#9ca3af;">Your message…</span>'}</div>${cta}`
  );
}

function buildAnnouncement(data: Record<string, string>): string {
  const linkUrl = data.linkUrl ?? '';
  const linkText = data.linkText ?? '';
  const link =
    linkUrl && linkText
      ? `<p><a href="${escapeHtml(linkUrl)}" style="color:#4f46e5;">${escapeHtml(linkText)}</a></p>`
      : '';
  const desc = (data.description || '').replace(/\n/g, '<br>');
  const title = data.title?.trim() ? escapeHtml(data.title) : '<span style="color:#9ca3af;">Title</span>';
  return wrapHtml(
    `<h1 style="font-size:26px;margin-bottom:12px;">${title}</h1><p style="line-height:1.6;">${desc || '<span style="color:#9ca3af;">Description…</span>'}</p>${link}`
  );
}

function buildNewsletter(data: Record<string, string>): string {
  const intro = (data.intro || '').replace(/\n/g, '<br>');
  const mainLinkUrl = data.mainLinkUrl ?? '';
  const mainLinkText = data.mainLinkText ?? '';
  const mainLink =
    mainLinkUrl && mainLinkText
      ? `<p style="margin:20px 0;"><a href="${escapeHtml(mainLinkUrl)}" style="color:#4f46e5;font-weight:600;">${escapeHtml(mainLinkText)}</a></p>`
      : '';
  const footer = data.footer
    ? `<p style="margin-top:32px;font-size:12px;color:#666;">${escapeHtml(data.footer)}</p>`
    : '';
  const title = data.title?.trim() ? escapeHtml(data.title) : '<span style="color:#9ca3af;">Title</span>';
  return wrapHtml(
    `<h1 style="font-size:24px;">${title}</h1><div style="line-height:1.6;">${intro || '<span style="color:#9ca3af;">Intro…</span>'}</div>${mainLink}${footer}`
  );
}

export function buildPreviewHtml(
  templateId: TemplateId,
  templateData: Record<string, string>
): string {
  switch (templateId) {
    case 'simple':
      return buildSimple(templateData);
    case 'announcement':
      return buildAnnouncement(templateData);
    case 'newsletter':
      return buildNewsletter(templateData);
    default:
      return wrapHtml('<p style="color:#666;">Select a template to preview.</p>');
  }
}

/** Wrap raw HTML for iframe preview (e.g. custom HTML mode). */
export function wrapCustomHtml(html: string): string {
  return wrapHtml(html || '<p style="color:#999;">Enter HTML to preview.</p>');
}

/** Default content per template — start empty; placeholders guide the user. */
export const TEMPLATE_DEFAULTS: Record<TemplateId, Record<string, string>> = {
  simple: {
    heading: '',
    body: '',
    ctaText: '',
    ctaUrl: '',
  },
  announcement: {
    title: '',
    description: '',
    linkUrl: '',
    linkText: '',
  },
  newsletter: {
    title: '',
    intro: '',
    mainLinkUrl: '',
    mainLinkText: '',
    footer: '',
  },
};

/**
 * Best-effort parse of stored campaign HTML (from our builders) back into template fields for editing.
 */
export function parseStoredCampaignHtml(
  html: string
): { templateId: TemplateId; templateData: Record<string, string> } | null {
  if (!html || !html.trim()) return null;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const bodyEl = doc.body;
    if (!bodyEl) return null;

    const h1 = bodyEl.querySelector('h1');
    if (!h1) return null;

    const h1Style = h1.getAttribute('style') || '';
    const titleText = h1.textContent?.trim() ?? '';

    // Announcement: h1 font-size 26px + following <p>
    if (h1Style.includes('26px')) {
      const p = h1.nextElementSibling;
      const descText = p?.tagName === 'P' ? (p.textContent || '').trim() : '';
      return {
        templateId: 'announcement',
        templateData: {
          title: titleText,
          description: descText,
          linkUrl: '',
          linkText: '',
        },
      };
    }

    // Simple: h1 has margin-bottom:16px + following <div> with body
    if (h1Style.includes('margin-bottom:16px') || h1Style.includes('margin-bottom: 16px')) {
      const div = h1.nextElementSibling;
      if (div?.tagName === 'DIV') {
        const bodyText = (div.textContent || '').replace(/\u00a0/g, ' ').trim();
        return {
          templateId: 'simple',
          templateData: {
            heading: titleText,
            body: bodyText,
            ctaText: '',
            ctaUrl: '',
          },
        };
      }
    }

    // Newsletter: h1 24px without simple's margin-bottom + following <div> intro
    const next = h1.nextElementSibling;
    if (next?.tagName === 'DIV') {
      const st = next.getAttribute('style') || '';
      if (st.includes('line-height')) {
        const introText = (next.textContent || '').replace(/\u00a0/g, ' ').trim();
        return {
          templateId: 'newsletter',
          templateData: {
            title: titleText,
            intro: introText,
            mainLinkUrl: '',
            mainLinkText: '',
            footer: '',
          },
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}
