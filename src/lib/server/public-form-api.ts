import { formApiInputs } from "./form-api-schemas";
import { publicForm, publicFormExists, submitForm } from "./forms";
import {
  createFormUploadSession,
  formUploadReservation,
  removeFormUpload,
  reserveFormUpload,
  writeFormUpload,
} from "./form-uploads";
import { uploadLimit } from "./config";
import {
  clientKey,
  HttpError,
  json,
  readLimited,
  response,
  throttle,
  throttleClient,
} from "./http";
export async function publicFormApi(request: Request, path: string[]) {
  const [, , token, action, fileId] = path;
  const method = request.method;
  if (!token) throw new HttpError(404, "Form not available.");
  if (method !== "GET") {
    if (!publicFormExists(token))
      throw new HttpError(404, "Form not available.");
    const client = clientKey(request);
    throttleClient(`form:${token}:${client}`, 120);
    throttleClient(`forms:client:${client}`, 240);
    // Forwarded addresses can be forged by direct clients, so these caps do not depend on them.
    throttle(`form:${token}`, 600);
    throttle("forms:anonymous", 1500);
  }
  if (method === "GET" && !action) {
    const form = publicForm(token);
    return response({
      status: form.status,
      versionId: form.versionId,
      definition: form.definition,
      maxFileBytes: Math.min(uploadLimit(), 10 * 1024 * 1024),
      maxResponseBytes: 25 * 1024 * 1024,
    });
  }
  if (method === "POST" && action === "responses")
    return response(submitForm(token, await json(request)), 201);
  if (method === "POST" && action === "sessions") {
    const input = formApiInputs.uploadSession.parse(await json(request));
    return response(createFormUploadSession(token, input.versionId), 201);
  }
  if (method === "POST" && action === "uploads" && !fileId) {
    const { secret, ...input } = formApiInputs.reservation.parse(
      await json(request),
    );
    return response(reserveFormUpload(token, secret, input), 201);
  }
  if (action === "uploads" && fileId) {
    if (method === "PUT") {
      const secret = request.headers.get("X-Form-Upload");
      if (!secret)
        throw new HttpError(400, "Provide the upload session secret.");
      const reservation = formUploadReservation(token, secret, fileId);
      return response(
        await writeFormUpload(
          token,
          secret,
          fileId,
          await readLimited(request, Math.min(uploadLimit(), reservation.size)),
        ),
      );
    }
    if (method === "DELETE")
      return response(
        await removeFormUpload(
          token,
          formApiInputs.secret.parse(await json(request)).secret,
          fileId,
        ),
      );
  }
  throw new HttpError(404, "Form not available.");
}
