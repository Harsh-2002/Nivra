import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { Select } from "radix-ui";

test("Radix's hidden form select remains available without a CSP-blocked inline style", () => {
  const markup = renderToStaticMarkup(
    createElement(
      Select.Root,
      { name: "choice", defaultValue: "alpha", required: true },
      createElement(Select.Trigger, null, createElement(Select.Value)),
    ),
  );
  const dom = new JSDOM(markup);
  try {
    const control = dom.window.document.querySelector("select[name=choice]");
    assert.ok(control instanceof dom.window.HTMLSelectElement);
    assert.equal(control.hasAttribute("style"), false);
    assert.equal(control.classList.contains("nivra-select-bubble"), true);
    assert.equal(control.getAttribute("aria-hidden"), "true");
    assert.equal(control.tabIndex, -1);
    assert.equal(control.required, true);
    assert.equal(dom.window.document.querySelectorAll("[style]").length, 0);
    assert.ok(dom.window.document.querySelector(".nivra-select-value"));
  } finally {
    dom.window.close();
  }
});
