import { describe, expect, it } from "vitest";
import { generateExecutiveTemplate } from "../bulkProcessingQueue.js";

describe("bulkProcessingQueue executive template quality", () => {
  it("differentiates Systems, NETSOL, and 10Pearls templates", () => {
    const systems = generateExecutiveTemplate({
      name: "Sara",
      email: "sara@systemsltd.com",
      company: "Systems Limited",
      website: "https://www.systemsltd.com",
      role: "VP Operations",
      industry: "enterprise transformation services",
      services: ["digital transformation"],
      signals: ["enterprise delivery complexity"],
      confidence: 0.86,
    });
    const netsol = generateExecutiveTemplate({
      name: "Ali",
      email: "ali@netsoltech.com",
      company: "NETSOL Technologies",
      website: "https://www.netsoltech.com",
      role: "Director Finance Operations",
      industry: "fintech and lending platform",
      services: ["lending platform"],
      signals: ["finance visibility need"],
      confidence: 0.84,
    });
    const pearls = generateExecutiveTemplate({
      name: "Mina",
      email: "mina@10pearls.com",
      company: "10Pearls",
      website: "https://10pearls.com",
      role: "Digital Transformation Lead",
      industry: "product engineering and innovation services",
      services: ["software engineering"],
      signals: ["transformation agenda"],
      confidence: 0.82,
    });

    expect(systems.subject).toMatch(/delivery|enterprise|scale/i);
    expect(netsol.subject).toMatch(/lending|platform/i);
    expect(pearls.subject).toMatch(/engineering|product/i);
    expect(new Set([systems.subject, netsol.subject, pearls.subject]).size).toBe(3);
    expect(`${systems.body}\n${netsol.body}\n${pearls.body}`).not.toMatch(/public positioning points to|practical executive question|workflow map|execution rhythm and context discipline|pressure-testing|credible outreach angle|read-only view|credibly claim|the relevant conversation is/i);
    expect(`${systems.body}\n${systems.followup1}\n${systems.followup2}\n${netsol.body}\n${pearls.body}`).not.toMatch(/{{sender_name}}/);
  });

  it("varies follow-up language and avoids weak CTA repetition", () => {
    const template = generateExecutiveTemplate({
      name: "Sara",
      email: "sara@example.com",
      company: "Systems Limited",
      website: "https://www.systemsltd.com",
      role: "VP Operations",
      industry: "enterprise transformation services",
      services: ["digital transformation"],
      signals: ["enterprise delivery complexity"],
      confidence: 0.86,
    });

    expect(template.followup1).not.toBe(template.followup2);
    expect(template.cta).not.toMatch(/Would a short review be useful|pressure-testing|read-only view/i);
    expect(template.body).toMatch(/commercial relevance|delivery|enterprise|account/i);
  });
});
