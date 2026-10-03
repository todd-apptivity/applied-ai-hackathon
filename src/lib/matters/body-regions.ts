/**
 * The body map's vocabulary and its geometry, in one place.
 *
 * Two things live here because they have to agree: the regions the extractor
 * can name, and where those regions sit on the silhouette. Splitting them lets
 * one side grow a region the other cannot draw.
 *
 * Pure data — no database, no Node built-ins — so the extractor (server) and
 * the map (client) can both import it.
 *
 * Sides are the CLIENT's left and right, which is how a medical record speaks.
 * The anterior view therefore puts the client's left on the viewer's right,
 * the convention every imaging report and operative note already assumes; the
 * posterior view puts it back on the viewer's left. `regionPoint` is the only
 * thing that knows that, so nothing else has to.
 */

export type BodySide = "left" | "right" | "center";
export type BodyView = "anterior" | "posterior";

export interface BodyRegion {
  /** `shoulder-left`, `lumbar`. Stable; the extractor emits these. */
  id: string;
  /** The unsided part, shared by a left/right pair. */
  part: string;
  label: string;
  side: BodySide;
  /** Which silhouettes this region is drawn on. Spine is back-only. */
  views: readonly BodyView[];
  /** Centre in viewBox units, as laid out for the ANTERIOR view. */
  x: number;
  y: number;
  /** Radius of the heat blob. Bigger parts bleed wider. */
  radius: number;
}

/** The silhouette's coordinate space. Everything below is in these units. */
export const BODY_VIEWBOX = { width: 220, height: 530 } as const;

/**
 * The silhouette itself: head, neck, torso, two arms, two legs, two feet.
 *
 * Kept as separate paths rather than one union because each was tuned on its
 * own, and because they are drawn twice — once filled as the body, once as the
 * clip path that keeps the heat from leaking outside it.
 */
export const BODY_PATHS: readonly string[] = [
  // head
  "M 85 42 A 25 30 0 0 1 135 42 A 25 30 0 0 1 85 42 Z",
  // neck
  "M 100 62 L 120 62 L 122 92 L 98 92 Z",
  // torso
  "M 122 86 C 128 90 134 93 140 98 C 146 103 148 112 147 122 C 145 140 142 160 140 178 C 138 196 136 206 134 216 C 136 232 140 246 141 262 C 142 276 140 288 136 294 L 84 294 C 80 288 78 276 79 262 C 80 246 84 232 86 216 C 84 206 82 196 80 178 C 78 160 75 140 73 122 C 72 112 74 103 80 98 C 86 93 92 90 98 86 Z",
  // arms
  "M 138 97 C 151 100 160 110 161 126 C 162 148 162 170 162 192 C 163 214 164 238 164 262 C 164 276 164 288 163 296 C 162 304 156 309 151 308 C 146 307 144 301 144 293 C 144 281 146 269 147 256 C 149 234 148 212 148 190 C 148 168 147 146 146 126 C 145 113 139 104 138 97 Z",
  "M 82 97 C 69 100 60 110 59 126 C 58 148 58 170 58 192 C 57 214 56 238 56 262 C 56 276 56 288 57 296 C 58 304 64 309 69 308 C 74 307 76 301 76 293 C 76 281 74 269 73 256 C 71 234 72 212 72 190 C 72 168 73 146 74 126 C 75 113 81 104 82 97 Z",
  // legs
  "M 140 292 C 144 300 144 322 142 346 C 140 366 136 376 134 396 C 132 420 130 444 129 466 C 128 480 127 492 126 500 C 125 506 116 507 114 500 C 112 492 112 478 112 462 C 112 440 112 416 112 392 C 112 368 111 330 110 302 Z",
  "M 80 292 C 76 300 76 322 78 346 C 80 366 84 376 86 396 C 88 420 90 444 91 466 C 92 480 93 492 94 500 C 95 506 104 507 106 500 C 108 492 108 478 108 462 C 108 440 108 416 108 392 C 108 368 109 330 110 302 Z",
  // feet
  "M 112 498 L 130 498 C 139 498 145 503 145 508 C 145 512 141 514 133 514 L 115 514 C 111 514 109 510 110 504 Z",
  "M 108 498 L 90 498 C 81 498 75 503 75 508 C 75 512 79 514 87 514 L 105 514 C 109 514 111 510 110 504 Z",
];

const BOTH: readonly BodyView[] = ["anterior", "posterior"];
const FRONT: readonly BodyView[] = ["anterior"];
const BACK: readonly BodyView[] = ["posterior"];

export const BODY_REGIONS: readonly BodyRegion[] = [
  { id: "head", part: "head", label: "Head", side: "center", views: BOTH, x: 110, y: 40, radius: 26 },
  { id: "neck", part: "neck", label: "Neck / cervical spine", side: "center", views: BOTH, x: 110, y: 82, radius: 20 },
  { id: "shoulder-left", part: "shoulder", label: "Left shoulder", side: "left", views: BOTH, x: 144, y: 110, radius: 24 },
  { id: "shoulder-right", part: "shoulder", label: "Right shoulder", side: "right", views: BOTH, x: 76, y: 110, radius: 24 },
  { id: "chest", part: "chest", label: "Chest / ribs", side: "center", views: FRONT, x: 110, y: 145, radius: 28 },
  { id: "thoracic", part: "thoracic", label: "Upper back / thoracic spine", side: "center", views: BACK, x: 110, y: 150, radius: 28 },
  { id: "abdomen", part: "abdomen", label: "Abdomen", side: "center", views: FRONT, x: 110, y: 205, radius: 24 },
  { id: "lumbar", part: "lumbar", label: "Low back / lumbar spine", side: "center", views: BACK, x: 110, y: 215, radius: 26 },
  { id: "elbow-left", part: "elbow", label: "Left elbow", side: "left", views: BOTH, x: 155, y: 196, radius: 16 },
  { id: "elbow-right", part: "elbow", label: "Right elbow", side: "right", views: BOTH, x: 65, y: 196, radius: 16 },
  { id: "wrist-left", part: "wrist", label: "Left wrist / hand", side: "left", views: BOTH, x: 154, y: 292, radius: 16 },
  { id: "wrist-right", part: "wrist", label: "Right wrist / hand", side: "right", views: BOTH, x: 66, y: 292, radius: 16 },
  { id: "hip-left", part: "hip", label: "Left hip", side: "left", views: BOTH, x: 130, y: 270, radius: 20 },
  { id: "hip-right", part: "hip", label: "Right hip", side: "right", views: BOTH, x: 90, y: 270, radius: 20 },
  { id: "knee-left", part: "knee", label: "Left knee", side: "left", views: BOTH, x: 123, y: 384, radius: 20 },
  { id: "knee-right", part: "knee", label: "Right knee", side: "right", views: BOTH, x: 97, y: 384, radius: 20 },
  { id: "ankle-left", part: "ankle", label: "Left ankle", side: "left", views: BOTH, x: 119, y: 478, radius: 16 },
  { id: "ankle-right", part: "ankle", label: "Right ankle", side: "right", views: BOTH, x: 101, y: 478, radius: 16 },
  { id: "foot-left", part: "foot", label: "Left foot", side: "left", views: BOTH, x: 126, y: 507, radius: 14 },
  { id: "foot-right", part: "foot", label: "Right foot", side: "right", views: BOTH, x: 94, y: 507, radius: 14 },
];

const BY_ID = new Map(BODY_REGIONS.map((region) => [region.id, region]));

export function bodyRegion(id: string): BodyRegion | undefined {
  return BY_ID.get(id);
}

/** The region id for a part and a side, or null when that pairing has no region. */
export function regionId(part: string, side: BodySide): string | null {
  const id = side === "center" ? part : `${part}-${side}`;
  return BY_ID.has(id) ? id : null;
}

/**
 * Where to draw a region in a given view.
 *
 * The silhouette is the same shape from both sides, so the posterior view is
 * the anterior one mirrored. Mirroring the drawing would be wrong — the body
 * is symmetric but the heat is not — so only the points move.
 */
export function regionPoint(region: BodyRegion, view: BodyView): { x: number; y: number } {
  const x = view === "posterior" ? BODY_VIEWBOX.width - region.x : region.x;
  return { x, y: region.y };
}

/** One blob to draw: which silhouette, where on it, and how wide. */
export interface SiteMark {
  view: BodyView;
  x: number;
  y: number;
  /** Blob radius in viewBox units, already scaled by the site's intensity. */
  r: number;
}

/**
 * Every blob a site contributes, across the views it appears in.
 *
 * Resolving the geometry once, here, is what lets a renderer that has only the
 * scan's JSON — the case view is a standalone HTML document — draw the same
 * body as the React map without carrying its own copy of the region table.
 */
export function siteMarks(region: BodyRegion, intensity: number): SiteMark[] {
  const scale = 0.55 + 0.45 * Math.min(1, Math.max(0, intensity));
  return region.views.map((view) => {
    const point = regionPoint(region, view);
    return { view, x: point.x, y: point.y, r: region.radius * scale };
  });
}
