import { logWarn } from './logger.js';

/**
 * Extract the first JSON object/array from a model response.
 * Handles ``` / ```json fenced blocks, plus stray prose around the JSON.
 */
export function extractJsonBlock(text: string): string {
  if (!text) throw new Error('Empty model response');

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1] && fenced[1].trim()) {
    return fenced[1].trim();
  }

  const firstBrace = text.search(/[{[]/);
  if (firstBrace === -1) throw new Error('No JSON found in model response');
  const candidate = text.slice(firstBrace).trim();

  // Try progressively trimming trailing prose: find balanced end.
  const balanced = sliceBalancedJson(candidate);
  if (balanced) return balanced;

  // Fallback: greedy match from first { to last }
  const lastBrace = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (lastBrace > 0) return candidate.slice(0, lastBrace + 1);
  return candidate;
}

function sliceBalancedJson(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function parseModelJson<T>(text: string): T {
  const block = extractJsonBlock(text);
  try {
    return JSON.parse(block) as T;
  } catch (err) {
    // One repair attempt: strip trailing commas
    const repaired = block.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(repaired) as T;
    } catch {
      logWarn('Failed to parse model JSON', { preview: block.slice(0, 500) });
      throw new Error(`Model did not return valid JSON: ${(err as Error).message}`);
    }
  }
}
