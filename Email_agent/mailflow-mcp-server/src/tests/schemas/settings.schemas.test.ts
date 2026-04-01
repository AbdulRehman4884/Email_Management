/**
 * src/tests/schemas/settings.schemas.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  GetSmtpSettingsSchema,
  UpdateSmtpSettingsSchema,
} from "../../schemas/settings.schemas.js";

describe("GetSmtpSettingsSchema", () => {
  it("accepts an empty object (no input required)", () => {
    expect(GetSmtpSettingsSchema.safeParse({}).success).toBe(true);
  });

  it("strips unknown fields (userId must not pass through)", () => {
    const result = GetSmtpSettingsSchema.safeParse({ userId: "user-1" });
    if (result.success) {
      expect((result.data as Record<string, unknown>).userId).toBeUndefined();
    }
  });
});

describe("UpdateSmtpSettingsSchema", () => {
  it("accepts a valid partial update", () => {
    const result = UpdateSmtpSettingsSchema.safeParse({ host: "smtp.example.com" });
    expect(result.success).toBe(true);
  });

  it("accepts a password field (write-only input)", () => {
    const result = UpdateSmtpSettingsSchema.safeParse({
      host: "smtp.example.com",
      password: "supersecret",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty object (no fields provided)", () => {
    const result = UpdateSmtpSettingsSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least one field/i);
    }
  });

  it("rejects a port below 1", () => {
    const result = UpdateSmtpSettingsSchema.safeParse({ port: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a port above 65535", () => {
    const result = UpdateSmtpSettingsSchema.safeParse({ port: 65536 });
    expect(result.success).toBe(false);
  });

  it("accepts valid port boundaries", () => {
    expect(UpdateSmtpSettingsSchema.safeParse({ port: 1 }).success).toBe(true);
    expect(UpdateSmtpSettingsSchema.safeParse({ port: 65535 }).success).toBe(true);
  });

  it("rejects an invalid encryption value", () => {
    const result = UpdateSmtpSettingsSchema.safeParse({ encryption: "starttls" });
    expect(result.success).toBe(false);
  });

  it("accepts all valid encryption values", () => {
    for (const enc of ["tls", "ssl", "none"] as const) {
      expect(UpdateSmtpSettingsSchema.safeParse({ encryption: enc }).success).toBe(true);
    }
  });

  it("rejects an invalid fromEmail", () => {
    const result = UpdateSmtpSettingsSchema.safeParse({
      fromEmail: "not-an-email",
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown fields including userId", () => {
    const result = UpdateSmtpSettingsSchema.safeParse({
      host: "smtp.example.com",
      userId: "attacker",
    });
    if (result.success) {
      expect((result.data as Record<string, unknown>).userId).toBeUndefined();
    }
  });
});
