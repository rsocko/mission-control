import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useIdeationStore } from '@/lib/stores/ideationStore';

export function IdeationConvertDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const nodes = useIdeationStore((state) => state.nodes);
  const flushWorkspace = useIdeationStore((state) => state.flushWorkspace);
  const root = nodes.find((node) => node.parentId === null);
  const [name, setName] = useState(root?.label ?? 'New Project');
  const [color, setColor] = useState('#6366f1');
  const [converting, setConverting] = useState(false);

  const phaseCount = nodes.filter((node) => node.kind === 'phase').length;
  const taskCount = nodes.filter((node) => node.kind === 'task').length;

  const convert = async () => {
    setConverting(true);
    try {
      if (flushWorkspace && !await flushWorkspace()) {
        throw new Error('Resolve the workspace save issue before converting.');
      }
      const workspace = useIdeationStore.getState();
      const response = await fetch('/api/ideation/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          color,
          nodes,
          sourceWorkspace: workspace.workspaceId && workspace.workspaceRevision
            ? { id: workspace.workspaceId, revision: workspace.workspaceRevision }
            : undefined,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Conversion failed');
      toast.success('Project created from ideation');
      router.push(`/projects/${result.projectId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Conversion failed');
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-4" role="presentation" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="convert-title"
        className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-5 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400"><Rocket size={18} /></span>
          <div>
            <h2 id="convert-title" className="font-semibold text-[var(--text-primary)]">Convert to project</h2>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              Creates {phaseCount} phase{phaseCount === 1 ? '' : 's'} and {taskCount} task{taskCount === 1 ? '' : 's'} in one transaction.
            </p>
          </div>
        </div>
        <div className="mt-5 space-y-4">
          <label className="block space-y-1">
            <span className="text-xs text-[var(--text-secondary)]">Project name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)]" />
          </label>
          <label className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2">
            <span className="text-xs text-[var(--text-secondary)]">Project color</span>
            <input type="color" value={color} onChange={(event) => setColor(event.target.value)} className="h-7 w-10 bg-transparent" />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={convert} disabled={!name.trim() || converting}>
            {converting ? <LoaderCircle className="animate-spin" /> : <Rocket />}
            Create project
          </Button>
        </div>
      </div>
    </div>
  );
}
