import path from "node:path";
import { getImage } from "astro:assets";
import sharp from "sharp";
import type { GetImageResult, ImageMetadata } from "astro";
import d0 from "../ui/stills/wide/d-0.png";
import d1 from "../ui/stills/d-1.png";
import d2 from "../ui/stills/d-2.png";
import d3 from "../ui/stills/d-3.png";
import d4 from "../ui/stills/d-4.png";
import d5 from "../ui/stills/d-5.png";
import m0 from "../ui/stills/m-0.png";
import m1 from "../ui/stills/m-1.png";
import m2 from "../ui/stills/m-2.png";
import m3 from "../ui/stills/m-3.png";
import m4 from "../ui/stills/m-4.png";
import m5 from "../ui/stills/m-5.png";

const DESKTOP: readonly ImageMetadata[] = [d0, d1, d2, d3, d4, d5];
const MOBILE: readonly ImageMetadata[] = [m0, m1, m2, m3, m4, m5];

/** The `<source>` media of the mobile still; the desktop still is the `<img>` fallback. */
export const MOBILE_STILL_MEDIA = "(max-width: 767px)";
export const DESKTOP_STILL_MEDIA = "(min-width: 768px)";

/**
 * PF-87: the intro desktop still is a 12:5 render of the live rest pose (tools/render-stills.mjs,
 * stills/wide/d-0.png). Shown with object-fit: cover it is height-fitted (and centred) on every
 * viewport up to 12:5, exactly like the live camera, which keeps its vertical FOV: so its displayed
 * width is 240vh there, not 100vw. Same `sizes` on the `<img>` and the head preload.
 */
export const INTRO_DESKTOP_SIZES = "(min-aspect-ratio: 12/5) 100vw, 240vh";
export const DESKTOP_SIZES = "100vw";
/** Desktop `sizes` for one section's still. */
export const desktopSizes = (index: number): string =>
  index === 0 ? INTRO_DESKTOP_SIZES : DESKTOP_SIZES;

export interface SectionStillImages {
  desktopSrc: ImageMetadata;
  mobileSrc: ImageMetadata;
  desktop: GetImageResult;
  mobile: GetImageResult;
}

/**
 * The desktop and mobile AVIF stills for one section. One place for the encode settings so the
 * `<picture>` and the head preload of the first still resolve to the same URLs (one fetch each).
 */
export async function sectionStillImages(index: number): Promise<SectionStillImages> {
  const desktopSrc = DESKTOP[index];
  const mobileSrc = MOBILE[index];
  if (!desktopSrc || !mobileSrc) throw new Error(`No still for section ${index}`);
  const desktop = await getImage({
    src: desktopSrc,
    format: "avif",
    quality: 55,
    // The 12:5 intro still is 2160 wide at 900 tall (1440x900 shows its centre).
    widths: index === 0 ? [1440, 2160] : [960, 1440],
  });
  const mobile = await getImage({ src: mobileSrc, format: "avif", quality: 55, widths: [390] });
  return { desktopSrc, mobileSrc, desktop, mobile };
}

/** Source files of the intro still, for the inline placeholder (build time only). */
const STILLS_DIR = path.join(process.cwd(), "src/_pages/home/ui/stills");

export interface StillPlaceholder {
  desktop: string;
  mobile: string;
}

let introPlaceholder: Promise<StillPlaceholder> | null = null;

async function tinyWebp(file: string, width: number): Promise<string> {
  const buffer = await sharp(path.join(STILLS_DIR, file))
    .resize({ width })
    .webp({ quality: 60 })
    .toBuffer();
  return `data:image/webp;base64,${buffer.toString("base64")}`;
}

/**
 * PF-57: a tiny (72 px wide 12:5 (PF-87) / 24 px wide, ~0.3 KB each) copy of the intro still,
 * inlined in the HTML as the background of the intro `<picture>`. The still is the page background
 * on the first screen, and on Slow 4G its AVIF arrived ~200 ms after first paint, so the copy first sat on a
 * flat dark field and the lit print then popped in. With the placeholder the first paint already
 * has the print's colour and tone; the AVIF only sharpens it.
 */
export function introStillPlaceholder(): Promise<StillPlaceholder> {
  introPlaceholder ??= Promise.all([tinyWebp("wide/d-0.png", 72), tinyWebp("m-0.png", 24)]).then(
    ([desktop, mobile]) => ({ desktop, mobile }),
  );
  return introPlaceholder;
}
