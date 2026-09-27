# Roomtone MCP

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that lets AI agents — Claude Code, Claude Desktop, and any other MCP client — work with your [Roomtone](https://roomtone.io) meeting notes.

Agents can list your meetings, read a note's write-up, add a source you already have (a YouTube link or pasted text), chat with what was said, and pull the raw transcript. Recording a meeting itself always happens in the Roomtone app — this server only reads and adds to what already exists.

## Getting an API key

1. Open the Roomtone web app and go to **Settings → API keys**.
2. Create a key — it starts with `ak_` and is shown **once**, so copy it right away.

More details: https://roomtone.io/mcp

## Setup

### Claude.ai (Connectors, no install)

Claude.ai connects directly to a remote MCP server over OAuth — this npm package (stdio)
isn't involved. In Claude.ai: **Settings → Connectors → Add custom connector**, and enter:

```
https://mcp.roomtone.io/mcp
```

Claude opens a sign-in prompt for your Roomtone account and asks you to approve access —
no API key needed. This remote server is implemented directly in the Roomtone backend
(`backend/app/mcp_server.py` + `backend/app/oauth_provider.py`), sharing the same 7 tools.

### Claude Code

```bash
claude mcp add roomtone -e ROOMTONE_API_KEY=ak_... -- npx -y roomtone-mcp
```

### Any MCP client (generic `mcpServers` JSON)

```json
{
  "mcpServers": {
    "roomtone": {
      "command": "npx",
      "args": ["-y", "roomtone-mcp"],
      "env": {
        "ROOMTONE_API_KEY": "ak_..."
      }
    }
  }
}
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ROOMTONE_API_KEY` | Yes | Your Roomtone API key (`ak_...`). The server exits with an error if it is missing. |
| `ROOMTONE_API_URL` | No | API base URL. Defaults to `https://meganotes-api.fly.dev`. |

## Tools

| Tool | Description |
|---|---|
| `list_notebooks` | List every meeting (id, title, emoji, sources_count, updated_at). |
| `get_notebook` | Get one meeting with its sources (id, type, url, status) and its generated note. |
| `create_notebook` | Start a meeting note with a title and optional emoji. Reports a friendly message if the free-plan limit is reached. |
| `add_source` | Add a source: `youtube` (by URL, transcribed asynchronously) or `text` (stored immediately). |
| `generate_note` | Generate or regenerate the write-up (only `summary` is supported). Runs in the background — read the result via `get_notebook`. |
| `chat_with_sources` | Ask a question answered from the meeting's transcript. |
| `get_transcript` | Get the raw transcript text of a single source. |

## Development

Requires Node.js 18+.

```bash
npm install
npm run build   # tsc → dist/
ROOMTONE_API_KEY=ak_... node dist/index.js
```

The server speaks MCP over stdio. On startup it prints a status line to stderr and then waits for JSON-RPC messages on stdin.

## License

MIT
