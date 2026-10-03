/**
 * The body map's two halves that can be tested without a database: how a part
 * word gets its side, and whether every region the extractor can name is one
 * the silhouette can draw.
 *
 * The scan itself needs an index, so it is not exercised here. These cover the
 * parts that silently produce a wrong picture rather than an error — a left
 * shoulder drawn on the right, or a region id with nowhere to go.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BODY_REGIONS,
  BODY_VIEWBOX,
  bodyRegion,
  regionId,
  regionPoint,
} from "@/lib/matters/body-regions";
import { resolveSides } from "@/lib/matters/injury-scan";

/** Index of the part word in `text`, for readability in the cases below. */
function at(text: string, word: string): number {
  const index = text.indexOf(word);
  assert.ok(index >= 0, `"${word}" is not in the fixture`);
  return index;
}

describe("laterality", () => {
  it("reads the word before the part", () => {
    const text = "Dr. Capiola is proceeding with a left shoulder labral repair.";
    assert.deepEqual(resolveSides(text, at(text, "shoulder")), ["left"]);
  });

  it("reads the word after the part", () => {
    const text = "MRI report of the shoulder, right, dated 5/24/2023.";
    assert.deepEqual(resolveSides(text, at(text, "shoulder")), ["right"]);
  });

  it("treats both and bilateral as two sides", () => {
    const both = "Injuries claimed: both shoulders and both knees.";
    assert.deepEqual(resolveSides(both, at(both, "shoulders")), ["left", "right"]);

    const bilateral = "Bilateral labral and infraspinatus tears.";
    assert.deepEqual(resolveSides(bilateral, at(bilateral, "labral")), ["left", "right"]);
  });

  it("takes the nearest side word when two are in range", () => {
    const text = "left ankle pain and a right knee effusion";
    assert.deepEqual(resolveSides(text, at(text, "knee")), ["right"]);
    assert.deepEqual(resolveSides(text, at(text, "ankle")), ["left"]);
  });

  it("falls back to both sides rather than dropping the mention", () => {
    const text = "Second surgery recommended. No date for the arthroscopy yet.";
    assert.deepEqual(resolveSides(text, at(text, "arthroscopy")), ["left", "right"]);
  });

  it("ignores a side word that is out of range", () => {
    const text = `His left side was struck. ${"x".repeat(80)} The knee is swollen.`;
    assert.deepEqual(resolveSides(text, at(text, "knee")), ["left", "right"]);
  });
});

describe("regions", () => {
  it("resolves every part and side the extractor can emit", () => {
    for (const region of BODY_REGIONS) {
      assert.equal(regionId(region.part, region.side), region.id);
      assert.equal(bodyRegion(region.id), region);
    }
  });

  it("gives every paired part both sides", () => {
    const sides = new Map<string, Set<string>>();
    for (const region of BODY_REGIONS) {
      if (region.side === "center") continue;
      const seen = sides.get(region.part) ?? new Set<string>();
      seen.add(region.side);
      sides.set(region.part, seen);
    }
    for (const [part, seen] of sides) {
      assert.deepEqual([...seen].sort(), ["left", "right"], `${part} is missing a side`);
    }
  });

  it("has no region without a view to draw it on", () => {
    for (const region of BODY_REGIONS) {
      assert.ok(region.views.length > 0, `${region.id} is never drawn`);
    }
  });

  it("keeps every region inside the silhouette's box, in both views", () => {
    for (const region of BODY_REGIONS) {
      for (const view of region.views) {
        const point = regionPoint(region, view);
        assert.ok(point.x > 0 && point.x < BODY_VIEWBOX.width, `${region.id} x`);
        assert.ok(point.y > 0 && point.y < BODY_VIEWBOX.height, `${region.id} y`);
      }
    }
  });

  it("mirrors sided regions between front and back, and leaves centred ones alone", () => {
    const left = bodyRegion("shoulder-left");
    const right = bodyRegion("shoulder-right");
    assert.ok(left && right);

    // Anterior puts the client's left on the viewer's right; posterior undoes it.
    assert.equal(regionPoint(left, "anterior").x, regionPoint(right, "posterior").x);
    assert.equal(regionPoint(right, "anterior").x, regionPoint(left, "posterior").x);

    const lumbar = bodyRegion("lumbar");
    assert.ok(lumbar);
    assert.equal(regionPoint(lumbar, "posterior").x, BODY_VIEWBOX.width - lumbar.x);
  });
});
