import { loadConfig } from "./config/index.js";
import { startMikuAgent } from "./app.js";

const config = await loadConfig(process.env.MIKUSWARM_AGENT_CONFIG_DIR ?? "./config");
const runtime = await startMikuAgent(config);

process.once("SIGINT", () => void runtime.stop().then(() => process.exit(0)));
process.once("SIGTERM", () => void runtime.stop().then(() => process.exit(0)));
