import { NextResponse } from 'next/server';
import { getRules, setRules, resetRules, DEFAULT_RULES } from '@/lib/triage/suggestion-engine';
import type { TriageRule } from '@/lib/triage/suggestion-engine';

export async function GET() {
  return NextResponse.json({
    rules: getRules(),
    defaultRuleCount: DEFAULT_RULES.length,
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (body.reset === true) {
      resetRules();
      return NextResponse.json({ rules: getRules(), message: 'Rules reset to defaults' });
    }

    if (!Array.isArray(body.rules)) {
      return NextResponse.json(
        { error: 'Request body must contain a "rules" array or { reset: true }' },
        { status: 400 },
      );
    }

    // Basic validation
    for (const rule of body.rules as TriageRule[]) {
      if (!rule.id || !rule.name || typeof rule.priority !== 'number' || !rule.match || !Array.isArray(rule.suggest)) {
        return NextResponse.json(
          { error: `Invalid rule: each rule must have id, name, priority (number), match (object), and suggest (array). Problem rule: ${rule.id || 'unknown'}` },
          { status: 400 },
        );
      }
    }

    setRules(body.rules);
    return NextResponse.json({ rules: getRules(), message: `${body.rules.length} rules applied` });
  } catch (err) {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    );
  }
}
