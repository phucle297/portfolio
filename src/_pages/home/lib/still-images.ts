import { getImage } from "astro:assets";
import type { GetImageResult, ImageMetadata } from "astro";
import d0 from "../ui/stills/d-0.png";
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
    widths: [960, 1440],
  });
  const mobile = await getImage({ src: mobileSrc, format: "avif", quality: 55, widths: [390] });
  return { desktopSrc, mobileSrc, desktop, mobile };
}
