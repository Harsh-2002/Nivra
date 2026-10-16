export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { buildLabel } = await import("./lib/server/version");
    console.log(
      `Nivra ${buildLabel()} · ${process.env.NODE_ENV ?? "production"} · Node ${process.version}`,
    );
    const { installationExists } = await import("./lib/server/installation");
    const startup = await import("./lib/server/startup");
    startup.enableWorkers();
    if (installationExists()) await startup.startInstallationWorkers();
  }
}
