"use client";
import {
  Component,
  lazy,
  Suspense,
  type ComponentType,
  type ReactNode,
} from "react";
import { LoadingState } from "./loading-state";
import { NavigationIcon } from "./navigation-icon";
import { Button } from "./ui/button";

type Kind = Parameters<typeof LoadingState>[0]["kind"];
type Loader<P> = () => Promise<ComponentType<P>>;

const loaders = {
  calendar: () => import("./calendar-panel").then((m) => m.CalendarPanel),
  forms: () => import("./form-workspace").then((m) => m.FormWorkspace),
  templates: () => import("./templates-panel").then((m) => m.TemplatesPanel),
  tasks: () => import("./tasks-workspace").then((m) => m.TasksWorkspace),
  bookmarks: () => import("./bookmarks-panel").then((m) => m.BookmarksPanel),
  trash: () => import("./trash-panel").then((m) => m.TrashPanel),
  artifacts: () => import("./artifacts-panel").then((m) => m.ArtifactsPanel),
  "tag-suggestions": () =>
    import("./tag-suggestions-panel").then((m) => m.TagSuggestionsPanel),
};
const chunkFailure = (error: unknown) =>
  error instanceof Error &&
  (error.name === "ChunkLoadError" ||
    /Loading (CSS )?chunk|dynamically imported module/i.test(error.message));

// Only a failed download is handled here; any other error still reaches the application's own error page.
class ChunkBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    if (!chunkFailure(this.state.error)) throw this.state.error;
    return (
      <section className="tasks-panel">
        <div className="tasks-scroll">
          <div className="section-content">
            <div className="tasks-error" role="alert">
              <p>
                This section could not be loaded. Nivra may have been updated.
              </p>
              <Button variant="outline" onClick={() => location.reload()}>
                Reload
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }
}
function panel<P extends { onNavigation: () => void }>(
  load: Loader<P>,
  title: string,
  kind: Kind,
) {
  const Lazy = lazy(() => load().then((component) => ({ default: component })));
  return function LazyPanel(props: P) {
    return (
      <ChunkBoundary>
        <Suspense
          fallback={
            <section className="tasks-panel">
              <div className="tasks-scroll">
                <div className="section-content">
                  <header className="section-heading">
                    <div className="section-heading-title">
                      <h1>{title}</h1>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="menu-toggle"
                        aria-label="Open navigation"
                        onClick={props.onNavigation}
                      >
                        <NavigationIcon />
                      </Button>
                    </div>
                  </header>
                  <LoadingState kind={kind} label={`Loading ${title}`} />
                </div>
              </div>
            </section>
          }
        >
          <Lazy {...(props as P & React.JSX.IntrinsicAttributes)} />
        </Suspense>
      </ChunkBoundary>
    );
  };
}
export const CalendarPanel = panel(loaders.calendar, "Calendar", "clock");
export const FormWorkspace = panel(loaders.forms, "Forms", "notes");
export const TemplatesPanel = panel(loaders.templates, "Templates", "trash");
export const TasksWorkspace = panel(loaders.tasks, "Tasks", "tasks");
export const BookmarksPanel = panel(
  loaders.bookmarks,
  "Bookmarks",
  "bookmarks",
);
export const TrashPanel = panel(loaders.trash, "Trash", "trash");
export const ArtifactsPanel = panel(loaders.artifacts, "Artifacts", "gallery");
export const TagSuggestionsPanel = panel(
  loaders["tag-suggestions"],
  "Tag suggestions",
  "trash",
);
// Starts the download; with a wait, resolves once it finishes or the wait passes, whichever is first. Failures surface when the panel renders.
export function preloadPanel(view: string, wait = 0): Promise<void> {
  const load = loaders[view as keyof typeof loaders]?.();
  if (!load) return Promise.resolve();
  const done = load.then(
    () => undefined,
    () => undefined,
  );
  return wait
    ? Promise.race([done, new Promise<void>((r) => setTimeout(r, wait))])
    : done;
}
