/**
 * scripts/try-scripts.ts
 *
 * Manual quality check for generate_outreach_script. Reads each website once
 * (home + about + services),
 * writes all three scripts (LinkedIn, cold email, cold call) and prints them.
 * No MCP, no backend.
 *
 * Run from the mailflow-mcp-server folder (so .env is loaded):
 *   npx tsx scripts/try-scripts.ts "Company Name|https://example.com" "Other Co|https://other.com"
 */

import { fetchCompanyWebsite } from "../src/services/enrichment/websiteFetch.service.js";
import { getIntelligenceService } from "../src/services/openai/intelligenceService.js";
import { SCRIPT_TYPES } from "../src/schemas/enrichment.schemas.js";

async function main(): Promise<void> {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.log('Usage: npx tsx scripts/try-scripts.ts "Company|https://site.com" ...');
    process.exit(1);
  }

  const svc = getIntelligenceService();
  if (!svc) {
    console.log("OPENAI_API_KEY is not set in .env — cannot generate scripts.");
    process.exit(1);
  }

  for (const target of targets) {
    const [companyName, website] = target.split("|").map((s) => s.trim());
    if (!companyName || !website) {
      console.log(`Skipping "${target}" — use the format "Company|https://site.com"`);
      continue;
    }

    console.log("\n" + "=".repeat(70));
    console.log(`${companyName}  (${website})`);
    console.log("=".repeat(70));

    const fetched = await fetchCompanyWebsite(website);
    if (!fetched.success || !fetched.content) {
      console.log(`Website fetch failed: ${fetched.error ?? "no content"}`);
      continue;
    }
    console.log(`Fetched ${fetched.content.length} chars via ${fetched.source} — pages: ${fetched.pages.map((p) => `${p.kind}:${p.chars}`).join(", ")}`);

    for (const scriptType of SCRIPT_TYPES) {
      const started = Date.now();
      const result = await svc.generateOutreachScript({ scriptType, companyName, website, websiteContent: fetched.content });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);

      console.log(`\n--- ${scriptType}: ${result.status}, angle ${result.angle} (${result.wordCount} words, ${seconds}s)`);
      if (result.status !== "ok") continue;
      console.log(`Services: ${result.recommendedServices.join(", ")}`);
      console.log(`Problem:  ${result.problemStatement}`);
      if (result.subject) console.log(`Subject:  ${result.subject}`);
      console.log(result.script);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
