export const ignoredWebKitViewportWarning =
  'Viewport argument key "interactive-widget" not recognized and ignored.';

export function classifyConsoleMessage(engine, type, text) {
  if (engine === "webkit" && text === ignoredWebKitViewportWarning)
    return "unsupported-feature-warning";
  if (type === "error") return "error";
  return "other";
}
