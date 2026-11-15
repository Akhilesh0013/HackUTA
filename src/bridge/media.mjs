// Media helpers for the FaceTime bridge: caller video frame → JPEG, step card → RGBA video frame,
// and slicing the agent's 24 kHz PCM into the fixed-size frames LiveKit expects.
import sharp from 'sharp';

export const FRAME_WIDTH = 512; // what the Live model needs; smaller = faster upload
// Cards are portrait: the iPhone shows FaceTime video full-screen in portrait and crops a landscape
// frame's sides. 1080x1920 keeps text sharp at phone resolution.
export const CARD_W = 1080;
export const CARD_H = 1920;
// Area FaceTime doesn't cover: the top bar and self-view tile above, call controls below.
const SAFE = { top: 300, bottom: 360, side: 90 };

/** RGBA pixels → downscaled JPEG for `live.sendFrame`. */
export function rgbaToJpeg({ data, width, height }, maxWidth = FRAME_WIDTH) {
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } })
    .resize({ width: Math.min(maxWidth, width), withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** Word-wrap for SVG text (no text layout engine in SVG). */
function wrap(text, maxChars) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if ((line + ' ' + word).trim().length > maxChars && line) { lines.push(line); line = word; } else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  return lines;
}

/** A step card (or the idle screen when card is null) as SVG, same look as the browser page. */
export function cardSvg(card, w = CARD_W, h = CARD_H) {
  const font = 'font-family="Helvetica, Arial, sans-serif"';
  const parts = [`<rect width="${w}" height="${h}" fill="#0d1117"/>`];
  const s = w / CARD_W; // layout is tuned for 1080 wide; scales for other sizes
  const left = SAFE.side * s, width = w - 2 * SAFE.side * s;
  const top = SAFE.top * s, bottom = h - SAFE.bottom * s;
  const charsFor = (size, px) => Math.max(8, Math.floor(px / (size * 0.53)));
  if (!card) {
    parts.push(
      `<text x="${w / 2}" y="${h / 2 - 40 * s}" ${font} font-size="${150 * s}" font-weight="bold" fill="#d4a72c" text-anchor="middle">Genesis</text>`,
      ...wrap('Point your camera at what you need help with', charsFor(52 * s, width)).map((line, i) =>
        `<text x="${w / 2}" y="${h / 2 + (80 + i * 66) * s}" ${font} font-size="${52 * s}" fill="#8b949e" text-anchor="middle">${esc(line)}</text>`),
    );
  } else {
    // Largest type that fits the safe area: up to 6 steps of 120 chars.
    const badge = 0.9; // badge diameter as a share of the font size
    let fit;
    for (const base of [64, 56, 50, 44, 38, 33, 29]) {
      const size = base * s, titleSize = size * 1.3;
      const textX = left + size * badge + 28 * s;
      const titleLines = wrap(card.title, charsFor(titleSize, width));
      const steps = card.steps.map((t) => wrap(t, charsFor(size, left + width - textX)));
      const lineH = size * 1.25, gap = size * 0.9;
      const height = titleLines.length * titleSize * 1.2 + size * 1.1 + steps.reduce((a, l) => a + l.length * lineH + gap, 0);
      fit = { size, titleSize, textX, titleLines, steps, lineH, gap };
      if (top + height <= bottom) break;
    }
    const { size, titleSize, textX, titleLines, steps, lineH, gap } = fit;
    let y = top + titleSize;
    for (const line of titleLines) {
      parts.push(`<text x="${left}" y="${y}" ${font} font-size="${titleSize}" font-weight="bold" fill="#d4a72c">${esc(line)}</text>`);
      y += titleSize * 1.2;
    }
    y += size * 1.1;
    steps.forEach((lines, i) => {
      const color = i === 0 ? '#e6edf3' : '#8b949e';
      const cx = left + (size * badge) / 2;
      parts.push(`<circle cx="${cx}" cy="${y - size * 0.36}" r="${(size * badge) / 2}" fill="${i === 0 ? '#d4a72c' : '#30363d'}"/>`);
      parts.push(`<text x="${cx}" y="${y - size * 0.1}" ${font} font-size="${size * 0.7}" font-weight="bold" fill="${i === 0 ? '#0d1117' : '#e6edf3'}" text-anchor="middle">${i + 1}</text>`);
      lines.forEach((line, j) => {
        parts.push(`<text x="${textX}" y="${y + j * lineH}" ${font} font-size="${size}" fill="${color}">${esc(line)}</text>`);
      });
      y += lines.length * lineH + gap;
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`;
}

/** Render a card to raw RGBA bytes for a LiveKit VideoFrame. */
export async function cardToRgba(card, w = CARD_W, h = CARD_H) {
  const data = await sharp(Buffer.from(cardSvg(card, w, h))).resize(w, h).ensureAlpha().raw().toBuffer();
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Slices a PCM16 byte stream into frames of `samples` each, carrying the remainder between calls. */
export class PcmChunker {
  constructor(samples) {
    this.bytes = samples * 2;
    this.rest = Buffer.alloc(0);
  }
  push(pcm) {
    let buf = this.rest.length ? Buffer.concat([this.rest, pcm]) : Buffer.from(pcm);
    const out = [];
    while (buf.length >= this.bytes) {
      // Copy so each Int16Array is aligned and owns its memory.
      const chunk = new Int16Array(this.bytes / 2);
      Buffer.from(chunk.buffer).set(buf.subarray(0, this.bytes));
      out.push(chunk);
      buf = buf.subarray(this.bytes);
    }
    this.rest = Buffer.from(buf);
    return out;
  }
  reset() { this.rest = Buffer.alloc(0); }
}

/** Root mean square of PCM16 samples: rough "is the caller talking" signal. */
export function rms(int16) {
  if (!int16.length) return 0;
  let sum = 0;
  for (let i = 0; i < int16.length; i++) sum += int16[i] * int16[i];
  return Math.sqrt(sum / int16.length);
}

/**
 * The caller's frame with a circle around `box` ([ymin, xmin, ymax, xmax], 0-1000) and a label,
 * fitted into the portrait card canvas, as RGBA. This is a snapshot: it does not follow the camera.
 */
export async function pointerToRgba(jpeg, box, label, w = CARD_W, h = CARD_H) {
  const s = w / CARD_W;
  const meta = await sharp(jpeg).metadata();
  const top = 200 * s, areaH = h - top - 300 * s; // leave FaceTime's top bar and controls clear
  const scale = Math.min(w / meta.width, areaH / meta.height);
  const iw = Math.round(meta.width * scale), ih = Math.round(meta.height * scale);
  const ox = Math.round((w - iw) / 2), oy = Math.round(top + (areaH - ih) / 2);
  const img = await sharp(jpeg).resize(iw, ih).toBuffer();

  const [y0, x0, y1, x1] = box;
  const bx = ox + (x0 / 1000) * iw, by = oy + (y0 / 1000) * ih;
  const bw = ((x1 - x0) / 1000) * iw, bh = ((y1 - y0) / 1000) * ih;
  const cx = bx + bw / 2, cy = by + bh / 2;
  const rx = Math.max(bw * 0.62 + 14 * s, 46 * s), ry = Math.max(bh * 0.62 + 14 * s, 46 * s);

  const text = String(label || '').slice(0, 40);
  const fs = 46 * s, padX = 26 * s, pillH = fs * 1.6;
  const pillW = Math.min(w - 40 * s, text.length * fs * 0.56 + 2 * padX);
  const above = cy - ry - pillH - 24 * s > top;
  const py = above ? cy - ry - pillH - 20 * s : Math.min(cy + ry + 20 * s, h - 300 * s - pillH);
  const px = Math.min(Math.max(cx - pillW / 2, 20 * s), w - pillW - 20 * s);
  const ring = `cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none"`;
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <ellipse ${ring} stroke="#000" stroke-opacity="0.55" stroke-width="${22 * s}"/>
    <ellipse ${ring} stroke="#ffd60a" stroke-width="${11 * s}"/>
    ${text ? `<rect x="${px}" y="${py}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="#ffd60a"/>
    <text x="${px + pillW / 2}" y="${py + pillH * 0.68}" font-family="Helvetica, Arial, sans-serif" font-size="${fs}" font-weight="bold" fill="#0d1117" text-anchor="middle">${esc(text)}</text>` : ''}
  </svg>`;
  const data = await sharp({ create: { width: w, height: h, channels: 4, background: '#0d1117' } })
    .composite([{ input: img, left: ox, top: oy }, { input: Buffer.from(overlay), left: 0, top: 0 }])
    .ensureAlpha().raw().toBuffer();
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
