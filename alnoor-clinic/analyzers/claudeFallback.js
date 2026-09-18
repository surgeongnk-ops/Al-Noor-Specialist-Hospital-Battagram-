// analyzers/claudeFallback.js — optional, on-demand AI-assisted re-parse for
// Analyzer Inbox entries the best-effort tokenizer (serialBridge.js's
// parseBundle) couldn't make good sense of.
//
// This is deliberately NOT part of the automatic capture path
// (serialBridge.js / astmTransport.js / inbox.js): this hospital runs
// offline day-to-day (see db.js's header comment), and nothing here should
// make an outbound network call an operator didn't ask for. Instead, a lab
// technician reviewing a low-confidence Analyzer Inbox entry can click
// "Ask Claude to Re-Parse" in lab.html — wired to
// POST /api/analyzers/inbox/:id/ai-suggest in routes/analyzers.routes.js —
// which calls this module exactly once, on demand.
//
// Uses Node's built-in `fetch` (Node >=22, per this project's package.json
// engines field) instead of @anthropic-ai/sdk, to keep this codebase's
// zero-new-dependencies rule intact (db.js's header comment: "nothing here
// may require `npm install` to recover"). That constraint is specific to
// this codebase — it's the reason for raw HTTP here, not a general
// recommendation.
//
// Safety model unchanged from the rest of Phase 2: this function only
// RETURNS a suggestion. It never writes to analyzer_result_inbox or
// lab_orders itself — the route handler decides what to store, and nothing
// reaches a saved report without a technician reviewing it in the Inbox,
// clicking Import, then Save Results, exactly as with any other analyzer
// message.

'use strict';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 2048;

const SUGGEST_TOOL = {
  name: 'record_analyzer_results',
  description: 'Record every discrete analyte result found in a raw, non-standardized lab analyzer message.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      specimen_id_guess: {
        type: ['string', 'null'],
        description: 'Specimen/sample ID printed in the message, if any.'
      },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source_code: {
              type: 'string',
              description: "The analyzer's own short code/abbreviation for this test, or its full name if no separate code is printed."
            },
            source_name: { type: 'string', description: 'Human-readable test/parameter name.' },
            value: { type: 'string' },
            unit: { type: ['string', 'null'] },
            ref_range: { type: ['string', 'null'] },
            abnormal_flag: {
              type: ['string', 'null'],
              description: 'H, L, N, or whatever flag the analyzer printed, verbatim.'
            }
          },
          required: ['source_code', 'source_name', 'value', 'unit', 'ref_range', 'abnormal_flag'],
          additionalProperties: false
        }
      }
    },
    required: ['specimen_id_guess', 'results'],
    additionalProperties: false
  }
};

const SYSTEM_PROMPT = [
  "You are helping a hospital lab technician read a raw, undocumented message",
  "captured from an analyzer's serial or network output. Its exact format is",
  "not documented by the manufacturer. Extract every discrete analyte result",
  "you can find and call record_analyzer_results exactly once. Copy numeric",
  "values as strings exactly as printed -- never round or convert units. Use",
  "null for any field genuinely absent from the text. This is a suggestion a",
  "human will review before anything is saved -- if a line is ambiguous,",
  "make your best reasonable guess rather than omitting it, but never invent",
  "a specimen ID or a result that is not actually present in the text."
].join(' ');

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Ask Claude to re-parse one analyzer message's raw text.
 *
 * @param {string} rawPayload Raw text captured from the analyzer (analyzer_result_inbox.raw_payload).
 * @returns {Promise<{specimen_id_guess: string|null, results: object[]}>}
 */
async function suggestResults(rawPayload) {
  if (!isConfigured()) {
    throw new Error('ANTHROPIC_API_KEY is not set on this server');
  }
  if (!rawPayload || !rawPayload.trim()) {
    throw new Error('Nothing to parse: this inbox entry has no raw payload');
  }

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: [SUGGEST_TOOL],
        tool_choice: { type: 'tool', name: 'record_analyzer_results' },
        messages: [{ role: 'user', content: rawPayload }]
      })
    });
  } catch (err) {
    throw new Error(`Could not reach the Claude API (${err.message}) — this hospital's network may be offline`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Claude API request failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const toolUse = (data.content || []).find((block) => block.type === 'tool_use');
  if (!toolUse) {
    throw new Error('Claude did not return a structured result — try again or enter this result by hand');
  }

  const rawResults = Array.isArray(toolUse.input && toolUse.input.results) ? toolUse.input.results : [];
  const results = rawResults
    .map((r) => ({
      source_code: String((r && r.source_code) || '').trim(),
      source_name: String((r && (r.source_name || r.source_code)) || '').trim(),
      value: String((r && r.value) || '').trim(),
      unit: (r && r.unit) || '',
      ref_range: (r && r.ref_range) || '',
      abnormal_flag: (r && r.abnormal_flag) || '',
      raw_line: null // Claude reasons over the whole message, not one source line
    }))
    .filter((r) => r.source_code && r.value);

  if (results.length === 0) {
    throw new Error('Claude could not find any usable results in this message');
  }

  return {
    specimen_id_guess: (toolUse.input && toolUse.input.specimen_id_guess) || null,
    results
  };
}

module.exports = { isConfigured, suggestResults };
