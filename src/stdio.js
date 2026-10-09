// MCP over stdio. Logs go to stderr; stdout carries the protocol only.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";

/** @param {import("./store.js").Store} store */
export async function runStdio(store) {
  const server = createMcpServer(store);
  await server.connect(new StdioServerTransport());
  return server;
}
