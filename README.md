# karsh-barkod

Code 128, EAN-13, EAN-8 ve UPC-A'yı elle kodlayan tek bir TypeScript dosyası:
modül genişlikleri, GS1 kontrol hanesi, etiket yerleşimi, SVG geometrisi ve
TSPL/ZPL yazıcı komutları.

Code 128, EAN-13, EAN-8 and UPC-A encoded by hand, with the GS1 check digit,
whole-dot label geometry, an SVG writer and the two label-printer dialects.

930 satır · sıfır import · DOM yok · MIT
930 lines · zero imports · no DOM · MIT

---

## Türkçe

### Ne işe yarar

Bir değeri alır, basılacak simgeyi verir — ve simgenin etikete kadar giden
yolundaki her şeyi:

- **Dört simgeleme.** Code 128 (A/B/C kümeleri arasında en kısa yolu bulan bir
  kodlayıcıyla), EAN-13, EAN-8, UPC-A. Her çubuk modül cinsinden, koruma
  çubukları işaretli, okunur rakam satırı yerleştirilmiş halde.
- **GS1 kontrol hanesi.** GTIN-8/12/13/14 ve SSCC için mod-10; eksikse
  hesaplar, tamsa doğrular, hesabı adım adım saklar.
- **Tam sayı geometri.** Her çubuk nokta (dot) cinsinden, sessiz bölgeler
  dahil. Yarım nokta genişliğinde çubuk olmaz: yazıcı onu ya bir nokta basar
  ya hiç.
- **SVG.** Tüm çubuklar tek bir yol (path); `viewBox` nokta cinsinden, en ve
  boy milimetre cinsinden — sayfa programı simgeyi yazıcının basacağı
  boyutta yerleştirsin diye.
- **PNG çözünürlüğü.** Var olan bir PNG'ye `pHYs` chunk'ı yazar, böylece Word
  ve baskı iletişim kutusu dosyayı 96 dpi sanmaz.
- **Yazıcı lehçeleri.** TSPL (TSC) ve ZPL (Zebra) komutları; yerleşim,
  ortalama, taşma denetimi ve her lehçenin kendi kaçışlarıyla.

Bir kütüphanenin gizleyeceği şey tam da burada bilinmesi gereken şey: simge
kaç modül genişliğinde, hangi çubuk nerede, hangi karakterde yazıcı boğulur.
Etiket o genişlikten ortalanır ve önizleme, yazıcının basacağı çubukları
çizer.

### Kurulum

Paket TypeScript kaynağı olarak dağıtılır; derleme adımı yoktur.

```bash
npm i github:<kullanıcı>/karsh-barkod
```

Kaynak TypeScript olduğu için tüketen tarafın TS'i çözebilmesi gerekir:
bir paketleyici (Vite, webpack, Next) ya da `tsc`. Düz `node` ile
çalıştırmak için önce derle.

Ya da `src/barkod.ts` dosyasını projene kopyala: tek dosya, hiç `import`
satırı yok, lisansı MIT.

### Kullanım

**Bir EAN-13 kodla.** On iki hane ver, kontrol hanesini o hesaplasın:

```ts
import { buildBarcode } from "karsh-barkod";

const result = buildBarcode("ean13", "869123456789");

if (result.ok) {
  result.note;            // { code: "computed", digit: 0 }
  result.barcode.data;    // "8691234567890" — kontrol hanesi dahil
  result.barcode.modules; // 95
  result.barcode.quiet;   // [11, 7] — soldaki ve sağdaki sessiz bölge
  result.barcode.bars;    // 30 çubuk, modül cinsinden
}
```

On üç hane verilirse kontrol hanesi doğrulanır; tutmuyorsa hata döner ve
**düzeltilmez**: yanlış bir kontrol hanesi genellikle başka bir yerdeki yanlış
haneyi işaret eder, sonuncuyu "düzeltmek" yakalanmış bir hatayı başkasına ait
geçerli görünen bir numaraya çevirirdi.

```ts
buildBarcode("ean13", "8691234567891");
// { ok: false, problem: { code: "checkDigit", given: 1, expected: 0, body: 12 } }
```

**Geometri ve SVG.** Nokta cinsinden yerleşim, milimetre cinsinden ölçü:

```ts
import { layoutBarcode, barcodeSvg, DOTS_PER_MM } from "karsh-barkod";

const geometry = layoutBarcode(result.barcode, {
  module: 3,      // modül genişliği, tam nokta
  height: 120,    // çubuk boyu, nokta
  showText: true,
});

geometry.width;  // 339
geometry.height; // 147 — rakam satırı dahil
geometry.left;   // 33 — ilk çubuğa kadarki sessiz bölge

barcodeSvg(geometry, DOTS_PER_MM[300]).split("\n")[0];
// <svg ... width="28.25mm" height="12.25mm" viewBox="0 0 339 147" shape-rendering="crispEdges">
```

**Etiket komutu üret.** Code 128 değerlerinden bir Zebra işi:

```ts
import { buildBarcode, recommendedModule, toZpl } from "karsh-barkod";

const built = ["KRS-0001", "KRS-0002"].map((v) => buildBarcode("code128", v));
const barcodes = built.flatMap((r) => (r.ok ? [r.barcode] : []));

const zpl = toZpl(barcodes, {
  widthMm: 50,
  heightMm: 30,
  gapMm: 2,
  dpi: 203,
  quantity: 1,
  flip: false,
  module: recommendedModule("code128", 203), // 2 nokta
  barHeightMm: 15,
  showText: true,
  position: null, // ortala
});

zpl.skipped; // [] — etikete sığmayan ya da lehçeye yazılamayan değerler
```

`zpl.code` ilk etiket için şunu verir:

```
^XA
^PW400
^LL240
^LH0,0
^PON
^FO88,49^BY2^BCN,120,Y,N,N,A^FDKRS-0001^FS
^PQ1
^XZ
```

Aynı ayarlarla `toTspl` bir TSC işi yazar:

```
SIZE 50 mm,30 mm
GAP 2 mm,0 mm
DIRECTION 1
REFERENCE 0,0
CLS
BARCODE 88,49,"128",120,2,0,2,2,"KRS-0001"
PRINT 1
```

**Kontrol hanesini göster.** Boşluk, tire ve nokta atılır; hesap adım adım
döner, ekranda gösterilebilsin diye:

```ts
import { checkGs1 } from "karsh-barkod";

const gs1 = checkGs1("gtin13", "869 1234 56789");
// status: "computed", full: "8691234567890", expected: 0, sum: 130
// steps: 12 adım, her biri { digit, weight, product }
```

### API

**Kodlama**

| Dışa aktarım | İmza | Ne yapar |
| --- | --- | --- |
| `buildBarcode` | `(symbology: Symbology, input: string) => BarcodeResult` | Değeri doğrular, kodlar, çubukları ve okunur rakamları verir |
| `encodeCode128` | `(text: string) => number[]` | En kısa Code 128 simge dizisi; `encodeCode128("KRS-0001")` → `[104, 43, 50, 51, 13, 99, 0, 1, 27, 106]` |
| `printable` | `(text: string) => string` | Kontrol karakterlerini Unicode denetim resimlerine çevirir, okunur satır ve SVG geçerli kalsın diye |
| `foldToAscii` | `(text: string) => string` | Türkçe harfleri ve bölünmez boşluğu düz ASCII'ye indirir; `"ÜRÜN-Çİğ"` → `"URUN-CIg"` |

**GS1**

| Dışa aktarım | İmza | Ne yapar |
| --- | --- | --- |
| `checkGs1` | `(key: Gs1Key, input: string) => Gs1Result` | Eksikse hesaplar, tamsa doğrular; her hane, ağırlığı ve toplam dönen değerde |

**Geometri ve çizim**

| Dışa aktarım | İmza | Ne yapar |
| --- | --- | --- |
| `layoutBarcode` | `(barcode: Barcode, options: LayoutOptions) => Geometry` | Tam nokta yerleşim: çubuk dikdörtgenleri, metin satırları, sessiz bölge |
| `barsPath` | `(bars: Rect[]) => string` | Bütün çubukları tek bir SVG yolu olarak yazar |
| `barcodeSvg` | `(geometry: Geometry, dotsPerMm: number) => string` | Tek başına duran SVG: `viewBox` nokta, en/boy milimetre |
| `pngWithResolution` | `(png: Uint8Array, dotsPerMm: number) => Uint8Array` | Var olan bir PNG'ye `pHYs` chunk'ı yazar; PNG üretmez |

**Etiket ve yazıcı**

| Dışa aktarım | İmza | Ne yapar |
| --- | --- | --- |
| `DOTS_PER_MM` | `Record<Dpi, number>` | `{ 203: 8, 300: 12, 600: 24 }` — iki kılavuzun da yazdığı yuvarlama |
| `recommendedModule` | `(symbology: Symbology, dpi: Dpi) => number` | Varsayılan modül, tam nokta: her çözünürlükte aynı fiziksel genişlik |
| `minimumModule` | `(symbology: Symbology, dpi: Dpi) => number` | Tabanı hâlâ tutan en ince modül; altı uyarıyı hak eder |
| `placeBarcode` | `(barcode: Barcode, settings: LabelSettings) => Placement` | Simgeyi etikete yerleştirir, ortalar, taşmayı bildirir |
| `toTspl` | `(barcodes: Barcode[], settings: LabelSettings) => DialectOutput` | TSC yazıcı işi; yazılamayan değerler `skipped` içinde |
| `toZpl` | `(barcodes: Barcode[], settings: LabelSettings) => DialectOutput` | Zebra yazıcı işi; yazılamayan değerler `skipped` içinde |

**Tipler**

`Symbology` (`"code128"`, `"ean13"`, `"ean8"`, `"upca"`), `Barcode`, `Bar`,
`HumanText`, `BarcodeResult`, `BarcodeProblem`, `BarcodeNote`, `Gs1Key`
(`"gtin8"`, `"gtin12"`, `"gtin13"`, `"gtin14"`, `"sscc"`), `Gs1Result`,
`Gs1Step`, `Geometry`, `Rect`, `TextRun`, `LayoutOptions`, `Dpi` (`203`,
`300`, `600`), `LabelSettings`, `Placement`, `DialectOutput`,
`DialectProblem`.

### Sınırlar ve kararlar

- **Hiçbir şey fırlatmaz.** Her giriş hatası `{ ok: false, problem }` ya da
  bir `status` alanı olarak döner; mesajı çağıran yazar, paket metin üretmez.
- **Kontrol hanesi düzeltilmez.** Yanlışsa hata döner, doğrusu söylenir, ama
  numara sessizce değiştirilmez.
- **Code 128 en fazla 80 karakter.** Daha uzağını hiçbir el terminali güvenle
  okumuyor; GS1 zaten 48'de duruyor.
- **`DOTS_PER_MM` nominal dpi değil.** 300 dpi aslında 11,81 nokta/mm'dir;
  yazıcılar 12'ye yuvarlar. Komutlar, SVG ve PNG aynı yuvarlamayı kullanır ki
  üçü aynı boyda çıksın.
- **Taşan etiket basılmaz, atlanır.** Çubukları etiketten taşan ya da
  koordinatı eksiye düşen bir değer komuta hiç girmez ve `skipped` içinde
  gerekçesiyle bildirilir — yarısı kesik bir barkod, hiç barkod olmamasından
  kötüdür.
- **Lehçe kaçışları yazıcının kendi kuralı.** ZPL'de basılamayan karakterler
  `^FH` ile onaltılık kaçışa çevrilir; TSPL'de veri içindeki çift tırnak
  kılavuzun verdiği kaçışla yazılır, kontrol karakteri taşıyan bir değer ise
  hiç yazılmaz — tırnaklı bir dizede kaçışı yoktur ve yazıcı onu komut
  sanabilir.
- **PNG üretilmez.** `pngWithResolution` var olan bir PNG'nin baytlarına
  çözünürlük yazar; kodlayıcı değildir.

### Neden kütüphane değil, elle yazıldı

Simgelemeler küçük ve sabit tablolar. Bir kütüphanenin gizleyeceği şey ise tam
olarak bu aracın bilmesi gereken şey: simge kaç modül genişliğinde, hangi
çubuk nerede duruyor, hangi karakterde yazıcı boğuluyor. Etiketi o genişlikten
ortalayabilmek ve önizlemede yazıcının basacağı çubukları gösterebilmek için
kodlayıcının içini görmek gerekiyordu.

Code 128 kodlayıcısı bunun en somut örneği. Yaygın kestirme kural — "dört ve
üzeri hane varsa C kümesine geç" — çoğu zaman doğru, geri kalanında bir iki
modül uzun. Burada onun yerine bir en kısa yol araması var: her konum ve her
küme için, oraya kadarki en ucuz kodlama. Sonuç yapısı gereği en kısa, ve
etiketin ortalandığı genişlik gerçekten basılan genişlik oluyor. Eşit
uzunluktaki yollar arasındaki tercihler de Zebra'nın otomatik kipinin
çıktısına bakılarak ayarlandı, önizleme yazıcıyla aynı çubukları göstersin
diye.

Dosyada hiç `import` yok ve DOM'a dokunmuyor; bu yüzden her tablo, düz bir
Node betiğinde bir referans kodlayıcıya karşı doğrulanabiliyor.

### Lisans

MIT — bkz. [LICENSE](LICENSE). © 2026 Hasan Karşı / KARSH.

---

## English

### What it does

Takes a value and gives back the symbol to be printed — and everything that
symbol needs on its way to a label:

- **Four symbologies.** Code 128 (with an encoder that finds the shortest path
  through code sets A, B and C), EAN-13, EAN-8, UPC-A. Every bar in module
  units, guard bars marked, the human-readable line laid out.
- **The GS1 check digit.** Mod-10 for GTIN-8/12/13/14 and SSCC: computed when
  one digit is missing, verified when the number is complete, with the working
  kept step by step.
- **Whole-dot geometry.** Every bar in printer dots, quiet zones included.
  There is no half-dot bar: a printer prints it as one dot or as none.
- **SVG.** All bars as a single path; the `viewBox` in dots and the width and
  height in millimetres, so a layout program places the symbol at the size the
  printer would print it.
- **PNG resolution.** Writes a `pHYs` chunk into an existing PNG, so Word and
  the print dialog stop assuming 96 dpi.
- **Printer dialects.** TSPL (TSC) and ZPL (Zebra) commands, with placement,
  centring, overflow checks and each dialect's own escapes.

What a library would hide is exactly what this has to know: how many modules
wide the symbol is, where each bar sits, which characters a printer will choke
on. The label is centred from that width, and the preview draws the bars the
printer will draw.

### Install

The package ships as TypeScript source; there is no build step.

```bash
npm i github:<user>/karsh-barkod
```

Because it ships as TypeScript, whatever consumes it has to resolve TS: a
bundler (Vite, webpack, Next) or `tsc`. To run it under plain `node`,
compile it first.

Or copy `src/barkod.ts` into your project — one file, not a single `import`
line in it, MIT.

### Usage

**Encode an EAN-13.** Give twelve digits and let it compute the check digit:

```ts
import { buildBarcode } from "karsh-barkod";

const result = buildBarcode("ean13", "869123456789");

if (result.ok) {
  result.note;            // { code: "computed", digit: 0 }
  result.barcode.data;    // "8691234567890" — check digit included
  result.barcode.modules; // 95
  result.barcode.quiet;   // [11, 7] — the quiet zones, left and right
  result.barcode.bars;    // 30 bars, in module units
}
```

Give thirteen digits and the check digit is verified instead. A wrong one is
an error and is **not corrected**: a wrong check digit usually means a
mistyped digit somewhere else, and "fixing" the last one would turn a caught
typo into a valid-looking number that belongs to someone else.

```ts
buildBarcode("ean13", "8691234567891");
// { ok: false, problem: { code: "checkDigit", given: 1, expected: 0, body: 12 } }
```

**Geometry and SVG.** Laid out in dots, measured in millimetres:

```ts
import { layoutBarcode, barcodeSvg, DOTS_PER_MM } from "karsh-barkod";

const geometry = layoutBarcode(result.barcode, {
  module: 3,      // module width, whole dots
  height: 120,    // bar height, dots
  showText: true,
});

geometry.width;  // 339
geometry.height; // 147 — the digit line included
geometry.left;   // 33 — the quiet zone before the first bar

barcodeSvg(geometry, DOTS_PER_MM[300]).split("\n")[0];
// <svg ... width="28.25mm" height="12.25mm" viewBox="0 0 339 147" shape-rendering="crispEdges">
```

**Write a printer job.** A Zebra job from Code 128 values:

```ts
import { buildBarcode, recommendedModule, toZpl } from "karsh-barkod";

const built = ["KRS-0001", "KRS-0002"].map((v) => buildBarcode("code128", v));
const barcodes = built.flatMap((r) => (r.ok ? [r.barcode] : []));

const zpl = toZpl(barcodes, {
  widthMm: 50,
  heightMm: 30,
  gapMm: 2,
  dpi: 203,
  quantity: 1,
  flip: false,
  module: recommendedModule("code128", 203), // 2 dots
  barHeightMm: 15,
  showText: true,
  position: null, // centre it
});

zpl.skipped; // [] — values that did not fit, or that the dialect cannot carry
```

`zpl.code` gives this for the first label:

```
^XA
^PW400
^LL240
^LH0,0
^PON
^FO88,49^BY2^BCN,120,Y,N,N,A^FDKRS-0001^FS
^PQ1
^XZ
```

With the same settings `toTspl` writes a TSC job:

```
SIZE 50 mm,30 mm
GAP 2 mm,0 mm
DIRECTION 1
REFERENCE 0,0
CLS
BARCODE 88,49,"128",120,2,0,2,2,"KRS-0001"
PRINT 1
```

**Show the check digit.** Spaces, dashes and dots are stripped, and the
working comes back so it can be put on screen:

```ts
import { checkGs1 } from "karsh-barkod";

const gs1 = checkGs1("gtin13", "869 1234 56789");
// status: "computed", full: "8691234567890", expected: 0, sum: 130
// steps: 12 of them, each { digit, weight, product }
```

### API

**Encoding**

| Export | Signature | What it does |
| --- | --- | --- |
| `buildBarcode` | `(symbology: Symbology, input: string) => BarcodeResult` | Validates, encodes, and returns the bars and the human-readable digits |
| `encodeCode128` | `(text: string) => number[]` | The shortest Code 128 symbol sequence; `encodeCode128("KRS-0001")` → `[104, 43, 50, 51, 13, 99, 0, 1, 27, 106]` |
| `printable` | `(text: string) => string` | Turns control characters into Unicode control pictures, so the readable line and the SVG stay valid |
| `foldToAscii` | `(text: string) => string` | Folds Turkish letters and the no-break space to plain ASCII; `"ÜRÜN-Çİğ"` → `"URUN-CIg"` |

**GS1**

| Export | Signature | What it does |
| --- | --- | --- |
| `checkGs1` | `(key: Gs1Key, input: string) => Gs1Result` | Computes the check digit when one short, verifies it when complete; every digit, its weight and the sum come back with it |

**Geometry and drawing**

| Export | Signature | What it does |
| --- | --- | --- |
| `layoutBarcode` | `(barcode: Barcode, options: LayoutOptions) => Geometry` | Whole-dot layout: bar rectangles, text runs, quiet zone |
| `barsPath` | `(bars: Rect[]) => string` | Every bar as one SVG path |
| `barcodeSvg` | `(geometry: Geometry, dotsPerMm: number) => string` | A standalone SVG: `viewBox` in dots, width and height in millimetres |
| `pngWithResolution` | `(png: Uint8Array, dotsPerMm: number) => Uint8Array` | Writes a `pHYs` chunk into an existing PNG; it does not encode one |

**Labels and printers**

| Export | Signature | What it does |
| --- | --- | --- |
| `DOTS_PER_MM` | `Record<Dpi, number>` | `{ 203: 8, 300: 12, 600: 24 }` — the rounding both manuals document |
| `recommendedModule` | `(symbology: Symbology, dpi: Dpi) => number` | The default module in whole dots: the same physical width at every resolution |
| `minimumModule` | `(symbology: Symbology, dpi: Dpi) => number` | The fewest whole dots that still reach the floor; anything thinner deserves a warning |
| `placeBarcode` | `(barcode: Barcode, settings: LabelSettings) => Placement` | Places the symbol on the label, centres it, and reports overflow |
| `toTspl` | `(barcodes: Barcode[], settings: LabelSettings) => DialectOutput` | A TSC job; whatever could not be written is in `skipped` |
| `toZpl` | `(barcodes: Barcode[], settings: LabelSettings) => DialectOutput` | A Zebra job; whatever could not be written is in `skipped` |

**Types**

`Symbology` (`"code128"`, `"ean13"`, `"ean8"`, `"upca"`), `Barcode`, `Bar`,
`HumanText`, `BarcodeResult`, `BarcodeProblem`, `BarcodeNote`, `Gs1Key`
(`"gtin8"`, `"gtin12"`, `"gtin13"`, `"gtin14"`, `"sscc"`), `Gs1Result`,
`Gs1Step`, `Geometry`, `Rect`, `TextRun`, `LayoutOptions`, `Dpi` (`203`,
`300`, `600`), `LabelSettings`, `Placement`, `DialectOutput`,
`DialectProblem`.

### Limits and decisions

- **Nothing throws.** Every input error comes back as `{ ok: false, problem }`
  or as a `status`; the caller writes the message, the package writes no prose.
- **A check digit is never corrected.** A wrong one is an error, the right one
  is named, and the number is not quietly changed.
- **Code 128 stops at 80 characters.** No handheld scanner reads longer
  reliably, and GS1 stops at 48 anyway.
- **`DOTS_PER_MM` is not the nominal dpi.** 300 dpi is really 11.81 dots/mm
  and printers round it to 12. The commands, the SVG and the PNG all use the
  same rounding so that all three come out the same size.
- **A label that overflows is skipped, not printed.** A value whose bars run
  off the stock, or whose coordinate would be negative, never enters the
  command and is reported in `skipped` with its reason — half a barcode is
  worse than none.
- **The escapes belong to the printer.** In ZPL an unprintable character goes
  out through `^FH` as a hex escape; in TSPL a double quote inside the data is
  written with the escape the manual gives, while a value carrying a control
  character is left out entirely — a quoted string has no escape for it, and
  the printer might read it as a command.
- **No PNG is encoded.** `pngWithResolution` writes resolution into the bytes
  of a PNG you already have.

### Why this was written rather than installed

The symbologies are small, fixed tables. What a library would hide is exactly
what this tool has to know: how many modules wide the symbol is, where each
bar sits, which characters a printer will choke on. Centring the label on that
width, and showing in the preview the bars the printer will actually draw,
both need the inside of the encoder.

The Code 128 encoder is the clearest case. The usual rule of thumb — "four
digits or more, go to set C" — is right most of the time and a module or two
long the rest. Here it is a shortest-path search instead: for each position
and each code set, the cheapest way to have encoded everything so far. The
result is minimal by construction, so the width the label is centred on is the
width that gets printed. Ties between equally short paths were tuned against
the output of a Zebra printer's automatic mode, so that the preview shows the
same bars the printer does.

The file has no `import` line and never touches the DOM, which is why every
table in it can be checked against a reference encoder from a plain Node
script.

### License

MIT — see [LICENSE](LICENSE). © 2026 Hasan Karşı / KARSH.
