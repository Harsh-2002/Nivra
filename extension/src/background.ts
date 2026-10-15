import { ApiError, api, friendlyError, type CaptureResult } from "./api.js";
import { savablePage } from "./page.js";
import { getConnection } from "./storage.js";

const menus = [
  { id: "page", title: "Save page to Nivra", contexts: ["page"] },
  { id: "link", title: "Save link to Nivra", contexts: ["link"] },
  {
    id: "selection",
    title: "Save selection to Nivra",
    contexts: ["selection"],
  },
] as const;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.contextMenus.removeAll().then(() => {
    for (const menu of menus)
      chrome.contextMenus.create({
        id: menu.id,
        title: menu.title,
        contexts: [...menu.contexts],
      });
  });
});

function flash(tabId: number | undefined, ok: boolean, title: string) {
  if (tabId === undefined) return;
  void chrome.action.setBadgeText({ tabId, text: ok ? "✓" : "!" });
  void chrome.action.setBadgeBackgroundColor({
    tabId,
    color: ok ? "#171717" : "#b42318",
  });
  void chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
  void chrome.action.setTitle({ tabId, title });
  setTimeout(() => {
    void chrome.action.setBadgeText({ tabId, text: "" });
    void chrome.action.setTitle({ tabId, title: "Save to Nivra" });
  }, 4000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab?.id;
  const connection = await getConnection();
  if (!connection) {
    try {
      await chrome.action.openPopup();
    } catch {
      flash(tabId, false, "Connect Nivra from the toolbar button first.");
    }
    return;
  }
  const isLink = info.menuItemId === "link";
  const page = savablePage(
    isLink ? info.linkUrl : info.pageUrl || tab?.url,
    isLink ? undefined : tab?.title,
  );
  if (!page) {
    flash(tabId, false, "Only web pages (http or https) can be saved.");
    return;
  }
  const passage =
    info.menuItemId === "selection" ? (info.selectionText || "").trim() : "";
  try {
    const result = await api<CaptureResult>(connection, "capture", {
      method: "POST",
      idempotencyKey: crypto.randomUUID(),
      body: {
        type: "bookmark",
        url: page.url,
        ...(page.title ? { title: page.title } : {}),
        ...(passage ? { text: passage.slice(0, 10_000) } : {}),
      },
    });
    flash(
      tabId,
      true,
      result.alreadySaved ? "Already saved to Nivra" : "Saved to Nivra",
    );
  } catch (error) {
    flash(
      tabId,
      false,
      error instanceof ApiError && error.status === 409
        ? "This link is in Trash in Nivra."
        : friendlyError(error),
    );
  }
});
