/** Cap DSH request images to Anthropic's many-image long-edge limit. */
import { createRequire } from "node:module";
import { join } from "node:path";
import { resolveDshNodeModules } from "./dsh-nm.mjs";

const require = createRequire(import.meta.url);
const sharp = require(join(resolveDshNodeModules(), "sharp"));

/** Anthropic many-image requests reject any side above this. */
export const ANTHROPIC_MANY_IMAGE_MAX_DIMENSION = 2000;

export function longEdge(version) {
  return Math.max(version.width ?? 0, version.height ?? 0);
}

/**
 * Return a request-image version whose longest side is <= maxDimension.
 * Aspect ratio is preserved. Already-small versions are returned as-is.
 */
export async function capRequestImage(version, maxDimension = ANTHROPIC_MANY_IMAGE_MAX_DIMENSION) {
  if (!version?.data || !version.width || !version.height) return version;
  if (longEdge(version) <= maxDimension) return version;
  const scale = maxDimension / longEdge(version);
  const width = Math.max(1, Math.floor(version.width * scale));
  const height = Math.max(1, Math.floor(version.height * scale));
  const hasAlpha = version.hasAlpha === true;
  let pipeline = sharp(version.data, {
    failOn: "error",
    limitInputPixels: false,
  })
    .rotate()
    .toColourspace("srgb")
    .resize({
      width,
      height,
      fit: "inside",
      withoutEnlargement: true,
    });
  pipeline = hasAlpha ? pipeline.webp({ quality: 80, effort: 0 }) : pipeline.jpeg({ quality: 80 });
  const buf = await pipeline.toBuffer();
  const meta = await sharp(buf).metadata();
  const outWidth = meta.width ?? width;
  const outHeight = meta.height ?? height;
  return {
    ...version,
    data: new Uint8Array(buf),
    mediaType: hasAlpha ? "image/webp" : "image/jpeg",
    bytes: buf.byteLength,
    width: outWidth,
    height: outHeight,
  };
}

/** Wrap a DSH attachments store so every model-request image meets the cap. */
export function installRequestImageCap(attachments, maxDimension = ANTHROPIC_MANY_IMAGE_MAX_DIMENSION) {
  if (!attachments || typeof attachments.readImageRequest !== "function") {
    throw new Error("attachments.readImageRequest is missing");
  }
  if (attachments.__dshAnthropicImageCap) return attachments;
  const orig = attachments.readImageRequest.bind(attachments);
  attachments.readImageRequest = async function readImageRequestCapped(ref, policy, signal) {
    const version = await orig(ref, policy, signal);
    return capRequestImage(version, maxDimension);
  };
  attachments.__dshAnthropicImageCap = true;
  return attachments;
}
