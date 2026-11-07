/**
 * A stand-in for `pi --mode rpc` in rpc.test.ts: answers get_state; a prompt
 * emits an event with U+2028 inside a string (CRLF-terminated), a select
 * dialog, and after its answer agent_settled; "crash" exits with code 3.
 * Closing stdin exits 0.
 */

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  const lines = (buffer + chunk).split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines.filter((l) => l.trim() !== "")) handle(JSON.parse(line) as { id?: string; type: string; message?: string; value?: string });
});
process.stdin.on("end", () => process.exit(0));

function out(record: object, crlf = false): void {
  process.stdout.write(`${JSON.stringify(record)}${crlf ? "\r\n" : "\n"}`);
}

function handle(command: { id?: string; type: string; message?: string; value?: string }): void {
  switch (command.type) {
    case "get_state":
      out({ id: command.id, type: "response", command: "get_state", success: true, data: { cwd: process.cwd(), env: process.env.ONLY_THIS ?? null } });
      return;
    case "prompt":
      if (command.message === "crash") {
        process.stderr.write("fatal: crashed on purpose\n");
        process.exit(3);
      }
      out({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
      out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a\u2028b\u2029c" } }, true);
      out({ type: "extension_ui_request", id: "ui1", method: "select", title: "Pick", options: ["x", "y"] });
      return;
    case "extension_ui_response":
      out({ type: "agent_settled", aborted: false, picked: command.value });
      return;
    default:
      out({ id: command.id, type: "response", command: command.type, success: false, error: `unknown command ${command.type}` });
  }
}
