export const ONBOARDING_INTERESTS = [
  "Work",
  "Personal",
  "Learning",
  "Projects",
] as const;

export type OnboardingInterest = (typeof ONBOARDING_INTERESTS)[number];
export type InstallPlatform = "ios" | "android" | "desktop";

const suggestedTagsByInterest: Record<OnboardingInterest, string[]> = {
  Work: ["Meetings", "Follow up", "Reference"],
  Personal: ["Home", "Health", "Reading"],
  Learning: ["Courses", "Questions", "Resources"],
  Projects: ["Planning", "In progress", "Review"],
};

export function normalizeTagName(name: string) {
  return name.normalize("NFKC").trim().toLowerCase();
}

export function getSuggestedTags(interests: readonly string[]) {
  const seen = new Set<string>();
  return interests.flatMap((interest) => {
    if (!ONBOARDING_INTERESTS.includes(interest as OnboardingInterest))
      return [];
    return suggestedTagsByInterest[interest as OnboardingInterest].filter(
      (name) => {
        const normalized = normalizeTagName(name);
        if (!normalized || seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      },
    );
  });
}

export function getInterestsFromTagNames(tagNames: readonly string[]) {
  const existing = new Set(tagNames.map(normalizeTagName));
  return ONBOARDING_INTERESTS.filter((interest) =>
    getSuggestedTags([interest]).some((name) =>
      existing.has(normalizeTagName(name)),
    ),
  );
}

export function parseTagAliases(input: string, tagName: string) {
  const excluded = normalizeTagName(tagName);
  const seen = new Set<string>();
  return input
    .split(",")
    .map((alias) => alias.normalize("NFKC").trim())
    .filter((alias) => {
      const normalized = normalizeTagName(alias);
      if (!normalized || normalized === excluded || seen.has(normalized))
        return false;
      seen.add(normalized);
      return true;
    });
}

export function detectInstallPlatform(
  userAgent: string,
  maxTouchPoints = 0,
): InstallPlatform {
  if (/iPad|iPhone|iPod/i.test(userAgent)) return "ios";
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "desktop";
}

export function isSecureInstallContext(protocol: string, hostname: string) {
  return (
    protocol === "https:" ||
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase())
  );
}

export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice?: Promise<{
    outcome: "accepted" | "dismissed";
    platform?: string;
  }>;
};

export type PwaInstallSnapshot = {
  prompt: InstallPromptEvent | null;
  installed: boolean;
  standalone: boolean;
  platform: InstallPlatform;
  secure: boolean;
};

const serverSnapshot: PwaInstallSnapshot = {
  prompt: null,
  installed: false,
  standalone: false,
  platform: "desktop",
  secure: false,
};
let snapshot = serverSnapshot;
const subscribers = new Set<() => void>();
let listenersStarted = false;

function publish(next: PwaInstallSnapshot) {
  snapshot = next;
  for (const subscriber of subscribers) subscriber();
}

function readBrowserState(): Omit<PwaInstallSnapshot, "prompt"> {
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  return {
    installed:
      standalone ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    standalone:
      standalone ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    platform: detectInstallPlatform(
      navigator.userAgent,
      navigator.maxTouchPoints,
    ),
    secure: isSecureInstallContext(location.protocol, location.hostname),
  };
}

function startInstallListeners() {
  if (listenersStarted || typeof window === "undefined") return;
  listenersStarted = true;
  snapshot = { ...snapshot, ...readBrowserState() };

  window.addEventListener("beforeinstallprompt", (event) => {
    const prompt = event as InstallPromptEvent;
    if (typeof prompt.prompt !== "function") return;
    event.preventDefault();
    publish({ ...snapshot, prompt });
  });
  window.addEventListener("appinstalled", () => {
    publish({ ...snapshot, prompt: null, installed: true });
  });
  window
    .matchMedia?.("(display-mode: standalone)")
    .addEventListener("change", (event) => {
      publish({
        ...snapshot,
        standalone: event.matches,
        installed: snapshot.installed || event.matches,
      });
    });
}

export function subscribePwaInstall(subscriber: () => void) {
  subscribers.add(subscriber);
  startInstallListeners();
  return () => subscribers.delete(subscriber);
}

export function getPwaInstallSnapshot() {
  return snapshot;
}

export function getPwaInstallServerSnapshot() {
  return serverSnapshot;
}

export async function promptPwaInstall() {
  const prompt = snapshot.prompt;
  if (!prompt) return "unavailable" as const;
  publish({ ...snapshot, prompt: null });
  await prompt.prompt();
  const choice = await prompt.userChoice;
  return choice?.outcome ?? ("prompted" as const);
}

if (typeof window !== "undefined") startInstallListeners();
