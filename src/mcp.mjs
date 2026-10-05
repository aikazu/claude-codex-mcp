// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
// Implements initialize / ping / tools/list / tools/call plus progress
// notifications — everything this server needs, with no SDK dependency.

import readline from "node:readline";

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export function startMcpServer({
  name,
  version,
  instructions,
  tools,
  callTool,
  onClose,
  input = process.stdin,
  output = process.stdout,
}) {
  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);

  async function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    const reply = (result) => isRequest && send({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => isRequest && send({ jsonrpc: "2.0", id, error: { code, message } });

    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          instructions,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools });
      case "tools/call": {
        const token = params?._meta?.progressToken;
        let progress = 0;
        const ctx = {
          progress:
            token === undefined
              ? undefined
              : (job) =>
                  send({
                    jsonrpc: "2.0",
                    method: "notifications/progress",
                    params: {
                      progressToken: token,
                      progress: ++progress,
                      message: `codex ${job.kind} ${job.id}: ${job.status}`,
                    },
                  }),
        };
        try {
          return reply(await callTool(params?.name, params?.arguments, ctx));
        } catch (e) {
          return reply({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
        }
      }
      default:
        if (typeof method === "string" && method.startsWith("notifications/")) return;
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  const rl = readline.createInterface({ input });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg?.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e.message } });
    });
  });
  rl.on("close", () => onClose?.());
  return { send };
}
