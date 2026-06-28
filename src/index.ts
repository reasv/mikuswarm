import { loadConfig } from "./config/index.js";
import { seedConfigDir } from "./bootstrap/seed.js";
import { startMikuAgent } from "./app.js";

// First-run config seeding (ARCHITECTURE.md §4 "First-run seeding"). MUST run
// BEFORE loadConfig — the loader fail-fasts on a missing/empty config dir, so a
// fresh deploy needs its 00-defaults.toml + 90-local.toml copied in first. This
// is copy-missing/never-overwrite and a strict no-op when the files exist (the
// live + current-image case), and it fails SAFE (logs + continues) so it can
// never turn a real config problem into a crash here.
const configDir = process.env.MIKUSWARM_AGENT_CONFIG_DIR ?? "./config";
await seedConfigDir(configDir, console);

const config = await loadConfig(configDir);
const runtime = await startMikuAgent(config);

let exiting = false;

async function stopAndExit(code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  await runtime.stop().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    code = code || 1;
  });
  process.exit(code);
}

process.once("SIGINT", () => void stopAndExit(0));
process.once("SIGTERM", () => void stopAndExit(0));
process.once("uncaughtException", (error) => {
  console.error(error.stack ?? error.message);
  void stopAndExit(1);
});
process.once("unhandledRejection", (reason) => {
  console.error(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
  void stopAndExit(1);
});
