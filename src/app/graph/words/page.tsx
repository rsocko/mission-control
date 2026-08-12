import type { Metadata } from 'next';
import WordInsightsLoader from '@/components/word-insights/WordInsightsLoader';

export const metadata: Metadata = {
  title: 'Words | Graph | Mission Control',
  description: 'Explore recurring words and their connected tasks.',
};

export default function WordsGraphPage() {
  return <WordInsightsLoader />;
}
