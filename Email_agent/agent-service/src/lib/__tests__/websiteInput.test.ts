import { describe, it, expect } from "vitest";
import {
  isEmailLike,
  isValidWebsiteInput,
  normalizeWebsiteUrlOrUndefined,
} from "../websiteInput.js";

describe("websiteInput", () => {
  describe("isEmailLike", () => {
    it("detects plain emails", () => {
      expect(isEmailLike("deltaprimeaisolutions@gmail.com")).toBe(true);
      expect(isEmailLike("ali@aktraders.com")).toBe(true);
    });

    it("does not flag bare domains", () => {
      expect(isEmailLike("openai.com")).toBe(false);
      expect(isEmailLike("stripe.com")).toBe(false);
    });
  });

  describe("normalizeWebsiteUrlOrUndefined", () => {
    it("accepts common domain shapes", () => {
      expect(normalizeWebsiteUrlOrUndefined("openai.com")).toBe("https://openai.com");
      expect(normalizeWebsiteUrlOrUndefined("www.openai.com")).toBe("https://openai.com");
      expect(normalizeWebsiteUrlOrUndefined("https://openai.com")).toBe("https://openai.com");
      expect(normalizeWebsiteUrlOrUndefined("stripe.com")).toBe("https://stripe.com");
    });

    it("rejects emails and garbage", () => {
      expect(normalizeWebsiteUrlOrUndefined("deltaprime@gmail.com")).toBe(undefined);
      expect(normalizeWebsiteUrlOrUndefined("hello world")).toBe(undefined);
    });
  });

  describe("isValidWebsiteInput", () => {
    it("matches valid inputs", () => {
      expect(isValidWebsiteInput("https://openai.com/path")).toBe(true);
      expect(isValidWebsiteInput("stripe.com")).toBe(true);
    });

    it("rejects invalid inputs", () => {
      expect(isValidWebsiteInput("not-a-domain")).toBe(false);
    });
  });
});
