import { cpSync, mkdirSync } from "node:fs";
import "./build-icons.mjs";
import { copyPinnedOcrAsset } from "./copy-ocr-asset.mjs";
mkdirSync("public/excalidraw", { recursive: true });
cpSync(
  "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
  "public/excalidraw/fonts",
  { recursive: true },
);
copyPinnedOcrAsset(
  "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
  "generated/ocr/4.0.0_best_int/eng.traineddata.gz",
);
