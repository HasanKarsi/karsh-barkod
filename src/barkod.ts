/**
 * Barcodes encoded by hand: Code 128, EAN-13, EAN-8 and UPC-A, the GS1 check
 * digit, and the two label-printer dialects that print them — TSPL for TSC
 * printers and ZPL for Zebra.
 *
 * No library, on purpose. The symbologies are small, fixed tables, and what a
 * library would hide is exactly what this tool has to know: how many modules
 * wide the symbol is, where each bar sits, which characters a printer will
 * choke on. The label is centred from that width, and the preview draws the
 * bars the printer will draw.
 *
 * Pure TypeScript — no DOM, no React — so every table here is checked against
 * a reference encoder in a plain Node script.
 */

export type Symbology = "code128" | "ean13" | "ean8" | "upca";

/** One bar in module units. `x` counts from the first bar, quiet zone excluded. */
export interface Bar {
  x: number;
  w: number;
  /** Guard bars (EAN/UPC) run down between the digit groups. */
  guard: boolean;
}

/** A human-readable digit or line, in module units: `x` is its centre. */
export interface HumanText {
  x: number;
  text: string;
  /** Relative size; the UPC-A digits outside the guards are printed smaller. */
  small: boolean;
}

export interface Barcode {
  symbology: Symbology;
  /** What the symbol encodes: the Code 128 text, or every digit including the check digit. */
  data: string;
  bars: Bar[];
  /** Width from the first bar to the end of the last one. */
  modules: number;
  /** Minimum light margins, in modules, left and right. */
  quiet: readonly [number, number];
  text: HumanText[];
}

export type BarcodeProblem =
  | { code: "empty" }
  | { code: "scientific"; value: string }
  | { code: "nonAscii"; chars: string[] }
  | { code: "tooLong"; max: number }
  | { code: "notDigits"; chars: string[] }
  | { code: "length"; short: number; full: number; got: number }
  /**
   * No corrected number on purpose: a wrong check digit usually means a
   * mistyped digit somewhere else, and "fixing" the last one would turn a
   * caught typo into a valid-looking number that belongs to someone else.
   */
  | { code: "checkDigit"; given: number; expected: number; body: number };

export type BarcodeNote = { code: "computed"; digit: number } | { code: "verified"; digit: number };

export type BarcodeResult =
  | { ok: true; barcode: Barcode; note?: BarcodeNote }
  | { ok: false; problem: BarcodeProblem };

/** Longer than this and no hand scanner reads it reliably; GS1 stops at 48. */
const CODE128_MAX = 80;

/**
 * How a spreadsheet shows, and so copies, a long number in a General cell:
 * "5,90123E+12", with every digit past the sixth gone. Nobody types this on
 * purpose, so it gets its own message rather than a list of bad characters.
 */
const SCIENTIFIC = /^\d(?:[.,]\d+)?E\+\d+$/i;

export function buildBarcode(symbology: Symbology, input: string): BarcodeResult {
  const trimmed = input.trim();
  if (SCIENTIFIC.test(trimmed)) return { ok: false, problem: { code: "scientific", value: trimmed } };
  return symbology === "code128" ? buildCode128(input) : buildEanUpc(symbology, input);
}

/* ---- Code 128 -------------------------------------------------------- */

/**
 * Bar and space widths of the 107 symbols, bar first. Each of 0–105 is eleven
 * modules; the stop (106) is thirteen, its trailing bar included.
 */
const CODE128_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

const SHIFT = 98;
const START = [103, 104, 105] as const;
/** The value that switches *to* a set, the same from either of the other two. */
const SWITCH_TO = [101, 100, 99] as const;
const STOP = 106;

/** Code sets as indexes: 0 = A (controls and capitals), 1 = B (printable ASCII), 2 = C (digit pairs). */
type CodeSet = 0 | 1 | 2;
const SETS: readonly CodeSet[] = [0, 1, 2];

const inA = (c: number) => c < 96;
const inB = (c: number) => c >= 32 && c < 128;
const valueIn = (set: CodeSet, c: number) => (set === 0 && c < 32 ? c + 64 : c - 32);
const isDigit = (c: number) => c >= 48 && c <= 57;

/** Every character Code 128 cannot carry, once each, in the order they appear. */
function nonAsciiChars(text: string): string[] {
  const seen: string[] = [];
  for (const char of text) {
    if (char.charCodeAt(0) > 127 && !seen.includes(char)) seen.push(char);
  }
  return seen;
}

/**
 * What a path through the encoder costs, compared field by field: symbols
 * first — the width is what matters. The rest only break ties between equally
 * short symbols, towards what a Zebra printer's automatic mode picks (checked
 * against its output):
 *
 *   runs of four or more digits in set C;
 *   as few set changes as possible;
 *   an odd run's spare digit before the pairs, not after (Start C excepted);
 *   a start set that takes the first character without a SHIFT;
 *   otherwise a SHIFT rather than a switch for a lone character;
 *   B rather than A, when starting or switching.
 *
 * The preview then shows, bar for bar, what the printer most likely prints.
 * Each weight exceeds the largest total the next one down can reach at the
 * length limit, so the sum compares like the tuple.
 */
const SYMBOL = 1e13;
const LONG_RUN_DIGIT_OUTSIDE_C = 1e10;
const SET_CHANGE = 1e7;
const SPARE_DIGIT_AFTER = 1e5;
const SHIFT_FIRST = 1e4;
const SWITCH_NOT_SHIFT = 100;
const INTO_A = 1;

/**
 * The shortest symbol for `text`, switching between sets A, B and C wherever
 * that saves a symbol.
 *
 * The usual rule of thumb — "four digits or more, go to C" — is right most of
 * the time and a module or two long the rest (an odd run, a run at the very
 * end, a lone lowercase letter among controls). This is a shortest path
 * instead: for each position and each set, the cheapest way to have encoded
 * everything so far and be left in that set. Switches, SHIFTs and digit pairs
 * are the edges. The result is minimal by construction, and the width the
 * label is centred on is the width that gets printed.
 */
export function encodeCode128(text: string): number[] {
  const codes = Array.from(text, (char) => char.charCodeAt(0));
  const n = codes.length;
  // Which digits belong to a run of four or more, and which of those open it.
  const longRun = codes.map(() => false);
  const opensRun = codes.map(() => false);
  for (let start = 0; start < n; ) {
    let end = start;
    while (end < n && isDigit(codes[end]!)) end += 1;
    if (end - start >= 4) {
      longRun.fill(true, start, end);
      opensRun[start] = start > 0;
    }
    start = Math.max(end, start + 1);
  }
  const cost = Array.from({ length: n + 1 }, () => [Infinity, Infinity, Infinity]);
  /** How each state was reached: the previous state and the values emitted on the way. */
  const via: ({ i: number; set: CodeSet; emit: number[] } | null)[][] = Array.from(
    { length: n + 1 },
    () => [null, null, null],
  );

  for (const set of SETS) cost[0]![set] = SYMBOL + (set === 0 ? INTO_A : 0);

  const relax = (i: number, set: CodeSet, value: number, from: { i: number; set: CodeSet; emit: number[] }) => {
    if (value < cost[i]![set]!) {
      cost[i]![set] = value;
      via[i]![set] = from;
    }
  };
  const cheapest = (i: number) => SETS.reduce((a, b) => (cost[i]![b]! < cost[i]![a]! ? b : a));

  for (let i = 0; i <= n; i += 1) {
    // A switch costs the same whichever set it leaves, so one pass from the
    // cheapest set is enough — chaining two switches never helps.
    if (i > 0) {
      const best = cheapest(i);
      for (const set of SETS) {
        if (set === best) continue;
        const change = SYMBOL + SET_CHANGE + SWITCH_NOT_SHIFT + (set === 0 ? INTO_A : 0);
        relax(i, set, cost[i]![best]! + change, { i, set: best, emit: [SWITCH_TO[set]] });
      }
    }
    if (i === n) break;

    const c = codes[i]!;
    const digit = longRun[i] ? LONG_RUN_DIGIT_OUTSIDE_C + (opensRun[i] ? 0 : SPARE_DIGIT_AFTER) : 0;
    for (const set of SETS) {
      const here = cost[i]![set]!;
      if (here === Infinity) continue;
      if (set === 2) {
        const d = codes[i + 1];
        if (isDigit(c) && d !== undefined && isDigit(d)) {
          relax(i + 2, 2, here + SYMBOL, { i, set, emit: [(c - 48) * 10 + (d - 48)] });
        }
        continue;
      }
      if (set === 0 ? inA(c) : inB(c)) {
        relax(i + 1, set, here + SYMBOL + digit, { i, set, emit: [valueIn(set, c)] });
      } else {
        // A lone character from the other set: SHIFT, then the character.
        const other: CodeSet = set === 0 ? 1 : 0;
        const shift = 2 * SYMBOL + SET_CHANGE + (i === 0 ? SHIFT_FIRST : 0);
        relax(i + 1, set, here + shift, { i, set, emit: [SHIFT, valueIn(other, c)] });
      }
    }
  }

  // Walk back from the cheapest end state.
  let set = cheapest(n);
  let i = n;
  const reversed: number[] = [];
  for (let step = via[i]![set]; step; step = via[i]![set]) {
    for (let k = step.emit.length - 1; k >= 0; k -= 1) reversed.push(step.emit[k]!);
    i = step.i;
    set = step.set;
  }
  const values = [START[set], ...reversed.reverse()];

  const sum = values.reduce((acc, value, index) => acc + value * Math.max(index, 1), 0);
  values.push(sum % 103, STOP);
  return values;
}

/** Bar/space widths, bar first, for a list of symbol values. */
function widthsOf(values: number[]): number[] {
  return values.flatMap((value) => Array.from(CODE128_PATTERNS[value]!, Number));
}

function barsFromWidths(widths: number[], guard: (index: number) => boolean = () => false): Bar[] {
  const bars: Bar[] = [];
  let x = 0;
  widths.forEach((w, index) => {
    if (index % 2 === 0) bars.push({ x, w, guard: guard(index) });
    x += w;
  });
  return bars;
}

/**
 * Control characters have no glyph; the human-readable line shows the Unicode
 * "control pictures" (␉ for a tab) so a tab is visible and the SVG stays valid
 * XML, which forbids most of them outright.
 */
export function printable(text: string): string {
  return Array.from(text, (char) => {
    const c = char.charCodeAt(0);
    if (c < 32) return String.fromCharCode(0x2400 + c);
    if (c === 127) return "␡";
    return char;
  }).join("");
}

function buildCode128(input: string): BarcodeResult {
  if (input === "") return { ok: false, problem: { code: "empty" } };
  const foreign = nonAsciiChars(input);
  if (foreign.length > 0) return { ok: false, problem: { code: "nonAscii", chars: foreign } };
  if (input.length > CODE128_MAX) return { ok: false, problem: { code: "tooLong", max: CODE128_MAX } };

  const values = encodeCode128(input);
  const widths = widthsOf(values);
  const modules = widths.reduce((a, b) => a + b, 0);
  return {
    ok: true,
    barcode: {
      symbology: "code128",
      data: input,
      bars: barsFromWidths(widths),
      modules,
      quiet: [10, 10],
      text: [{ x: modules / 2, text: printable(input), small: false }],
    },
  };
}

const ASCII_FOLD: Record<string, string> = {
  ç: "c", Ç: "C", ğ: "g", Ğ: "G", ı: "i", İ: "I", ö: "o", Ö: "O", ş: "s", Ş: "S", ü: "u", Ü: "U",
  â: "a", Â: "A", î: "i", Î: "I", û: "u", Û: "U",
  // The no-break space that text copied from a web page or a spreadsheet carries.
  [String.fromCharCode(0xa0)]: " ",
};

/**
 * Folds Turkish letters — the circumflexed ones of "kâr" and "hâlâ" included —
 * to their plain Latin neighbours, which is what anyone typing a stock code on
 * a Turkish keyboard meant anyway, and a no-break space to a plain one.
 * Anything else outside ASCII is left for the error message to name.
 */
export function foldToAscii(text: string): string {
  return Array.from(text, (char) => ASCII_FOLD[char] ?? char).join("");
}

/* ---- GS1 check digit ------------------------------------------------- */

/**
 * The GS1 mod-10 check digit shared by GTIN-8/12/13/14 and SSCC: weights 3
 * and 1 alternate from the rightmost digit leftwards, and the check digit
 * tops the sum up to a multiple of ten.
 */
function gs1CheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const fromRight = digits.length - 1 - i;
    sum += Number(digits[i]) * (fromRight % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export type Gs1Key = "gtin8" | "gtin12" | "gtin13" | "gtin14" | "sscc";

const GS1_LENGTHS: Record<Gs1Key, number> = {
  gtin8: 8,
  gtin12: 12,
  gtin13: 13,
  gtin14: 14,
  sscc: 18,
};

export interface Gs1Step {
  digit: number;
  weight: 1 | 3;
  product: number;
}

export type Gs1Result =
  | { status: "empty" }
  | { status: "notDigits"; chars: string[] }
  | { status: "length"; short: number; full: number; got: number }
  | {
      status: "computed" | "valid" | "invalid";
      /** The body followed by the right check digit. */
      full: string;
      expected: number;
      /** Present when a complete number was given. */
      given?: number;
      steps: Gs1Step[];
      sum: number;
    };

/** Spaces, dashes and dots are how numbers get printed and pasted; they carry nothing. */
function stripSeparators(input: string): string {
  return input.replace(/[\s.-]/g, "");
}

function foreignDigits(text: string): string[] {
  const seen: string[] = [];
  for (const char of text) if (!/[0-9]/.test(char) && !seen.includes(char)) seen.push(char);
  return seen;
}

/**
 * Computes the check digit when one digit short, verifies it when complete,
 * and keeps the working — every digit, its weight and the sum — for display.
 */
export function checkGs1(key: Gs1Key, input: string): Gs1Result {
  const digits = stripSeparators(input);
  if (digits === "") return { status: "empty" };
  const foreign = foreignDigits(digits);
  if (foreign.length > 0) return { status: "notDigits", chars: foreign };

  const full = GS1_LENGTHS[key];
  if (digits.length !== full && digits.length !== full - 1) {
    return { status: "length", short: full - 1, full, got: digits.length };
  }

  const body = digits.slice(0, full - 1);
  const steps: Gs1Step[] = Array.from(body, (char, i) => {
    const weight = (body.length - 1 - i) % 2 === 0 ? 3 : 1;
    return { digit: Number(char), weight, product: Number(char) * weight };
  });
  const sum = steps.reduce((acc, step) => acc + step.product, 0);
  const expected = (10 - (sum % 10)) % 10;

  if (digits.length === full - 1) {
    return { status: "computed", full: body + expected, expected, steps, sum };
  }
  const given = Number(digits[full - 1]);
  return {
    status: given === expected ? "valid" : "invalid",
    full: body + expected,
    expected,
    given,
    steps,
    sum,
  };
}

/* ---- EAN-13, EAN-8, UPC-A ------------------------------------------- */

/** Set A (odd parity), space first; set C is the same widths read bar first. */
const EAN_L = ["3211", "2221", "2122", "1411", "1132", "1231", "1114", "1312", "1213", "3112"];
/** Set B (even parity): set C mirrored. */
const EAN_G = ["1123", "1222", "2212", "1141", "2311", "1321", "4111", "2131", "3121", "2113"];
/** EAN-13's first digit is not drawn; it is the pattern of A and B in the left half. */
const EAN13_PARITY = [
  "LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL",
];

const EAN_SHAPE: Record<Exclude<Symbology, "code128">, { full: number; quiet: readonly [number, number] }> = {
  ean13: { full: 13, quiet: [11, 7] },
  ean8: { full: 8, quiet: [7, 7] },
  upca: { full: 12, quiet: [9, 9] },
};

/** The digit count a printer is given: every EAN/UPC dialect computes the check digit itself. */
function eanBodyLength(symbology: Exclude<Symbology, "code128">): number {
  return EAN_SHAPE[symbology].full - 1;
}

function buildEanUpc(symbology: Exclude<Symbology, "code128">, input: string): BarcodeResult {
  const digits = stripSeparators(input);
  if (digits === "") return { ok: false, problem: { code: "empty" } };
  const foreign = foreignDigits(digits);
  if (foreign.length > 0) return { ok: false, problem: { code: "notDigits", chars: foreign } };

  const { full, quiet } = EAN_SHAPE[symbology];
  if (digits.length !== full && digits.length !== full - 1) {
    return { ok: false, problem: { code: "length", short: full - 1, full, got: digits.length } };
  }

  const body = digits.slice(0, full - 1);
  const expected = gs1CheckDigit(body);
  let note: BarcodeNote;
  if (digits.length === full) {
    const given = Number(digits[full - 1]);
    if (given !== expected) {
      return { ok: false, problem: { code: "checkDigit", given, expected, body: body.length } };
    }
    note = { code: "verified", digit: expected };
  } else {
    note = { code: "computed", digit: expected };
  }

  const data = body + expected;
  return { ok: true, barcode: eanBarcode(symbology, data, quiet), note };
}

function eanBarcode(
  symbology: Exclude<Symbology, "code128">,
  data: string,
  quiet: readonly [number, number],
): Barcode {
  const d = Array.from(data, Number);
  // UPC-A is EAN-13 with a leading zero, which makes the left half all set A.
  const left = symbology === "ean8" ? d.slice(0, 4) : symbology === "upca" ? d.slice(0, 6) : d.slice(1, 7);
  const right = symbology === "ean8" ? d.slice(4) : symbology === "upca" ? d.slice(6) : d.slice(7);
  const parity = symbology === "ean13" ? EAN13_PARITY[d[0]!]! : "LLLLLL";

  const widths: number[] = [];
  const tall: boolean[] = [];
  const push = (ws: string | number[], isTall: boolean) => {
    for (const w of ws) {
      widths.push(Number(w));
      tall.push(isTall);
    }
  };

  push([1, 1, 1], true);
  left.forEach((digit, i) => {
    const table = parity[i] === "G" ? EAN_G : EAN_L;
    // UPC-A extends the bars of its first and last digits like guards.
    push(table[digit]!, symbology === "upca" && i === 0);
  });
  push([1, 1, 1, 1, 1], true);
  right.forEach((digit, i) => push(EAN_L[digit]!, symbology === "upca" && i === right.length - 1));
  push([1, 1, 1], true);

  const modules = widths.reduce((a, b) => a + b, 0);
  const half = left.length;
  const rightStart = 3 + 7 * half + 5;
  const centre = (start: number, index: number) => start + 7 * index + 3.5;

  const text: HumanText[] = [];
  if (symbology === "ean13") {
    text.push({ x: -4, text: String(d[0]), small: false });
    left.forEach((digit, i) => text.push({ x: centre(3, i), text: String(digit), small: false }));
    right.forEach((digit, i) => text.push({ x: centre(rightStart, i), text: String(digit), small: false }));
  } else if (symbology === "ean8") {
    left.forEach((digit, i) => text.push({ x: centre(3, i), text: String(digit), small: false }));
    right.forEach((digit, i) => text.push({ x: centre(rightStart, i), text: String(digit), small: false }));
  } else {
    // UPC-A: number system and check digit sit outside the guards, smaller.
    text.push({ x: -4.5, text: String(d[0]), small: true });
    left.slice(1).forEach((digit, i) => text.push({ x: centre(3, i + 1), text: String(digit), small: false }));
    right.slice(0, -1).forEach((digit, i) => text.push({ x: centre(rightStart, i), text: String(digit), small: false }));
    text.push({ x: modules + 4.5, text: String(d[11]), small: true });
  }

  return {
    symbology,
    data,
    bars: barsFromWidths(widths, (index) => tall[index]!),
    modules,
    quiet,
    text,
  };
}

/* ---- Geometry -------------------------------------------------------- */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextRun {
  /** Centre of the text. */
  x: number;
  /** Baseline. */
  y: number;
  text: string;
  size: number;
}

/** A barcode laid out in whole dots (= pixels), quiet zones included. */
export interface Geometry {
  width: number;
  height: number;
  bars: Rect[];
  texts: TextRun[];
  /** Where the first bar starts: the left quiet zone. */
  left: number;
}

export interface LayoutOptions {
  /** Module width in dots. Whole numbers only — a half-dot bar prints as either one or none. */
  module: number;
  /** Bar height in dots. */
  height: number;
  showText: boolean;
}

/**
 * Integer geometry for any renderer. Text is set in proportion to the
 * module — nine modules to the em — and EAN guards run five modules down
 * between the digit groups, as on a printed pack.
 */
export function layoutBarcode(barcode: Barcode, { module: m, height, showText }: LayoutOptions): Geometry {
  const left = barcode.quiet[0] * m;
  const width = left + barcode.modules * m + barcode.quiet[1] * m;
  const ean = barcode.symbology !== "code128";
  const guardDrop = ean && showText ? 5 * m : 0;

  const bars = barcode.bars.map((bar) => ({
    x: left + bar.x * m,
    y: 0,
    w: bar.w * m,
    h: height + (bar.guard ? guardDrop : 0),
  }));

  if (!showText) return { width, height, bars, texts: [], left };

  const size = 9 * m;
  const baseline = ean ? height + 8 * m : height + 9 * m;
  const texts = barcode.text.map((run) => ({
    x: left + run.x * m,
    y: run.small ? baseline - m : baseline,
    text: run.text,
    size: run.small ? 7 * m : size,
  }));
  return { width, height: ean ? height + 9 * m : height + 11 * m, bars, texts, left };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Keeps a number short in markup: 12, 12.5, 0.25 — never 12.500000001. */
function num(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Every bar as one SVG path: a few hundred rects would be the same picture, ten times the markup. */
export function barsPath(bars: Rect[]): string {
  return bars.map((bar) => `M${bar.x} ${bar.y}h${bar.w}v${bar.h}h-${bar.w}z`).join("");
}

/**
 * A standalone SVG. The viewBox is in dots so every edge lands on a whole
 * unit; width and height are in millimetres so a layout program places it at
 * the size the printer would print it.
 */
export function barcodeSvg(geometry: Geometry, dotsPerMm: number): string {
  const { width, height, bars, texts } = geometry;
  const path = barsPath(bars);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width / dotsPerMm)}mm" height="${num(height / dotsPerMm)}mm" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    `<path d="${path}" fill="#000"/>`,
  ];
  if (texts.length > 0) {
    parts.push(`<g font-family="OCR-B, 'OCR B', ui-monospace, monospace" fill="#000" text-anchor="middle">`);
    for (const run of texts) {
      parts.push(`<text x="${num(run.x)}" y="${num(run.y)}" font-size="${run.size}">${escapeXml(run.text)}</text>`);
    }
    parts.push("</g>");
  }
  parts.push("</svg>");
  return parts.join("\n");
}

/* ---- PNG resolution -------------------------------------------------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Writes a pHYs chunk into a PNG so Word, InDesign and the print dialog place
 * it at its real size — a canvas export says nothing about resolution and
 * every program then assumes 72 or 96 dpi. The chunk goes right after IHDR,
 * which is where the specification wants it.
 *
 * The resolution is the printer's dot pitch — 8, 12 or 24 dots to the
 * millimetre, the rounding the commands and the SVG use — not the nominal
 * dpi: 300 dpi is 11.81 dots/mm, and the same barcode would come out 1.6 %
 * wider as a PNG than as an SVG.
 */
export function pngWithResolution(png: Uint8Array, dotsPerMm: number): Uint8Array<ArrayBuffer> {
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  const perMetre = dotsPerMm * 1000;
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, perMetre);
  view.setUint32(12, perMetre);
  chunk[16] = 1; // unit: metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));

  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}

/* ---- Labels ---------------------------------------------------------- */

export type Dpi = 203 | 300 | 600;

/** The rounding both TSC and Zebra document: 8, 12 and 24 dots to the millimetre. */
export const DOTS_PER_MM: Record<Dpi, number> = { 203: 8, 300: 12, 600: 24 };

/**
 * Module widths in millimetres. For EAN and UPC the floor is GS1's for retail
 * scanning — 80 % of the nominal 0.33 mm — and the default is the fewest dots
 * that clear it. Code 128 has no retail floor: below about 0.19 mm most
 * handheld scanners start to miss, and 0.25 mm reads comfortably.
 */
const MODULE_MM: Record<Symbology, { floor: number; target: number }> = {
  code128: { floor: 0.19, target: 0.25 },
  ean13: { floor: 0.264, target: 0.264 },
  ean8: { floor: 0.264, target: 0.264 },
  upca: { floor: 0.264, target: 0.264 },
};

/** The default module in whole dots: the same physical width at every resolution. */
export function recommendedModule(symbology: Symbology, dpi: Dpi): number {
  return Math.ceil(MODULE_MM[symbology].target * DOTS_PER_MM[dpi]);
}

/** The fewest whole dots that still reach the floor; anything thinner deserves a warning. */
export function minimumModule(symbology: Symbology, dpi: Dpi): number {
  return Math.ceil(MODULE_MM[symbology].floor * DOTS_PER_MM[dpi]);
}

export interface LabelSettings {
  widthMm: number;
  heightMm: number;
  gapMm: number;
  dpi: Dpi;
  quantity: number;
  /** Turn the print 180° — for a roll loaded the other way round. */
  flip: boolean;
  /** Module width in dots. */
  module: number;
  barHeightMm: number;
  showText: boolean;
  /** Top-left of the barcode in dots; `null` centres it. */
  position: { x: number; y: number } | null;
}

export interface Placement {
  /** Where the first bar goes, in dots — the coordinate both dialects take. */
  x: number;
  y: number;
  labelWidth: number;
  labelHeight: number;
  barHeight: number;
  geometry: Geometry;
  /** "bars": the bars run off the label; "quiet": the bars fit but a quiet zone is clipped. */
  overflow: "none" | "quiet" | "bars";
  tooTall: boolean;
}

export function placeBarcode(barcode: Barcode, settings: LabelSettings): Placement {
  const dpmm = DOTS_PER_MM[settings.dpi];
  const labelWidth = Math.round(settings.widthMm * dpmm);
  const labelHeight = Math.round(settings.heightMm * dpmm);
  const barHeight = Math.max(1, Math.round(settings.barHeightMm * dpmm));
  const geometry = layoutBarcode(barcode, {
    module: settings.module,
    height: barHeight,
    showText: settings.showText,
  });

  const barsWidth = barcode.modules * settings.module;
  let x: number;
  let y: number;
  if (settings.position) {
    ({ x, y } = settings.position);
  } else {
    // Centre the whole symbol, quiet zones included: EAN-13's are 11 and 7
    // modules, and its first digit sits in the wider one. On a label too
    // narrow for the quiet zones the bars are kept on the stock — a clipped
    // margin may still scan, a clipped bar never does — and a symbol taller
    // than the label starts at its top edge rather than above it.
    const centred = Math.round((labelWidth - geometry.width) / 2) + geometry.left;
    x = barsWidth <= labelWidth ? Math.min(Math.max(centred, 0), labelWidth - barsWidth) : centred;
    y = Math.max(0, Math.round((labelHeight - geometry.height) / 2));
  }

  const barsStart = x;
  const barsEnd = x + barsWidth;
  const overflow =
    barsStart < 0 || barsEnd > labelWidth
      ? "bars"
      : x - geometry.left < 0 || barsEnd + barcode.quiet[1] * settings.module > labelWidth
        ? "quiet"
        : "none";

  return {
    x,
    y,
    labelWidth,
    labelHeight,
    barHeight,
    geometry,
    overflow,
    tooTall: y < 0 || y + geometry.height > labelHeight,
  };
}

/** Millimetres as the manuals write them: "50", "2.5". */
function mm(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** Why a value could not be written in a dialect. */
export type DialectProblem = "control" | "tsplEscape" | "offLabel";

/**
 * Bars that run off the label cannot scan, and the coordinate that puts them
 * there may be negative, which neither dialect accepts. Such a label is left
 * out of the command rather than printed cut in half.
 */
function offLabel(placement: Placement): boolean {
  return placement.overflow === "bars" || placement.y < 0;
}

export interface DialectOutput {
  code: string;
  /** Values left out, by their index in the input, with the reason. */
  skipped: { index: number; problem: DialectProblem }[];
}

const TSPL_TYPE: Record<Symbology, string> = {
  code128: "128",
  ean13: "EAN13",
  ean8: "EAN8",
  upca: "UPCA",
};

/**
 * The part of the data a printer is given. Both dialects take EAN-13, EAN-8
 * and UPC-A without the check digit and compute it themselves, so the digit
 * the preview shows is the digit the printer prints.
 */
function printerData(barcode: Barcode): string {
  return barcode.symbology === "code128"
    ? barcode.data
    : barcode.data.slice(0, eanBodyLength(barcode.symbology));
}

/** ASCII control characters: 0–31 and DEL. */
const isControl = (char: string) => {
  const c = char.charCodeAt(0);
  return c < 32 || c === 127;
};
const hasControl = (text: string) => Array.from(text).some(isControl);

/**
 * TSPL (TSC): SIZE, GAP, DIRECTION and REFERENCE, then one CLS … PRINT block
 * per label. DIRECTION is kept in the printer's memory and REFERENCE moves the
 * origin, so both are restated rather than trusted from an earlier job.
 *
 * A double quote inside the data is written \["], the escape the TSPL2 manual
 * gives. Control characters have no escape in a quoted string — a raw ESC
 * would even be read as a printer command — so such values are left out and
 * reported, as is any literal "\[", which the printer would take for the start
 * of an escape.
 */
export function toTspl(barcodes: Barcode[], settings: LabelSettings): DialectOutput {
  const lines = [
    `SIZE ${mm(settings.widthMm)} mm,${mm(settings.heightMm)} mm`,
    `GAP ${mm(settings.gapMm)} mm,0 mm`,
    `DIRECTION ${settings.flip ? 0 : 1}`,
    "REFERENCE 0,0",
  ];
  const skipped: DialectOutput["skipped"] = [];

  barcodes.forEach((barcode, index) => {
    const data = printerData(barcode);
    if (hasControl(data)) return void skipped.push({ index, problem: "control" });
    if (data.includes("\\[")) return void skipped.push({ index, problem: "tsplEscape" });
    const placement = placeBarcode(barcode, settings);
    if (offLabel(placement)) return void skipped.push({ index, problem: "offLabel" });

    const { x, y, barHeight } = placement;
    // Human-readable 2 centres the line under Code 128; EAN/UPC lay their digits out themselves.
    const readable = settings.showText ? (barcode.symbology === "code128" ? 2 : 1) : 0;
    const m = settings.module;
    lines.push(
      "CLS",
      `BARCODE ${x},${y},"${TSPL_TYPE[barcode.symbology]}",${barHeight},${readable},0,${m},${m},"${data.replace(/"/g, '\\["]')}"`,
      `PRINT ${settings.quantity}`,
    );
  });

  return { code: barcodes.length - skipped.length > 0 ? lines.join("\r\n") + "\r\n" : "", skipped };
}

/** Written as a char code: in this file a literal would be one more escape to get wrong. */
const BACKSLASH = String.fromCharCode(92);
/** ^ and ~ start commands; control characters cannot be typed into a field at all. */
const zplUnsafe = (char: string) => char === "^" || char === "~" || isControl(char);

/**
 * ZPL (Zebra): one ^XA … ^XZ format per label.
 *
 * Code 128 goes out in automatic mode (^BC…A), where the printer picks the
 * code sets itself — the same width as encodeCode128 and, checked against its
 * output, almost always the same bars. A character a field cannot carry as
 * typed is written through ^FH as an _XX hex escape, which makes the
 * underscore one of them. A backslash is an escape inside the field on its
 * own terms: alone it vanishes, doubled it prints once — before or after ^FH.
 */
export function toZpl(barcodes: Barcode[], settings: LabelSettings): DialectOutput {
  const blocks: string[] = [];
  const skipped: DialectOutput["skipped"] = [];
  for (const [index, barcode] of barcodes.entries()) {
    const placement = placeBarcode(barcode, settings);
    if (offLabel(placement)) {
      skipped.push({ index, problem: "offLabel" });
      continue;
    }
    const { x, y, labelWidth, labelHeight, barHeight } = placement;
    const readable = settings.showText ? "Y" : "N";
    const symbol =
      barcode.symbology === "code128"
        ? `^BCN,${barHeight},${readable},N,N,A`
        : barcode.symbology === "ean13"
          ? `^BEN,${barHeight},${readable},N`
          : barcode.symbology === "ean8"
            ? `^B8N,${barHeight},${readable},N`
            : `^BUN,${barHeight},${readable},N,Y`;

    const data = printerData(barcode);
    const hexField = Array.from(data).some(zplUnsafe);
    const escaped = Array.from(data, (char) =>
      hexField && (zplUnsafe(char) || char === "_")
        ? `_${hex(char)}`
        : char === BACKSLASH
          ? BACKSLASH + BACKSLASH
          : char,
    ).join("");
    const field = `${hexField ? "^FH" : ""}^FD${escaped}^FS`;

    blocks.push(
      [
        "^XA",
        `^PW${labelWidth}`,
        `^LL${labelHeight}`,
        "^LH0,0",
        settings.flip ? "^POI" : "^PON",
        `^FO${x},${y}^BY${settings.module}${symbol}${field}`,
        `^PQ${settings.quantity}`,
        "^XZ",
      ].join("\r\n"),
    );
  }
  return { code: blocks.length > 0 ? blocks.join("\r\n") + "\r\n" : "", skipped };
}

function hex(char: string): string {
  return char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
}
