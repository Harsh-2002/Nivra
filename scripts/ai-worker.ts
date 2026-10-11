import path from "node:path";
import { loadEmbedding } from "../src/lib/server/ai/embedding";
const send = (value: unknown) => {
  if (process.connected) process.send?.(value, () => {});
};
const rssLimit = 512 * 1024 * 1024;
let busy = false;
let stopped = false;
const model = loadEmbedding(path.join(process.cwd(), "models/arctic"));
const fail = () => {
  send({ type: "unavailable" });
  process.exitCode = 1;
  void shutdown();
};
const monitor = setInterval(() => {
  send({ type: "resources", rss: process.memoryUsage().rss });
  if (process.memoryUsage().rss > rssLimit) fail();
}, 250);
monitor.unref();
async function shutdown() {
  if (stopped) return;
  stopped = true;
  clearInterval(monitor);
  await (await model.catch(() => undefined))?.dispose().catch(() => {});
  process.exit(process.exitCode ?? 0);
}
process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("message", async (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const data = message as {
    type?: string;
    id?: string;
    text?: string;
    query?: boolean;
  };
  if (data.type === "shutdown") return void shutdown();
  if (
    data.type !== "encode" ||
    typeof data.id !== "string" ||
    typeof data.text !== "string" ||
    data.text.length > 20_000 ||
    busy ||
    stopped
  )
    return;
  busy = true;
  try {
    const embedding = await (
      await model
    ).encode(data.text, data.query === true);
    if (process.memoryUsage().rss > rssLimit) return fail();
    send({ type: "result", id: data.id, embedding: Array.from(embedding) });
  } catch {
    send({ type: "failed", id: data.id });
  } finally {
    busy = false;
  }
});
void model
  .then(() => send({ type: "ready", rss: process.memoryUsage().rss }))
  .catch(fail);
