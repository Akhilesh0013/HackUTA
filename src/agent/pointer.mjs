// point_at: find a described thing in the caller's latest camera frame and return its box.
// The Live model is weak at exact coordinates, so a regular Gemini vision model does the finding.
// Boxes use Gemini's convention: [ymin, xmin, ymax, xmax], each 0-1000 of the image size.

const clean = (s, n) => String(s ?? '').replace(/[\r\n"]+/g, ' ').trim().slice(0, n);

export function buildLocatePrompt(target) {
  return `Find this in the image: "${clean(target, 120)}".
Return JSON only: {"found": true|false, "box_2d": [ymin, xmin, ymax, xmax], "label": "2-4 word name"}
Coordinates are integers normalized to 0-1000 of the image height and width.
The box should tightly cover only that thing. If it is not clearly visible, return {"found": false}.`;
}

/** Validate a model reply; returns { found, box, label } with a sane box, or { found: false }. */
export function parseLocate(r) {
  if (Array.isArray(r)) r = r[0]; // some models reply with a list of detections
  if (r && r.found === undefined && Array.isArray(r.box_2d)) r = { ...r, found: true };
  if (!r || r.found !== true || !Array.isArray(r.box_2d) || r.box_2d.length !== 4) return { found: false };
  const box = r.box_2d.map(Number);
  if (box.some((v) => !Number.isFinite(v))) return { found: false };
  const [y0, x0, y1, x1] = box.map((v) => Math.min(1000, Math.max(0, v)));
  if (y1 - y0 < 3 || x1 - x0 < 3) return { found: false };
  return { found: true, box: [y0, x0, y1, x1], label: clean(r.label, 24) };
}

/** Ask the vision model where `target` is in `jpeg`. Throws if every model fails. */
export async function locate(gemini, jpeg, target) {
  const r = await gemini.json(
    [{ inlineData: { mimeType: 'image/jpeg', data: Buffer.from(jpeg).toString('base64') } }, { text: buildLocatePrompt(target) }],
    { tier: 'vision', timeoutMs: 10000, attempts: 1, thinking: false }, // 10 s is the API's minimum deadline
  );
  return parseLocate(r);
}
