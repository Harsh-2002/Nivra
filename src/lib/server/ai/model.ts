import manifest from "./model-manifest.json";
export const modelVersion = `${manifest.id}:${manifest.revision}`;

export const embeddingSpace = {
  version: modelVersion,
  modality: "text",
  dimensions: manifest.dimensions,
} as const;
