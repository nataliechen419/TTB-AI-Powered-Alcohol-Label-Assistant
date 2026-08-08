import { FIELD_LABELS, STATUTORY_GOVERNMENT_WARNING, type ApplicationData, type FieldKey, type FieldResult } from './db.js'
import { UNREADABLE, type LabelExtraction } from './extract.js'

/** Lowercases, drops decorative punctuation, and collapses whitespace so
 * "STONE'S THROW" and "Stone's Throw" — or "12.5% Alc. by Vol." and
 * "12.5% ALC BY VOL" — normalize to the same string. Periods adjacent to a
 * digit are preserved so decimals like "12.5" survive. Whitespace between a
 * digit and an immediately-following unit (e.g. "750 mL" vs "750ml", "40 %"
 * vs "40%") is also collapsed, since that spacing is purely cosmetic. Used
 * for the "minor variance" tier — broader, case/punctuation-insensitive. */
function normalizeLoose(value: string): string {
  return value
    .toLowerCase()
    .replace(/(?<!\d)\.(?!\d)/g, '')
    .replace(/['",()]/g, '')
    .replace(/(\d)\s+(?=[a-z%])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Narrower than normalizeLoose: only touches number+unit pairs — collapsing
 * whitespace between a digit run and the unit letters/percent sign right
 * after it, and lowercasing just that unit (e.g. "750 mL" -> "750ml", "40 %"
 * -> "40%"). Everything else in the string keeps its original case and
 * spacing. Values that are identical except for this kind of formatting are
 * literally the same measurement, so they're treated as a full match rather
 * than a "minor variance" — unlike broader case/punctuation differences
 * elsewhere in the string (e.g. a brand name), which still surface as a
 * variance for a reviewer to eyeball. */
function normalizeUnits(value: string): string {
  return value.trim().replace(/(\d+)\s*([a-zA-Z%]+)/g, (_m, digits: string, unit: string) => `${digits}${unit.toLowerCase()}`)
}

/** Distinguishes two very different signals coming out of extraction:
 * - UNREADABLE: the field is present on the label but the image quality
 *   makes it illegible — re-uploading a clearer photo could fix this.
 * - empty string: the field simply isn't printed on the label at all —
 *   no re-upload of the same label will ever produce a value.
 * Returns a FieldResult for either case, or null if the field was actually
 * detected and normal comparison logic should run. */
function missingFieldResult(
  key: FieldKey,
  appValue: string,
  detected: string,
  opts: { highStakes?: boolean; missingNote?: string } = {},
): FieldResult | null {
  const label = FIELD_LABELS[key]
  const trimmed = detected.trim()

  if (trimmed === UNREADABLE) {
    return { key, label, appValue, detected: "Could not read — image unclear in this area.", status: 'unreadable', ...(opts.highStakes ? { highStakes: true } : {}) }
  }

  if (!trimmed) {
    return {
      key, label, appValue, detected: 'Not on label', status: 'missing',
      note: opts.missingNote ?? 'This field was not found anywhere on the label.',
      ...(opts.highStakes ? { highStakes: true } : {}),
    }
  }

  return null
}

/** True if the shorter of the two (already normalizeLoose'd) strings appears
 * as a contiguous, whole-word run inside the longer one — e.g. "sierra
 * nevada" inside "sierra nevada brewing co". Word-boundary matching (rather
 * than a raw substring check) avoids false positives like "cat" incidentally
 * appearing inside "category". A lone single-word match is only accepted if
 * that word has some real length, so short filler words don't trigger it. */
function isTruncatedForm(a: string, b: string): boolean {
  const wordsA = a.split(' ').filter(Boolean)
  const wordsB = b.split(' ').filter(Boolean)
  if (wordsA.length === 0 || wordsB.length === 0 || wordsA.length === wordsB.length) return false

  const [shorter, longer] = wordsA.length < wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA]
  if (shorter.length === 1 && shorter[0].length < 4) return false

  const shortStr = shorter.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\s)${shortStr}(\\s|$)`).test(longer.join(' '))
}

/** Strips combining diacritical marks (e.g. ñ -> n, é -> e) via Unicode NFD
 * decomposition, so accented and unaccented spellings of otherwise-identical
 * text can be compared. Used to recognize the specific "OCR misread an
 * accent" pattern — Claude's vision extraction occasionally drops or
 * mis-transcribes diacritics on producer/brand names (e.g. reading "La
 * Rojeña" as "La Rojenia") — so that case gets a pointed, specific note
 * telling the reviewer exactly which kind of thing to double-check, instead
 * of a generic "wording differs somewhere in here" variance note. */
function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

const DIACRITIC_VARIANCE_NOTE =
  'Detected text matches once accented characters are ignored — this looks like a misread diacritic (e.g. ñ, é, ü) rather than a real discrepancy. Double-check that specific letter against the label.'

/** Fraction of the smaller (already normalizeLoose'd) value's words that also
 * appear in the other, ignoring order — e.g. "Korbel Brut" vs "Korbel
 * Champagne Cellars" share {korbel} out of 2, a ratio of 0.5. Originally
 * written for bottler-address comparison (where a producer's name is largely
 * intact but a city/importer clause differs) but the same signal generalizes
 * to any short text field: it catches "clearly related, not clearly
 * identical" pairs — same core name/word, different qualifier — without
 * hardcoding which brand or field it applies to. */
function wordOverlapRatio(a: string, b: string): number {
  const wordsA = new Set(a.split(/[\s,]+/).filter(Boolean))
  const wordsB = new Set(b.split(/[\s,]+/).filter(Boolean))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let shared = 0
  for (const w of wordsA) if (wordsB.has(w)) shared++
  return shared / Math.min(wordsA.size, wordsB.size)
}

/** Standard edit distance (single-character insertions/deletions/substitutions)
 * between two strings. Used to recognize a single-letter OCR slip within one
 * word (e.g. "Cultavin" read as "Culvavin") as distinct from a genuinely
 * different word. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const prev: number[] = Array.from({ length: n + 1 })
  const curr: number[] = Array.from({ length: n + 1 })
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j]
  }
  return prev[n]
}

/** True if two (already-normalized, comma/whitespace-tokenized) word lists
 * are identical except for exactly one position, where that one differing
 * word-pair is within a character or two of each other — e.g. "cultavin"
 * vs "culvavin" (one substitution). This is the signature of a single-letter
 * OCR misread on an otherwise-correctly-read word, not a real difference in
 * content (a real difference — a different city, a different producer name
 * entirely — swaps in an unrelated word, not a near-identical one). Returns
 * the two differing words so the caller can name them in the reviewer note,
 * or null if the lists don't fit this exact pattern. */
function singleWordMisread(a: string, b: string): [string, string] | null {
  const wordsA = a.split(/[\s,]+/).filter(Boolean)
  const wordsB = b.split(/[\s,]+/).filter(Boolean)
  if (wordsA.length !== wordsB.length || wordsA.length === 0) return null

  let diffIndex = -1
  for (let i = 0; i < wordsA.length; i++) {
    if (wordsA[i] !== wordsB[i]) {
      if (diffIndex !== -1) return null // more than one word differs — not this pattern
      diffIndex = i
    }
  }
  if (diffIndex === -1) return null // identical — handled elsewhere

  const wa = wordsA[diffIndex], wb = wordsB[diffIndex]
  const maxLen = Math.max(wa.length, wb.length)
  if (maxLen < 4) return null // too short for edit distance to be a meaningful signal
  const distance = levenshtein(wa, wb)
  return distance > 0 && distance <= Math.max(1, Math.floor(maxLen / 6)) ? [wa, wb] : null
}

function compareGeneric(key: FieldKey, appValue: string, detected: string): FieldResult {
  const missing = missingFieldResult(key, appValue, detected)
  if (missing) return missing

  const label = FIELD_LABELS[key]

  if (
    appValue.trim() === detected.trim() ||
    normalizeUnits(appValue) === normalizeUnits(detected) ||
    appValue.trim().toLowerCase() === detected.trim().toLowerCase()
  ) {
    // Pure case difference (e.g. "Robert Mondavi Winery" vs "ROBERT MONDAVI
    // WINERY") — nothing else about the text differs, so this is a full
    // match, not a variance. Labels are legally allowed to print most
    // fields in all caps; that's not a discrepancy worth flagging.
    return { key, label, appValue, detected, status: 'match' }
  }

  const looseApp = normalizeLoose(appValue)
  const looseDetected = normalizeLoose(detected)

  if (looseApp === looseDetected) {
    return { key, label, appValue, detected, status: 'variance', note: 'Minor formatting difference (punctuation/case) — value is the same.' }
  }

  // Not identical, but identical once accents are stripped — almost always a
  // misread diacritic rather than a real wording difference (see
  // stripDiacritics above). Checked before the fuzzier truncation/word-
  // overlap tiers below because it's a much more specific, higher-confidence
  // signal than "shares some words" — pin the reviewer's attention on the
  // actual accented character rather than a generic wording-differs note.
  if (stripDiacritics(looseApp) === stripDiacritics(looseDetected)) {
    return { key, label, appValue, detected, status: 'variance', note: DIACRITIC_VARIANCE_NOTE }
  }

  // One side is a shortened/expanded form of the other, with the whole
  // shorter form appearing intact inside the longer one — e.g. a label
  // printing "Sierra Nevada" for an application declared as "Sierra Nevada
  // Brewing Co.", or a label printing "BACARDI 151" for an application
  // declared as "Bacardi". A human reviewer reads both of those as
  // unambiguously the same brand/name — the extra text is a corporate
  // suffix or a product-line descriptor, not a different identity — so this
  // is a match, not a discrepancy to flag. The note still explains what the
  // extra wording was, so a reviewer can see it at a glance.
  if (isTruncatedForm(looseApp, looseDetected)) {
    return {
      key, label, appValue, detected, status: 'match',
      note: 'Detected text is a shortened or expanded form of the application value (e.g. a dropped corporate suffix or an added product descriptor) — same underlying value.',
    }
  }

  // Neither identical nor a clean truncation, but still clearly related —
  // e.g. a label reading "Korbel Brut" for an application declared as
  // "Korbel Champagne Cellars" shares the core brand word but adds/swaps a
  // qualifier. That's worth a reviewer's glance, not an automatic hard
  // mismatch as if the two were unrelated strings.
  if (wordOverlapRatio(looseApp, looseDetected) >= 0.5) {
    return {
      key, label, appValue, detected, status: 'variance',
      note: 'Detected text shares some wording with the application value but differs beyond formatting — worth a quick check.',
    }
  }

  return { key, label, appValue, detected, status: 'mismatch', note: 'Detected value does not match the application.' }
}

/** Used only for standalone batch validation (no application record to
 * compare against yet), where there's no ground truth to judge class/type
 * wording against. When there IS an application on file, classType now goes
 * through the normal compareGeneric tiers like every other field. */
function comparePresenceOnly(key: FieldKey, appValue: string, detected: string): FieldResult {
  const missing = missingFieldResult(key, appValue, detected)
  if (missing) return missing

  return { key, label: FIELD_LABELS[key], appValue, detected, status: 'onLabel' }
}

function compareCountryOfOrigin(appValue: string | null, detected: string): FieldResult | null {
  // Domestic products don't require this field — skip the row entirely.
  if (appValue === null) return null

  const missing = missingFieldResult('countryOfOrigin', appValue, detected, {
    missingNote: 'Country of origin is required for imports but was not found on the label.',
  })
  if (missing) return missing

  // Unlike other fields, a bare case difference here (e.g. "Product of
  // Mexico" vs "PRODUCT OF MEXICO") isn't worth surfacing as even a minor
  // variance — country-of-origin wording has no legal casing requirement
  // the way the Government Warning does, so treat it as a full match.
  const key = 'countryOfOrigin'
  if (appValue.trim().toLowerCase() === detected.trim().toLowerCase()) {
    return { key, label: FIELD_LABELS[key], appValue, detected, status: 'match' }
  }

  return compareGeneric(key, appValue, detected)
}

/** Extracts an ABV percentage from either a direct "%" statement (e.g. "40%
 * ALC BY VOL") or a US proof statement — "80 Proof", "80° Proof", or just a
 * bare "151°" with no "PROOF" wording at all (some labels lean on the ° mark
 * alone, especially in a product name like "Bacardi 151°") — proof is
 * exactly double the ABV percentage. Returns null if neither pattern is
 * found. */
function parseAbvPercent(value: string): number | null {
  const pctMatch = value.match(/(\d+(?:\.\d+)?)\s*%/)
  if (pctMatch) return parseFloat(pctMatch[1])

  const proofMatch = value.match(/(\d+(?:\.\d+)?)\s*°?\s*proof/i)
  if (proofMatch) return parseFloat(proofMatch[1]) / 2

  const degreeMatch = value.match(/(\d+(?:\.\d+)?)\s*°/)
  if (degreeMatch) return parseFloat(degreeMatch[1]) / 2

  return null
}

/** True if a value states its strength purely as proof (with either the
 * word "PROOF" or a bare ° mark) and never states a "%" anywhere — used to
 * decide whether the proof->percent conversion note below applies. */
function isProofForm(value: string): boolean {
  if (value.includes('%')) return false
  return /proof/i.test(value) || /\d\s*°/.test(value)
}

/** Formats a numeric ABV percentage for display, trimming to at most 2
 * decimal places without leaving trailing zeros (e.g. 40 -> "40% ALC BY
 * VOL", 75.5 -> "75.5% ALC BY VOL"). Spelled out with the full "ALC BY VOL"
 * wording (not just the bare "%") so the converted figure reads as a
 * complete alcohol-content statement next to the proof figure, not a
 * fragment. */
function formatAbvPercent(pct: number): string {
  return `${Number(pct.toFixed(2))}% ALC BY VOL`
}

/** A label stating alcohol content purely as US proof (e.g. "80 PROOF", with
 * no "%" at all) is the same value as the application's percentage, not a
 * discrepancy — proof is exactly double the ABV%. When that's a genuine unit
 * difference (one side proof, the other percent), this appends the
 * %-equivalent onto the *detected* value for display (e.g. "80 Proof" ->
 * "80 Proof (40% ALC BY VOL)") rather than annotating the application's
 * declared value, so the reviewer sees the conversion right next to the
 * proof figure as printed on the label, plus a note underneath calling out
 * that it's a unit difference, not a real discrepancy. If both sides already
 * state a percentage and that number agrees, it's not a unit conversion at
 * all — just a wording difference (e.g. "15.0% ALC BY VOL" vs "15.0% BY
 * VOL"). The alcohol content itself is confirmed identical either way, so
 * both cases resolve to a full match — the note still explains what actually
 * differed, in case a reviewer wants to eyeball it. */
function compareAbv(appValue: string, detected: string): FieldResult {
  const key: FieldKey = 'abv'
  const label = FIELD_LABELS[key]

  const missing = missingFieldResult(key, appValue, detected)
  if (missing) return missing

  const generic = compareGeneric(key, appValue, detected)
  // Only a clean match short-circuits here. A 'variance' from compareGeneric
  // (e.g. its word-overlap tier) is just a generic string-similarity signal —
  // it doesn't know ABV is a number. "5.6% ALC BY VOL" vs "ALC. 5.6% VOL."
  // shares enough words to read as "variance" generically, but the number
  // itself is identical, which is a stronger, more specific signal that
  // should win: if the percentages parse and agree, it's a real match, not
  // a "worth a quick check" wording variance.
  if (generic.status === 'match') return generic

  const appPct = parseAbvPercent(appValue)
  const detectedPct = parseAbvPercent(detected)

  // The reverse case matters just as much: ABV is a regulated number, not
  // prose, so once both sides parse as a percentage, that number is
  // authoritative and must override compareGeneric's word-overlap guess —
  // "12.5% ALC BY VOL" vs "13% ALC BY VOL" share every word except the
  // digit itself, which reads as a close "variance" generically, but a
  // genuinely different alcohol content is a real compliance mismatch, not
  // a phrasing nuance, and must never be softened to "variance".
  if (appPct !== null && detectedPct !== null && Math.abs(appPct - detectedPct) >= 0.05) {
    return { key, label, appValue, detected, status: 'mismatch', note: 'Detected alcohol content does not match the application.' }
  }
  if (appPct === null || detectedPct === null) {
    return generic
  }

  const appIsProof = isProofForm(appValue)
  const detectedIsProof = isProofForm(detected)

  if (appIsProof !== detectedIsProof) {
    const detectedDisplay = detectedIsProof ? `${detected} (${formatAbvPercent(detectedPct)})` : detected
    return {
      key, label, appValue, detected: detectedDisplay, status: 'match',
      note: 'Label states a different unit (proof vs. % ALC/VOL) than the application — same alcohol content once converted.',
    }
  }

  return {
    key, label, appValue, detected, status: 'match',
    note: 'Same alcohol percentage — minor wording difference from the application.',
  }
}

/** EU/UK packaging convention: a lone trailing "e" (or its official "℮"
 * glyph) after the quantity marks it as an "estimated" fill under EU
 * average-quantity rules — e.g. "355 ml e". It's regulatory boilerplate
 * about the fill, not a different quantity, so it's stripped before
 * comparing net contents. The leading whitespace before the mark is
 * optional (`\s*`, not `\s+`) because on a small/low-res source photo the
 * mark sits close enough to the unit that OCR sometimes runs them together
 * with no space at all — e.g. "700 ml e" read back as "700 mle" — and that's
 * still the same estimated-fill mark, not a different unit ("mle"), so it
 * should still be recognized and stripped. */
function stripEstimatedSignMark(value: string): string {
  return value.replace(/\s*[e℮]\.?\s*$/i, '').trim()
}

/** Parses a metric volume statement (mL, cL, or L) into a common mL value
 * plus the unit actually used, so differently-stated volumes (e.g. "70 CL"
 * vs "700 mL") can be compared numerically. Returns null if no recognizable
 * metric unit is found (e.g. a bare "12 fl oz" statement). */
function parseVolumeMl(value: string): { ml: number; unit: 'ml' | 'cl' | 'l' } | null {
  const match = value.match(/(\d+(?:\.\d+)?)\s*(ml|cl|l)\b/i)
  if (!match) return null
  const amount = parseFloat(match[1])
  const unit = match[2].toLowerCase() as 'ml' | 'cl' | 'l'
  const ml = unit === 'ml' ? amount : unit === 'cl' ? amount * 10 : amount * 1000
  return { ml, unit }
}

/** Formats an mL amount for display, trimming to at most 2 decimal places
 * without leaving trailing zeros (e.g. 700 -> "700 mL", 355 -> "355 mL"). */
function formatVolumeMl(ml: number): string {
  return `${Number(ml.toFixed(2))} mL`
}

/** Applications declare net contents in a single canonical unit (mL). Labels
 * — especially on imports — often print the same volume in a different
 * metric unit (e.g. "70 CL" for what the application declares as "700 mL").
 * That's not a discrepancy, just a different unit for the same quantity, so
 * once the numbers are confirmed equal this appends the mL-equivalent onto
 * the *detected* value for display (e.g. "70 CL" -> "70 CL (700 mL)") rather
 * than annotating the application's declared value — mirroring how the ABV
 * proof/percent conversion is surfaced. The label's own trailing EU
 * "estimated fill" mark (e.g. "355 ml e") is stripped before comparing,
 * since it's a fill-quantity disclaimer, not a different quantity. */
function compareNetContents(appValue: string, detected: string): FieldResult {
  const key: FieldKey = 'netContents'
  const label = FIELD_LABELS[key]

  const missing = missingFieldResult(key, appValue, detected)
  if (missing) return missing

  const detectedCore = stripEstimatedSignMark(detected)
  const generic = compareGeneric(key, appValue, detectedCore)
  // Same reasoning as compareAbv: a generic 'variance' is only a wording
  // signal, not a volume comparison. If the parsed mL amounts actually agree
  // below, that's authoritative and should win over a wording-based variance.
  if (generic.status === 'match') {
    return { ...generic, appValue, detected }
  }

  const appVol = parseVolumeMl(appValue)
  const detectedVol = parseVolumeMl(detectedCore)
  if (appVol && detectedVol && appVol.unit !== detectedVol.unit && Math.abs(appVol.ml - detectedVol.ml) < 0.5) {
    return {
      key, label, appValue, detected: `${detected} (${formatVolumeMl(detectedVol.ml)})`, status: 'match',
      note: 'Label states a different metric unit than the application — same volume once converted.',
    }
  }

  return { ...generic, appValue, detected }
}

/** Bottler/producer address text on real labels routinely carries more than
 * the bare declared address: a leading attribution phrase ("PRODUCED AND
 * BOTTLED BY"), multiple bottling locations, or — for imports — an
 * additional importer clause for a different market. None of that is a
 * discrepancy as long as the declared address itself appears intact in what
 * was detected, so this checks for containment (after stripping boilerplate
 * and normalizing formatting) before falling back to the generic tiers. */
function normalizeAddressCore(value: string): string {
  return value
    .toLowerCase()
    .replace(/[|\n]/g, ', ')
    .replace(/^\s*(produced\s*(and|&)\s*bottled\s*by|vinted\s*(and|&)\s*bottled\s*by|distilled\s*(and|&)\s*bottled\s*by|bottled\s*by|produced\s*by|imported\s*by)\s*[:,-]?\s*/, '')
    .replace(/['",()]/g, '')
    .replace(/(?<!\d)\.(?!\d)/g, '')
    .replace(/(\d)\s+(?=[a-z%])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Same cleanup as normalizeAddressCore but WITHOUT stripping the leading
 * attribution phrase — used to distinguish two different kinds of "close but
 * not identical": pure punctuation/case noise (this stays unequal to
 * normalizeAddressCore's output too, i.e. genuinely nothing else differs)
 * vs. a label that adds a whole attribution phrase like "PRODUCED BY" that
 * normalizeAddressCore strips as boilerplate. The former is a cosmetic
 * variance; the latter is a real (if legally unremarkable) piece of text
 * that a reviewer would notice was added, so it's called out by name in the
 * match note rather than getting silently swallowed into "punctuation/case". */
function normalizeAddressRaw(value: string): string {
  return value
    .toLowerCase()
    .replace(/[|\n]/g, ', ')
    .replace(/['",()]/g, '')
    .replace(/(?<!\d)\.(?!\d)/g, '')
    .replace(/(\d)\s+(?=[a-z%])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function compareAddress(appValue: string, detected: string): FieldResult {
  const key: FieldKey = 'bottlerAddress'
  const label = FIELD_LABELS[key]

  const missing = missingFieldResult(key, appValue, detected)
  if (missing) return missing

  if (
    appValue.trim() === detected.trim() ||
    normalizeUnits(appValue) === normalizeUnits(detected) ||
    appValue.trim().toLowerCase() === detected.trim().toLowerCase()
  ) {
    return { key, label, appValue, detected, status: 'match' }
  }

  const coreApp = normalizeAddressCore(appValue)
  const coreDetected = normalizeAddressCore(detected)

  if (normalizeAddressRaw(appValue) === normalizeAddressRaw(detected)) {
    // Nothing but punctuation/case differs (e.g. a "|" line break instead of
    // a comma, or all-caps vs. mixed case) — no attribution phrase, city, or
    // other actual wording was added or changed on either side, so this is
    // the same declared address, not something worth a reviewer's second
    // look the way a real (even minor) content difference is.
    return { key, label, appValue, detected, status: 'match', note: 'Minor formatting difference (punctuation/case) only — the declared address matches.' }
  }

  // Not identical, but identical once accents are stripped — a misread
  // diacritic (see stripDiacritics above), not a genuinely different
  // address. Checked before the coreApp/coreDetected containment and
  // word-overlap tiers below since it's a more specific signal.
  if (stripDiacritics(normalizeAddressRaw(appValue)) === stripDiacritics(normalizeAddressRaw(detected))) {
    return { key, label, appValue, detected, status: 'variance', note: DIACRITIC_VARIANCE_NOTE }
  }

  if (coreApp === coreDetected) {
    // The only difference was a recognized attribution prefix (e.g.
    // "Produced By") that normalizeAddressCore strips as boilerplate — the
    // declared address itself is identical, so this is a match, not a
    // variance, but the note still says what the extra text was.
    return {
      key, label, appValue, detected, status: 'match',
      note: 'Label includes a standard attribution phrase (e.g. "Produced By") not present in the application — the declared address itself matches exactly.',
    }
  }

  if (coreDetected.includes(coreApp) || coreApp.includes(coreDetected)) {
    return {
      key, label, appValue, detected, status: 'match',
      note: 'Label includes additional text beyond the declared address (e.g. an importer clause or attribution prefix) — the declared address itself matches.',
    }
  }

  // Every word lines up except one, and that one word is a near-identical
  // spelling (e.g. "Cultavin" vs "Culvavin") — a single-letter OCR misread
  // on an otherwise-correct read, not an actual different producer/city.
  // Checked before the generic word-overlap tier below, whose "a detail
  // (e.g. city) differs" note would be misleading here since nothing about
  // the address content actually differs.
  const misread = singleWordMisread(coreApp, coreDetected)
  if (misread) {
    return {
      key, label, appValue, detected, status: 'variance',
      note: `Detected text differs from the application by what looks like a single-letter misread ("${misread[1]}" vs "${misread[0]}") rather than a real address difference — double-check that word against the label.`,
    }
  }

  // Largely the same address (same producer name, same state, etc.) with
  // one differing detail — most commonly a city, when a producer has more
  // than one bottling location. Worth a reviewer's glance, not a hard
  // mismatch.
  if (wordOverlapRatio(coreApp, coreDetected) >= 0.6) {
    return {
      key, label, appValue, detected, status: 'variance',
      note: 'Address is largely the same as declared; a detail (e.g. city) differs — worth a quick check.',
    }
  }

  return { key, label, appValue, detected, status: 'mismatch', note: 'Detected value does not match the application.' }
}

/** The Government Warning is higher-stakes than the other fields: TTB
 * regulations require exact wording AND all-caps presentation, so even a
 * case-only difference is a hard mismatch here — unlike other fields, where
 * case/punctuation differences are just a "minor variance". */
function compareGovernmentWarning(appValue: string, detected: string): FieldResult {
  const missing = missingFieldResult('governmentWarning', appValue, detected, {
    highStakes: true,
    missingNote: 'The statutory Government Warning is required by law but was not found on the label.',
  })
  if (missing) return missing

  const label = FIELD_LABELS.governmentWarning
  const wordingMatches = normalizeLoose(detected) === normalizeLoose(STATUTORY_GOVERNMENT_WARNING)
  const isAllCaps = detected === detected.toUpperCase()

  if (!wordingMatches) {
    return {
      key: 'governmentWarning', label, appValue, detected, status: 'mismatch', highStakes: true,
      note: 'Wording deviates from the statutory Government Warning text. This must be corrected.',
    }
  }

  if (!isAllCaps) {
    return {
      key: 'governmentWarning', label, appValue, detected, status: 'mismatch', highStakes: true,
      note: 'Required in ALL CAPS and bold. Label uses mixed case — this must be corrected.',
    }
  }

  return { key: 'governmentWarning', label, appValue, detected, status: 'match', highStakes: true }
}

/** Fields a reviewer can optionally type into "Custom Test Mode" to cross-
 * check a one-off label photo that isn't tied to a queued application yet.
 * Only brandName is required — everything else left blank falls back to a
 * presence-only check (like validateStandalone) instead of a value
 * comparison, since there's no declared ground truth for that field. */
export interface FlexibleApplicationInput {
  brandName: string
  beverageType?: string
  classType?: string
  abv?: string
  netContents?: string
  bottlerAddress?: string
  countryOfOrigin?: string
}

/** Same tiered comparison logic as compareToApplication, but for a label
 * being spot-checked ad hoc rather than against a filed application — any
 * field the reviewer didn't bother typing in falls back to a presence-only
 * row (matching validateStandalone's behavior for a fully blank form) rather
 * than being skipped or forced into a false "mismatch". */
export function compareFlexible(input: FlexibleApplicationInput, extraction: LabelExtraction): FieldResult[] {
  const results: FieldResult[] = []

  results.push(compareGeneric('brandName', input.brandName, extraction.brandName))

  if (input.beverageType?.trim()) {
    results.push(compareGeneric('beverageType', input.beverageType, extraction.beverageType))
  } else {
    results.push(comparePresenceOnly('beverageType', '(not provided)', extraction.beverageType))
  }

  results.push(
    input.classType?.trim()
      ? compareGeneric('classType', input.classType, extraction.classType)
      : comparePresenceOnly('classType', '(not provided)', extraction.classType),
  )

  results.push(input.abv?.trim() ? compareAbv(input.abv, extraction.abv) : comparePresenceOnly('abv', '(not provided)', extraction.abv))

  results.push(
    input.netContents?.trim()
      ? compareNetContents(input.netContents, extraction.netContents)
      : comparePresenceOnly('netContents', '(not provided)', extraction.netContents),
  )

  results.push(
    input.bottlerAddress?.trim()
      ? compareAddress(input.bottlerAddress, extraction.bottlerAddress)
      : comparePresenceOnly('bottlerAddress', '(not provided)', extraction.bottlerAddress),
  )

  if (input.countryOfOrigin?.trim()) {
    const country = compareCountryOfOrigin(input.countryOfOrigin, extraction.countryOfOrigin)
    if (country) results.push(country)
  } else if (extraction.countryOfOrigin.trim() && extraction.countryOfOrigin.trim() !== UNREADABLE) {
    // No expected country was entered, but the label has one printed —
    // surface it as a presence-only row rather than silently dropping it,
    // since a reviewer would still want to see what was detected.
    results.push(comparePresenceOnly('countryOfOrigin', '(not provided)', extraction.countryOfOrigin))
  }

  // The Government Warning has one legally correct wording regardless of
  // what (if anything) the reviewer typed — there's no separate input for
  // it in Custom Test Mode, so it's always checked against the statutory
  // text, same as validateStandalone.
  results.push(compareGovernmentWarning('(statutory text required)', extraction.governmentWarning))

  return results
}

export function compareToApplication(applicationData: ApplicationData, extraction: LabelExtraction): FieldResult[] {
  const results: FieldResult[] = []

  results.push(compareGeneric('brandName', applicationData.brandName, extraction.brandName))
  results.push(compareGeneric('beverageType', applicationData.beverageType, extraction.beverageType))
  results.push(compareGeneric('classType', applicationData.classType, extraction.classType))
  results.push(compareAbv(applicationData.abv, extraction.abv))
  results.push(compareNetContents(applicationData.netContents, extraction.netContents))
  results.push(compareAddress(applicationData.bottlerAddress, extraction.bottlerAddress))

  const country = compareCountryOfOrigin(applicationData.countryOfOrigin, extraction.countryOfOrigin)
  if (country) results.push(country)

  results.push(compareGovernmentWarning(applicationData.governmentWarning, extraction.governmentWarning))

  return results
}

/** No application record exists yet for freshly-batched files, so instead of
 * comparing against ground truth we run self-contained TTB validation:
 * required fields present + government warning wording/caps correct. Every
 * field below except governmentWarning gets an 'onLabel' status rather than
 * 'match' — there's no expected value on file to actually match against, so
 * these only confirm the field is present and legible, not that it's
 * correct. Labeling that "Match" would misleadingly imply a real comparison
 * happened. governmentWarning is the one exception: its wording is checked
 * against the fixed statutory text below, which IS a genuine comparison. */
export function validateStandalone(extraction: LabelExtraction): FieldResult[] {
  const results: FieldResult[] = []

  const requiredKeys: { key: Exclude<FieldKey, 'countryOfOrigin' | 'governmentWarning' | 'classType'>; value: string }[] = [
    { key: 'brandName', value: extraction.brandName },
    { key: 'beverageType', value: extraction.beverageType },
    { key: 'abv', value: extraction.abv },
    { key: 'netContents', value: extraction.netContents },
    { key: 'bottlerAddress', value: extraction.bottlerAddress },
  ]

  for (const { key, value } of requiredKeys) {
    results.push(comparePresenceOnly(key, '(no application on file)', value))
  }

  results.push(comparePresenceOnly('classType', '(no application on file)', extraction.classType))

  const gw = extraction.governmentWarning
  const gwLabel = FIELD_LABELS.governmentWarning
  const missingGw = missingFieldResult('governmentWarning', '(statutory text required)', gw, {
    highStakes: true,
    missingNote: 'The statutory Government Warning is required by law but was not found on the label.',
  })
  if (missingGw) {
    results.push(missingGw)
  } else {
    const wordingMatches = normalizeLoose(gw) === normalizeLoose(STATUTORY_GOVERNMENT_WARNING)
    const isAllCaps = gw === gw.toUpperCase()
    if (!wordingMatches) {
      results.push({ key: 'governmentWarning', label: gwLabel, appValue: '(statutory text required)', detected: gw, status: 'mismatch', highStakes: true, note: 'Wording deviates from the statutory Government Warning text.' })
    } else if (!isAllCaps) {
      results.push({ key: 'governmentWarning', label: gwLabel, appValue: '(statutory text required)', detected: gw, status: 'mismatch', highStakes: true, note: 'Required in ALL CAPS and bold. Label uses mixed case.' })
    } else {
      results.push({ key: 'governmentWarning', label: gwLabel, appValue: '(statutory text required)', detected: gw, status: 'match', highStakes: true })
    }
  }

  return results
}
