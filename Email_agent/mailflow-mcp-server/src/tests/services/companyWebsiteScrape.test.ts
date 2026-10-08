import { describe, expect, it } from "vitest";
import { pickSubpageUrls } from "../../services/enrichment/websiteFetch.service.js";

describe("pickSubpageUrls", () => {
  it("prefers about/services links found on the homepage (same host)", () => {
    const home = [
      "[About Us](https://www.acme.com/company/about-us)",
      "[What we do](https://acme.com/what-we-do)",
      "[Partner](https://other.com/about)",
    ].join(" ");
    expect(pickSubpageUrls("https://acme.com", home)).toEqual({
      about:    "https://www.acme.com/company/about-us",
      services: "https://acme.com/what-we-do",
    });
  });

  it("falls back to /about and /services", () => {
    expect(pickSubpageUrls("https://acme.com/", "no links here")).toEqual({
      about:    "https://acme.com/about",
      services: "https://acme.com/services",
    });
  });
});
