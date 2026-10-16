import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const image = process.argv[2];
const previousImage = process.argv[3];
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
  const run = (initial = false) =>
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
      `${volume}:${initial && previousImage ? "/app/data" : "/data"}`,
      initial && previousImage ? previousImage : image,
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
    run(true);
    const checkRuntime = () =>
      docker(
        "exec",
        name,
        "node",
        "-e",
        "const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os');assert.equal(os.userInfo().username,'nivra');assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);assert.equal(process.env.NIVRA_DATA_DIR,'/data');assert.equal(process.env.HOME,'/data');assert.equal(fs.statSync('/data').uid,1000);assert.equal(fs.existsSync('/app/data'),false);",
      );
    if (!previousImage) checkRuntime();
    const checkNotices = () =>
      docker(
        "exec",
        name,
        "node",
        "-e",
        "const fs=require('node:fs');const p='/app/THIRD_PARTY_NOTICES.txt';const s=fs.readFileSync(p,'utf8');for(const item of ['NIVRA THIRD-PARTY NOTICES','onnxruntime-node@1.30.0','Assistant (SIL Open Font License 1.1)','Cascadia Code (SIL Open Font License 1.1)','Comic Shanns (MIT)','Excalifont (SIL Open Font License 1.1)','Liberation Sans (pre-2.00 family license)','Lilita One (SIL Open Font License 1.1)','Nunito (SIL Open Font License 1.1)','Virgil (SIL Open Font License 1.1)','Xiaolai SC (SIL Open Font License 1.1)'])if(!s.includes(item))throw Error('Runtime third-party notice is missing: '+item);",
      );
    if (!previousImage) checkNotices();
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
      "if(require('node:fs').existsSync(require('node:path').join(process.env.NIVRA_DATA_DIR,'nivra.sqlite'))) process.exit(1)",
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
    checkRuntime();
    checkNotices();
    const expectedCommit = process.env.NIVRA_EXPECT_COMMIT;
    if (expectedCommit) {
      const expectedVersion = process.env.NIVRA_EXPECT_VERSION || null;
      const logs = docker("logs", name);
      const label = `${expectedVersion ?? "development"} (commit ${expectedCommit.slice(0, 7)})`;
      assert.ok(
        logs.includes(`Nivra ${label}`),
        `The startup log must name the running version (${label}):\n${logs.slice(0, 600)}`,
      );
      const { build } = await (
        await request("/api/v1/system", "GET", undefined, cookie)
      ).json();
      assert.deepEqual(
        [build.version, build.commit],
        [expectedVersion, expectedCommit],
        "Settings must report the version the image was built from",
      );
    }
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
      "process.stdout.write(String(JSON.parse(require('node:fs').readFileSync('/data/encryption-mode.json')).encrypted))",
    );
    assert.equal(
      savedMode,
      String(encrypted),
      "Encryption mode changed after recreation",
    );
    console.log(
      `Container verified: ${encrypted ? "encrypted" : "plaintext"} onboarding, authorization, single owner, files tooling and ${previousImage ? "volume upgrade" : "persistence"}.`,
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
