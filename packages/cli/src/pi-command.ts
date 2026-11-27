// pi's own commands (auth, config, mcp, install, remove, uninstall, list, update) on harness's data
// directory: the bundled pi CLI with PI_CODING_AGENT_DIR=~/.harness/agent, so logins, MCP servers
// and packages land where harness's agents read them.

import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { layoutOf } from "#protocol/layout.ts";

export function piCommand(home: string, args: string[]): number {
  const cli = join(getPackageDir(), "dist", "bundle", "cli.js");
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: layoutOf(home).agent, PI_SKIP_VERSION_CHECK: "1" } });
  if (result.error !== undefined) {
    process.stderr.write(`harness ${args[0]}: ${result.error.message}\n`);
    return 1;
  } else {
    return result.status ?? 1;
  }
}
