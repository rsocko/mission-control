'use client';

import { AnimatePresence } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import {
  IntakeExecuteStep,
  IntakeInputStep,
  IntakePreviewStep,
  useDocumentIntake,
} from './document-intake';
import type { Step } from './document-intake';

// ─── Props ──────────────────────────────────────────────────────────────────

export interface DocumentIntakeWizardProps {
  isOpen: boolean;
  onClose: () => void;
}

const STEP_ORDER: Step[] = ['input', 'preview', 'executing', 'done'];

const STEP_LABELS: Record<Step, string> = {
  input: '1. Input',
  preview: '2. Preview',
  executing: '3. Executing',
  done: '4. Done',
};

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Modal wizard that turns an audit/findings document into a project, phases,
 * and GitHub-linked tasks.
 *
 * This component is now a thin orchestrator: `useDocumentIntake` owns the
 * workflow's state machine and API orchestration, and each step's UI lives
 * in its own component under `./document-intake` so it can be rendered and
 * tested independently (see issue #1228).
 */
export function DocumentIntakeWizard({ isOpen, onClose }: DocumentIntakeWizardProps) {
  const intake = useDocumentIntake({ isOpen, onClose });
  const { step } = intake;

  return (
    <Modal isOpen={isOpen} onClose={intake.close} size="2xl" title="Import Project from Document" closeOnBackdropClick={step === 'input'}>
      <div className="overflow-y-auto px-5 pb-5 max-h-[75vh]">
        {/* Step Indicator */}
        <div className="flex items-center gap-2 mb-6 text-sm">
          {STEP_ORDER.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <ArrowRight className="w-3 h-3 text-[var(--text-muted)]" />}
              <span className={`px-2 py-0.5 rounded ${step === s ? 'bg-[var(--accent-500)]/20 text-[var(--accent-400)]' : 'text-[var(--text-muted)]'}`}>
                {STEP_LABELS[s]}
              </span>
            </div>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {step === 'input' && (
            <IntakeInputStep
              key="input"
              document={intake.document}
              documentUrl={intake.documentUrl}
              onDocumentChange={intake.setDocument}
              onDocumentUrlChange={intake.setDocumentUrl}
              inputMode={intake.inputMode}
              onInputModeChange={intake.setInputMode}
              repo={intake.repo}
              onRepoChange={intake.setRepo}
              connectedRepos={intake.connectedRepos}
              projectMode={intake.projectMode}
              onProjectModeChange={intake.setProjectMode}
              projectName={intake.projectName}
              onProjectNameChange={intake.setProjectName}
              existingProjects={intake.existingProjects}
              selectedProjectId={intake.selectedProjectId}
              onSelectedProjectIdChange={intake.setSelectedProjectId}
              category={intake.category}
              onCategoryChange={intake.setCategory}
              existingCategories={intake.existingCategories}
              loading={intake.loading}
              error={intake.error}
              onAnalyze={intake.analyze}
            />
          )}

          {intake.preview && step !== 'done' && (
            <div key="preview" className={step === 'preview' ? '' : 'hidden'} aria-hidden={step !== 'preview'}>
              <IntakePreviewStep
                preview={intake.preview}
                document={intake.document}
                documentUrl={intake.documentUrl}
                reprocessing={intake.reprocessing}
                onReprocess={intake.reprocess}
                selectedFindingIds={intake.selectedFindingIds}
                onToggleFinding={intake.toggleFinding}
                editableTags={intake.editableTags}
                onEditableTagsChange={intake.setEditableTags}
                error={intake.error}
                repo={intake.repo}
                projectMode={intake.projectMode}
                selectedProjectId={intake.selectedProjectId}
                onBack={intake.backToInput}
                onExecute={intake.execute}
              />
            </div>
          )}

          {step === 'executing' && (
            <IntakeExecuteStep
              key="executing"
              phase="executing"
              result={null}
              onReset={intake.reset}
              onClose={intake.close}
            />
          )}

          {step === 'done' && intake.result && (
            <IntakeExecuteStep
              key="done"
              phase="done"
              result={intake.result}
              onReset={intake.reset}
              onClose={intake.close}
            />
          )}
        </AnimatePresence>
      </div>
    </Modal>
  );
}
