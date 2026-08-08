import { STATUTORY_GOVERNMENT_WARNING, type ApplicationData, type FieldKey } from './db'
import type { LabelExtraction } from './extract'

const MOCK_UNREADABLE = 'UNREADABLE'

/** Mock mode runs the whole app with zero live Claude calls — either because
 * no ANTHROPIC_API_KEY is configured, or because MOCK_MODE is explicitly set.
 * This makes the app safely demoable (e.g. a reviewer testing it with their
 * own batch of images) without any risk of API spend landing on this account. */
export function isMockMode(): boolean {
  const override = process.env.MOCK_MODE
  if (override === 'true') return true
  if (override === 'false') return false
  return !process.env.ANTHROPIC_API_KEY
}

/** Deterministic PRNG seeded from the uploaded file's own bytes, so the same
 * image always produces the same mock result instead of flickering between
 * runs — makes the demo feel stable rather than random. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 42
  return () => {
    state = (state * 1103515245 + 12345) >>> 0
    return state / 0xffffffff
  }
}

function hashBytes(buf: Buffer, salt = ''): number {
  let seed = salt.length
  for (let i = 0; i < salt.length; i++) seed = (seed * 31 + salt.charCodeAt(i)) >>> 0
  const stride = Math.max(1, Math.floor(buf.length / 256))
  for (let i = 0; i < buf.length; i += stride) seed = (seed * 31 + buf[i]) >>> 0
  return seed >>> 0
}

function titleCaseVariant(value: string): string {
  return value.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
}

function punctuationVariant(value: string): string {
  return value.replace(/[,.]/g, '')
}

/** Mostly returns the true value; occasionally introduces a formatting
 * variance (case/punctuation) or, rarely, a genuine mismatch/unreadable —
 * so a reviewer sees realistic mixed results rather than either "everything
 * matches" or random noise. The "unreadable" tier can be disabled per call
 * (see KNOWN_CLEAR_PHOTO below) for applications where the real photo is
 * known to be sharp — mock mode can't actually look at the pixels, so
 * without this a fine, legible photo could still randomly roll "unreadable"
 * on some field, which looks like a bug rather than a demo quirk. */
function mockField(value: string, rand: () => number, allowUnreadable = true): string {
  const roll = rand()
  if (roll < 0.72) return value
  if (roll < 0.86) return titleCaseVariant(value)
  if (roll < 0.95) return punctuationVariant(value)
  return allowUnreadable ? MOCK_UNREADABLE : value
}

/** Real photos for a couple of seeded applications are EU/UK export versions
 * of the label, which carry only warning symbols/icons instead of the full
 * US-mandated Government Warning paragraph — the text is genuinely absent
 * from that specific label, not blurry or hard to read. Mock mode can't see
 * the actual photo pixels (see mockExtractFromApplication below), so this
 * hardcodes that known ground truth rather than letting the random roll
 * occasionally mislabel "not on label" as "unreadable". */
const KNOWN_NO_GOVERNMENT_WARNING = new Set(['Sierra Nevada Brewing Co.'])

/** Per-field exemptions from the "unreadable" roll for specific known real
 * photos. Mock mode is otherwise fine rolling "unreadable" on any field —
 * that's an intentional, realistic part of the demo, not something to
 * suppress wholesale. This only overrides the specific field+brand
 * combinations where the real photo is plainly legible in that exact spot
 * and a random "unreadable" roll would look like a bug rather than a demo
 * quirk (e.g. Tito's back label prints "DISTILLED 6 TIMES" in large, sharp
 * type — there's no realistic way that area reads as unclear). */
const KNOWN_LEGIBLE_FIELDS: Record<string, Set<string>> = {
  "Tito's Handmade Vodka": new Set(['beverageType']),
}

function isKnownLegible(brandName: string, field: string): boolean {
  return KNOWN_LEGIBLE_FIELDS[brandName]?.has(field) ?? false
}

/** Per-field markers for known real photos where a field is genuinely absent
 * from that specific label — not blurry, not hard to read, just never
 * printed anywhere on it (e.g. Jose Cuervo's back label has no ABV/alcohol
 * content statement at all — no "%", no "ALC BY VOL", nowhere). This is a
 * distinct ground truth from "unreadable" (present but illegible) and from
 * the KNOWN_*_OVERRIDE maps below (present but stated differently) — mock
 * mode can't see the actual photo pixels, so without this a genuinely-absent
 * field would incorrectly cycle through variants of the application's own
 * declared value instead of ever showing "Not on label". Generalizes the
 * same idea KNOWN_NO_GOVERNMENT_WARNING already applies specifically to the
 * government-warning field, to any field on any known real photo. */
const KNOWN_MISSING_FIELDS: Record<string, Set<FieldKey>> = {
  'Jose Cuervo': new Set(['abv']),
}

function isKnownMissing(brandName: string, field: FieldKey): boolean {
  return KNOWN_MISSING_FIELDS[brandName]?.has(field) ?? false
}

/** Short-circuits any field-specific mock generator to an empty string when
 * that field is a known-missing case (see KNOWN_MISSING_FIELDS) — an empty
 * string flows straight into compare.ts's existing "Not on label" / mismatch
 * handling, exactly as a real extraction would for a field that was never
 * printed on the label. */
function withMissingCheck(applicationData: ApplicationData, field: FieldKey, compute: () => string): string {
  if (isKnownMissing(applicationData.brandName, field)) return ''
  return compute()
}

/** Korbel's real photo prints the shortened marketing name "Korbel Brut" as
 * its prominent brand text, not the fuller legal producer name the
 * application declares ("Korbel Champagne Cellars") — the full name does
 * appear elsewhere on the label (in the address block, as "F. Korbel &
 * Bros., Inc."), but the brand-name field specifically reads differently.
 * Mock mode can't see the actual photo pixels, so this hardcodes that known
 * real-world detail rather than letting the generic formatting-variance roll
 * only ever produce case/punctuation variants of the application's own
 * declared brand name — otherwise the "shares wording but isn't identical"
 * variance tier this app supports (see server/compare.ts) would never
 * actually be exercised for the one real label it applies to. */
const KNOWN_BRAND_NAME_OVERRIDE: Record<string, string> = {
  'Korbel Champagne Cellars': 'Korbel Brut',
}

function mockBrandName(applicationData: ApplicationData, rand: () => number): string {
  const override = KNOWN_BRAND_NAME_OVERRIDE[applicationData.brandName]
  if (override) return override
  return mockField(applicationData.brandName, rand)
}

/** Jose Cuervo's real photo prints net contents in centiliters ("70 CL"),
 * not the milliliters the application declares ("700 mL") — same volume,
 * different metric unit, and genuinely what's printed on that label. Mock
 * mode can't see the actual photo pixels (see the note on
 * mockExtractFromApplication below), so this hardcodes that known real-world
 * detail rather than letting the generic formatting-variance roll only ever
 * produce variants of the application's own declared unit. */
const KNOWN_NET_CONTENTS_OVERRIDE: Record<string, string> = {
  'Jose Cuervo': '70 CL',
}

function mockNetContents(applicationData: ApplicationData, rand: () => number): string {
  const override = KNOWN_NET_CONTENTS_OVERRIDE[applicationData.brandName]
  if (override) return override
  return mockField(applicationData.netContents, rand)
}

/** Tito's real photo states alcohol content purely as US proof ("80 Proof"),
 * not the "% ALC BY VOL" wording the application declares — same value
 * (proof is double the ABV%), just a different unit, and genuinely what's
 * printed on that label. Mock mode can't see the actual photo pixels, so
 * this hardcodes that known real-world detail rather than letting the
 * generic formatting-variance roll only ever produce variants of the
 * application's own declared unit — otherwise the proof/percent conversion
 * this app supports would never actually be exercised for the one real
 * label it applies to. */
const KNOWN_ABV_OVERRIDE: Record<string, string> = {
  "Tito's Handmade Vodka": '80 Proof',
}

function mockAbv(applicationData: ApplicationData, rand: () => number): string {
  const override = KNOWN_ABV_OVERRIDE[applicationData.brandName]
  if (override) return override
  return mockField(applicationData.abv, rand)
}

function mockGovernmentWarning(brandName: string, rand: () => number): string {
  if (KNOWN_NO_GOVERNMENT_WARNING.has(brandName)) return ''

  const roll = rand()
  if (roll < 0.82) return STATUTORY_GOVERNMENT_WARNING
  if (roll < 0.94) return STATUTORY_GOVERNMENT_WARNING.charAt(0) + STATUTORY_GOVERNMENT_WARNING.slice(1).toLowerCase()
  return MOCK_UNREADABLE
}

/** Ground-truth-aware mock used by the single-application review flow — the
 * seeded application already has a known-correct answer, so the mock
 * reproduces it with a small deterministic chance of variance/mismatch per
 * field, exercising the same UI states real extraction would. */
export function mockExtractFromApplication(applicationData: ApplicationData, imageBuffer: Buffer): LabelExtraction {
  const rand = seededRandom(hashBytes(imageBuffer))
  const brandName = applicationData.brandName

  const imageQuality: 'clear' | 'poor' = rand() < 0.88 ? 'clear' : 'poor'

  return {
    brandName: withMissingCheck(applicationData, 'brandName', () => mockBrandName(applicationData, rand)),
    beverageType: withMissingCheck(applicationData, 'beverageType', () => mockField(applicationData.beverageType, rand, !isKnownLegible(brandName, 'beverageType'))),
    classType: withMissingCheck(applicationData, 'classType', () => mockField(applicationData.classType, rand)),
    abv: withMissingCheck(applicationData, 'abv', () => mockAbv(applicationData, rand)),
    netContents: withMissingCheck(applicationData, 'netContents', () => mockNetContents(applicationData, rand)),
    bottlerAddress: withMissingCheck(applicationData, 'bottlerAddress', () => mockField(applicationData.bottlerAddress, rand)),
    countryOfOrigin: applicationData.countryOfOrigin === null ? '' : withMissingCheck(applicationData, 'countryOfOrigin', () => mockField(applicationData.countryOfOrigin as string, rand)),
    governmentWarning: mockGovernmentWarning(applicationData.brandName, rand),
    imageQuality,
    qualityNote: imageQuality === 'poor' ? 'Demo mode: simulated glare/angle issue.' : '',
  }
}

/** Batch files have no linked application to compare against, so the
 * standalone mock instead cycles through a small pool of canned label
 * profiles chosen to hit every downstream status (Approved / Needs Review /
 * Flagged), picked deterministically from each file's own bytes + name. */
const MOCK_LABEL_POOL: LabelExtraction[] = [
  {
    brandName: 'Cedar Hollow Farms', beverageType: 'Wine', classType: 'Dry Red Wine', abv: '13.5% ALC BY VOL', netContents: '750 mL',
    bottlerAddress: 'Cedar Hollow Farms, 12 Ridge Ln, Paso Robles, CA 93446', countryOfOrigin: '',
    governmentWarning: STATUTORY_GOVERNMENT_WARNING, imageQuality: 'clear', qualityNote: '',
  },
  {
    brandName: 'Ironclad Brewing Co', beverageType: 'Malt Beverage', classType: 'American Lager', abv: '5% ALC BY VOL', netContents: '',
    bottlerAddress: 'Ironclad Brewing Co, 900 Foundry St, Pittsburgh, PA 15222', countryOfOrigin: '',
    governmentWarning: STATUTORY_GOVERNMENT_WARNING, imageQuality: 'clear', qualityNote: '',
  },
  {
    brandName: 'Vantage Point Distillers', beverageType: 'Distilled Spirits', classType: 'Straight Rye Whiskey', abv: '47% ALC BY VOL', netContents: '750 mL',
    bottlerAddress: 'Vantage Point Distillers, 61 Overlook Dr, Louisville, KY 40202', countryOfOrigin: '',
    governmentWarning: STATUTORY_GOVERNMENT_WARNING.charAt(0) + STATUTORY_GOVERNMENT_WARNING.slice(1).toLowerCase(),
    imageQuality: 'clear', qualityNote: '',
  },
  {
    brandName: MOCK_UNREADABLE, beverageType: 'Wine', classType: 'Mead', abv: '11% ALC BY VOL', netContents: '500 mL',
    bottlerAddress: 'Salt Marsh Meadery, 8 Tidewater Ln, Chestertown, MD 21620', countryOfOrigin: '',
    governmentWarning: STATUTORY_GOVERNMENT_WARNING, imageQuality: 'poor', qualityNote: 'Demo mode: simulated glare over the brand panel.',
  },
  {
    brandName: 'Northgate Cellars', beverageType: 'Wine', classType: 'Pinot Noir', abv: '13.8% ALC BY VOL', netContents: '750 mL',
    bottlerAddress: 'Northgate Cellars, 4 Summit Rd, McMinnville, OR 97128', countryOfOrigin: '',
    governmentWarning: STATUTORY_GOVERNMENT_WARNING.replace('BIRTH DEFECTS', 'BIRTH ISSUES'), imageQuality: 'clear', qualityNote: '',
  },
  {
    brandName: 'Firelight Distilling', beverageType: 'Distilled Spirits', classType: 'London Dry Gin', abv: '44% ALC BY VOL', netContents: '750 mL',
    bottlerAddress: 'Firelight Distilling, 210 Kiln St, Denver, CO 80202', countryOfOrigin: '',
    governmentWarning: STATUTORY_GOVERNMENT_WARNING, imageQuality: 'clear', qualityNote: '',
  },
  {
    brandName: 'Copper Kettle Cidery', beverageType: 'Wine', classType: 'Hard Apple Cider', abv: MOCK_UNREADABLE, netContents: '473 mL',
    bottlerAddress: 'Copper Kettle Cidery, 19 Orchard Rd, Hood River, OR 97031', countryOfOrigin: '',
    governmentWarning: STATUTORY_GOVERNMENT_WARNING, imageQuality: 'poor', qualityNote: 'Demo mode: simulated blur near the ABV statement.',
  },
  {
    brandName: 'Wraith Hollow Winery', beverageType: 'Wine', classType: 'Cabernet Sauvignon', abv: '14.2% ALC BY VOL', netContents: '750 mL',
    bottlerAddress: 'Wraith Hollow Winery, 77 Fog Ridge Rd, Healdsburg, CA 95448', countryOfOrigin: '',
    governmentWarning: STATUTORY_GOVERNMENT_WARNING, imageQuality: 'clear', qualityNote: '',
  },
]

export function mockExtractStandalone(imageBuffer: Buffer, fileName: string): LabelExtraction {
  const index = hashBytes(imageBuffer, fileName) % MOCK_LABEL_POOL.length
  return MOCK_LABEL_POOL[index]
}
