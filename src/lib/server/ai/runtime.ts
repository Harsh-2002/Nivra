import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
export type RuntimeResources = { rss: number; peakRss: number };
export class EmbeddingWorker {
  private child?: ChildProcess;
  private pending?: {
    id: string;
    resolve: (value: Float32Array) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private ready?: Promise<void>;
  resources: RuntimeResources = { rss: 0, peakRss: 0 };
  constructor(private directory = process.cwd()) {}
  start() {
    if (this.ready) return this.ready;
    this.resources.rss = 0;
    this.ready = new Promise<void>((resolve, reject) => {
      const child = (this.child = fork(
        path.join(this.directory, "generated/ai-worker.cjs"),
        [],
        {
          cwd: this.directory,
          execArgv: ["--max-old-space-size=128"],
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
        const data = message as {
          type: string;
          id?: string;
          embedding?: unknown;
          rss?: number;
        };
        if (typeof data.rss === "number") {
          this.resources.rss = data.rss;
          this.resources.peakRss = Math.max(this.resources.peakRss, data.rss);
        }
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
          if (
            data.type === "result" &&
            Array.isArray(data.embedding) &&
            data.embedding.length === 384 &&
            data.embedding.every(
              (n) => typeof n === "number" && Number.isFinite(n),
            )
          )
            pending.resolve(Float32Array.from(data.embedding));
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
  async encode(text: string, query = false, deadline = 3000) {
    if (text.length > 20_000)
      throw new Error("Local AI text exceeds the inference limit.");
    await this.start();
    if (this.pending) throw new Error("Local AI worker is busy.");
    return new Promise<Float32Array>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (this.pending?.id === id) {
          this.pending = undefined;
          reject(new Error("Local AI inference timed out."));
          this.child?.kill("SIGKILL");
        }
      }, deadline);
      this.pending = { id, resolve, reject, timer };
      this.child!.send({ type: "encode", id, text, query }, (error) => {
        if (error && this.pending?.id === id) {
          clearTimeout(timer);
          this.pending = undefined;
          reject(new Error("Local AI worker is unavailable."));
        }
      });
    });
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
