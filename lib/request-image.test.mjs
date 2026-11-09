// Integration test: needs DSH's sharp, so it is skipped (not failed) when DeepSeek Harness is not installed.
import test from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { capRequestImage, longEdge, ANTHROPIC_MANY_IMAGE_MAX_DIMENSION } from "./request-image.mjs";
import { dshNodeModulesOrNull } from "./dsh-nm.mjs";

const nm = dshNodeModulesOrNull();

test("capRequestImage caps a 2449x1712 PNG to the many-image limit and leaves a small one alone",
  { skip: nm ? false : "DeepSeek Harness not installed (needs its sharp); set DSH_NODE_MODULES to run" }, async () => {
    const sharp = createRequire(import.meta.url)(join(nm, "sharp"));
    const src = await sharp({ create: { width: 2449, height: 1712, channels: 3, background: { r: 12, g: 24, b: 36 } } }).png().toBuffer();
    const meta = await sharp(src).metadata();
    assert.equal(meta.width, 2449);
    assert.equal(meta.height, 1712);
    assert.ok(longEdge(meta) > ANTHROPIC_MANY_IMAGE_MAX_DIMENSION);

    const capped = await capRequestImage({ data: src, mediaType: "image/png", width: meta.width, height: meta.height, bytes: src.byteLength, hasAlpha: false });
    assert.ok(longEdge(capped) <= ANTHROPIC_MANY_IMAGE_MAX_DIMENSION, `long edge ${longEdge(capped)}`);
    assert.ok(capped.width <= 2000);
    assert.ok(capped.height <= 2000);
    assert.equal(Math.round((capped.width / capped.height) * 100), Math.round((2449 / 1712) * 100));

    const small = await capRequestImage({ data: src, mediaType: "image/png", width: 800, height: 600, bytes: src.byteLength, hasAlpha: false });
    assert.equal(small.width, 800);
    assert.equal(small.height, 600);
  });
