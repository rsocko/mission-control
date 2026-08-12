'use client';

import { Sparkles, Layers, Rocket, Plus } from 'lucide-react';
import Link from 'next/link';

/**
 * Zero-task motivational empty state for the mobile Today screen.
 *
 * Covers:
 * - F-29: Design and implement zero-task motivational state
 * - F-30: Show suggestions: "Add tasks", "Check triage queue", "Ask Houston"
 */
export function MobileTodayEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {/* Motivational illustration */}
      <div className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 flex items-center justify-center mb-5">
        <Sparkles size={28} className="text-emerald-400" />
      </div>

      <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
        All clear!
      </h3>
      <p className="text-sm text-[var(--text-secondary)] mb-8 max-w-[260px] leading-relaxed">
        Your day is wide open. Add some focus tasks, or let Houston pick for you.
      </p>

      {/* Suggestion buttons */}
      <div className="w-full space-y-3 max-w-[280px]">
        <button
          onClick={() => {
            window.dispatchEvent(new CustomEvent('mission-control:open-quick-add'));
          }}
          className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-[var(--accent-500)]/10 border border-[var(--accent-500)]/30 text-[var(--accent-400)] active:bg-[var(--accent-500)]/20 transition-colors min-h-[44px]"
        >
          <Plus size={18} />
          <span className="text-sm font-medium">Add tasks</span>
        </button>

        <Link
          href="/triage"
          className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-orange-500/10 border border-orange-500/30 text-orange-400 active:bg-orange-500/20 transition-colors min-h-[44px]"
        >
          <Layers size={18} />
          <span className="text-sm font-medium">Check triage queue</span>
        </Link>

        <Link
          href="/ai"
          className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-400 active:bg-purple-500/20 transition-colors min-h-[44px]"
        >
          <Rocket size={18} />
          <span className="text-sm font-medium">Ask Houston</span>
        </Link>
      </div>
    </div>
  );
}
