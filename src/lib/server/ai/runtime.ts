import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
export type RuntimeResources = {
  rss: number;
  peakRss: number;
  cpuUserUs?: number;
  cpuSystemUs?: number;
};
export type VectorCandidate = { key: string; sourceKey: string; score: number };
export class EmbeddingWorker {
  private child?: ChildProcess;
  private pending?: {
    id: string;
    resolve: (data: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private ready?: Promise<void>;
  resources: RuntimeResources = { rss: 0, peakRss: 0 };
  constructor(
    private directory = process.cwd(),
    private lockFile?: string,
  ) {}
  get running() {
    return Boolean(
      this.child?.connected &&
      this.child.exitCode === null &&
      this.child.signalCode === null,
    );
  }
  start() {
    if (this.ready) return this.ready;
    this.resources.rss = 0;
    this.ready = new Promise<void>((resolve, reject) => {
      const child = (this.child = fork(
        path.join(this.directory, "generated/ai-worker.cjs"),
        [],
        {
          cwd: this.directory,
          execPath: this.lockFile ? "/usr/bin/flock" : process.execPath,
          execArgv: this.lockFile
            ? [
                "-n",
                "-F",
                this.lockFile,
                process.execPath,
                "--max-old-space-size=128",
              ]
            : ["--max-old-space-size=128"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: { ...process.env, ORT_DISABLE_TELEMETRY: "1" },
        },
      ));
      const timer = setTimeout(() => {
        reject(new Error("Local AI initialization timed out."));
        child.kill("SIGKILL");
      }, 30_000);
      child.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return;
        const data = message as Record<string, unknown>;
        if (typeof data.rss === "number") {
          this.resources.rss = data.rss;
          this.resources.peakRss = Math.max(this.resources.peakRss, data.rss);
        }
        if (typeof data.peakRss === "number")
          this.resources.peakRss = Math.max(
            this.resources.peakRss,
            data.peakRss,
          );
        if (typeof data.cpuUserUs === "number")
          this.resources.cpuUserUs = data.cpuUserUs;
        if (typeof data.cpuSystemUs === "number")
          this.resources.cpuSystemUs = data.cpuSystemUs;
        if (data.type === "ready") {
          clearTimeout(timer);
          resolve();
        }
        if (data.type === "unavailable") {
          clearTimeout(timer);
          reject(new Error("Local AI model is unavailable."));
          child.kill("SIGKILL");
        }
        if (this.resources.rss > 512 * 1024 * 1024) child.kill("SIGKILL");
        const pending = this.pending;
        if (!pending || pending.id !== data.id) return;
        if (data.type === "result" || data.type === "failed") {
          clearTimeout(pending.timer);
          this.pending = undefined;
          if (data.type === "result") pending.resolve(data);
          else pending.reject(new Error("Local AI inference failed."));
        }
      });
      const stopped = () => {
        clearTimeout(timer);
        reject(new Error("Local AI worker stopped."));
        if (this.pending) {
          clearTimeout(this.pending.timer);
          this.pending.reject(new Error("Local AI worker stopped."));
          this.pending = undefined;
        }
        if (this.child === child) {
          this.child = undefined;
          this.ready = undefined;
        }
      };
      child.once("exit", stopped);
      child.once("error", stopped);
    });
    return this.ready;
  }
  private async request(payload: Record<string, unknown>, deadline: number) {
    if (typeof payload.text !== "string" || payload.text.length > 20_000)
      throw new Error("Local AI text exceeds the inference limit.");
    if (Date.now() >= deadline)
      throw new Error("Local AI inference timed out.");
    let initializationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.start(),
        new Promise<never>((_, reject) => {
          initializationTimer = setTimeout(
            () =>
              reject(
                new Error(
                  "Local AI initialization exceeded the query deadline.",
                ),
              ),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(initializationTimer);
    }
    if (Date.now() >= deadline)
      throw new Error("Local AI inference timed out.");
    if (this.pending) throw new Error("Local AI worker is busy.");
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = randomUUID(),
        timer = setTimeout(
          () => {
            if (this.pending?.id === id) {
              this.pending = undefined;
              reject(new Error("Local AI inference timed out."));
              this.child?.kill("SIGKILL");
            }
          },
          Math.max(1, deadline - Date.now()),
        );
      this.pending = { id, resolve, reject, timer };
      this.child!.send({ ...payload, id, deadline }, (error) => {
        if (error && this.pending?.id === id) {
          clearTimeout(timer);
          this.pending = undefined;
          reject(new Error("Local AI worker is unavailable."));
        }
      });
    });
  }
  async encode(text: string, query = false, timeout = 30_000) {
    const data = await this.request(
      { type: "encode", text, query },
      Date.now() + timeout,
    );
    if (
      !Array.isArray(data.embedding) ||
      data.embedding.length !== 384 ||
      !data.embedding.every((n) => typeof n === "number" && Number.isFinite(n))
    )
      throw new Error("Invalid local embedding.");
    return Float32Array.from(data.embedding);
  }
  async search(
    owner: string,
    text: string,
    deadline: number,
    filterType = "",
    tag = "",
  ): Promise<VectorCandidate[]> {
    const data = await this.request(
      { type: "search", text, owner, filterType, tag },
      deadline,
    );
    if (
      !Array.isArray(data.candidates) ||
      data.candidates.length > 30 ||
      !data.candidates.every(
        (c) =>
          c &&
          typeof c.key === "string" &&
          typeof c.sourceKey === "string" &&
          typeof c.score === "number" &&
          Number.isFinite(c.score),
      )
    )
      throw new Error("Invalid related matches.");
    return data.candidates;
  }
  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.connected) child.send({ type: "shutdown" }, () => {});
      else child.kill("SIGTERM");
    });
  }
}
