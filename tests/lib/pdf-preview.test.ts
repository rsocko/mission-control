import { describe, expect, it } from 'vitest';
import { withPdfFitToWidth } from '@/lib/pdf-preview';

describe('withPdfFitToWidth', () => {
  it('adds a fit-to-width PDF viewer parameter', () => {
    expect(withPdfFitToWidth('/report.pdf'))
      .toBe('/report.pdf#zoom=page-width');
  });

  it('preserves other viewer parameters and replaces an existing zoom', () => {
    expect(withPdfFitToWidth('/report.pdf#page=3&zoom=125'))
      .toBe('/report.pdf#page=3&zoom=page-width');
  });
});
