import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const image = process.argv[2];
if (!image) throw new Error("Provide the Docker image to verify.");
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

for (const encrypted of [false, true]) {
  const name = `nivra-smoke-${randomUUID()}`;
  const volume = `${name}-data`;
  let port = "";
  const run = () =>
    docker(
      "run",
      "-d",
      "--name",
      name,
      "--init",
      "--security-opt",
      "no-new-privileges:true",
      "--cap-drop",
      "ALL",
      "-p",
      `127.0.0.1:${port}:3000`,
      "-v",
      `${volume}:/app/data`,
      image,
    );
  const ready = async () => {
    port = JSON.parse(docker("inspect", name))[0].NetworkSettings.Ports[
      "3000/tcp"
    ][0].HostPort;
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 120; attempt++) {
      if ((await fetch(`${base}/health`).catch(() => null))?.ok) return base;
      await setTimeout(1000);
    }
    throw new Error("Container did not become ready within two minutes.");
  };
  try {
    run();
    let base = await ready();
    const request = (path, method = "GET", body, cookie) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          origin: base,
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal(
      (await request("/.well-known/oauth-authorization-server/api/auth"))
        .status,
      409,
    );
    docker(
      "exec",
      name,
      "node",
      "-e",
      "if(require('node:fs').existsSync('/app/data/nivra.sqlite')) process.exit(1)",
    );
    const password = `CI-${randomUUID()}`;
    const setup = await request("/api/v1/setup", "POST", {
      name: "Container test",
      username: "container_test",
      password,
      encrypted,
    });
    assert.equal(setup.status, 200, "Onboarding failed");
    const cookie = setup.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie, "Onboarding did not create a session");
    assert.equal((await request("/api/v1/notes")).status, 401);
    assert.equal(
      (
        await request("/api/v1/setup", "POST", {
          name: "Another owner",
          username: "another_owner",
          password,
          encrypted,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          "/api/v1/notes",
          "POST",
          { title: "Container persistence" },
          cookie,
        )
      ).status,
      201,
    );
    const backup = JSON.parse(
      docker("exec", name, "node", "backup-cli.cjs", "create"),
    );
    assert.ok(backup.id, "Backup did not return an identifier");
    docker("exec", name, "node", "backup-cli.cjs", "verify", backup.id);
    docker(
      "exec",
      name,
      "node",
      "backup-cli.cjs",
      "restore",
      backup.id,
      "/tmp/nivra-restored",
    );
    docker(
      "exec",
      name,
      "node",
      "-e",
      "const c=require('@napi-rs/canvas').createCanvas(400,100),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,400,100);x.fillStyle='black';x.font='30px DejaVu Sans';x.fillText('NIVRA OFFLINE TEST',10,60);require('sharp')(c.toBuffer('image/png')).metadata().then(m=>{if(m.width!==400)throw Error('Native image smoke failed')})",
    );
    docker("exec", name, "ffmpeg", "-version");
    docker("rm", "-f", name);
    run();
    base = await ready();
    const notes = await request("/api/v1/notes", "GET", undefined, cookie);
    assert.equal(notes.status, 200, "Session was not preserved");
    assert.deepEqual(
      (await notes.json()).items.map((note) => note.title),
      ["Container persistence"],
    );
    const savedMode = docker(
      "exec",
      name,
      "node",
      "-e",
      "process.stdout.write(String(JSON.parse(require('node:fs').readFileSync('/app/data/encryption-mode.json')).encrypted))",
    );
    assert.equal(
      savedMode,
      String(encrypted),
      "Encryption mode changed after recreation",
    );
    console.log(
      `Container verified: ${encrypted ? "encrypted" : "plaintext"} onboarding, authorization, single owner, files tooling and persistence.`,
    );
  } catch (error) {
    try {
      console.error(docker("logs", "--tail", "50", name));
    } catch {}
    throw error;
  } finally {
    try {
      docker("rm", "-f", name);
    } catch {}
    try {
      docker("volume", "rm", volume);
    } catch {}
  }
}
