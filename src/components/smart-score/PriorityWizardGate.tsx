'use client';

import React, { useState, useEffect } from 'react';
import { AnimatePresence } from 'motion/react';
import { PrioritySetupWizard } from '@/components/smart-score';
import { uiLogger } from '@/lib/client-logger';

/**
 * Shows priority setup after a connector exists, unless the user has already
 * completed or dismissed it in this installation.
 */
export function PriorityWizardGate() {
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => {
    const dismissed = localStorage.getItem('mc_priority_wizard_dismissed');
    if (dismissed === 'true') return;

    const controller = new AbortController();

    Promise.all([
      fetch('/api/connectors', { signal: controller.signal }),
      fetch('/api/priority-entities', { signal: controller.signal }),
      fetch('/api/smart-score/settings', { signal: controller.signal }),
    ])
      .then(async ([connectorsResponse, entitiesResponse, settingsResponse]) => {
        if (!connectorsResponse.ok || !entitiesResponse.ok || !settingsResponse.ok) {
          throw new Error('Failed to load priority setup state');
        }

        const [connectorsData, entitiesData, settingsData] = await Promise.all([
          connectorsResponse.json(),
          entitiesResponse.json(),
          settingsResponse.json(),
        ]);
        const hasConnector = Array.isArray(connectorsData.connectors)
          && connectorsData.connectors.some(
            (connector: { deletedAt?: string | null }) => !connector.deletedAt,
          );
        const hasEntities = Array.isArray(entitiesData.entities)
          && entitiesData.entities.length > 0;
        const hasFinishedSetup = settingsData.settings?.priority_wizard_completed === 'true'
          || settingsData.settings?.priority_wizard_dismissed === 'true';

        if (hasConnector && !hasEntities && !hasFinishedSetup) {
          setShowWizard(true);
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        uiLogger.error('Failed to check priority setup state', { err });
      });

    return () => controller.abort();
  }, []);

  const handleClose = () => {
    setShowWizard(false);
    localStorage.setItem('mc_priority_wizard_dismissed', 'true');
    fetch('/api/smart-score/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'priority_wizard_dismissed', value: 'true' }),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch((err) => {
      uiLogger.warn('Failed to persist priority setup dismissal', { err });
    });
  };

  return (
    <AnimatePresence>
      {showWizard && (
        <PrioritySetupWizard onComplete={handleClose} onDismiss={handleClose} />
      )}
    </AnimatePresence>
  );
}
