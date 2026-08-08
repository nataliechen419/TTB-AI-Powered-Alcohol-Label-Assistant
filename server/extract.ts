import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import sharp from 'sharp'
import { z } from 'zod'
// Constructed lazily (on first real API call) rather than as a module-level
// constant. vite.config.ts's dotenv loading runs *after* its static imports
// (which include this module, transitively) due to ES module import
// hoisting — so a top-level `new Anthropic()` here would capture
// process.env.ANTHROPIC_API_KEY before dotenv ever set it, permanently
// baking in "no key" for the life of the process. Lazy construction
// sidesteps the ordering issue entirely; the Anthropic SDK itself throws a
// clear error at construction time if the key is still missing.
let client: Anthropic | undefined
function getClient(): Anthropic {
  if (!client) client = new Anthropic()
  return client
}

// Model reads "UNREADABLE" into a field when glare/angle/lighting prevents a
// confident read — this keeps the "couldn't read this clearly" state distinct
// from a genuine empty/missing field on the label.
const UNREADABLE = 'UNREADABLE'
export { UNREADABLE }

const LabelExtractionSchema = z.object({
  brandName: z.string().describe('The brand name as printed on the label. "UNREADABLE" if not confidently legible.'),
  beverageType: z.string().describe('The broad federal beverage category the label indicates — e.g. "Wine", "Distilled Spirits", or "Malt Beverage". Base this primarily on the actual printed class/type wording on the label itself (e.g. "Champagne", "Sparkling Wine", "Table Wine", "Bourbon Whiskey", "Vodka", "Beer", "Ale", "Lager", "Cider", "Malt Beverage") — that printed text is the authoritative signal, not the shape of the bottle or its packaging. Only fall back to visual/packaging cues (bottle shape, closure style, etc.) when no legible class/type wording is present anywhere on the label. In particular, a cork, wire cage/muselet, and foil capsule are standard sparkling wine/Champagne packaging — do not infer "Malt Beverage" from that packaging just because it superficially resembles some beer bottle styles; if the label says "Champagne" or "Sparkling Wine", the beverageType is "Wine" regardless of how the bottle is dressed. "UNREADABLE" if not confidently determinable.'),
  classType: z.string().describe('The class/type designation (e.g. "Bourbon Whiskey", "Table Wine", "Reposado", "Brut"). Transcribe whatever class/type wording is actually printed and legible, even if it is only a single descriptive word rather than the full canonical phrase — e.g. a label that prints just "REPOSADO" prominently, without "Tequila Reposado" spelled out together as one line, should still yield "Reposado" here, not "UNREADABLE". Only use "UNREADABLE" when no class/type wording at all is legible on the label, not merely because it is partial or spread across the label rather than printed as a single unified phrase.'),
  abv: z.string().describe('The alcohol content exactly as printed, including the "%" and unit wording. "UNREADABLE" if not confidently legible.'),
  netContents: z.string().describe('The net contents exactly as printed, including units. "UNREADABLE" if not confidently legible.'),
  bottlerAddress: z.string().describe('The name and address of the actual bottler/producer — the entity that made or bottled the product — exactly as printed. Many labels ALSO print a second, unrelated company address, such as an importer, distributor, or overseas marketing office for a different country\'s market (often introduced by wording like "Imported by" or "Distributed by", or simply printed as a second company block). Do not confuse that secondary address for the bottler/producer\'s own address. The producer\'s address is normally in the same country as any "Product of <country>" / country-of-origin statement on the label — use that as a strong signal when more than one company address appears. "UNREADABLE" if not confidently legible.'),
  countryOfOrigin: z.string().describe('The country of origin for an imported product — return JUST the country name itself (e.g. "France", "Mexico"), not the surrounding phrase, regardless of how it\'s printed on the label. It may appear as a distinct phrase like "Product of Mexico" or "Made in France" (extract only "Mexico"/"France" from that), or it may only be satisfied by the country name appearing as the last part of the producer/bottler\'s printed name-and-address block (e.g. an address ending "...16130 GENSAC-LA-PALLUE, FRANCE" — extract "France"). Do not leave this empty just because the country only appears as the last line of the address rather than as its own dedicated sentence. Empty string "" if the label has no country name anywhere on it (domestic products are not required to have one). "UNREADABLE" if a country-of-origin statement is present but not confidently legible.'),
  governmentWarning: z.string().describe('The full Government Warning statement exactly as printed, INCLUDING the leading "GOVERNMENT WARNING:" heading itself — that heading is part of the required statutory text, not a section label to skip. It is usually bolded or otherwise styled differently from the numbered sentences that follow it, which makes it easy to mistake for a caption and omit; do not omit it. The value you return must start with those two words. This is standardized federal boilerplate you have almost certainly seen before — do not rely on your memory of its "usual" wording or casing. Look at THIS image and transcribe the capitalization exactly as printed, letter by letter; many labels legally must print it in ALL CAPS, and if this one does, your output must also be ALL CAPS. "UNREADABLE" if not confidently legible.'),
  imageQuality: z.enum(['clear', 'poor']).describe('Overall assessment of whether the image is clear enough to confidently read all fields.'),
  qualityNote: z.string().describe('If imageQuality is "poor", a short note on why (glare, angle, blur, low light). Empty string if clear.'),
})

export type LabelExtraction = z.infer<typeof LabelExtractionSchema>

const SYSTEM_PROMPT = `You are assisting a federal alcohol beverage compliance agent by transcribing text from a label image.
Read the label image carefully and transcribe each required field exactly as printed, preserving original wording, punctuation, and capitalization verbatim — do not correct, normalize, or paraphrase.
Some fields (especially the Government Warning) are standardized boilerplate you have seen many times in training. Resist the pull of that memorized "canonical" version — transcribe the capitalization and punctuation of THIS specific image, not what you recall being typical. If a label prints text in ALL CAPS, your transcription of that text must also be in ALL CAPS, even if you'd normally expect mixed case.
The Government Warning's leading "GOVERNMENT WARNING:" heading is itself part of the required statutory text, even though it is typically styled (bolded) differently from the numbered sentences after it — do not treat it as a caption to leave out. Your governmentWarning transcription must include it.
Pay close attention to diacritical marks and accented characters (e.g. ñ, é, à, ü) — they're common in non-English producer/brand names and easy to misread as a plain letter or a different letter combination entirely (e.g. misreading "ñ" as a different ending like "ria"). Look carefully at the actual glyph printed rather than substituting whatever spelling looks most familiar. When determining beverageType, anchor on the printed class/type wording (e.g. "Champagne", "Sparkling Wine", "Whiskey", "Malt Beverage") rather than the bottle's shape or packaging — a cork, wire cage/muselet, and foil capsule are ordinary sparkling wine/Champagne dress and must not be read as "Malt Beverage" merely because that packaging superficially resembles some beer bottle styles; only lean on visual/packaging cues if no legible class/type text exists on the label at all. If a field is present but glare, blur, poor angle, or low lighting prevent a confident read, return "UNREADABLE" for that field's value.
If a field is genuinely absent from the label (e.g. no country-of-origin statement on a domestic product), return an empty string for that field, not "UNREADABLE".
For small or dense fine print — especially a bottler/producer's street address — read it character by character from what is actually visible in THIS image rather than pattern-matching to a plausible-sounding or more familiar name, spelling, or street. Real producer addresses often use unusual abbreviations and uncommon street names that a guess based on general knowledge will get wrong even though it "sounds right." If part of that text is too small or blurry to make out with genuine confidence, mark that field UNREADABLE rather than substituting your best guess for it.
Never guess at illegible text — accuracy matters more than completeness in a compliance context.`

export interface ExtractionResult {
  data: LabelExtraction
  /** Wall-clock time spent on the extraction call itself, in ms — surfaced
   * to the reviewer so "how long did this take" isn't a mystery. Measured
   * here (not in the route handler) so it covers exactly the model call,
   * not JSON parsing/comparison overhead around it. */
  durationMs: number
}

// Vision extraction needs to stay fast enough that a reviewer isn't sitting
// and watching a spinner — Opus was measured at 5.4-6.3s per label locally,
// consistently over a 5s budget. Haiku 4.5 measured 2.2-3.6s across the same
// test images (including a 1.86MB label), comfortably under budget, and its
// misses on hard-to-read fields still come back as "unreadable" or a flagged
// variance/mismatch rather than a silently-wrong "match" — this is a review
// tool where every field gets a human look regardless, so the speed trade
// doesn't compromise the compliance safety net.
const EXTRACTION_MODEL = 'claude-haiku-4-5'

// Safety-net timeout, not the primary speed control (the model choice above
// is). This just prevents a single hung request (network hiccup, provider
// slowdown) from stalling the UI indefinitely. Bumped from the original 9s to
// give headroom for tiled requests below, which send 2 images instead of 1
// and roughly double processing time.
const EXTRACTION_TIMEOUT_MS = 15_000

// Claude's vision input auto-resizes images down to roughly 1.15 megapixels
// before the model ever sees them. A typical phone photo of a label (5-8MP)
// gets shrunk well past that threshold, and fine printed detail — especially
// small accented characters like ñ/é/ü in producer names — blurs out enough
// to cause genuine OCR misreads (verified empirically: the same label
// photographed once produced "La Rojeña", "La Rojenia", and "La Rojeria"
// across repeated calls). Tiling the source image into two overlapping
// vertical halves keeps each individual tile much closer to that resize
// threshold, so the model is working from meaningfully more real pixel
// detail per unit of label text, at the cost of ~2x latency/tokens per label.
const TILE_TRIGGER_PIXELS = 1_500_000
// Each tile covers this fraction of the image height, so the two tiles
// overlap by (2 * TILE_FRACTION - 1) of the height — 20% overlap at 0.6 —
// which keeps any single line of text from landing exactly on a seam.
const TILE_FRACTION = 0.6

// The opposite problem from tiling: a source photo this small (e.g. a
// 338x600 phone crop, ~203K px) has so few raw pixels that fine print — a
// bottler address in particular — is only a handful of pixels tall, and the
// model starts pattern-matching to a plausible-sounding but wrong company
// name/address instead of reading what's actually there (verified: the same
// tiny Grey Goose photo produced "BACARDI CORP", "BACARDI U.S.A." and other
// unrelated hallucinated addresses across repeated calls, even after prompt
// instructions to prefer "UNREADABLE" over guessing). Below this threshold,
// upscale before sending. This adds no real detail, but multimodal vision
// models tokenize images into a fixed patch grid — a tiny source image gets
// too few patches to give the model any per-character attention budget, and
// smooth upscaling (plus a mild sharpen to keep edges crisp) gives it more
// patches to work with, closer to how a tiled/higher-res photo would land.
const UPSCALE_TRIGGER_PIXELS = 500_000
// Target size to upscale small images to. Kept below TILE_TRIGGER_PIXELS —
// there's no benefit pushing past Claude's own ~1.15MP auto-resize
// threshold, since anything larger just gets downscaled again server-side.
const UPSCALE_TARGET_PIXELS = 1_000_000

interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  base64: string
}

/** Splits a large label photo into two overlapping vertical crops (top and
 * bottom, both re-encoded as JPEG) so each stays closer to Claude's ~1.15MP
 * auto-resize threshold and retains more fine-text detail than one shrunk
 * full-image would; or, for a very small source photo, upscales it (single
 * image, not cropped) so the model has more pixel/patch budget to resolve
 * fine print with. Returns null (rather than throwing) when the image is
 * already a reasonable middle size that neither case applies to, or if sharp
 * fails for any reason — callers fall back to sending the original single
 * image. */
async function tileImage(image: ImageInput): Promise<ImageInput[] | null> {
  try {
    const buffer = Buffer.from(image.base64, 'base64')
    const img = sharp(buffer)
    const { width, height } = await img.metadata()
    if (!width || !height) return null
    const pixels = width * height

    if (pixels >= TILE_TRIGGER_PIXELS) {
      const tileHeight = Math.round(height * TILE_FRACTION)
      const regions = [
        { top: 0, height: tileHeight },
        { top: height - tileHeight, height: tileHeight },
      ]

      const tiles = await Promise.all(
        regions.map(async r => {
          const cropped = await sharp(buffer)
            .extract({ left: 0, top: r.top, width, height: r.height })
            .jpeg({ quality: 92 })
            .toBuffer()
          return { mediaType: 'image/jpeg' as const, base64: cropped.toString('base64') }
        }),
      )
      return tiles
    }

    if (pixels < UPSCALE_TRIGGER_PIXELS) {
      const scale = Math.sqrt(UPSCALE_TARGET_PIXELS / pixels)
      const targetWidth = Math.round(width * scale)
      const upscaled = await sharp(buffer)
        .resize({ width: targetWidth, kernel: sharp.kernel.lanczos3 })
        .sharpen()
        .jpeg({ quality: 95 })
        .toBuffer()
      return [{ mediaType: 'image/jpeg' as const, base64: upscaled.toString('base64') }]
    }

    return null
  } catch {
    // Corrupt/unsupported image, unexpected metadata, etc. — the original
    // single-image path still works, so this preprocessing is a nice-to-have,
    // not a dependency to fail hard on.
    return null
  }
}

export async function extractLabelFields(
  imageBase64: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
): Promise<ExtractionResult> {
  const startedAt = Date.now()

  const tiles = await tileImage({ mediaType, base64: imageBase64 })

  const imageBlocks = (tiles ?? [{ mediaType, base64: imageBase64 }]).map(t => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: t.mediaType, data: t.base64 },
  }))

  const instructionText =
    tiles && tiles.length > 1
      ? 'These 2 images are overlapping top and bottom crops of the SAME single label — not two different labels. Together they cover the full label with some duplicated text in the middle where the crops overlap. Use whichever crop shows a given piece of text most clearly, and transcribe the required TTB label fields once for the label as a whole.'
      : 'Transcribe the required TTB label fields from this image.'

  const response = await getClient().beta.messages.parse(
    {
      model: EXTRACTION_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [...imageBlocks, { type: 'text', text: instructionText }],
        },
      ],
      output_format: betaZodOutputFormat(LabelExtractionSchema),
    },
    { timeout: EXTRACTION_TIMEOUT_MS },
  )

  if (!response.parsed_output) {
    throw new Error('Label extraction failed to produce structured output')
  }

  return { data: response.parsed_output, durationMs: Date.now() - startedAt }
}
