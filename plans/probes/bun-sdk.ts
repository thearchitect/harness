// Probe for gate G1 of plans/harness-platform-plan.md: the pi SDK under bun with the bundle's
// extensions and a scripted (faux) model — one turn calls codemode, which calls bash.
//
//   HARNESS_NODE_MODULES=$(nix build --no-link --print-out-paths .#npmTools)/node_modules \
//     bun plans/probes/bun-sdk.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NM = process.env.HARNESS_NODE_MODULES;
if (NM === undefined || NM === "") {
  console.error("HARNESS_NODE_MODULES is not set: point it at the bundle's node_modules");
  process.exit(2);
}

const repo = join(import.meta.dir, "..", "..");
const agentDir = mkdtempSync(join(tmpdir(), "harness-bun-probe-"));
const pi = await import(`${NM}/@earendil-works/pi-coding-agent/dist/index.js`);
const ai = await import(`${NM}/@earendil-works/pi-ai/dist/index.js`);

const loader = new pi.DefaultResourceLoader({
  cwd: agentDir,
  agentDir,
  additionalExtensionPaths: [
    repo,
    `${NM}/@cortexkit/pi-magic-context`,
    `${NM}/pi-ask-user/index.ts`,
    `${NM}/pi-ollama-cloud`,
    `${NM}/pi-deepseek-search`,
    `${NM}/@narumitw/pi-usage`,
  ],
  extensionFactories: [pi.createCodemodeExtension(), pi.createMcpExtension()],
});
await loader.reload();
{
  const ext = loader.getExtensions();
  console.log("extensions:", ext.extensions.map((e: { path: string }) => e.path.replace(NM, "NM")));
  console.log("extension errors:", JSON.stringify(ext.errors));
}

const faux = ai.fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const modelRuntime = await pi.ModelRuntime.create({ agentDir });
modelRuntime.registerNativeProvider(faux.provider);
faux.setResponses([
  ai.fauxAssistantMessage(
    ai.fauxToolCall("codemode", { code: 'const r = await tools.bash({ command: "echo hi-from-bash" }); text(r.output);' }),
    { stopReason: "toolUse" },
  ),
  ai.fauxAssistantMessage("done"),
]);

const { session } = await pi.createAgentSession({
  cwd: agentDir,
  agentDir,
  resourceLoader: loader,
  sessionManager: pi.SessionManager.inMemory(),
  modelRuntime,
  model: faux.getModel(),
});
await session.bindExtensions({});
console.log("tools:", session.getActiveToolNames());

await session.prompt("run it");
for (const m of session.messages) {
  if (m.role === "toolResult") {
    console.log("toolResult:", JSON.stringify(m.content).slice(0, 300));
  } else {
    // Only tool results carry the evidence of the codemode → bash chain.
  }
}
console.log("last:", session.getLastAssistantText());

// The process does not exit by itself after dispose() (a G1 finding): exit explicitly.
session.dispose();
console.log("ok");
process.exit(0);
