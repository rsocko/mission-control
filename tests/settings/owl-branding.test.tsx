import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { AddConnectorModal } from '@/app/settings/components/AddConnectorModal';
import {
  CONNECTOR_ICONS,
  CONNECTOR_TYPES,
  getConnectorDisplayName,
} from '@/app/settings/components/types';
import { getConnectorNameUpdate } from '@/lib/connectors/display-name';
import { SOURCES } from '@/app/kanban/components/constants';
import { CONNECTOR_LABELS } from '@/lib/constants/colors';

function renderMotionElement(
  tag: 'button' | 'div',
  props: React.PropsWithChildren<Record<string, unknown>>,
) {
  const {
    animate,
    children,
    exit,
    initial,
    transition,
    variants,
    whileHover,
    whileTap,
    ...domProps
  } = props;
  void animate;
  void exit;
  void initial;
  void transition;
  void variants;
  void whileHover;
  void whileTap;
  return React.createElement(tag, domProps, children);
}

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  motion: {
    button: (props: React.PropsWithChildren<Record<string, unknown>>) => renderMotionElement('button', props),
    div: (props: React.PropsWithChildren<Record<string, unknown>>) => renderMotionElement('div', props),
  },
}));

describe('OWL connector branding', () => {
  it('keeps the compatibility ID while presenting OWL and Paperless-ngx metadata', () => {
    expect(CONNECTOR_TYPES).toContainEqual({
      type: 'document-intelligence',
      name: 'OWL',
      description: 'Paperless-ngx connector and document agent for Mission Control',
    });
    expect(CONNECTOR_ICONS['document-intelligence']).toBe('/icons/agents/owl.svg');
    expect(CONNECTOR_LABELS['document-intelligence']).toBe('OWL');
    expect(SOURCES).toContainEqual({
      id: 'document-intelligence',
      name: 'OWL',
      icon: '/icons/agents/owl.svg',
    });
    expect(getConnectorDisplayName({
      type: 'document-intelligence',
      name: 'Document Intelligence',
    })).toBe('OWL');
    expect(getConnectorDisplayName({
      type: 'document-intelligence',
      name: 'Family archive',
    })).toBe('Family archive');
    expect(getConnectorNameUpdate({
      type: 'document-intelligence',
      name: 'Document Intelligence',
    }, 'OWL', false)).toBe('Document Intelligence');
    expect(getConnectorNameUpdate({
      type: 'document-intelligence',
      name: 'Document Intelligence',
    }, 'Family archive', true)).toBe('Family archive');
  });

  it('explains OWL ownership boundaries during setup', () => {
    render(<AddConnectorModal onClose={() => undefined} onAdded={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: /OWL Paperless-ngx connector/i }));

    expect(screen.getByRole('heading', { name: 'Connect OWL' })).toBeInTheDocument();
    expect(screen.getByText('OWL is the Paperless-ngx connector and document agent for Mission Control.')).toBeInTheDocument();
    expect(screen.getByText(/Paperless-ngx remains the system of record for documents/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add OWL' })).toBeInTheDocument();
  });
});
