import path from "node:path";
import { loadEmbedding } from "../src/lib/server/ai/embedding";
import { heavyInference } from "../src/lib/server/heavy-inference";
import {
  vectorSearch,
  clearVectorCache,
} from "../src/lib/server/ai/vector-search";
const send = (value: unknown) => {
  if (process.connected) process.send?.(value, () => {});
};
const rssLimit = 512 * 1024 * 1024;
let busy = false;
let stopped = false;
const model = heavyInference(
  () => loadEmbedding(path.join(process.cwd(), "models/arctic")),
  30_000,
);
const fail = () => {
  send({ type: "unavailable" });
  process.exitCode = 1;
  void shutdown();
};
const monitor = setInterval(() => {
  send({
    type: "resources",
    rss: process.memoryUsage().rss,
    peakRss: process.resourceUsage().maxRSS * 1024,
    cpuUserUs: process.cpuUsage().user,
    cpuSystemUs: process.cpuUsage().system,
  });
  if (process.memoryUsage().rss > rssLimit) fail();
}, 250);
monitor.unref();
async function shutdown() {
  if (stopped) return;
  stopped = true;
  clearInterval(monitor);
  clearVectorCache();
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
    owner?: string;
    deadline?: number;
    filterType?: string;
    tag?: string;
  };
  if (data.type === "shutdown") return void shutdown();
  if (
    !["encode", "search"].includes(data.type ?? "") ||
    typeof data.id !== "string" ||
    typeof data.text !== "string" ||
    data.text.length > 20_000 ||
    busy ||
    stopped
  )
    return;
  busy = true;
  try {
    const result = await heavyInference(
      async () => {
        const embedding = await (
          await model
        ).encode(data.text!, data.type === "search" || data.query === true);
        if (process.memoryUsage().rss > rssLimit) return fail();
        if (data.type === "search") {
          if (typeof data.owner !== "string" || !Number.isFinite(data.deadline))
            throw new Error("Invalid query");
          const candidates = await vectorSearch(
            data.owner,
            embedding,
            data.deadline! - 100,
            data.filterType,
            data.tag,
          );
          return { type: "result", id: data.id, candidates };
        } else
          return {
            type: "result",
            id: data.id,
            embedding: Array.from(embedding),
          };
      },
      data.type === "search"
        ? Math.max(1, (data.deadline ?? 0) - Date.now())
        : 120_000,
    );
    busy = false;
    if (result) send(result);
  } catch {
    busy = false;
    send({ type: "failed", id: data.id });
  } finally {
    busy = false;
  }
});
void model
  .then(() =>
    send({
      type: "ready",
      rss: process.memoryUsage().rss,
      peakRss: process.resourceUsage().maxRSS * 1024,
    }),
  )
  .catch(fail);
