import { EyeOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface ProjectActionsCardProps {
  syncManaged: boolean;
  onHide: () => void;
  onDelete: () => void;
}

export function ProjectActionsCard({
  syncManaged,
  onHide,
  onDelete,
}: ProjectActionsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Project actions</CardTitle>
        <CardDescription>Manage project visibility and permanent deletion.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Hide this project</p>
            <p className="text-xs text-[var(--text-tertiary)]">
              Remove it from project navigation and portfolio views. You can unhide it from All Projects.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onHide}
          >
            <EyeOff aria-hidden="true" />
            Hide project
          </Button>
        </div>

        {!syncManaged && (
          <div className="flex flex-col items-start justify-between gap-4 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-center">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">Delete this project</p>
              <p className="text-xs text-[var(--text-tertiary)]">
                Permanently remove this project and all its phase assignments. Tasks themselves will not be deleted.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 border-[var(--danger)]/30 text-[var(--danger)] hover:bg-[var(--danger)]/10"
              onClick={onDelete}
            >
              <Trash2 aria-hidden="true" />
              Delete project
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
