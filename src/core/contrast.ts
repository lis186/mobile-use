import sharp from 'sharp';

const SAMPLE_SIZE = 60; // px — ~20pt at 3x retina; wide enough for text+background

function linearize(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

// Always returns ≥ 1 — guaranteed by the (L + 0.05) / (L + 0.05) formula bounds.
export function wcagContrast(l1: number, l2: number): number {
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

// Returns null on corrupt buffer or region too small to sample reliably.
export async function sampleContrast(
  imageBuffer: Buffer,
  xPct: number,
  yPct: number,
): Promise<number | null> {
  try {
    const { width, height } = await sharp(imageBuffer).metadata();
    if (!width || !height) return null;

    const cx = Math.round((xPct / 100) * width);
    const cy = Math.round((yPct / 100) * height);
    const half = Math.floor(SAMPLE_SIZE / 2);
    const left = Math.max(0, cx - half);
    const top = Math.max(0, cy - half);
    const w = Math.min(SAMPLE_SIZE, width - left);
    const h = Math.min(SAMPLE_SIZE, height - top);
    if (w < 4 || h < 4) return null;

    const { data, info } = await sharp(imageBuffer)
      .extract({ left, top, width: w, height: h })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const ch = info.channels;
    const luminances: number[] = [];
    for (let i = 0; i + 2 < data.length; i += ch) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      luminances.push(luminance(r, g, b));
    }
    if (luminances.length < 4) return null;

    luminances.sort((a, b) => a - b);
    const n = luminances.length;
    // p12.5 as dark-side anchor, p87.5 as light-side anchor (25 % trim each side).
    const darkAnchor = luminances[Math.floor(n * 0.125)] ?? luminances[0] ?? 0;
    const lightAnchor = luminances[Math.floor(n * 0.875)] ?? luminances[n - 1] ?? 1;

    return Math.round(wcagContrast(darkAnchor, lightAnchor) * 100) / 100;
  } catch {
    return null;
  }
}
