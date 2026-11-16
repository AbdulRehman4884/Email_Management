/**
 * src/types/scripts.ts
 *
 * Shapes returned by the MailFlow backend script-generation endpoints.
 */

import type { ScriptType } from "../schemas/enrichment.schemas.js";

export interface SavedScriptFile {
  fileId:       number;
  filename:     string;
  companyCount: number;
  totalRows:    number;
  report:       Record<string, number>;
  createdAt:    string;
}

export interface SavedCompanyScript {
  type:                ScriptType;
  status:              "ok" | "insufficient_data";
  angle:               "website" | "industry";
  whatTheySell:        string;
  problemStatement:    string;
  painPoints:          string[];
  recommendedServices: string[];
  subject:             string | null;
  script:              string;
  wordCount:           number;
  updatedAt:           string;
}

export interface ScriptCompany {
  id:                number;
  fileId:            number;
  filename:          string;
  userInstructions:  string | null;
  rowNumber:         number;
  companyName:       string;
  website:           string;
  extraFields:       Record<string, string>;
  hasWebsiteContent: boolean;
  /** Present only when requested with includeContent. */
  websiteContent?:   string | null;
  scripts:           Partial<Record<ScriptType, SavedCompanyScript>>;
}
