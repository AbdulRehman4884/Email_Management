/**
 * Build HTML from template id + data. Placeholders {{firstName}} and {{email}} are left for worker to replace per recipient.
 */
export type TemplateId = 'simple' | 'announcement' | 'newsletter';

export interface SimpleTemplateData {
  heading: string;
  body: string;
  ctaText?: string;
  ctaUrl?: string;
}

export interface AnnouncementTemplateData {
  title: string;
  description: string;
  linkUrl?: string;
  linkText?: string;
}

export interface NewsletterTemplateData {
  title: string;
  intro: string;
  mainLinkUrl?: string;
  mainLinkText?: string;
  footer?: string;
}

export type TemplateData = SimpleTemplateData | AnnouncementTemplateData | NewsletterTemplateData;

const wrapHtml = (body: string) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">${body}</body></html>`;

function buildSimple(data: SimpleTemplateData): string {
  const cta =
    data.ctaText && data.ctaUrl
      ? `<p style="margin:24px 0;"><a href="${escapeHtml(data.ctaUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;">${escapeHtml(data.ctaText)}</a></p>`
      : '';
  const body = (data.body || '').replace(/\n/g, '<br>');
  return wrapHtml(
    `<h1 style="font-size:24px;margin-bottom:16px;">${escapeHtml(data.heading || 'Hello')}</h1><div style="line-height:1.6;">${body}</div>${cta}`
  );
}

function buildAnnouncement(data: AnnouncementTemplateData): string {
  const link =
    data.linkUrl && data.linkText
      ? `<p><a href="${escapeHtml(data.linkUrl)}" style="color:#4f46e5;">${escapeHtml(data.linkText)}</a></p>`
      : '';
  const desc = (data.description || '').replace(/\n/g, '<br>');
  return wrapHtml(
    `<h1 style="font-size:26px;margin-bottom:12px;">${escapeHtml(data.title || 'Announcement')}</h1><p style="line-height:1.6;">${desc}</p>${link}`
  );
}

function buildNewsletter(data: NewsletterTemplateData): string {
  const intro = (data.intro || '').replace(/\n/g, '<br>');
  const mainLink =
    data.mainLinkUrl && data.mainLinkText
      ? `<p style="margin:20px 0;"><a href="${escapeHtml(data.mainLinkUrl)}" style="color:#4f46e5;font-weight:600;">${escapeHtml(data.mainLinkText)}</a></p>`
      : '';
  const footer = data.footer
    ? `<p style="margin-top:32px;font-size:12px;color:#666;">${escapeHtml(data.footer)}</p>`
    : '';
  return wrapHtml(
    `<h1 style="font-size:24px;">${escapeHtml(data.title || 'Newsletter')}</h1><div style="line-height:1.6;">${intro}</div>${mainLink}${footer}`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildHtml(templateId: TemplateId, templateData: TemplateData): string {
  switch (templateId) {
    case 'simple':
      return buildSimple(templateData as SimpleTemplateData);
    case 'announcement':
      return buildAnnouncement(templateData as AnnouncementTemplateData);
    case 'newsletter':
      return buildNewsletter(templateData as NewsletterTemplateData);
    default:
      throw new Error(`Unknown template: ${templateId}`);
  }
}

export function getTemplateIds(): TemplateId[] {
  return ['simple', 'announcement', 'newsletter'];
}
