import assert from "node:assert/strict";
import { fork } from "node:child_process";
import path from "node:path";

const worker = path.resolve("generated/bookmark-reader-worker.mjs");
const timeoutMs = 15_000;
const input = {
  html: `<!doctype html><html><head><title>Field Notes</title></head><body>
    <article><h1>Field Notes</h1>
      <p>Keep <strong>useful evidence</strong> and <a href="/reference">references</a>.</p>
      <img src="https://tracking.example/pixel.png">
      <script>process.send({ bad: true })</script>
      <p onclick="alert(1)">A second paragraph.</p>
    </article>
  </body></html>`,
  url: "https://example.test/article",
  fallbackTitle: "Saved bookmark",
};

function parseArticle() {
  const child = fork(worker, [], {
    execArgv: [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.connected) child.disconnect();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(message);
    };
    const timeout = setTimeout(
      () => finish(new Error(`Bookmark reader exceeded ${timeoutMs} ms.`)),
      timeoutMs,
    );

    child.once("message", (message) => finish(null, message));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled)
        finish(
          new Error(
            `Bookmark reader exited before replying (${code ?? signal}).`,
          ),
        );
    });
    child.send(input, (error) => {
      if (error) finish(error);
    });
  });
}

const response = await parseArticle();
assert.equal(
  response.error,
  undefined,
  "the worker should extract the article",
);
const article = response.result;
assert.equal(article.title, "Field Notes");
assert.equal(article.url, input.url);
assert.match(article.text, /useful evidence/);
assert.match(article.text, /A second paragraph/);
assert.match(
  JSON.stringify(article.content),
  /https:\/\/example\.test\/reference/,
);
assert.match(article.fingerprint, /^[a-f0-9]{64}$/);
const serialized = JSON.stringify(article);
assert.doesNotMatch(serialized, /<script|tracking\.example|onclick/);

console.log(
  JSON.stringify({
    status: "ok",
    title: article.title,
    blocks: article.content.blocks.length,
    textCharacters: article.text.length,
    fingerprintLength: article.fingerprint.length,
    sanitized: true,
  }),
);
