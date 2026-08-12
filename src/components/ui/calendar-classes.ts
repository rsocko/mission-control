/**
 * Shared react-day-picker v9 classNames for consistent calendar styling
 * across the DatePicker popover and the context-menu date dialog.
 */
export const calendarClassNames = {
  root: 'mc-rdp relative p-3',
  months: 'flex flex-col',
  month_caption: 'flex h-7 items-center mb-2 pr-16',
  caption_label: 'text-sm font-semibold text-[var(--text-primary)]',
  nav: 'absolute right-3 top-3 flex h-7 items-center gap-1',
  button_previous:
    'inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40',
  button_next:
    'inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40',
  chevron: 'size-4 fill-current',
  weekdays: 'flex',
  weekday:
    'text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider w-8 text-center',
  weeks: 'flex flex-col',
  week: 'flex',
  day: 'h-8 w-8 text-center text-xs',
  day_button:
    'h-8 w-8 rounded-md text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors inline-flex items-center justify-center cursor-pointer',
  today:
    '[&>button]:ring-1 [&>button]:ring-[var(--text-muted)] [&>button]:text-[var(--text-primary)]',
  selected:
    '[&>button]:bg-[var(--accent-600)] [&>button]:text-white [&>button]:hover:bg-[var(--accent-500)] [&>button]:font-semibold [&>button]:ring-0',
  outside: 'opacity-40',
  disabled: 'opacity-25 cursor-not-allowed',
} as const;
