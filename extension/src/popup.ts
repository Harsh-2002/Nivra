import {
  ApiError,
  api,
  friendlyError,
  loadCollections,
  loadTags,
  type Bookmark,
  type CaptureResult,
} from "./api.js";
import {
  looksSensitive,
  noteDocument,
  savablePage,
  type PageTarget,
} from "./page.js";
import {
  PairingError,
  allowInstance,
  disconnect,
  exchange,
  openCodePage,
  parseInstance,
} from "./pairing.js";
import {
  cacheIsFresh,
  getCache,
  getConnection,
  getConnectState,
  getPending,
  setConnectState,
  setCache,
  type Connection,
  type Tag,
} from "./storage.js";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const views = ["loading", "connect", "waiting", "main"] as const;
const attemptKey = crypto.randomUUID();
let connection: Connection;
let target: PageTarget | null = null;
let bookmark: Bookmark | null = null;
let savedId = "";
let created = false;
let allTags: Tag[] = [];
let collections: string[] = [];
let selectedTags = new Set<string>();
let originalTags = new Set<string>();
let pendingOrigin = "";

function show(view: (typeof views)[number]) {
  for (const name of views) $(`view-${name}`).hidden = name !== view;
}
function message(id: string, text = "") {
  const element = $(id);
  element.textContent = text;
  element.hidden = !text;
}
function busy(form: string, value: boolean) {
  for (const control of $(form).querySelectorAll("button, input, textarea"))
    (control as HTMLButtonElement).disabled = value;
}
function setMode(mode: "link" | "note") {
  $("mode-link").setAttribute("aria-pressed", String(mode === "link"));
  $("mode-note").setAttribute("aria-pressed", String(mode === "note"));
  $("panel-link").hidden = mode !== "link";
  $("panel-note").hidden = mode !== "note";
  if (mode === "note") $<HTMLTextAreaElement>("note-text").focus();
}

// Connect ---------------------------------------------------------------
function showConnect(error = "") {
  show("connect");
  message("connect-error", error);
  $<HTMLInputElement>("instance").focus();
}
function showCodeForm(origin: string, notice = "") {
  pendingOrigin = origin;
  $("connect-form").hidden = true;
  $("code-form").hidden = false;
  message("connect-error", notice);
  $<HTMLInputElement>("pair-code").focus();
}
async function connectBrowser() {
  message("connect-error");
  try {
    const { origin, insecure } = parseInstance(
      $<HTMLInputElement>("instance").value,
    );
    const hint = $("instance-hint");
    hint.hidden = !insecure;
    hint.textContent = insecure
      ? "This address isn’t encrypted. Use it only on a network you trust."
      : "";
    // Must stay the first await: the permission prompt needs the click's user gesture.
    await allowInstance(origin);
    await setConnectState({ status: "waiting", origin });
    pendingOrigin = origin;
    show("waiting");
    void chrome.runtime.sendMessage({ type: "connect", origin });
  } catch (error) {
    message(
      "connect-error",
      error instanceof PairingError
        ? error.message
        : "Couldn’t connect. Check the address and try again.",
    );
  }
}
async function submitCode() {
  message("connect-error");
  const code = $<HTMLInputElement>("pair-code").value.trim();
  if (!code) return message("connect-error", "Paste the pairing code.");
  busy("code-form", true);
  try {
    const pending = await getPending();
    if (!pending || pending.origin !== pendingOrigin)
      throw new PairingError(
        "Open the pairing page first, then paste its code.",
      );
    connection = await exchange(pendingOrigin, code, pending.verifier);
    await start();
    return;
  } catch (error) {
    message(
      "connect-error",
      error instanceof PairingError ? error.message : "Couldn’t connect.",
    );
  }
  busy("code-form", false);
}

// Link -----------------------------------------------------------------
function setStatus(text: string, ok = false) {
  $("status-text").textContent = text;
  $("status-icon").toggleAttribute("hidden", !ok);
}
function renderCollections() {
  const holder = $("collection-chips");
  holder.replaceChildren();
  const current = $<HTMLInputElement>("collection").value;
  for (const name of collections.slice(0, 5)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button outline";
    button.textContent = name;
    button.setAttribute("aria-pressed", String(name === current));
    button.addEventListener("click", () => {
      $<HTMLInputElement>("collection").value = name;
      renderCollections();
    });
    holder.append(button);
  }
}
function renderTags() {
  const holder = $("tag-chips");
  holder.replaceChildren();
  const filter = $<HTMLInputElement>("tag-filter").value.trim().toLowerCase();
  const visible = allTags
    .filter(
      (tag) =>
        selectedTags.has(tag.id) || tag.name.toLowerCase().includes(filter),
    )
    .sort(
      (a, b) =>
        Number(selectedTags.has(b.id)) - Number(selectedTags.has(a.id)) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 50);
  for (const tag of visible) {
    const row = document.createElement("label");
    row.className = "tag-option";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = selectedTags.has(tag.id);
    box.addEventListener("change", () => {
      if (box.checked) selectedTags.add(tag.id);
      else selectedTags.delete(tag.id);
      renderTags();
    });
    const dot = document.createElement("span");
    dot.className = "tag-dot";
    dot.dataset.color = tag.color;
    const name = document.createElement("span");
    name.textContent = tag.name;
    row.append(box, dot, name);
    holder.append(row);
  }
}
async function addTagFromFilter() {
  const input = $<HTMLInputElement>("tag-filter");
  const name = input.value.trim();
  if (!name) return;
  const existing = allTags.find(
    (tag) => tag.name.toLowerCase() === name.toLowerCase(),
  );
  try {
    const tag =
      existing ||
      (await api<Tag>(connection, "tags", {
        method: "POST",
        body: { name },
      }));
    if (!existing) allTags.push(tag);
    selectedTags.add(tag.id);
    input.value = "";
    renderTags();
    void setCache(connection.instance, { tags: allTags, collections });
  } catch (error) {
    message("link-error", friendlyError(error));
  }
}
async function loadForm(id: string) {
  const cached = await getCache(connection.instance);
  const fresh = cached && cacheIsFresh(cached);
  const [loaded, state, tags, known] = await Promise.all([
    api<Bookmark>(connection, `bookmarks/${id}`),
    api<{ revision: number; tags: Tag[] }>(
      connection,
      `item-tags/bookmark/${id}`,
    ),
    fresh ? Promise.resolve(cached.tags) : loadTags(connection),
    fresh ? Promise.resolve(cached.collections) : loadCollections(connection),
  ]);
  bookmark = loaded;
  allTags = tags;
  collections = known;
  if (!fresh) void setCache(connection.instance, { tags, collections: known });
  selectedTags = new Set(state.tags.map((tag) => tag.id));
  originalTags = new Set(selectedTags);
  $<HTMLInputElement>("title").value = loaded.title;
  $<HTMLInputElement>("collection").value = loaded.collection;
  renderCollections();
  renderTags();
  $("link-form").hidden = false;
  $<HTMLInputElement>("title").focus();
}
function failure(error: unknown, panel = "link-error") {
  if (error instanceof ApiError && error.status === 401) {
    showConnect("Your connection ended. Connect this browser again.");
    return;
  }
  message(panel, friendlyError(error));
}
async function saveCurrent() {
  if (!target) return;
  setStatus("Saving…");
  message("link-error");
  try {
    const result = await api<CaptureResult>(connection, "capture", {
      method: "POST",
      idempotencyKey: attemptKey,
      body: {
        type: "bookmark",
        url: target.url,
        ...(target.title ? { title: target.title } : {}),
      },
    });
    created = !result.alreadySaved;
    savedId = result.id;
    setStatus(result.alreadySaved ? "Already saved" : "Saved to Nivra", true);
    $("undo").hidden = !created;
    await loadForm(result.id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      setStatus("This link is in Trash");
      message("link-error", "Restore it from Trash in Nivra to save it again.");
      return;
    }
    setStatus("Not saved");
    failure(error);
  }
}
async function undo() {
  if (!savedId) return;
  $<HTMLButtonElement>("undo").disabled = true;
  try {
    const current = await api<Bookmark>(connection, `bookmarks/${savedId}`);
    await api(connection, `bookmarks/${savedId}`, {
      method: "DELETE",
      body: { revision: current.revision },
    });
    setStatus("Moved to Trash", true);
    $("undo").hidden = true;
    $("link-form").hidden = true;
    bookmark = null;
    created = false;
  } catch (error) {
    $<HTMLButtonElement>("undo").disabled = false;
    failure(error);
  }
}
async function conflictRetry<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return run();
    throw error;
  }
}
async function saveLink() {
  if (!bookmark) return;
  message("link-error");
  busy("link-form", true);
  try {
    const title = $<HTMLInputElement>("title").value.trim();
    const collection = $<HTMLInputElement>("collection").value.trim();
    const noteText = $<HTMLTextAreaElement>("note").value.trim();
    const changes: Record<string, unknown> = {};
    if (title && title !== bookmark.title) changes.title = title;
    if (collection !== bookmark.collection) changes.collection = collection;
    if (noteText) {
      const note = await api<{ id: string }>(connection, "notes", {
        method: "POST",
        body: {
          title: `Note on ${(title || bookmark.title || new URL(bookmark.url).hostname).slice(0, 200)}`,
          document: noteDocument(noteText, bookmark.url),
        },
      });
      changes.noteId = note.id;
    }
    const id = bookmark.id;
    if (Object.keys(changes).length)
      bookmark = await conflictRetry(async () => {
        const current = await api<Bookmark>(connection, `bookmarks/${id}`);
        return api<Bookmark>(connection, `bookmarks/${id}`, {
          method: "PATCH",
          body: { revision: current.revision, ...changes },
        });
      });
    const tagsChanged =
      selectedTags.size !== originalTags.size ||
      [...selectedTags].some((tag) => !originalTags.has(tag));
    if (tagsChanged) {
      await conflictRetry(async () => {
        const state = await api<{ revision: number }>(
          connection,
          `item-tags/bookmark/${id}`,
        );
        return api(connection, `item-tags/bookmark/${id}`, {
          method: "PATCH",
          body: { revision: state.revision, tags: [...selectedTags] },
        });
      });
      originalTags = new Set(selectedTags);
    }
    setStatus("Changes saved", true);
    $("undo").hidden = true;
    setTimeout(() => window.close(), 700);
  } catch (error) {
    failure(error);
    busy("link-form", false);
  }
}

// Note -----------------------------------------------------------------
function syncNoteLimit() {
  const source = $<HTMLInputElement>("note-source").checked && target;
  $<HTMLTextAreaElement>("note-text").maxLength = source
    ? Math.max(1000, 10_000 - (target!.url.length + 20))
    : 10_000;
}
async function saveNote() {
  message("note-error");
  const text = $<HTMLTextAreaElement>("note-text").value.trim();
  if (!text) return message("note-error", "Write something to save.");
  const withSource = $<HTMLInputElement>("note-source").checked && target;
  busy("note-form", true);
  try {
    await api<CaptureResult>(connection, "capture", {
      method: "POST",
      idempotencyKey: crypto.randomUUID(),
      body: {
        type: "note",
        title: target?.title || "Quick note",
        text: withSource ? `${text}\n\nSource: ${target!.url}` : text,
      },
    });
    $("note-status").textContent = "Note saved";
    $<HTMLTextAreaElement>("note-text").value = "";
    setTimeout(() => window.close(), 700);
  } catch (error) {
    failure(error, "note-error");
    busy("note-form", false);
  }
}

// Theme and hints -------------------------------------------------------
type Theme = "light" | "dark" | "system";
function applyTheme(theme?: string) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
}
async function syncTheme(connection: Connection) {
  const cached = await chrome.storage.local.get("theme");
  applyTheme(cached.theme as Theme | undefined);
  try {
    const session = await api<{ theme?: Theme }>(
      connection,
      "extension/session",
    );
    applyTheme(session.theme);
    await chrome.storage.local.set({ theme: session.theme ?? "system" });
  } catch {
    // The saved theme or the system setting remains.
  }
}
function showShortcutHints() {
  const data = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  const apple = /mac|iphone|ipad/i.test(data?.platform || navigator.platform);
  const hint = `${apple ? "⌘ Enter" : "Ctrl+Enter"} to save`;
  $("link-shortcut").textContent = hint;
  $("note-shortcut").textContent = hint;
}

// Start ----------------------------------------------------------------
async function start() {
  const stored = await getConnection();
  const state = await getConnectState();
  // A sign-in in progress wins over a stale connection that is being replaced.
  if (state?.status === "waiting") {
    pendingOrigin = state.origin;
    show("waiting");
    return;
  }
  if (!stored) {
    if (state?.status === "code") {
      await setConnectState(null);
      $<HTMLInputElement>("instance").value = state.origin;
      showConnect();
      showCodeForm(
        state.origin,
        "The sign-in window didn’t finish. Use a pairing code instead.",
      );
      return;
    }
    if (state?.status === "error") {
      await setConnectState(null);
      showConnect(state.message ?? "Couldn’t connect. Try again.");
      return;
    }
    const pending = await getPending();
    showConnect();
    if (pending) {
      $<HTMLInputElement>("instance").value = pending.origin;
      showCodeForm(pending.origin);
    }
    return;
  }
  connection = stored;
  showShortcutHints();
  void syncTheme(connection);
  const requested = Number(new URLSearchParams(location.search).get("tab"));
  const tab =
    Number.isInteger(requested) && requested > 0
      ? await chrome.tabs.get(requested).catch(() => undefined)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  target = savablePage(tab?.url, tab?.title);
  $<HTMLAnchorElement>("open-nivra").href = `${connection.instance}/bookmarks`;
  show("main");
  syncNoteLimit();
  if (!target) {
    setStatus("This page can’t be saved");
    message("link-error", "Only web pages (http or https) can be saved.");
    $<HTMLInputElement>("note-source").checked = false;
    $<HTMLInputElement>("note-source").disabled = true;
    return;
  }
  if (looksSensitive(target.url)) {
    setStatus("Not saved yet");
    message(
      "link-error",
      "This address looks like it contains a private token or one-time code. Saving stores it in Nivra, and Nivra will fetch it.",
    );
    $("save-anyway").hidden = false;
    return;
  }
  await saveCurrent();
}

$("connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void connectBrowser();
});
$("connect-cancel").addEventListener("click", () => {
  void setConnectState(null).then(() => showConnect());
});
$("use-code").addEventListener("click", () => {
  void setConnectState(null).then(() => {
    showConnect();
    showCodeForm(pendingOrigin);
    void openCodePage(pendingOrigin);
  });
});
// The background worker finishes pairing even when this popup was closed meanwhile.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.connection?.newValue) void start();
  else if (changes.connectState) void start();
});
$("code-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitCode();
});
$("code-reopen").addEventListener(
  "click",
  () => void openCodePage(pendingOrigin),
);
$("link-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveLink();
});
$("note-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveNote();
});
$("undo").addEventListener("click", () => void undo());
$("save-anyway").addEventListener("click", () => {
  $("save-anyway").hidden = true;
  message("link-error");
  void saveCurrent();
});
$("mode-link").addEventListener("click", () => setMode("link"));
$("mode-note").addEventListener("click", () => setMode("note"));
$("note-source").addEventListener("change", syncNoteLimit);
$("tag-filter").addEventListener("input", renderTags);
$("tag-filter").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addTagFromFilter();
  }
});
$("collection").addEventListener("input", renderCollections);
$("disconnect").addEventListener("click", () => {
  void disconnect().then((revoked) => {
    $("view-main").hidden = true;
    showConnect(
      revoked
        ? ""
        : "Disconnected here, but Nivra couldn’t be reached to revoke this browser. Revoke it in Settings → MCP.",
    );
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.close();
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    const form = document.activeElement?.closest("form");
    if (form) form.requestSubmit();
  }
});
void start().catch(() => showConnect("Something went wrong. Try again."));
