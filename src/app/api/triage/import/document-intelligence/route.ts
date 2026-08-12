import { NextResponse } from 'next/server';
import {
  importDocumentIntelligenceActions,
  importAllDocumentIntelligenceActions,
  resolveDocIntelligenceSettings,
} from '@/lib/triage/importers/document-intelligence-importer';
import logger from '@/lib/logger';

export async function POST(request: Request) {
  try {
    const settings = resolveDocIntelligenceSettings();
    if (!settings.baseUrl) {
      return NextResponse.json(
        { error: 'OWL URL is not configured — set DOC_INTELLIGENCE_URL or configure the OWL connector.' },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({})) as {
      mode?: 'single' | 'full' | 'incremental';
    };

    const mode = body.mode || 'full';

    if (mode === 'full' || mode === 'incremental') {
      const result = await importAllDocumentIntelligenceActions({
        ...settings,
        incremental: mode === 'incremental',
      });
      return NextResponse.json({ result, mode });
    }

    const summary = await importDocumentIntelligenceActions(settings);
    return NextResponse.json({ summary });
  } catch (error) {
    logger.error({ err: error }, 'Failed to import OWL document actions');
    return NextResponse.json(
      { error: 'Failed to import OWL document actions' },
      { status: 500 },
    );
  }
}
