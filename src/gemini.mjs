// Gemini client for curation (proposer + safety classifier). Batch work uses generateContent
// models; the live FaceTime agent uses LIVE_MODEL over the Live API (see src/agent/).
// Returns null when GEMINI_API_KEY is unset or @google/genai isn't installed, so curation can
// run offline (deterministic proposer; safety gate fails closed).

/** Real-time model for the FaceTime agent (bidiGenerateContent only). */
export const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';

/**
 * Curation model chains, tried in order (Gemini returns 503/504 under load, so we fall back).
 *  fast:   drafting guide changes (proposer). Cheap and quick.
 *  strong: the G7 safety classifier, the last automated check before a human, so no lite model first.
 */
const uniq = (a) => a.filter((m, i) => m && a.indexOf(m) === i);
export const MODEL_CHAINS = {
  fast: uniq([process.env.GEMINI_MODEL, 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash']),
  strong: uniq([process.env.GEMINI_SAFETY_MODEL, 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash']),
};
/** @deprecated kept for the CLI banner */
export const CURATION_MODELS = MODEL_CHAINS.fast;

const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 45000);
const RETRYABLE = /\b(429|500|503|504)\b|UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|timed? ?out|aborted|fetch failed/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getGemini({ log = console.log } = {}) {
  if (!process.env.GEMINI_API_KEY) return null;
  let GoogleGenAI;
  try {
    ({ GoogleGenAI } = await import('@google/genai'));
  } catch {
    log('GEMINI_API_KEY is set but @google/genai is not installed (npm install). Running offline.');
    return null;
  }
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const preferred = { fast: 0, strong: 0 }; // last model that worked per chain (sticky)

  const client = {
    get model() { return MODEL_CHAINS.fast[preferred.fast]; },
    modelFor(tier = 'fast') { return MODEL_CHAINS[tier][preferred[tier]]; },
    /** Ask for JSON and parse it. Retries + model fallback; throws if every model fails. */
    async json(prompt, { temperature = 0, tier = 'fast' } = {}) {
      const chain = MODEL_CHAINS[tier] || MODEL_CHAINS.fast;
      const errors = [];
      for (let i = preferred[tier]; i < chain.length; i++) {
        const model = chain[i];
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await ai.models.generateContent({
              model,
              contents: prompt,
              config: { responseMimeType: 'application/json', temperature, httpOptions: { timeout: TIMEOUT_MS } },
            });
            const text = typeof res.text === 'function' ? res.text() : res.text;
            const parsed = JSON.parse(text);
            if (i !== preferred[tier]) log(`Gemini (${tier}): switched to ${model}`);
            preferred[tier] = i;
            return parsed;
          } catch (err) {
            const msg = String(err?.message || err).slice(0, 160);
            errors.push(`${model}: ${msg}`);
            if (!RETRYABLE.test(msg)) break; // bad JSON / 4xx: next model, no retry
            if (attempt === 0) await sleep(1500);
          }
        }
      }
      throw new Error(`All Gemini models failed: ${errors.join(' | ')}`);
    },
  };
  return client;
}
