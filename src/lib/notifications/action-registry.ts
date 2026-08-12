/**
 * Notification Action Plugin Registry
 * 
 * Allows connectors and plugins to register custom notification action types
 * that extend the built-in set (open_url, create_task, run_workflow, etc.)
 */

export interface PluginActionDefinition {
  type: string;
  label: string;
  icon: string;
  variant: 'primary' | 'secondary' | 'ghost' | 'danger';
  opensExternal?: boolean;
  requiresConfirmation?: boolean;
  handler: 'client' | 'server' | 'connector' | 'workflow';
  /** For server/connector handlers, the endpoint to call */
  endpoint?: string;
  /** For workflow handlers, the workflow/webhook ID to trigger */
  workflowId?: string;
  /** JSON schema for validating payload */
  payloadSchema?: Record<string, unknown>;
  /** Connector type(s) this action applies to */
  connectorTypes?: string[];
  /** Categories this action applies to */
  categories?: string[];
}

// ─── REGISTRY ───────────────────────────────────────────────────────────────

const actionRegistry = new Map<string, PluginActionDefinition>();

export function registerAction(definition: PluginActionDefinition): void {
  actionRegistry.set(definition.type, definition);
}

export function getActionDefinition(type: string): PluginActionDefinition | undefined {
  return actionRegistry.get(type);
}

export function getActionsForConnector(connectorType: string): PluginActionDefinition[] {
  return Array.from(actionRegistry.values()).filter(
    def => !def.connectorTypes || def.connectorTypes.includes(connectorType)
  );
}

export function getActionsForCategory(category: string): PluginActionDefinition[] {
  return Array.from(actionRegistry.values()).filter(
    def => !def.categories || def.categories.includes(category)
  );
}

export function getAllRegisteredActions(): PluginActionDefinition[] {
  return Array.from(actionRegistry.values());
}

// ─── BUILT-IN CUSTOM ACTIONS ────────────────────────────────────────────────

// Home Assistant actions
registerAction({
  type: 'ha_toggle_device',
  label: 'Toggle Device',
  icon: 'power',
  variant: 'primary',
  handler: 'connector',
  connectorTypes: ['home-assistant'],
  categories: ['home'],
});

registerAction({
  type: 'ha_close_door',
  label: 'Close Door',
  icon: 'door-closed',
  variant: 'danger',
  requiresConfirmation: true,
  handler: 'connector',
  connectorTypes: ['home-assistant'],
  categories: ['home'],
});

// Finance actions
registerAction({
  type: 'mark_reviewed',
  label: 'Mark Reviewed',
  icon: 'check',
  variant: 'secondary',
  handler: 'server',
  categories: ['finance'],
});

// RyMessage actions
registerAction({
  type: 'reply_message',
  label: 'Reply',
  icon: 'message-circle',
  variant: 'primary',
  handler: 'connector',
  connectorTypes: ['rymessage'],
  categories: ['social'],
});

// n8n workflow actions
registerAction({
  type: 'trigger_n8n',
  label: 'Run Automation',
  icon: 'zap',
  variant: 'secondary',
  handler: 'workflow',
  connectorTypes: ['n8n'],
});
