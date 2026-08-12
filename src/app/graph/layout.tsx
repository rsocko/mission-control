import { GraphRouteShell } from '@/components/graph/GraphRouteShell';

export default function GraphLayout({ children }: { children: React.ReactNode }) {
  return <GraphRouteShell>{children}</GraphRouteShell>;
}
