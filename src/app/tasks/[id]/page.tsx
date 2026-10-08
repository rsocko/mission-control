import { redirect } from 'next/navigation';

export default async function TaskDeepLinkPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/all-tasks?taskId=${encodeURIComponent(id)}`);
}
