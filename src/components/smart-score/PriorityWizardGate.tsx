'use client';

import React, { useState, useEffect } from 'react';
import { AnimatePresence } from 'motion/react';
import { PrioritySetupWizard } from '@/components/smart-score';
import { uiLogger } from '@/lib/client-logger';

/**
 * Wrapper that shows the Priority Setup Wizard on first launch
 * when no priority entities have been configured yet.
 */
export function PriorityWizardGate() {
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => {
    // Check if wizard has been completed or dismissed
    const dismissed = localStorage.getItem('mc_priority_wizard_dismissed');
    if (dismissed === 'true') return;

    // Check if any entities exist
    fetch('/api/priority-entities')
      .then((r) => r.json())
      .then((data) => {
        if (!data.entities || data.entities.length === 0) {
          setShowWizard(true);
        }
      })
      .catch((err) => { uiLogger.error('Failed to check priority entities', { err }); });
  }, []);

  const handleClose = () => {
    setShowWizard(false);
    localStorage.setItem('mc_priority_wizard_dismissed', 'true');
  };

  return (
    <AnimatePresence>
      {showWizard && (
        <PrioritySetupWizard onComplete={handleClose} onDismiss={handleClose} />
      )}
    </AnimatePresence>
  );
}
