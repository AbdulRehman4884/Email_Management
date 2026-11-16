import React from 'react';
import { Link } from 'react-router-dom';
import { Mail, Users, BarChart3, Settings, ArrowRight, Clock, MessageSquareReply, Inbox, Contact, Bot } from 'lucide-react';
import { Card, CardContent } from '../components/ui';
import { PLACEHOLDER_HINT } from '../lib/campaignValidation';
import { SMTP_DAILY_EMAIL_LIMIT_MAX } from '../lib/smtpLimits';

// F-46: content matches the current app (wizard upload, follow-ups, inbox, CRM, AI agent); Help is in the sidebar.
const SECTIONS: Array<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: React.ReactNode;
  link?: { to: string; label: string };
}> = [
  {
    icon: Mail,
    title: 'Creating campaigns',
    body: (
      <>
        Open <strong>Campaigns</strong> and choose <strong>New campaign</strong>. Step 1: name, sending account(s) and
        optional schedule. Step 2: subject and content (Blank, Announcement, Newsletter or Custom HTML). Step 3: upload
        recipients. The campaign is saved when you upload recipients, click <strong>Save as draft</strong> or{' '}
        <strong>Done</strong>; you can edit it later while it is a draft, scheduled or paused.
      </>
    ),
    link: { to: '/campaigns/create', label: 'Create a campaign' },
  },
  {
    icon: Users,
    title: 'Recipients & uploads',
    body: (
      <>
        Upload one or more CSV or Excel files with an <code className="text-xs bg-gray-100 px-1 rounded">email</code>{' '}
        column in step 3 of the wizard, or later on the campaign page while it is a draft. Duplicate addresses, addresses
        already in the campaign and invalid ones are skipped and reported. On a draft you can remove the uploaded
        recipients and upload a corrected file.
        <span className="block mt-2">{PLACEHOLDER_HINT}</span>
      </>
    ),
    link: { to: '/campaigns', label: 'View campaigns' },
  },
  {
    icon: Clock,
    title: 'Sending, limits & scheduling',
    body: (
      <>
        Each SMTP account sends at most {SMTP_DAILY_EMAIL_LIMIT_MAX} emails per day, about one email every 1–2 minutes per
        campaign. You can schedule a start time, send only on selected weekdays or within a daily time window, set a
        per-campaign daily limit, and auto-pause after a time or duration. A paused campaign shows why it paused.
      </>
    ),
  },
  {
    icon: MessageSquareReply,
    title: 'Follow-ups',
    body: (
      <>
        Add follow-up templates on a campaign page. Send one from the Inbox <strong>Sent</strong> tab, or schedule a
        bulk follow-up under <strong>Follow-up → Schedule follow-up</strong>. Follow-ups go only to recipients who
        received the campaign email and are sent as replies in the same email thread.
      </>
    ),
    link: { to: '/follow-ups', label: 'Open follow-ups' },
  },
  {
    icon: Inbox,
    title: 'Inbox',
    body: (
      <>
        <strong>Replies</strong> lists answers from your recipients, <strong>System notifications</strong> lists bounce
        and mailer-daemon messages, and <strong>Sent</strong> lists every campaign email with its delivery, open and reply
        status. You can reply to a conversation directly from the Inbox.
      </>
    ),
    link: { to: '/inbox', label: 'Open inbox' },
  },
  {
    icon: BarChart3,
    title: 'Analytics',
    body: (
      <>
        <strong>Analytics</strong> shows emails sent, bounces, open rate, reply rate and unsubscribes for all or selected
        campaigns, plus a daily or monthly chart. Opens are tracked with a tracking pixel (some mail apps block it, so
        real opens can be higher). Link clicks are not tracked.
      </>
    ),
    link: { to: '/analytics', label: 'Open analytics' },
  },
  {
    icon: Contact,
    title: 'CRM, pipelines & forms',
    body: (
      <>
        On plans with CRM, every recipient becomes a lead. Replies are labelled automatically, leads move through your
        pipeline stages, and website tracking and lead capture forms add new leads.
      </>
    ),
    link: { to: '/crm', label: 'Open CRM' },
  },
  {
    icon: Bot,
    title: 'AI Agent',
    body: <>Ask the AI Agent about your campaigns and stats, or let it prepare actions that you confirm before they run.</>,
    link: { to: '/agent', label: 'Open AI Agent' },
  },
  {
    icon: Settings,
    title: 'SMTP & account',
    body: (
      <>
        Connect your mail accounts (SMTP) under Settings, set the sender name and email, and choose which account the
        reports and inbox show.
      </>
    ),
    link: { to: '/settings', label: 'Open settings' },
  },
];

export function Help() {
  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Help & documentation</h1>
        <p className="text-gray-500 mt-1">A short guide to every part of MailFlow.</p>
      </div>

      {SECTIONS.map((s) => (
        <Card key={s.title}>
          <CardContent className="pt-6">
            <div className="flex items-start gap-3 mb-3">
              <div className="p-2 bg-gray-100 rounded-lg flex-shrink-0">
                <s.icon className="w-5 h-5 text-gray-600" />
              </div>
              <div>
                <h2 className="font-semibold text-gray-900">{s.title}</h2>
                <p className="text-sm text-gray-600 mt-1">{s.body}</p>
                {s.link && (
                  <Link
                    to={s.link.to}
                    className="inline-flex items-center text-sm text-blue-600 font-medium mt-3 hover:text-blue-700"
                  >
                    {s.link.label}
                    <ArrowRight className="w-3.5 h-3.5 ml-1" />
                  </Link>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
