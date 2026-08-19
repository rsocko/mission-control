/**
 * Narrow contracts between the project page shell and its tab owners.
 *
 * Project data, mutations, and task interactions stay in the layer-2 context
 * hooks; these types only cover the few overlays and route-level controllers
 * the shell keeps because more than one tab (or the route query) uses them.
 */

/** Where a shared task overlay should place the resulting task. */
export interface ProjectTaskTarget {
  /** `null` assigns to the project without a phase. */
  phaseId: string | null;
}

/** Shared AddTaskModal / TaskPickerDialog entry points owned by the shell. */
export interface ProjectTaskOverlayActions {
  requestCreateTask: (target: ProjectTaskTarget) => void;
  requestLinkTasks: (target: ProjectTaskTarget) => void;
}

export interface ConfirmationRequest {
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'danger' | 'warning';
  /**
   * Runs when the user confirms. `close` dismisses the shared dialog so each
   * owner keeps control of whether it closes before or after its own work.
   */
  onConfirm: (close: () => void) => void | Promise<void>;
}

export type RequestConfirmation = (request: ConfirmationRequest) => void;

/**
 * Phase proposal controller. The shell owns it because `?action=ai-suggest`
 * opens the review overlay even when the Plan tab is not the active tab.
 */
export interface ProjectProposalActions {
  generate: (guidance?: string) => void;
  refine: (guidance?: string) => void;
  isGenerating: boolean;
  isRefining: boolean;
}
