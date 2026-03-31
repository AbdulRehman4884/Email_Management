/**
 * src/tests/tools/getSmtpSettings.tool.test.ts
 *
 * Verifies SMTP masking behaviour and error handling.
 * Primary security assertion: username is always *** in tool output.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { getSmtpSettingsTool } from "../../mcp/tools/settings/getSmtpSettings.tool.js";
import { updateSmtpSettingsTool } from "../../mcp/tools/settings/updateSmtpSettings.tool.js";
import { createMockToolContext, createMockMailflowClient } from "../helpers.js";
import { MASKED_VALUE } from "../../config/constants.js";
import { MailFlowApiError } from "../../lib/errors.js";
import type { SmtpSettings } from "../../types/mailflow.js";
import type { SmtpSettingsId } from "../../types/common.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REAL_USERNAME = "smtp-user@example.com";

const mockSmtpSettings: SmtpSettings = {
  id: "smtp-1" as SmtpSettingsId,
  host: "smtp.example.com",
  port: 587,
  username: REAL_USERNAME,
  encryption: "tls",
  fromEmail: "no-reply@example.com",
  fromName: "Example",
  isVerified: true,
  updatedAt: "2025-01-01T00:00:00Z",
};

// ── getSmtpSettings ───────────────────────────────────────────────────────────

describe("getSmtpSettingsTool.handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("masks the username in the returned settings", async () => {
    const mailflow = createMockMailflowClient({
      getSmtpSettings: vi.fn().mockResolvedValue(mockSmtpSettings),
    });
    const context = createMockToolContext({ mailflow });

    const result = await getSmtpSettingsTool.handler({}, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.username).toBe(MASKED_VALUE);
      expect(result.data.username).not.toBe(REAL_USERNAME);
    }
  });

  it("never exposes the real username through the MCP channel", async () => {
    const mailflow = createMockMailflowClient({
      getSmtpSettings: vi.fn().mockResolvedValue({
        ...mockSmtpSettings,
        username: "sensitive-smtp-login",
      }),
    });
    const context = createMockToolContext({ mailflow });

    const result = await getSmtpSettingsTool.handler({}, context);

    // Serialize to JSON (as toolExecution.service would do) and check raw string
    const json = JSON.stringify(result);
    expect(json).not.toContain("sensitive-smtp-login");
    expect(json).toContain(MASKED_VALUE);
  });

  it("returns non-masked fields unchanged", async () => {
    const mailflow = createMockMailflowClient({
      getSmtpSettings: vi.fn().mockResolvedValue(mockSmtpSettings),
    });
    const context = createMockToolContext({ mailflow });

    const result = await getSmtpSettingsTool.handler({}, context);

    if (result.success) {
      expect(result.data.host).toBe("smtp.example.com");
      expect(result.data.port).toBe(587);
      expect(result.data.encryption).toBe("tls");
      expect(result.data.isVerified).toBe(true);
    }
  });

  it("returns toolFailure when API returns 404", async () => {
    const mailflow = createMockMailflowClient({
      getSmtpSettings: vi.fn().mockRejectedValue(
        new MailFlowApiError(404, "SMTP settings not found"),
      ),
    });
    const context = createMockToolContext({ mailflow });

    const result = await getSmtpSettingsTool.handler({}, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("MAILFLOW_NOT_FOUND");
    }
  });

  it("has name matching TOOL_NAMES.GET_SMTP_SETTINGS constant", () => {
    expect(getSmtpSettingsTool.name).toBe("get_smtp_settings");
  });
});

// ── updateSmtpSettings — SMTP masking ─────────────────────────────────────────

describe("updateSmtpSettingsTool.handler — SMTP masking", () => {
  beforeEach(() => vi.clearAllMocks());

  it("masks the username in the response even after an update", async () => {
    const mailflow = createMockMailflowClient({
      updateSmtpSettings: vi.fn().mockResolvedValue(mockSmtpSettings),
    });
    const context = createMockToolContext({ mailflow });

    const result = await updateSmtpSettingsTool.handler(
      { host: "smtp.new.com" },
      context,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.username).toBe(MASKED_VALUE);
    }
  });

  it("password sent to the API client is not echoed back in the result", async () => {
    const mailflow = createMockMailflowClient({
      updateSmtpSettings: vi.fn().mockResolvedValue(mockSmtpSettings),
    });
    const context = createMockToolContext({ mailflow });

    const result = await updateSmtpSettingsTool.handler(
      { password: "my-secret-password" },
      context,
    );

    // The response should never contain the password
    const json = JSON.stringify(result);
    expect(json).not.toContain("my-secret-password");
  });

  it("forwards update fields to mailflow.updateSmtpSettings", async () => {
    const updateSmtpSettings = vi.fn().mockResolvedValue(mockSmtpSettings);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ updateSmtpSettings }),
    });

    await updateSmtpSettingsTool.handler(
      { host: "smtp.new.com", port: 465, encryption: "ssl" },
      context,
    );

    expect(updateSmtpSettings).toHaveBeenCalledOnce();
    const [payload] = updateSmtpSettings.mock.calls[0]!;
    expect(payload.host).toBe("smtp.new.com");
    expect(payload.port).toBe(465);
    expect(payload.encryption).toBe("ssl");
  });
});
