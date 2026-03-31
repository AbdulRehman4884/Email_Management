/**
 * src/schemas/settings.schemas.ts
 *
 * Zod input schemas for settings-related MCP tools: get_smtp_settings, update_smtp_settings.
 *
 * Security rules:
 *  - userId is NEVER a schema field
 *  - password and username are accepted as write-only inputs and masked in all logs
 *  - updateSmtpSettings requires at least one field via .refine()
 *  - Port is validated within TCP range (1–65535)
 */

import { z } from "zod";

// ── getSmtpSettings ───────────────────────────────────────────────────────────

/**
 * No input parameters — SMTP settings are scoped to the authenticated user
 * resolved from the bearer token, never from tool input.
 */
export const GetSmtpSettingsSchema = z.object({});

export type GetSmtpSettingsInput = z.infer<typeof GetSmtpSettingsSchema>;

// ── updateSmtpSettings ────────────────────────────────────────────────────────

export const UpdateSmtpSettingsSchema = z
  .object({
    /** SMTP server hostname or IP */
    host: z
      .string()
      .min(1, "host must not be empty")
      .max(255, "host must be 255 characters or fewer")
      .trim()
      .optional(),

    /** SMTP port number */
    port: z
      .number({ invalid_type_error: "port must be a number" })
      .int("port must be an integer")
      .min(1, "port must be at least 1")
      .max(65535, "port must be 65535 or fewer")
      .optional(),

    /**
     * SMTP authentication username.
     * Write-only — masked in logs, never returned in responses.
     */
    username: z
      .string()
      .min(1, "username must not be empty")
      .max(320, "username must be 320 characters or fewer")
      .optional(),

    /**
     * SMTP authentication password.
     * Write-only — masked in ALL logs and NEVER included in tool output.
     */
    password: z
      .string()
      .min(1, "password must not be empty")
      .optional(),

    /** Transport encryption type */
    encryption: z
      .enum(["tls", "ssl", "none"], {
        errorMap: () => ({
          message: 'encryption must be one of "tls", "ssl", or "none"',
        }),
      })
      .optional(),

    /** From address used in sent emails */
    fromEmail: z
      .string()
      .email("fromEmail must be a valid email address")
      .optional(),

    /** From display name used in sent emails */
    fromName: z
      .string()
      .min(1)
      .max(255)
      .trim()
      .optional(),
  })
  .refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: "At least one field to update must be provided" },
  );

export type UpdateSmtpSettingsInput = z.infer<typeof UpdateSmtpSettingsSchema>;
