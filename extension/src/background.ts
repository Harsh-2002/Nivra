import { PairingError, connectInBrowser } from "./pairing.js";
import { setConnectState } from "./storage.js";
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

// Chrome closes the popup when the sign-in window takes focus, so the pairing runs here.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (
    sender.id === chrome.runtime.id &&
    message?.type === "connect" &&
    typeof message.origin === "string"
  )
    void runConnect(message.origin);
});
async function runConnect(origin: string) {
  // Any extension API call resets the idle timer, which sign-in with TOTP can outlast.
  const keepAlive = setInterval(
    () => void chrome.runtime.getPlatformInfo(),
    20_000,
  );
  try {
    await setConnectState({ status: "waiting", origin });
    const connection = await connectInBrowser(origin);
    if (connection) {
      await setConnectState(null);
      void chrome.action.setBadgeText({ text: "✓" });
      void chrome.action.setBadgeBackgroundColor({ color: "#171717" });
      void chrome.action.setBadgeTextColor({ color: "#ffffff" });
      void chrome.action.setTitle({
        title: "Connected. Click to save this page.",
      });
      setTimeout(() => {
        void chrome.action.setBadgeText({ text: "" });
        void chrome.action.setTitle({ title: "Save to Nivra" });
      }, 8000);
      return;
    }
    await setConnectState({ status: "code", origin });
  } catch (error) {
    await setConnectState({
      status: "error",
      origin,
      message:
        error instanceof PairingError
          ? error.message
          : "Couldn’t connect. Check the address and try again.",
    });
  } finally {
    clearInterval(keepAlive);
  }
}
