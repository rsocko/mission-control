export type TagRecommendationSurface = 'quick-add' | 'ai-insights';
export type TagRecommendationAction = 'shown' | 'applied' | 'dismissed';

export interface TagRecommendationFeedback {
  surface: TagRecommendationSurface;
  action: TagRecommendationAction;
  taskId: string;
  suggestedTagIds: string[];
  acceptedTagIds: string[];
  removedTagIds: string[];
}

export function recordTagRecommendationFeedback(
  feedback: TagRecommendationFeedback,
): void {
  recordTagRecommendationFeedbackBatch([feedback]);
}

export function recordTagRecommendationFeedbackBatch(
  feedback: TagRecommendationFeedback[],
): void {
  if (feedback.length === 0) return;
  void fetch('/api/tag-suggestions/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(feedback),
    keepalive: true,
  }).catch((error) => {
    console.warn('Failed to record tag recommendation feedback', error);
  });
}
