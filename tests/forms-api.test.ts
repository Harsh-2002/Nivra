import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Forms HTTP contract isolates public submissions, scoped content and private files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-forms-api-"));
  process.env.NIVRA_DATA_DIR = directory;
  process.env.NIVRA_PUBLIC_URL = "http://localhost:3000";
  const { GET } = await import("../src/app/api/v1/[...path]/route");
  const { sqlite } = await import("../src/lib/server/db");
  const d = sqlite();
  const { stopJobWorker } = await import("../src/lib/server/jobs");
  const { operationFor } = await import("../src/lib/server/api-contract");
  let cookie = "";
  async function call(
    route: string,
    method = "GET",
    input?: unknown,
    auth: string | null = null,
    anonymous = false,
    headers: Record<string, string> = {},
  ) {
    return GET(
      new Request(`http://localhost:3000/api/v1/${route}`, {
        method,
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-type": "application/json",
          ...(auth
            ? { authorization: `Bearer ${auth}` }
            : anonymous
              ? {}
              : { cookie }),
          ...headers,
        },
        body:
          input === undefined
            ? undefined
            : input instanceof Uint8Array
              ? new Uint8Array(input)
              : JSON.stringify(input),
      }),
      { params: Promise.resolve({ path: route.split("?")[0].split("/") }) },
    );
  }
  async function body(response: Response, status = 200) {
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  try {
    const setup = await call("setup", "POST", {
      name: "Forms Owner",
      username: "forms",
      password: "Test-" + randomUUID(),
    });
    cookie = setup.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    await body(setup);
    const read = await body(
      await call("ai-connections", "POST", {
        action: "create-key",
        name: "Read",
        access: "read",
      }),
      201,
    );
    const write = await body(
      await call("ai-connections", "POST", {
        action: "create-key",
        name: "Write",
        access: "full",
      }),
      201,
    );
    assert.equal(
      (await call("forms", "GET", undefined, null, true)).status,
      401,
    );
    assert.equal((await call("forms", "POST", {}, read.key)).status, 403);
    const fieldId = randomUUID(),
      fileId = randomUUID();
    const definition = {
      schemaVersion: 1,
      title: "Survey",
      confirmation: `Thanks. Contact: {{field:${fieldId}}}`,
      fields: [
        { id: fieldId, type: "email", label: "Email", required: true },
        {
          id: fileId,
          type: "file",
          label: "Document",
          fileTypes: ["document"],
        },
      ],
    };
    assert.equal(
      (
        await call(
          "forms",
          "POST",
          {
            definition: {
              ...definition,
              confirmation: `Thanks {{field:${randomUUID()}}}`,
            },
          },
          write.key,
        )
      ).status,
      400,
    );
    const requestKey = "forms-" + randomUUID();
    const form = await body(
      await call("forms", "POST", { definition }, write.key, false, {
        "Idempotency-Key": requestKey,
      }),
      201,
    );
    const retried = await body(
      await call("forms", "POST", { definition }, write.key, false, {
        "Idempotency-Key": requestKey,
      }),
      201,
    );
    assert.equal(form.id, retried.id);
    assert.equal(
      (
        await call(
          `forms/${form.id}`,
          "PATCH",
          { revision: 99, favorite: true },
          write.key,
        )
      ).status,
      409,
    );
    const patchKey = "patch-" + randomUUID();
    const patch = { revision: form.revision, favorite: true };
    const saved = await body(
      await call(`forms/${form.id}`, "PATCH", patch, write.key, false, {
        "Idempotency-Key": patchKey,
      }),
    );
    const savedRetry = await body(
      await call(`forms/${form.id}`, "PATCH", patch, write.key, false, {
        "Idempotency-Key": patchKey,
      }),
    );
    assert.deepEqual(savedRetry, saved);
    assert.equal(saved.revision, form.revision + 1);
    assert.equal(
      (
        await call(
          `forms/${form.id}`,
          "PATCH",
          { ...patch, favorite: false },
          write.key,
          false,
          { "Idempotency-Key": patchKey },
        )
      ).status,
      409,
    );
    form.revision = saved.revision;
    const published = await body(
      await call(
        `forms/${form.id}/publish`,
        "POST",
        { revision: form.revision },
        write.key,
      ),
    );
    assert.match(published.url, /^http:\/\/localhost:3000\/form\//);
    const publicPath = `public/forms/${published.publicToken}`;
    const publicDefinition = await body(
      await call(publicPath, "GET", undefined, null, true),
    );
    assert.equal(publicDefinition.definition.title, "Survey");
    assert.equal(publicDefinition.ownerId, undefined);
    assert.equal(
      (await call(publicPath + "/responses", "GET", undefined, null, true))
        .status,
      405,
    );
    assert.equal(
      (
        await call(
          publicPath + "/responses",
          "POST",
          {
            versionId: published.publishedVersionId,
            retryKey: randomUUID(),
            answers: { [fieldId]: "invalid" },
          },
          null,
          true,
        )
      ).status,
      400,
    );
    const session = await body(
      await call(
        publicPath + "/sessions",
        "POST",
        { versionId: published.publishedVersionId },
        null,
        true,
      ),
      201,
    );
    const bytes = new TextEncoder().encode("A document");
    const reserved = await body(
      await call(
        publicPath + "/uploads",
        "POST",
        {
          secret: session.secret,
          fieldId: fileId,
          filename: "document.txt",
          size: bytes.length,
        },
        null,
        true,
      ),
      201,
    );
    assert.equal(
      (
        await call(
          publicPath + `/uploads/${reserved.id}`,
          "PUT",
          bytes,
          null,
          true,
          { "content-type": "application/octet-stream" },
        )
      ).status,
      400,
    );
    await body(
      await call(
        publicPath + `/uploads/${reserved.id}`,
        "PUT",
        bytes,
        null,
        true,
        {
          "content-type": "application/octet-stream",
          "X-Form-Upload": session.secret,
        },
      ),
    );
    const submission = {
      versionId: published.publishedVersionId,
      retryKey: randomUUID(),
      uploadSecret: session.secret,
      answers: { [fieldId]: "owner@example.test", [fileId]: [reserved.id] },
    };
    const accepted = await body(
      await call(publicPath + "/responses", "POST", submission, null, true),
      201,
    );
    assert.equal(accepted.confirmation, "Thanks. Contact: owner@example.test");
    assert.ok(
      operationFor(`/api/v1/${publicPath}/responses`, "POST")?.output.safeParse(
        accepted,
      ).success,
    );
    assert.equal(
      (
        await body(
          await call(publicPath + "/responses", "POST", submission, null, true),
          201,
        )
      ).id,
      accepted.id,
    );
    const results = await body(
      await call(`forms/${form.id}/responses`, "GET", undefined, read.key),
    );
    assert.equal(results.total, 1);
    const detail = await body(
      await call(
        `forms/${form.id}/responses/${accepted.id}`,
        "GET",
        undefined,
        read.key,
      ),
    );
    assert.ok(
      operationFor(
        `/api/v1/forms/${form.id}/responses/${accepted.id}`,
        "GET",
      )?.output.safeParse(detail).success,
    );
    const privateFile = `forms/${form.id}/files/${reserved.id}`;
    assert.equal(
      (await call(privateFile, "GET", undefined, null, true)).status,
      401,
    );
    assert.equal(
      await (await call(privateFile, "GET", undefined, read.key)).text(),
      "A document",
    );
    const csv = await call(
      `forms/${form.id}/export/csv`,
      "GET",
      undefined,
      read.key,
    );
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), /owner@example.test/);
    assert.equal((await call(`forms/${form.id}/export/not-json`)).status, 400);
    const updated = await body(
      await call(
        `forms/${form.id}/responses/${accepted.id}`,
        "PATCH",
        { revision: detail.revision, reviewed: true },
        write.key,
      ),
    );
    const sharedTag = randomUUID();
    const automaticTag = randomUUID();
    const manualTag = randomUUID();
    d.prepare(
      "INSERT INTO tags(id,name,color) VALUES(?,'Shared automatic','gray'),(?,'Unreviewed automatic','gray'),(?,'Manual response','gray')",
    ).run(sharedTag, automaticTag, manualTag);
    for (const tagId of [sharedTag, automaticTag, manualTag])
      d.prepare(
        "INSERT INTO response_tags(response_id,tag_id) VALUES(?,?)",
      ).run(accepted.id, tagId);
    const ownerId = (
      d.prepare("SELECT owner_id FROM forms WHERE id=?").get(form.id) as {
        owner_id: string;
      }
    ).owner_id;
    const responseSource = `response:${accepted.id}`;
    const attachmentSource = `form-file:${reserved.id}`;
    for (const sourceKey of [responseSource, attachmentSource])
      d.prepare(
        "UPDATE ai_content SET owner_id=?,item_kind='response',item_id=?,state='indexed',indexed_generation=generation,fingerprint='fixture-fingerprint',pending=0 WHERE source_key=?",
      ).run(ownerId, accepted.id, sourceKey);
    const generation = (sourceKey: string) =>
      (
        d
          .prepare("SELECT generation FROM ai_content WHERE source_key=?")
          .get(sourceKey) as { generation: number }
      ).generation;
    const addAutomation = d.prepare(
      "INSERT INTO ai_auto_assignments(source_key,tag_id,generation,fingerprint,approved,created_at) VALUES(?,?,?,?,?,?)",
    );
    addAutomation.run(
      responseSource,
      sharedTag,
      generation(responseSource),
      "fixture-fingerprint",
      0,
      Date.now(),
    );
    addAutomation.run(
      attachmentSource,
      sharedTag,
      generation(attachmentSource),
      "fixture-fingerprint",
      1,
      Date.now(),
    );
    for (const sourceKey of [responseSource, attachmentSource])
      addAutomation.run(
        sourceKey,
        automaticTag,
        generation(sourceKey),
        "fixture-fingerprint",
        0,
        Date.now(),
      );
    const unreviewed = await body(
      await call(
        `forms/${form.id}/responses/${accepted.id}`,
        "PATCH",
        { revision: updated.revision, reviewed: false },
        write.key,
      ),
    );
    assert.equal(unreviewed.reviewed, false);
    assert.equal(unreviewed.revision, updated.revision + 1);
    assert.deepEqual(
      new Set(
        (
          d
            .prepare("SELECT tag_id FROM response_tags WHERE response_id=?")
            .all(accepted.id) as { tag_id: string }[]
        ).map(({ tag_id }) => tag_id),
      ),
      new Set([sharedTag, manualTag]),
    );
    assert.deepEqual(
      d
        .prepare(
          "SELECT source_key,tag_id,approved FROM ai_auto_assignments WHERE source_key IN(?,?) ORDER BY source_key,tag_id",
        )
        .all(responseSource, attachmentSource),
      [{ source_key: attachmentSource, tag_id: sharedTag, approved: 1 }],
    );
    await body(
      await call(
        `forms/${form.id}/responses/${accepted.id}`,
        "DELETE",
        { revision: unreviewed.revision },
        write.key,
      ),
    );
    assert.equal(
      (
        await call(
          `forms/${form.id}/responses/${accepted.id}`,
          "PATCH",
          { revision: unreviewed.revision + 1, reviewed: false },
          write.key,
        )
      ).status,
      403,
    );
    assert.equal(
      (await call(privateFile, "GET", undefined, read.key)).status,
      404,
    );
    await body(
      await call(
        `forms/${form.id}`,
        "DELETE",
        { revision: published.revision },
        write.key,
      ),
    );
    assert.equal(
      (await call(publicPath, "GET", undefined, null, true)).status,
      404,
    );
    assert.equal(
      (
        await call(
          `forms/${form.id}`,
          "PATCH",
          { revision: published.revision + 1, favorite: true },
          write.key,
        )
      ).status,
      403,
    );
    assert.deepEqual(sqlite().pragma("foreign_key_check"), []);
  } finally {
    await stopJobWorker();
    sqlite().close();
    await rm(directory, { recursive: true, force: true });
  }
});
