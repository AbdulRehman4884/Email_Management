/**
 * src/config/companyServices.ts
 *
 * Single source of truth for who we are and what we sell.
 * Used by the script generator (generate_outreach_script) to decide
 * which service fits a company's problems and how to pitch it.
 *
 * To add or change a service: edit SERVICES below. No prompt code changes needed.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServiceDefinition {
  /** Short stable code, used in logs and tests. */
  readonly id: string;
  /** Display name. The AI must return exactly this string in recommendedServices. */
  readonly name: string;
  /** What we can actually deliver — written the way an experienced engineer would describe it. */
  readonly whatWeDo: string;
  /** Problems visible in a company's website TEXT that point to this service. */
  readonly signals: readonly string[];
  /** One-line value statement for the script. */
  readonly pitch: string;
  /**
   * REAL results from Dalta Prime projects that email and call scripts may quote
   * word for word, numbers included. Example of the format:
   *   "Cut first-reply time on support emails from 6 hours to under 5 minutes for a 12-person clinic"
   * Leave the list empty until there is a real, verifiable result — scripts then
   * describe the outcome without a number. Never put invented figures here.
   */
  readonly proofPoints: readonly string[];
}

// ── Company ───────────────────────────────────────────────────────────────────

export const COMPANY = {
  name: "Dalta Prime AI Solution",
  callerName: "Reyan",
} as const;

// ── Services ──────────────────────────────────────────────────────────────────

// TODO(Dalta Prime): fill proofPoints with real project results (see ServiceDefinition).
export const SERVICES: readonly ServiceDefinition[] = [
  {
    id: "ai_automation",
    name: "AI Automation",
    whatWeDo:
      "Automate repetitive work with AI: document and invoice processing, email triage " +
      "and drafted replies, data entry, report generation, and AI chatbots for support " +
      "and lead capture.",
    signals: [
      "High volume of customer inquiries or support requests",
      "Slow response promises such as \"we reply within 24-48 hours\"",
      "Quotes, orders or bookings requested manually by email or form",
      "Long FAQ pages answering the same questions repeatedly",
      "Mentions of a large support or back-office team",
    ],
    pitch: "Cut hours of repetitive work and respond to customers instantly.",
    proofPoints: [],
  },
  {
    id: "agentic_ai",
    name: "Agentic AI",
    whatWeDo:
      "AI agents that plan and act across tools with human approval: AI sales/SDR agents, " +
      "support agents that resolve tickets end-to-end, research agents, and internal " +
      "operations agents.",
    signals: [
      "Complex multi-step customer journeys (onboarding, claims, applications)",
      "Large sales or support operations",
      "Knowledge-heavy work such as legal, finance, insurance or healthcare administration",
      "The company talks about adopting AI or digital transformation",
    ],
    pitch: "An AI agent that completes the whole task end-to-end, not just one step.",
    proofPoints: [],
  },
  {
    id: "n8n",
    name: "n8n",
    whatWeDo:
      "Connect existing tools (CRM, email, Google Sheets, Slack, payments) into automated " +
      "workflows with n8n, self-hosted for full data control: lead routing, data sync, " +
      "alerts and approvals.",
    signals: [
      "Uses many separate SaaS tools or has an integrations page",
      "Data appears to be copied between systems by hand",
      "Privacy-sensitive industry where data control matters",
      "Growing small or mid-sized business adding new tools",
    ],
    pitch: "Your tools talk to each other: no double entry, full control of your data.",
    proofPoints: [],
  },
  {
    id: "ghl",
    name: "GHL (GoHighLevel)",
    whatWeDo:
      "GoHighLevel setup and management: CRM and sales pipelines, instant SMS/email lead " +
      "follow-up, online booking with reminders, funnels, review requests, and " +
      "white-label setups for agencies.",
    signals: [
      "Local service business (clinic, dentist, real estate, salon, gym, home services) or a marketing agency",
      "\"Call to book\" or \"call for an appointment\" with no online booking",
      "Contact form with no promise of an instant reply",
      "No visible way to capture and follow up with leads automatically",
    ],
    pitch: "Never lose a lead again: instant follow-up and self-booking, 24/7.",
    proofPoints: [],
  },
  {
    id: "web_development",
    name: "Web Development",
    whatWeDo:
      "Modern responsive websites, e-commerce stores, landing pages, CMS setups and " +
      "conversion-focused redesigns.",
    signals: [
      "Old copyright year in the footer",
      "No online booking, ordering or clear call-to-action",
      "Thin, outdated or placeholder content",
      "Sells products but has no online store",
    ],
    pitch: "A website that turns visitors into customers.",
    proofPoints: [],
  },
  {
    id: "software_development",
    name: "Software Development",
    whatWeDo:
      "Custom web and mobile apps, SaaS platforms, customer portals, internal tools, " +
      "API integrations and legacy system modernization.",
    signals: [
      "Orders or requests handled by phone or email instead of a portal",
      "No customer portal or mobile app where customers would expect one",
      "\"App coming soon\" or similar announcements",
      "Hiring software developers",
      "Mentions of legacy or outdated internal systems",
    ],
    pitch: "Custom software that replaces slow manual or legacy processes.",
    proofPoints: [],
  },
  {
    id: "qa",
    name: "QA",
    whatWeDo:
      "Manual and automated testing for web, mobile and APIs: regression suites, load " +
      "testing and test automation inside CI pipelines.",
    signals: [
      "Software or SaaS company",
      "Frequent releases, a changelog or release notes",
      "Apps published on the App Store or Google Play",
      "Hiring QA or test engineers",
      "Fintech, healthcare or other industries where bugs are costly",
    ],
    pitch: "Ship faster without breaking things for your users.",
    proofPoints: [],
  },
];

/** Exact names the AI is allowed to return. Used to reject invented services. */
export const SERVICE_NAMES: ReadonlySet<string> = new Set(SERVICES.map((s) => s.name));

// ── Selection rules (goes into the prompt verbatim) ───────────────────────────

export const SERVICE_SELECTION_RULES = [
  "Recommend at most 2 services. Put the one with the strongest signal first.",
  "Use only problems visible in the website TEXT. You cannot see design, speed or images, so never claim the site is slow or looks outdated unless the text says so.",
  "When services overlap: a local service business needing lead follow-up or booking -> GHL (GoHighLevel); connecting tools they already use -> n8n; one repetitive task -> AI Automation; multi-step work that needs decisions -> Agentic AI.",
  "If no signal clearly matches any service, choose the service that best fits the common pain points of their industry (industry angle).",
  "A website mostly describes what the company SELLS. Never treat their product or service features as their problems. Look for problems in how they run their own business: how customers contact them, book, get quotes, track orders, or get support.",
  "If the company itself builds or sells software (SaaS, apps, IT services), prefer QA or Software Development.",
  "Recommend Agentic AI only when the text clearly shows knowledge-heavy work or a large sales/support operation. Never use it as a default choice.",
  "Recommend GHL (GoHighLevel) only for local or appointment-based businesses (clinics, salons, gyms, real estate, home services) and marketing agencies. Never for B2B companies such as logistics, manufacturing or software.",
  "A missing feature is a weak signal. Prefer problems the text actually states or clearly shows (for example a \"call us for a quote\" line or an email-only contact).",
].join("\n");

// ── Prompt helper ─────────────────────────────────────────────────────────────

/**
 * Renders SERVICES as plain text for the prompt.
 * Keeps prompt-building code free of service details.
 */
export function buildServicesPromptBlock(): string {
  return SERVICES.map((s) =>
    [
      `### ${s.name}`,
      `What we do: ${s.whatWeDo}`,
      `Signals: ${s.signals.join("; ")}`,
      `Pitch: ${s.pitch}`,
      s.proofPoints.length > 0
        ? `Proof (real results — the only result numbers you may quote): ${s.proofPoints.join("; ")}`
        : "Proof: none yet — do not quote any result number for this service.",
    ].join("\n"),
  ).join("\n\n");
}

/** Proof points of the given services (by exact name) — the numbers a script may quote. */
export function proofPointsFor(serviceNames: readonly string[]): string[] {
  return SERVICES.filter((s) => serviceNames.includes(s.name)).flatMap((s) => s.proofPoints);
}