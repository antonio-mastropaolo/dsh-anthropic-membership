import { createRequire } from "node:module";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { capRequestImage, longEdge, ANTHROPIC_MANY_IMAGE_MAX_DIMENSION } from "./request-image.mjs";
import { resolveDshNodeModules } from "./dsh-nm.mjs";

const require = createRequire(import.meta.url);
const sharp = require(join(resolveDshNodeModules(), "sharp"));

const src = await sharp({
  create: {
    width: 2449,
    height: 1712,
    channels: 3,
    background: { r: 12, g: 24, b: 36 },
  },
}).png().toBuffer();
const meta = await sharp(src).metadata();
assert.equal(meta.width, 2449);
assert.equal(meta.height, 1712);
assert.ok(longEdge(meta) > ANTHROPIC_MANY_IMAGE_MAX_DIMENSION);

const capped = await capRequestImage({
  data: src,
  mediaType: "image/png",
  width: meta.width,
  height: meta.height,
  bytes: src.byteLength,
  hasAlpha: false,
});
assert.ok(longEdge(capped) <= ANTHROPIC_MANY_IMAGE_MAX_DIMENSION, `long edge ${longEdge(capped)}`);
assert.ok(capped.width <= 2000);
assert.ok(capped.height <= 2000);
assert.equal(Math.round((capped.width / capped.height) * 100), Math.round((2449 / 1712) * 100));
console.log("capRequestImage", `${meta.width}x${meta.height} -> ${capped.width}x${capped.height}`);

const small = await capRequestImage({
  data: src,
  mediaType: "image/png",
  width: 800,
  height: 600,
  bytes: src.byteLength,
  hasAlpha: false,
});
assert.equal(small.width, 800);
assert.equal(small.height, 600);
console.log("pass");
