/**
 * Sanitized SMTP failure analysis for worker logs and recipient.lastSendError.
 * Never includes passwords or credentials beyond the SMTP login email.
 */

export type SmtpFailureCategory =
  | "smtp_missing_config"
  | "smtp_auth"
  | "smtp_gmail_app_password"
  | "smtp_tls_connection"
  | "smtp_recipient_rejected"
  | "smtp_sender_mismatch"
  | "smtp_rate_limit"
  | "smtp_unknown";

export interface SmtpErrorParts {
  message: string;
  code?: string;
  responseCode?: number;
  response?: string;
  command?: string;
}

export function extractSmtpErrorParts(err: unknown): SmtpErrorParts {
  const message = err instanceof Error ? err.message : String(err);
  let code: string | undefined;
  let responseCode: number | undefined;
  let response: string | undefined;
  let command: string | undefined;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.code === "string") code = o.code;
    if (typeof o.command === "string") command = o.command;
    if (typeof o.response === "string") response = o.response;
    else if (typeof o.response === "number") response = String(o.response);
    if (typeof o.responseCode === "number") responseCode = o.responseCode;
    else if (typeof o.responseCode === "string") responseCode = Number.parseInt(o.responseCode, 10);
  }
  return { message, code, responseCode, response, command };
}

function includes535(text: string | undefined): boolean {
  if (!text) return false;
  return /\b535\b/.test(text) || text.includes("5.7.8") || text.toLowerCase().includes("username and password not accepted");
}

function isGmailHost(host: string): boolean {
  return host.toLowerCase().includes("smtp.gmail.com");
}

export interface ClassifiedSmtpFailure {
  category: SmtpFailureCategory;
  /** Short line for logs (no secrets). */
  summary: string;
  /** Stored on recipient + shown in live test. */
  detailForRecipient: string;
}

export function classifySmtpSendFailure(
  err: unknown,
  ctx: { smtpHost: string; smtpPort: number; smtpUser: string; campaignFromEmail: string },
): ClassifiedSmtpFailure {
  const parts = extractSmtpErrorParts(err);
  const combined = `${parts.message}\n${parts.response ?? ""}`.toLowerCase();
  const responseUpper = (parts.response ?? "").toUpperCase();

  if (parts.message.includes("SMTP host is not configured")) {
    return {
      category: "smtp_missing_config",
      summary: "SMTP host missing",
      detailForRecipient:
        "SMTP settings are not configured for this user. Add host/port/user in Settings (or server SMTP_HOST).",
    };
  }
  if (parts.message.includes("SMTP username or password is empty")) {
    return {
      category: "smtp_missing_config",
      summary: "SMTP credentials missing",
      detailForRecipient: parts.message,
    };
  }

  if (!ctx.smtpHost?.trim() || (!ctx.smtpUser?.trim() && combined.includes("auth"))) {
    return {
      category: "smtp_missing_config",
      summary: "SMTP host/user missing or unusable",
      detailForRecipient:
        "SMTP settings are not configured for this user (or username is empty). Configure SMTP in Settings, or set SMTP_HOST/SMTP_USER on the server for environment fallback.",
    };
  }

  if (
    parts.code === "ETIMEDOUT" ||
    parts.code === "ECONNREFUSED" ||
    parts.code === "ENOTFOUND" ||
    (combined.includes("tls") && combined.includes("wrong version")) ||
    combined.includes("certificate") ||
    combined.includes("ssl routines")
  ) {
    return {
      category: "smtp_tls_connection",
      summary: `TLS/connection failure (${parts.code ?? "unknown"})`,
      detailForRecipient: `TLS or network error connecting to ${ctx.smtpHost}:${ctx.smtpPort}. code=${parts.code ?? "n/a"} message=${parts.message}`,
    };
  }

  if (
    parts.responseCode === 421 ||
    combined.includes("rate limit") ||
    combined.includes("too many") ||
    responseUpper.includes("454") ||
    responseUpper.includes("452")
  ) {
    return {
      category: "smtp_rate_limit",
      summary: "SMTP rate limit / temporary failure",
      detailForRecipient: `Rate limit or temporary SMTP error. responseCode=${parts.responseCode ?? "n/a"} message=${parts.message}`,
    };
  }

  const resp = parts.response ?? "";
  if (
    /\b5\.1\.1\b/i.test(resp) ||
    combined.includes("user unknown") ||
    combined.includes("no such user") ||
    combined.includes("mailbox unavailable") ||
    (combined.includes("recipient") && combined.includes("rejected") && !combined.includes("sender"))
  ) {
    return {
      category: "smtp_recipient_rejected",
      summary: "Recipient rejected by SMTP server",
      detailForRecipient: `Recipient rejected by server. responseCode=${parts.responseCode ?? "n/a"} message=${parts.message}`,
    };
  }

  if (
    /\b5\.7\.1\b/i.test(resp) ||
    combined.includes("sender") && (combined.includes("not allowed") || combined.includes("verify") || combined.includes("mismatch")) ||
    combined.includes("from address") && combined.includes("not")
  ) {
    return {
      category: "smtp_sender_mismatch",
      summary: "Sender / From address rejected",
      detailForRecipient: `Sender rejected by SMTP. Campaign fromEmail=${ctx.campaignFromEmail} (must match authenticated account for many providers). message=${parts.message}`,
    };
  }

  const authLike =
    parts.code === "EAUTH" ||
    parts.responseCode === 535 ||
    includes535(parts.response) ||
    includes535(parts.message) ||
    combined.includes("authentication failed") ||
    combined.includes("535-") ||
    combined.includes("534-5.7.9");

  if (authLike) {
    if (isGmailHost(ctx.smtpHost) || ctx.smtpUser.toLowerCase().endsWith("@gmail.com")) {
      return {
        category: "smtp_gmail_app_password",
        summary: "Gmail SMTP rejected login",
        detailForRecipient:
          "Gmail SMTP rejected login. Use a Gmail App Password, not normal account password. (Google: Security → 2-Step Verification → App passwords.) " +
          `responseCode=${parts.responseCode ?? "n/a"} message=${parts.message}`,
      };
    }
    return {
      category: "smtp_auth",
      summary: "SMTP authentication failed",
      detailForRecipient: `SMTP authentication failed for user=${ctx.smtpHost}:${ctx.smtpPort} login=${ctx.smtpUser}. code=${parts.code ?? "n/a"} responseCode=${parts.responseCode ?? "n/a"} message=${parts.message}`,
    };
  }

  return {
    category: "smtp_unknown",
    summary: "SMTP send failed",
    detailForRecipient: `SMTP error. code=${parts.code ?? "n/a"} responseCode=${parts.responseCode ?? "n/a"} message=${parts.message}${parts.response ? ` response=${parts.response.slice(0, 500)}` : ""}`,
  };
}

export function truncateLastSendError(s: string, maxLen = 2000): string {
  const t = s.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 20)}…[truncated]`;
}
