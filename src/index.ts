import { loadConfig } from "./config/index.js";
import { startMikuAgent } from "./app.js";

const config = await loadConfig(process.env.MIKUSWARM_AGENT_CONFIG_DIR ?? "./config");
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
