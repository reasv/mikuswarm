// A retrieval worker child for the WorkerRpc watchdog tests: `hang` never
// settles (a wedged native call), `sleep` takes `ms`, `ping` answers at once.
import { isWorkerChild, serveWorker } from "../../../src/retrieval/onnx/worker-rpc.js";

if (isWorkerChild("hang")) {
  serveWorker(
    async () => ({ state: null, info: null }),
    () => ({
      hang: () => new Promise(() => {}),
      sleep: (p: { ms: number }) => new Promise((r) => setTimeout(() => r("slept"), p.ms)),
      ping: () => "pong",
    }),
    () => new Promise(() => {}), // a close that never finishes either
  );
}
