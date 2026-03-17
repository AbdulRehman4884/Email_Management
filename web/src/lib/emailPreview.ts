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
  return wrapHtml(
    `<h1 style="font-size:24px;margin-bottom:16px;">${escapeHtml(data.heading || 'Hello')}</h1><div style="line-height:1.6;">${body}</div>${cta}`
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
  return wrapHtml(
    `<h1 style="font-size:26px;margin-bottom:12px;">${escapeHtml(data.title || 'Announcement')}</h1><p style="line-height:1.6;">${desc}</p>${link}`
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
  return wrapHtml(
    `<h1 style="font-size:24px;">${escapeHtml(data.title || 'Newsletter')}</h1><div style="line-height:1.6;">${intro}</div>${mainLink}${footer}`
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

/** Default content per template — body and fields auto-fill when user selects a template. */
export const TEMPLATE_DEFAULTS: Record<TemplateId, Record<string, string>> = {
  simple: {
    heading: 'Welcome!',
    body: 'Hi {{firstName}},\n\nThanks for connecting. Use {{email}} if you need to reach us.\n\nBest,\nThe Team',
    ctaText: '',
    ctaUrl: '',
  },
  announcement: {
    title: 'Important Update',
    description:
      'We have an announcement to share with you.\n\nStay tuned for more details.',
    linkUrl: '',
    linkText: '',
  },
  newsletter: {
    title: "This Week's Update",
    intro:
      'Hi {{firstName}},\n\nHere\'s what\'s new this week.\n\n— The Team',
    mainLinkUrl: '',
    mainLinkText: '',
    footer: '',
  },
};
