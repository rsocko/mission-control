import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActionHelpersSection } from '@/app/doc-intelligence/ActionHelpersSection';

describe('ActionHelpersSection', () => {
  it('renders concise safe actions and account context without raw extracted data', () => {
    render(<ActionHelpersSection metadata={{
      recommendedCta: {
        id: 'pay',
        label: 'Pay invoice',
        url: 'https://billing.example/pay',
      },
      extractedData: {
        account_number: 'ACCT-123',
        reference_number: 'REF-456',
        payment_url: 'javascript:alert(1)',
        phone: '555-0100',
        email: 'billing@example.com',
        links: [{ url: 'data:text/html,unsafe', label: 'Unsafe' }],
      },
    }} />);

    expect(screen.getByRole('heading', { name: 'Take action' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pay invoice' })).toHaveAttribute(
      'href',
      'https://billing.example/pay',
    );
    expect(screen.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:5550100');
    expect(screen.getByRole('link', { name: 'Email' })).toHaveAttribute(
      'href',
      'mailto:billing@example.com',
    );
    expect(screen.getByText('ACCT-123')).toBeInTheDocument();
    expect(screen.getByText('REF-456')).toBeInTheDocument();
    expect(screen.queryByText('Unsafe')).not.toBeInTheDocument();
    expect(document.querySelector('[href^="javascript:"]')).toBeNull();
    expect(document.querySelector('[href^="data:"]')).toBeNull();
  });

  it('renders nothing when older actions have no helper data', () => {
    const { container } = render(<ActionHelpersSection metadata={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
