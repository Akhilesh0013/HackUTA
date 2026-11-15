// Tool schemas (plain JSON Schema). Adapters below convert them for Gemini Live / OpenAI Realtime.
import { ERROR_TYPES, OUTCOMES, OUTCOME_EVIDENCE, RESULTS, TASK_CATEGORIES } from '../config.mjs';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

export const TOOL_DECLARATIONS = [
  {
    name: 'record_consent',
    description: "Store the caller's answer to the logging consent question. Call once, early in the call.",
    parameters: {
      type: 'object',
      properties: { granted: { type: 'boolean', description: 'true if the caller agreed to anonymous step logging' } },
      required: ['granted'],
    },
  },
  {
    name: 'log_observation',
    description: 'Log one step you visually checked. Only after consent. Never include personal info.',
    parameters: {
      type: 'object',
      properties: {
        t_video_ms: { type: 'integer', description: 'Milliseconds since call start when the action was seen' },
        task_category: str('Task category', { enum: TASK_CATEGORIES }),
        device: {
          type: 'object',
          properties: {
            type: str('Device type, e.g. monitor, router, desktop_pc, tv, printer'),
            brand: str('Brand if visible, else empty'),
            model: str('Model from label if visible, else empty'),
            id_confidence: { type: 'number', description: '0-1 confidence in brand/model' },
          },
          required: ['type'],
        },
        step_id: str('Short snake_case step name, e.g. connect_video_cable'),
        instruction_given: str('What you told the caller to do'),
        observed_action: str('What you actually saw them do'),
        result: str('Outcome of this step', { enum: RESULTS }),
        error_type: str(`One of: ${ERROR_TYPES.join(', ')}, or other:<short description>. Empty if correct.`),
        correction_given: str('The correction you gave, if any'),
        correction_worked: { type: 'boolean', description: 'Whether the correction fixed the step (omit if no correction)' },
        visual_evidence: str('What in the image supports your judgement'),
        guide_entry_used: str('Part D entry ID you applied (e.g. D1-001), or empty'),
        confidence: { type: 'number', description: '0-1 confidence in this observation' },
      },
      required: ['task_category', 'device', 'step_id', 'observed_action', 'result', 'confidence'],
    },
  },
  {
    name: 'log_session',
    description: 'Log the session summary once at the end of the call. Only after consent.',
    parameters: {
      type: 'object',
      properties: {
        task_category: str('Task category', { enum: TASK_CATEGORIES }),
        goal: str("The caller's goal in a few words"),
        outcome: str('Session outcome', { enum: OUTCOMES }),
        outcome_evidence: str('How you know the outcome', { enum: OUTCOME_EVIDENCE }),
        duration_s: { type: 'integer' },
        steps_total: { type: 'integer' },
        errors_total: { type: 'integer' },
        first_try_success_steps: { type: 'integer' },
        manual_used: str('Manual title used, or empty'),
        safety_stop: { type: 'boolean', description: 'true if you stopped for a Part A safety reason' },
        caller_rating: { type: 'integer', description: '1-5 if the caller gave one' },
      },
      required: ['task_category', 'goal', 'outcome', 'outcome_evidence', 'steps_total', 'errors_total', 'first_try_success_steps', 'safety_stop'],
    },
  },
  {
    name: 'lookup_manual',
    description: 'Find official manual excerpts for a device. Manuals override Part D knowledge.',
    parameters: {
      type: 'object',
      properties: {
        brand: str('Brand'),
        model: str('Model number as printed on the label'),
        topic: str('What you need, e.g. "front panel header", "input source", "wall mount"'),
      },
      required: ['brand', 'model', 'topic'],
    },
  },
  {
    name: 'show_card',
    description: "Show a step card on the caller's FaceTime screen.",
    parameters: {
      type: 'object',
      properties: {
        title: str('Card title, max 60 chars'),
        steps: { type: 'array', items: { type: 'string' }, description: '1-6 short steps' },
        image_hint: str('Optional: which diagram to draw, e.g. "hdmi_vs_dp", "router_wan_port"'),
      },
      required: ['title', 'steps'],
    },
  },
];

/** Gemini (Live or generateContent) `tools` value. */
export const toGeminiTools = () => [
  { functionDeclarations: TOOL_DECLARATIONS.map(({ name, description, parameters }) => ({ name, description, parametersJsonSchema: parameters })) },
];

/** OpenAI Realtime / Chat Completions function tools. */
export const toOpenAITools = () =>
  TOOL_DECLARATIONS.map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters }));
