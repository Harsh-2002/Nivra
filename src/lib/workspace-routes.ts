export const workspaceRoutes = {
  overview: "/overview",
  all: "/notes",
  favorites: "/favorites",
  journal: "/journal",
  tasks: "/tasks",
  calendar: "/calendar",
  bookmarks: "/bookmarks",
  artifacts: "/artifacts",
  forms: "/forms",
  "tag-suggestions": "/tag-suggestions",
  trash: "/trash",
} as const;
export type WorkspaceView = keyof typeof workspaceRoutes;
export const workspaceSurfaces = ["search", "settings"] as const;
export function workspaceSurface(pathname: string) {
  return workspaceSurfaces.find(
    (surface) => `/${surface}` === pathname.replace(/\/$/, ""),
  );
}
export function workspaceView(pathname: string): WorkspaceView | null {
  if (pathname === "/") return "overview";
  if (formRoute(pathname)) return "forms";
  return (
    (Object.entries(workspaceRoutes).find(
      ([, path]) => path === pathname.replace(/\/$/, ""),
    )?.[0] as WorkspaceView | undefined) ?? null
  );
}
export type FormRoute = {
  id: string;
  tab: "build" | "responses" | "share";
  responseId?: string;
};
export function formRoute(pathname: string): FormRoute | null {
  const match =
    /^\/forms\/([a-f0-9-]{36})\/(build|responses|share)(?:\/([a-f0-9-]{36}))?\/?$/i.exec(
      pathname,
    );
  if (!match || (match[3] && match[2] !== "responses")) return null;
  const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(match[1]) || (match[3] && !uuid.test(match[3]))) return null;
  return {
    id: match[1],
    tab: match[2] as FormRoute["tab"],
    ...(match[3] ? { responseId: match[3] } : {}),
  };
}
export function workspacePath(view: string): string {
  return workspaceRoutes[view as WorkspaceView] ?? workspaceRoutes.all;
}

export function cleanWorkspaceUrl(url: URL): URL {
  const result = new URL(url);
  const view = workspaceView(result.pathname);
  if (!view) return result;
  const keys =
    view === "calendar"
      ? [
          "date",
          "view",
          "mode",
          "event",
          "occurrence",
          "new",
          "link",
          "linkType",
          "linkTitle",
        ]
      : view === "tasks"
        ? ["view", "board", "stage", "task"]
        : view === "forms"
          ? formRoute(result.pathname)?.tab === "responses"
            ? ["date", "timezone"]
            : []
          : ["all", "journal", "favorites"].includes(view)
            ? ["note", "tag"]
            : view === "artifacts" || view === "bookmarks"
              ? ["tag"]
              : [];
  for (const key of [...result.searchParams.keys()])
    if (!keys.includes(key)) result.searchParams.delete(key);
  if (
    view === "tasks" &&
    !["list", "board"].includes(result.searchParams.get("view") ?? "")
  )
    result.searchParams.delete("view");
  return result;
}
