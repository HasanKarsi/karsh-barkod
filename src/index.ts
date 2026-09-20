/**
 * The package as one surface: a value in, a symbol out, and everything that
 * symbol needs on its way to a label — geometry in whole dots, an SVG, a PNG
 * that knows its own resolution, and the two printer dialects.
 *
 * Re-exported wholesale rather than through a curated list, because the layers
 * are usable on their own: `checkGs1` alone verifies a GTIN, `layoutBarcode`
 * alone feeds a renderer that is not this one, and `encodeCode128` alone is
 * the answer to "how wide will this print".
 */

export * from "./barkod";
