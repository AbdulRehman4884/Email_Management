/**
 * src/mcp/tools/enrichment/fetchWebsiteContent.tool.ts
 *
 * Fetches and returns cleaned text content from a public website.
 * Uses Jina Reader as the primary source, falling back to Firecrawl when
 * FIRECRAWL_API_KEY is configured. Content is capped at 8 000 characters.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { FetchWebsiteContentSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import { fetchWebsiteContent } from "../../../services/enrichment/websiteFetch.service.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { FetchWebsiteContentResult } from "../../../services/enrichment/websiteFetch.service.js";

export { type FetchWebsiteContentResult };

export const fetchWebsiteContentTool: McpToolDefinition<
  typeof FetchWebsiteContentSchema,
  FetchWebsiteContentResult
> = {
  name: TOOL_NAMES.FETCH_WEBSITE_CONTENT,

  description:
    "Fetches and returns the text content of a public website. " +
    "Uses Jina Reader (primary) with optional Firecrawl fallback. " +
    "Returns title, content (capped at 8 000 characters), content length, and source. " +
    "Suitable for extracting company descriptions, product info, and context for personalized outreach.",

  inputSchema: FetchWebsiteContentSchema,

  handler: async (input, context) => {
    context.log.debug({ url: input.url }, "fetch_website_content: starting");
    const result = await fetchWebsiteContent(input.url);

    if (!result.success) {
      context.log.warn(
        { url: input.url, source: result.source, error: result.error },
        "fetch_website_content: all sources failed",
      );
      return toolFailure(
        "FETCH_FAILED",
        result.error ?? "Failed to fetch website content",
        { url: result.url, source: result.source },
      );
    }

    context.log.debug(
      { url: result.url, source: result.source, contentLength: result.contentLength },
      "fetch_website_content: complete",
    );
    return toolSuccess(result);
  },
};
