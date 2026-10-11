import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import { InferenceSession, Tensor } from "onnxruntime-node";
import manifest from "./model-manifest.json";
export const modelVersion = `${manifest.id}:${manifest.revision}`;
export async function loadEmbedding(directory: string) {
  const json = async (file: string) =>
    JSON.parse(await readFile(path.join(directory, file), "utf8"));
  for (const [file, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(path.join(directory, file));
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error("Local AI model verification failed.");
  }
  const tokenizer = new Tokenizer(
    await json("tokenizer.json"),
    await json("tokenizer_config.json"),
  );
  const session = await InferenceSession.create(
    path.join(directory, "onnx/model_int8.onnx"),
    {
      executionProviders: ["cpu"],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    },
  );
  return {
    async encode(text: string, query = false): Promise<Float32Array> {
      const encoded = tokenizer.encode(
        (query ? manifest.queryPrefix : "") + text,
        { add_special_tokens: true },
      ).ids;
      const ids =
        encoded.length > 512
          ? [...encoded.slice(0, 511), encoded.at(-1)!]
          : encoded;
      const feeds: Record<string, Tensor> = {};
      for (const name of session.inputNames) {
        const values =
          name === "input_ids"
            ? ids
            : name === "attention_mask"
              ? ids.map(() => 1)
              : name === "token_type_ids"
                ? ids.map(() => 0)
                : undefined;
        if (!values) throw new Error("Unsupported local model input.");
        feeds[name] = new Tensor("int64", BigInt64Array.from(values, BigInt), [
          1,
          ids.length,
        ]);
      }
      const outputs = await session.run(feeds);
      const tensor =
        outputs.last_hidden_state ?? outputs[session.outputNames[0]];
      if (
        !(tensor.data instanceof Float32Array) ||
        tensor.data.length < manifest.dimensions
      )
        throw new Error("Invalid local model output.");
      const embedding = Float32Array.from(
        tensor.data.subarray(0, manifest.dimensions),
      );
      const norm = Math.sqrt(
        embedding.reduce((sum, value) => sum + value * value, 0),
      );
      if (!Number.isFinite(norm) || norm <= 0)
        throw new Error("Invalid local embedding.");
      for (let i = 0; i < embedding.length; i++) embedding[i] /= norm;
      return embedding;
    },
    dispose: () => session.release(),
  };
}
