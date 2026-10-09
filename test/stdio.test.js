import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("rostra mcp speaks MCP on stdio", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rostra-stdio-"));
  const client = new Client({ name: "test", version: "0" });
  try {
    const bin = fileURLToPath(new URL("../bin/rostra.js", import.meta.url));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "--db", join(dir, "r.db"), "mcp"], stderr: "pipe" }));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    const r = await client.callTool({ name: "add_agent", arguments: { name: "Stdio" } });
    assert.equal(JSON.parse(r.content[0].text).name, "Stdio");
    const s = await client.callTool({ name: "pipeline_summary", arguments: {} });
    assert.equal(JSON.parse(s.content[0].text).agents.prospect, 1);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
