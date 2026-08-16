/** Small metric tile used by {@link IntakePreviewStep}'s summary row. */
export interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  isText?: boolean;
  subtitle?: string;
}

export function SummaryCard({ icon, label, value, isText, subtitle }: SummaryCardProps) {
  return (
    <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-[var(--text-muted)]">{label}</span>
      </div>
      <p className={`${isText ? 'text-sm' : 'text-2xl font-bold'} text-[var(--text-primary)] truncate`}>
        {value}
      </p>
      {subtitle && <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{subtitle}</p>}
    </div>
  );
}
