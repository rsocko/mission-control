import type { Metadata } from 'next';
import { TaskWindow } from './TaskWindow';

export const metadata: Metadata = {
  title: 'Task | Mission Control',
};

export default async function TaskWindowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TaskWindow taskId={id} />;
}
