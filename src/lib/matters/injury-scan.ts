/**
 * The client's injuries, read out of the file rather than typed in twice.
 *
 * Nobody maintains an "injuries" field. What exists is an intake note that says
 * "cervical and lumbar spine, both shoulders, both knees", an imaging summary
 * that names the tears, calendar entries for two arthroscopies, and a hundred
 * emails chasing a surgical date. This walks a matter's records, matches a
 * body-part lexicon with its laterality, and returns one `InjurySite` per
 * region with the passages that put it there.
 *
 * Pure, in the same sense as `lib/matter/derive`: records in, sites out, no
 * database and no deep-link builder of its own. That is what lets the indexed
 * dashboard and the live case view share one extraction instead of growing two
 * lexicons that drift. The SQLite-and-permissions half lives in ./injuries.
 *
 * Deliberately model-free. A silhouette is a navigation aid, and it has to draw
 * the same way on every load, offline, with no key and no latency; a region
 * that moved because the sampler disagreed with itself would be worse than no
 * region. Every site carries its passages, so the reader checks the record
 * rather than trusting the dot.
 *
 * Two things the regex cannot do, and does not pretend to:
 *  - It reads mentions, not diagnoses. A region is hot because the file keeps
 *    returning to it, which is a decent proxy for significance and is not the
 *    same as severity.
 *  - It cannot tell a claim from a defence. Passages that read as prior or
 *    denied are marked `disputed` rather than dropped — on this file the
 *    contested left ankle is exactly what a new reader needs to see.
 */

import type { SourceRecord } from "@/lib/rag/sources";

import { type BodySide, regionId, bodyRegion, siteMarks, type SiteMark } from "./body-regions";

export type InjuryTier = "mild" | "moderate" | "severe";

export interface InjuryEvidence {
  /** `note:2997040808`, `document_page:21122800973#p4` — the citation key used elsewhere. */
  ref: string;
  kind: string;
  title: string;
  /** The record's own date, YYYY-MM-DD. */
  date: string | null;
  excerpt: string;
  clioUrl: string | null;
  /** The passage reads as a prior, denied, or degenerative finding. */
  disputed: boolean;
}

export interface InjurySite {
  regionId: string;
  label: string;
  part: string;
  side: BodySide;
  /** Distinct records that name this region. */
  mentions: number;
  /** 0–1, drives the heat. Peak finding weighted over raw volume. */
  intensity: number;
  tier: InjuryTier;
  /** Matched finding words, deduped and in file order: "tear", "arthroscopy". */
  findings: string[];
  /** Named where the file states its claim — the case summary or a pleading. */
  claimed: boolean;
  /** At least one passage reads as prior, denied, or degenerative. */
  disputed: boolean;
  evidence: InjuryEvidence[];
  /**
   * Where to draw this site, per silhouette view.
   *
   * Resolved here rather than in each renderer. The React map could look the
   * geometry up itself; the case view is a standalone HTML document that gets
   * only this JSON, and a second copy of the region table in that file would
   * drift from this one the first time a region moved.
   */
  marks: SiteMark[];
}

export interface InjuryMap {
  matterId: number;
  sites: InjurySite[];
  /** Records read. Shown so an empty map is legible as "nothing matched". */
  scanned: number;
  /** Records dropped because this viewer may not read them. */
  withheld: number;
}

export interface ScanOptions {
  /** Builds the deep link for a record; injected so this module stays pure. */
  link?: (record: SourceRecord) => string | null;
}

/* --- lexicon ------------------------------------------------------------- */

interface PartSpec {
  part: string;
  /** True when the part exists on both sides and laterality must be resolved. */
  paired: boolean;
  pattern: RegExp;
}

/**
 * Body parts, by the words a medical record actually uses.
 *
 * Bare anatomy words are avoided where they carry a second meaning in a legal
 * file — "head" matches only in `head injury` and its clinical synonyms,
 * because "head of claims" is a person. Every pattern is global and sticky-free
 * so one source can match a part more than once.
 */
const PARTS: readonly PartSpec[] = [
  {
    part: "head",
    paired: false,
    pattern:
      /\b(head injur\w*|traumatic brain injur\w*|TBI|concussi\w*|post-concussive|brain MRI|brain injur\w*|skull|parietal|intracranial|white matter tract\w*|hemosiderin|cognitive deficit\w*)\b/gi,
  },
  {
    part: "neck",
    paired: false,
    pattern: /\b(cervical\w*|neck|C[2-7]\s*[-–/]\s*C?[2-7]|lordosis)\b/gi,
  },
  {
    part: "shoulder",
    paired: true,
    pattern:
      /\b(shoulders?|rotator cuff|labral|labrum|infraspinatus|supraspinatus|glenohumeral|acromio\w*|deltoid)\b/gi,
  },
  {
    part: "thoracic",
    paired: false,
    pattern: /\b(thoracic|upper back|T\d{1,2}\s*[-–]\s*T?\d{1,2}|dorsal spine)\b/gi,
  },
  {
    part: "lumbar",
    paired: false,
    pattern:
      /\b(lumbar|lumbosacral|low(?:er)? back|L[1-5]\s*[-–/]\s*(?:S1|L[1-5])|sacroiliac|sciatica|radiculopath\w*)\b/gi,
  },
  { part: "chest", paired: false, pattern: /\b(chest|ribs?|sternum|sternal|costal)\b/gi },
  { part: "abdomen", paired: false, pattern: /\b(abdomen|abdominal|hernia)\b/gi },
  { part: "hip", paired: true, pattern: /\b(hips?|acetabul\w*|iliac)\b/gi },
  {
    part: "knee",
    paired: true,
    pattern: /\b(knees?|menisc\w*|patell\w*|ACL|MCL|cruciate|prepatellar)\b/gi,
  },
  { part: "ankle", paired: true, pattern: /\b(ankles?|talus|talar|achilles|malleol\w*)\b/gi },
  { part: "foot", paired: true, pattern: /\b(foot|feet|metatars\w*|plantar|hallux)\b/gi },
  { part: "elbow", paired: true, pattern: /\b(elbows?|olecranon|epicondyl\w*)\b/gi },
  { part: "wrist", paired: true, pattern: /\b(wrists?|carpal|scaphoid)\b/gi },
];

/** Laterality words, searched in a window around the part word. */
const LATERALITY =
  /\b(bilateral(?:ly)?|both|left|right|l(?:eft)?\s*(?:and|&|\/)\s*r(?:ight)?)\b/gi;

/**
 * Finding words, strongest first. The top match a region reaches anywhere in
 * the file sets its peak, which is most of the heat.
 */
const FINDINGS: readonly { weight: number; label: string; pattern: RegExp }[] = [
  {
    weight: 3,
    label: "surgery",
    pattern:
      /\b(surg\w*|arthroscop\w*|operative report|post-?operative|repair|fusion|discectomy|replacement|amputat\w*)\b/i,
  },
  {
    weight: 2,
    label: "structural",
    pattern: /\b(tears?|torn|fractur\w*|herniat\w*|ruptur\w*|avulsion|dislocat\w*|lesion)\b/i,
  },
  {
    weight: 1,
    label: "soft tissue",
    pattern:
      /\b(bulg\w*|sprain\w*|strain\w*|o?edema|contusion|impingement|derangement|stenosis|inflamm\w*|pain|tenderness)\b/i,
  },
];

/** The passage is talking about a prior, denied, or degenerative finding. */
const DISPUTED =
  /\b(prior|pre-?existing|preexisting|previous|denie[sd]|degenerative|not claimed|no .{0,24}(?:injury|claim) (?:is )?(?:claimed|alleged)|discrepanc\w*|inconsistent)\b/i;

/** The passage is the file stating what it claims, rather than discussing it. */
const CLAIMED =
  /\b(injur(?:y|ies) claimed|bill of particulars|claims? (?:for|of) injur\w*|alleges?|sustained|complaint alleges|case summary)\b/i;

/* --- extraction ---------------------------------------------------------- */

interface Accumulator {
  regionId: string;
  mentions: number;
  peak: number;
  findings: Set<string>;
  claimed: boolean;
  disputed: boolean;
  evidence: InjuryEvidence[];
}

/**
 * Scan a matter's records for body parts.
 *
 * Linear over the text — a few hundred records on a real file, a few
 * milliseconds. There is no index to maintain and no cache to go stale, so the
 * answer always matches what the records say right now.
 *
 * The caller decides what records to pass. That is where access control lives:
 * a region the viewer may not read is absent, not drawn faintly.
 */
export function scanInjuries(
  records: readonly SourceRecord[],
  options: ScanOptions = {},
): InjurySite[] {
  const sites = new Map<string, Accumulator>();
  for (const record of records) scanRecord(record, options, sites);
  return finalise(sites);
}

/** Add one record's matches to the running map. One record counts once per region. */
function scanRecord(
  row: SourceRecord,
  options: ScanOptions,
  sites: Map<string, Accumulator>,
): void {
  const text = row.text;
  const seenHere = new Set<string>();

  for (const spec of PARTS) {
    spec.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = spec.pattern.exec(text)) !== null) {
      // Wide enough to carry a readable passage, tight enough that "surgery"
      // three paragraphs away does not get attributed to this body part.
      const window = text.slice(
        Math.max(0, match.index - 120),
        Math.min(text.length, match.index + match[0].length + 120),
      );
      const sides = spec.paired ? resolveSides(text, match.index) : (["center"] as BodySide[]);

      for (const side of sides) {
        const id = regionId(spec.part, side);
        if (!id) continue;

        const finding = strongestFinding(window);
        const disputed = DISPUTED.test(window);
        const claimed = CLAIMED.test(window);

        const site = sites.get(id) ?? blankSite(id);
        sites.set(id, site);

        // Volume is "how many records keep coming back to this", not "how many
        // times the word appears" — one email can say "shoulder" nine times.
        if (!seenHere.has(id)) {
          seenHere.add(id);
          site.mentions += 1;
          site.evidence.push(evidence(row, options, window, disputed));
        }

        if (finding) {
          site.peak = Math.max(site.peak, finding.weight);
          site.findings.add(finding.label);
        }
        site.claimed ||= claimed;
        site.disputed ||= disputed;
      }
    }
  }
}

function blankSite(id: string): Accumulator {
  return {
    regionId: id,
    mentions: 0,
    peak: 0,
    findings: new Set(),
    claimed: false,
    disputed: false,
    evidence: [],
  };
}

/**
 * Which side(s) a part word refers to.
 *
 * Reads the nearest laterality word in a tight window around the match —
 * "left shoulder", "shoulder, right", "both knees". With none in range the
 * mention is recorded on both sides, because a file that says "the shoulder
 * surgery" has already told you which one somewhere else, and losing the
 * mention would under-draw a region the file plainly cares about.
 */
export function resolveSides(text: string, at: number): BodySide[] {
  const from = Math.max(0, at - 34);
  const window = text.slice(from, Math.min(text.length, at + 24));
  const relative = at - from;

  let nearest: { word: string; distance: number } | null = null;
  LATERALITY.lastIndex = 0;
  let found: RegExpExecArray | null;

  while ((found = LATERALITY.exec(window)) !== null) {
    const distance = Math.abs(found.index - relative);
    if (!nearest || distance < nearest.distance) {
      nearest = { word: found[0].toLowerCase(), distance };
    }
  }

  if (!nearest) return ["left", "right"];
  if (nearest.word === "left") return ["left"];
  if (nearest.word === "right") return ["right"];
  return ["left", "right"];
}

function strongestFinding(window: string): { weight: number; label: string } | null {
  for (const finding of FINDINGS) {
    if (finding.pattern.test(window)) return { weight: finding.weight, label: finding.label };
  }
  return null;
}

function evidence(
  row: SourceRecord,
  options: ScanOptions,
  window: string,
  disputed: boolean,
): InjuryEvidence {
  const page = row.page > 0 ? row.page : null;

  return {
    ref: page ? `${row.kind}:${row.clioId}#p${page}` : `${row.kind}:${row.clioId}`,
    kind: row.kind,
    title: row.title || `${row.kind} ${row.clioId}`,
    date: row.occurredAt ? row.occurredAt.slice(0, 10) : null,
    excerpt: excerpt(window),
    clioUrl: options.link?.(row) ?? null,
    disputed,
  };
}

/**
 * A readable snippet around the match.
 *
 * Trimmed to sentence edges where there are any, because a passage that starts
 * mid-word reads as a bug even when the match behind it is right.
 */
function excerpt(window: string): string {
  const flat = window.replace(/\s+/g, " ").trim();
  const start = flat.search(/[A-Z0-9-]/);
  const body = start > 0 && start < 60 ? flat.slice(start) : flat;
  if (body.length <= 240) return body;
  const cut = body.slice(0, 240);
  const lastStop = cut.lastIndexOf(". ");
  return `${lastStop > 120 ? cut.slice(0, lastStop + 1) : cut.trimEnd()}…`;
}

const KIND_RANK: Record<string, number> = {
  custom_field: 0,
  matter: 1,
  note: 2,
  document_page: 3,
  communication: 4,
  calendar_entry: 5,
  task: 6,
  document: 7,
};

const MAX_EVIDENCE = 4;

/**
 * Turn the accumulators into sites, and the counts into heat.
 *
 * Heat is RELATIVE to this file, not absolute. A matter where the worst region
 * is a sprained wrist should still show that wrist as its hottest point — the
 * map answers "where does this file keep pointing", and a scale calibrated
 * against some imagined worst case would render every ordinary matter blank.
 *
 * Mentions are square-rooted before normalising. Raw counts are dominated by
 * whichever part the medical-records boilerplate happens to repeat on every
 * page, and a linear scale lets that one part flatten everything else.
 */
function finalise(sites: Map<string, Accumulator>): InjurySite[] {
  const out: InjurySite[] = [];
  const busiest = Math.max(1, ...[...sites.values()].map((site) => site.mentions));

  for (const site of sites.values()) {
    const region = bodyRegion(site.regionId);
    if (!region) continue;

    // One stray word with a finding beside it is not an injury.
    if (site.mentions < 2 && site.peak < 2) continue;

    // Volume leads and the peak finding modulates it, rather than the two
    // adding. Added, a part named twice next to the word "surgery" outranks a
    // part the file returns to twenty times, which is backwards.
    const volume = Math.sqrt(site.mentions / busiest);
    const intensity = Math.min(1, volume * (0.6 + 0.4 * (site.peak / 3)));

    out.push({
      regionId: site.regionId,
      label: region.label,
      part: region.part,
      side: region.side,
      mentions: site.mentions,
      intensity,
      tier: intensity >= 0.6 ? "severe" : intensity >= 0.25 ? "moderate" : "mild",
      findings: [...site.findings],
      claimed: site.claimed,
      disputed: site.disputed,
      evidence: rankEvidence(site.evidence).slice(0, MAX_EVIDENCE),
      marks: siteMarks(region, intensity),
    });
  }

  // Loudest first, so the list beside the map reads in the order a reader cares.
  return out.sort((a, b) => b.intensity - a.intensity || b.mentions - a.mentions);
}

/** Undisputed first, then by kind — a case summary beats a chaser email. */
function rankEvidence(evidence: InjuryEvidence[]): InjuryEvidence[] {
  return [...evidence].sort((a, b) => {
    if (a.disputed !== b.disputed) return a.disputed ? 1 : -1;
    const rank = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
    if (rank !== 0) return rank;
    return (a.date ?? "").localeCompare(b.date ?? "");
  });
}
