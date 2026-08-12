/**
 * NLP Date Parser (chrono-node wrapper)
 *
 * Provides natural-language date parsing for Quick Add, Triage Queue AI extraction,
 * inline task editing, and the DatePicker. Supports phrases like
 * 'next Friday', 'end of month', 'tomorrow 3pm', 'aug 15', 'in 2 weeks', etc.
 *
 * @see https://github.com/wanasit/chrono – issue #1042
 */

import * as chrono from 'chrono-node';
import type { ParsingContext } from 'chrono-node';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NLPDateResult {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  /** Human-readable label (e.g. "Next Friday", "Aug 15") */
  label: string;
  /** The substring that was matched in the original text */
  matchedText: string;
  /** Start index of the match in the input text */
  index: number;
}

// ---------------------------------------------------------------------------
// Custom chrono parser for "end of month" / "end of week"
// chrono-node doesn't support these natively.
// ---------------------------------------------------------------------------

const endOfPattern: chrono.Parser = {
  pattern: () => /\bend\s+of\s+(month|week)\b/i,
  extract: (context: ParsingContext, match: RegExpMatchArray) => {
    const ref = context.reference.instant;
    const unit = match[1].toLowerCase();

    if (unit === 'month') {
      // Last day of the current month
      const lastDay = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
      return context.createParsingResult(match.index!, match[0], {
        year: lastDay.getFullYear(),
        month: lastDay.getMonth() + 1,
        day: lastDay.getDate(),
      });
    }

    // End of week → upcoming Friday
    const d = new Date(ref);
    const daysUntilFriday = (5 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilFriday);
    return context.createParsingResult(match.index!, match[0], {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
    });
  },
};

// ---------------------------------------------------------------------------
// Custom chrono refiner – ensure bare weekday names resolve to
// the *upcoming* occurrence (not today) when today happens to match.
// ---------------------------------------------------------------------------

const forwardWeekdayRefiner: chrono.Refiner = {
  refine: (context, results) => {
    const refDay = context.reference.instant.getDay();
    for (const result of results) {
      if (result.start.isCertain('month') || result.start.isCertain('day')) continue;
      const weekday = result.start.get('weekday');
      if (weekday === refDay && result.start.isCertain('weekday')) {
        // Bare weekday that matches today → push to next week
        const d = new Date(context.reference.instant);
        d.setDate(d.getDate() + 7);
        result.start.assign('day', d.getDate());
        result.start.assign('month', d.getMonth() + 1);
        result.start.assign('year', d.getFullYear());
      }
    }
    return results;
  },
};

// Build a custom chrono instance
const chronoForward = chrono.casual.clone();
chronoForward.parsers.push(endOfPattern);
chronoForward.refiners.push(forwardWeekdayRefiner);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Generate a friendly human-readable label from the matched text.
 * e.g. "next friday" → "Next Friday", "aug 15" → "Aug 15"
 */
function friendlyLabel(matchedText: string, date: Date): string {
  const lower = matchedText.trim().toLowerCase();

  // Common shorthands → fixed labels
  if (lower === 'today') return 'Today';
  if (['tomorrow', 'tmr', 'tmrw'].includes(lower)) return 'Tomorrow';
  if (lower === 'yesterday') return 'Yesterday';
  if (lower.startsWith('end of month')) return 'End of month';
  if (lower.startsWith('end of week')) return 'End of week';

  // "next <day>" → "Next <Day>"
  const nextMatch = lower.match(/^next\s+(.+)/);
  if (nextMatch) {
    return `Next ${capitalize(nextMatch[1])}`;
  }

  // "in N days/weeks" → "In N days/weeks"
  const inMatch = lower.match(/^in\s+\d+\s+\w+/);
  if (inMatch) {
    return capitalize(lower);
  }

  // Bare weekday name → capitalised
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  if (weekdays.includes(lower)) {
    return capitalize(lower);
  }

  // Fallback: format as "Mon, Aug 15"
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function capitalize(s: string): string {
  return s
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse the first natural-language date expression found in `text`.
 *
 * Returns `null` when no date expression is recognised.
 *
 * @param text   – the input text (e.g. "buy milk tomorrow")
 * @param refDate – optional reference date (defaults to now, midnight)
 */
export function parseNLPDate(text: string, refDate?: Date): NLPDateResult | null {
  const ref = new Date(refDate ?? new Date());
  ref.setHours(12, 0, 0, 0); // Noon avoids timezone edge-cases

  const results = chronoForward.parse(text, ref, { forwardDate: true });

  // Filter out time-only results (e.g. "at 3pm") that don't specify a date
  const dateResults = results.filter(r =>
    r.start.isCertain('day') || r.start.isCertain('month') || r.start.isCertain('weekday')
  );
  if (dateResults.length === 0) return null;

  const best = dateResults[0];
  const parsed = best.start.date();

  return {
    date: formatDate(parsed),
    label: friendlyLabel(best.text, parsed),
    matchedText: best.text,
    index: best.index,
  };
}

/**
 * Attempt to parse a standalone date string (e.g. typed into the DatePicker).
 * Returns the ISO date string or `null`.
 */
export function parseNLPDateString(input: string, refDate?: Date): { date: string; label: string } | null {
  const result = parseNLPDate(input, refDate);
  if (!result) return null;
  return { date: result.date, label: result.label };
}

/**
 * Find all date expressions in `text`. Useful for token highlighting.
 *
 * Each result includes the start index and length so callers can map back
 * to the original string for highlighting purposes.
 */
export function findAllNLPDates(text: string, refDate?: Date): NLPDateResult[] {
  const ref = new Date(refDate ?? new Date());
  ref.setHours(12, 0, 0, 0);

  const results = chronoForward.parse(text, ref, { forwardDate: true });

  // Filter out time-only results (e.g. "at 3pm") that don't specify a date
  const dateResults = results.filter(r =>
    r.start.isCertain('day') || r.start.isCertain('month') || r.start.isCertain('weekday')
  );

  return dateResults.map(r => ({
    date: formatDate(r.start.date()),
    label: friendlyLabel(r.text, r.start.date()),
    matchedText: r.text,
    index: r.index,
  }));
}
