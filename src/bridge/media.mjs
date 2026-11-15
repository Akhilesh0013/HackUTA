// Media helpers for the FaceTime bridge: caller video frame → JPEG, step card → RGBA video frame,
// and slicing the agent's 24 kHz PCM into the fixed-size frames LiveKit expects.
import sharp from 'sharp';

export const FRAME_WIDTH = 512; // what the Live model needs; smaller = faster upload
export const CARD_W = 1280;
export const CARD_H = 720;

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
  const parts = [`<rect width="${w}" height="${h}" fill="#0d1117"/>`];
  if (!card) {
    parts.push(
      `<text x="${w / 2}" y="${h / 2 - 20}" font-family="Helvetica, Arial, sans-serif" font-size="96" fill="#d4a72c" text-anchor="middle">Genesis</text>`,
      `<text x="${w / 2}" y="${h / 2 + 60}" font-family="Helvetica, Arial, sans-serif" font-size="36" fill="#8b949e" text-anchor="middle">Point your camera at the problem</text>`,
    );
  } else {
    const titleSize = String(card.title).length > 36 ? 36 : 56; // titles are capped at 60 chars
    parts.push(`<text x="80" y="110" font-family="Helvetica, Arial, sans-serif" font-size="${titleSize}" font-weight="bold" fill="#d4a72c">${esc(card.title)}</text>`);
    // Up to 6 steps of 120 chars must fit in 720 px: smaller type when there are more than 3.
    const compact = card.steps.length > 3;
    const [size, lineH, gap, chars] = compact ? [28, 32, 20, 75] : [38, 44, 30, 56];
    let y = 200;
    card.steps.forEach((step, i) => {
      const lines = wrap(step, chars);
      const color = i === 0 ? '#e6edf3' : '#8b949e';
      parts.push(`<circle cx="104" cy="${y - size * 0.37}" r="${size * 0.63}" fill="${i === 0 ? '#d4a72c' : '#30363d'}"/>`);
      parts.push(`<text x="104" y="${y - 3}" font-family="Helvetica, Arial, sans-serif" font-size="${size * 0.74}" font-weight="bold" fill="#0d1117" text-anchor="middle">${i + 1}</text>`);
      lines.forEach((line, j) => {
        parts.push(`<text x="150" y="${y + j * lineH}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" fill="${color}">${esc(line)}</text>`);
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
