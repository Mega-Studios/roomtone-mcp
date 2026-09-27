#!/usr/bin/env node
/**
 * Roomtone MCP — an MCP server that lets AI agents work with the user's
 * Roomtone meeting notes through the Roomtone API.
 *
 * Auth: `Authorization: Bearer <ROOMTONE_API_KEY>` (keys start with `ak_`).
 * Get a key in the Roomtone web app → Settings → API keys.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.ROOMTONE_API_KEY;
const API_URL = (process.env.ROOMTONE_API_URL || "https://meganotes-api.fly.dev").replace(/\/+$/, "");

if (!API_KEY) {
  console.error(
    "Error: the ROOMTONE_API_KEY environment variable is not set.\n" +
      "Get an API key (starts with `ak_`) in the Roomtone app: Settings → API keys,\n" +
      "then configure it, e.g.:\n" +
      "  claude mcp add roomtone -e ROOMTONE_API_KEY=ak_... -- npx -y roomtone-mcp"
  );
  process.exit(1);
}

if (!API_KEY.startsWith("ak_")) {
  console.error("Warning: ROOMTONE_API_KEY does not start with `ak_` — this may not be a valid Roomtone API key.");
}

/** Calls the Roomtone API and returns the unwrapped `data` payload. Throws on non-2xx. */
async function api(method: string, path: string, options: { json?: unknown; form?: FormData } = {}): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${API_KEY}` };
  let body: string | FormData | undefined;
  if (options.form) {
    body = options.form; // fetch sets the multipart content-type + boundary itself
  } else if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers, body });
  } catch (err) {
    throw new Error(`Could not reach the Roomtone API at ${API_URL}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.detail ? JSON.stringify(parsed.detail) : parsed.error ? String(parsed.error) : text;
    } catch {
      // keep raw body
    }
    const hint =
      res.status === 401
        ? " (check that ROOMTONE_API_KEY is a valid, non-revoked Roomtone API key)"
        : "";
    throw new Error(`Roomtone API error ${res.status} on ${method} ${path}: ${detail}${hint}`);
  }

  if (!text) return null;
  const parsed = JSON.parse(text);
  // All Roomtone endpoints wrap their payload in {"data": ...}
  return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
}

const server = new McpServer({ name: "roomtone-mcp", version: "0.2.0" });

server.registerTool(
  "list_notebooks",
  {
    title: "List meetings",
    description:
      "List every meeting in the user's Roomtone account. Returns an array with " +
      "id, title, emoji, sources_count and updated_at (unix seconds), newest first. " +
      "Use the returned id with the other tools.",
    inputSchema: {},
  },
  async () => {
    try {
      const notebooks = (await api("GET", "/notebooks")) as Array<Record<string, unknown>>;
      const slim = notebooks.map(({ id, title, emoji, sources_count, updated_at }) => ({
        id,
        title,
        emoji,
        sources_count,
        updated_at,
      }));
      return ok(slim);
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "get_notebook",
  {
    title: "Get meeting",
    description:
      "Get one meeting by id, including its sources (each with id, type, url, filename, status, error) " +
      "and its generated note. Source status is 'pending', 'processing', " +
      "'done' or 'failed' — a source's transcript is only available once it is 'done'.",
    inputSchema: {
      notebook_id: z.string().describe("The meeting id, as returned by list_notebooks"),
    },
  },
  async ({ notebook_id }) => {
    try {
      const nb = (await api("GET", `/notebooks/${encodeURIComponent(notebook_id)}`)) as Record<string, unknown>;
      const sources = ((nb.sources as Array<Record<string, unknown>>) || []).map(
        ({ id, type, url, filename, status, error, created_at }) => ({ id, type, url, filename, status, error, created_at })
      );
      return ok({ ...nb, sources });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "create_notebook",
  {
    title: "Create meeting note",
    description:
      "Start a new meeting note with a title and optional emoji, ready for a source to be added to it. " +
      "Returns the created note including its id. Free-plan users have a quota on how many notes they can " +
      "hold; if it is reached this tool reports a friendly upgrade message instead of creating one.",
    inputSchema: {
      title: z.string().describe("Title for the new meeting note"),
      emoji: z.string().optional().describe("Emoji icon for the note (defaults to 📚)"),
    },
  },
  async ({ title, emoji }) => {
    try {
      const body: Record<string, string> = { title };
      if (emoji) body.emoji = emoji;
      return ok(await api("POST", "/notebooks", { json: body }));
    } catch (err) {
      if (err instanceof Error && /Roomtone API error 402/.test(err.message)) {
        return fail(
          "Free plan limit reached — this account already has the maximum number of meeting notes. " +
            "Upgrade to Pro in the Roomtone app to create more."
        );
      }
      return fail(err);
    }
  }
);

server.registerTool(
  "add_source",
  {
    title: "Add source",
    description:
      "Add a source to a meeting note. Supported types: 'youtube' (requires url — the video is transcribed " +
      "asynchronously; poll get_notebook until the source status is 'done') and 'text' (requires text — " +
      "stored immediately as the source transcript). A recording itself always comes from the Roomtone app, " +
      "not from this tool. Returns the created source with its id and status.",
    inputSchema: {
      notebook_id: z.string().describe("The meeting id to add the source to"),
      type: z.enum(["youtube", "text"]).describe("Source type: 'youtube' or 'text'"),
      url: z.string().optional().describe("YouTube video URL (required when type is 'youtube')"),
      text: z.string().optional().describe("Raw text content (required when type is 'text')"),
      lang: z.string().optional().describe("ISO language code for transcription/processing, e.g. 'en' (default) or 'ru'"),
    },
  },
  async ({ notebook_id, type, url, text, lang }) => {
    try {
      if (type === "youtube" && !url) return fail("url is required when type is 'youtube'");
      if (type === "text" && !text) return fail("text is required when type is 'text'");
      const form = new FormData();
      form.append("jsonData", JSON.stringify({ type, url, text, lang: lang || "en" }));
      return ok(await api("POST", `/notebooks/${encodeURIComponent(notebook_id)}/sources`, { form }));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "generate_note",
  {
    title: "Generate write-up",
    description:
      "Generate (or regenerate) the write-up for a meeting from its sources. Runs in the background: " +
      "the tool returns {status: 'generating', type}; call get_notebook afterwards to read the write-up " +
      "once it appears in the note's content list. Requires the meeting to have at least one processed source.",
    inputSchema: {
      notebook_id: z.string().describe("The meeting id to generate a write-up for"),
      type: z
        .literal("summary")
        .optional()
        .describe("Kind of write-up — only 'summary' is supported (also the default)"),
      lang: z.string().optional().describe("ISO language code for the generated write-up, e.g. 'en' (default)"),
    },
  },
  async ({ notebook_id, type, lang }) => {
    try {
      return ok(
        await api("POST", `/notebooks/${encodeURIComponent(notebook_id)}/generate`, {
          json: { type: type || "summary", lang: lang || "en" },
        })
      );
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "chat_with_sources",
  {
    title: "Chat with a meeting",
    description:
      "Ask a question about a meeting. The answer is grounded in the transcripts of the meeting's " +
      "processed sources. Returns the assistant's reply as text. If the meeting has no " +
      "processed sources yet, the reply will say so.",
    inputSchema: {
      notebook_id: z.string().describe("The meeting id to chat with"),
      message: z.string().describe("The question or message to ask about the meeting"),
    },
  },
  async ({ notebook_id, message }) => {
    try {
      const data = (await api("POST", `/notebooks/${encodeURIComponent(notebook_id)}/chat`, {
        json: { message, history: [], lang: "en" },
      })) as { reply?: string };
      return ok(data?.reply ?? data);
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "get_transcript",
  {
    title: "Get transcript",
    description:
      "Get the raw transcript text of a single source on a meeting note (source ids come from get_notebook). " +
      "Returns the transcript as plain text; it is empty/null until the source finishes processing.",
    inputSchema: {
      notebook_id: z.string().describe("The meeting id the source belongs to"),
      source_id: z.string().describe("The source id, as returned by get_notebook or add_source"),
    },
  },
  async ({ notebook_id, source_id }) => {
    try {
      const data = (await api(
        "GET",
        `/notebooks/${encodeURIComponent(notebook_id)}/sources/${encodeURIComponent(source_id)}/transcript`
      )) as { transcript?: string | null };
      if (data?.transcript == null) {
        return ok("(no transcript yet — the source may still be processing; check its status with get_notebook)");
      }
      return ok(data.transcript);
    } catch (err) {
      return fail(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Roomtone MCP server running on stdio (API: ${API_URL})`);
}

main().catch((err) => {
  console.error("Fatal error starting Roomtone MCP server:", err);
  process.exit(1);
});
