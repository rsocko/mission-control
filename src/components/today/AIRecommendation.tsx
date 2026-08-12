import { Sparkles } from 'lucide-react';
import { AssistantMarkdown } from '@/components/ai/AssistantMarkdown';

interface AIRecommendationProps {
  recommendation: string;
  onDismiss: () => void;
}

export function AIRecommendation({ recommendation, onDismiss }: AIRecommendationProps) {
  return (
    <div className="mb-6 rounded-lg border border-blue-800/40 bg-blue-900/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0" role="status" aria-live="polite" aria-atomic="true">
          <p className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-blue-400">
            <Sparkles size={11} /> AI Recommendation
          </p>
          <AssistantMarkdown>{recommendation}</AssistantMarkdown>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss AI recommendation"
          className="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded text-xs text-[var(--text-muted)] hover:bg-blue-900/40 hover:text-[var(--text-secondary)]"
        >
          ×
        </button>
      </div>
    </div>
  );
}
