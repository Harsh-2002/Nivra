import assert from "node:assert/strict";
import { webkit } from "playwright";

const browser = await webkit.launch();
const page = await browser.newPage();
const errors = [];
let crashed = false;
let deadline;
page.on("crash", () => {
  crashed = true;
});
page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
try {
  await page.setContent(
    `<style>div { transition: filter 0.1s; } .dim { filter: brightness(0.95); }</style>${"<div>Runtime check</div>".repeat(10)}`,
  );
  await Promise.race([
    page.evaluate(async () => {
      const elements = [...document.querySelectorAll("div")];
      const settled = () =>
        Promise.all(
          elements.map(
            (element) =>
              new Promise((resolve) => {
                element.addEventListener("transitionend", resolve, {
                  once: true,
                });
              }),
          ),
        );
      for (let iteration = 0; iteration < 20; iteration++) {
        let transition = settled();
        elements.forEach((element) => element.classList.add("dim"));
        await transition;
        transition = settled();
        elements.forEach((element) => element.classList.remove("dim"));
        await transition;
      }
    }),
    new Promise((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error("WebKit compositor check exceeded 30 seconds")),
        30_000,
      );
    }),
  ]);
  assert.equal(crashed, false, "WebKit renderer must remain alive");
  assert.deepEqual(errors, [], "WebKit runtime must not emit page errors");
  console.log(`WebKit ${browser.version()}: 20 compositor cycles passed`);
} finally {
  clearTimeout(deadline);
  await browser.close();
}
