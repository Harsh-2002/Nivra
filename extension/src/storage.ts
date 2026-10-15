export type Connection = {
  instance: string;
  key: string;
  expiresAt: number | null;
  device: string;
};
export type Tag = { id: string; name: string; color: string };
type Cache = { at: number; tags: Tag[]; collections: string[] };
const cacheLifetime = 5 * 60 * 1000;

export async function getConnection() {
  const stored = await chrome.storage.local.get("connection");
  return stored.connection as Connection | undefined;
}
export const setConnection = (connection: Connection) =>
  chrome.storage.local.set({ connection });
export const clearConnection = () =>
  chrome.storage.local.remove(["connection", "cache"]);
export type Pending = { origin: string; verifier: string };
export async function getPending() {
  const stored = await chrome.storage.local.get("pending");
  return stored.pending as Pending | undefined;
}
export const setPending = (pending: Pending | null) =>
  pending
    ? chrome.storage.local.set({ pending })
    : chrome.storage.local.remove("pending");
export type ConnectState = {
  status: "waiting" | "code" | "error";
  origin: string;
  message?: string;
};
export async function getConnectState() {
  const stored = await chrome.storage.local.get("connectState");
  return stored.connectState as ConnectState | undefined;
}
export const setConnectState = (state: ConnectState | null) =>
  state
    ? chrome.storage.local.set({ connectState: state })
    : chrome.storage.local.remove("connectState");
export async function getCache(instance: string) {
  const stored = await chrome.storage.local.get("cache");
  const cache = stored.cache as (Cache & { instance: string }) | undefined;
  return cache && cache.instance === instance ? cache : undefined;
}
export const cacheIsFresh = (cache: Cache) =>
  Date.now() - cache.at < cacheLifetime;
export const setCache = (instance: string, cache: Omit<Cache, "at">) =>
  chrome.storage.local.set({ cache: { ...cache, instance, at: Date.now() } });
