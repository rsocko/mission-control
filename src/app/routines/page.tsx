'use client';

import { Suspense, type ReactNode, useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BarChart3, Calendar, CalendarCheck, ChevronLeft, ChevronRight, Loader2, Plus, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import { useSearchParams } from 'next/navigation';
import { AddRoutineForm, BehaviorHeatmap, CadenceInsightsView, FlexibleRoutineCard, OverCompletionLog, WeeklyGrid, type HeatmapCompletion, type Routine } from '@/components/routines';
import ResetView from '@/components/reset/ResetView';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { fadeSlideUp, staggerContainer } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { getLocalToday as getClientToday } from '@/lib/utils/client-date';
import { formatDateLocal, formatWeekRange, getWeekDates, getWeekMonday } from '@/lib/utils/date-format';

type ViewTab = 'routines' | 'reset' | 'insights';
type ConfirmState = { open: boolean; title: string; message: string; confirmLabel: string; variant: 'danger' | 'warning'; onConfirm: () => void };

export default function RoutinesPage() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--text-tertiary)]" /></div>}>
      <RoutinesPageContent />
    </Suspense>
  );
}

function RoutinesPageContent() {
  const searchParams = useSearchParams();
  const [routinesList, setRoutinesList] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ViewTab>('routines');
  const [weekMonday, setWeekMonday] = useState(() => getWeekMonday(getClientToday()));
  const [heatmapData, setHeatmapData] = useState<HeatmapCompletion[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmState>({ open: false, title: '', message: '', confirmLabel: '', variant: 'danger', onConfirm: () => {} });
  const [highlightedRoutineId, setHighlightedRoutineId] = useState<string | null>(searchParams.get('highlight'));
  const today = getClientToday();
  const weekDates = getWeekDates(weekMonday);

  // Scroll to and highlight the targeted routine, then clear after animation
  useEffect(() => {
    if (!highlightedRoutineId || loading) return;
    const el = document.querySelector(`[data-routine-id="${highlightedRoutineId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-blue-500/50', 'rounded-lg', 'transition-all');
      const timer = setTimeout(() => {
        el.classList.remove('ring-2', 'ring-blue-500/50');
        setHighlightedRoutineId(null);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [highlightedRoutineId, loading]);

  const fetchRoutines = useCallback(async () => {
    try {
      const params = new URLSearchParams({ date: today });
      if (weekMonday !== getWeekMonday(today)) params.set('weekOf', weekMonday);
      const response = await fetch(`/api/routines?${params}`);
      if (!response.ok) throw new Error('Failed to fetch');
      const data = await response.json();
      setRoutinesList(data.routines);
    } catch {
      toast.error('Failed to load routines');
    } finally {
      setLoading(false);
    }
  }, [today, weekMonday]);

  const fetchHeatmap = useCallback(async () => {
    const startDate = new Date(`${today}T12:00:00`);
    startDate.setDate(startDate.getDate() - 27 * 7);
    try {
      const response = await fetch(`/api/routines/completions?startDate=${formatDateLocal(startDate)}&endDate=${today}`);
      if (!response.ok) throw new Error('Failed to fetch');
      const data = await response.json();
      setHeatmapData(data.completions.map((completion: HeatmapCompletion) => ({ routineId: completion.routineId, date: completion.date })));
    } catch {}
  }, [today]);

  useEffect(() => { fetchRoutines(); }, [fetchRoutines]);
  useEffect(() => { if (activeTab === 'insights') fetchHeatmap(); }, [activeTab, fetchHeatmap]);

  const toggleCompletion = async (routineId: string, date: string, isCompleted: boolean) => {
    try {
      if (isCompleted) await fetch(`/api/routines/completions?routineId=${routineId}&date=${date}`, { method: 'DELETE' });
      else {
        const response = await fetch('/api/routines/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ routineId, date }) });
        if (response.status === 409) return void toast('Already completed!');
      }
      fetchRoutines();
    } catch {
      toast.error('Failed to toggle completion');
    }
  };

  const deleteRoutine = (id: string) => {
    const routine = routinesList.find((item) => item.id === id);
    setConfirmDialog({
      open: true,
      title: 'Archive routine?',
      message: `This will archive "${routine?.name || 'this routine'}". It will no longer appear in your routine tracking.`,
      confirmLabel: 'Archive',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog((dialog) => ({ ...dialog, open: false }));
        try {
          await fetch(`/api/routines/${id}`, { method: 'DELETE' });
          toast.success('Routine archived');
          fetchRoutines();
        } catch {
          toast.error('Failed to archive routine');
        }
      },
    });
  };

  const navigateWeek = (direction: -1 | 1) => {
    const nextWeek = new Date(`${weekMonday}T12:00:00`);
    nextWeek.setDate(nextWeek.getDate() + direction * 7);
    setWeekMonday(formatDateLocal(nextWeek));
  };

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--text-tertiary)]" /></div>;

  const dailyRoutines = routinesList.filter((routine) => routine.cadenceType === 'daily');
  const specificDaysRoutines = routinesList.filter((routine) => routine.cadenceType === 'specific_days');
  const flexibleRoutines = routinesList.filter((routine) => ['x_per_week', 'every_n_days', 'weekly', 'monthly', 'quarterly'].includes(routine.cadenceType));
  const tabs: Array<{ key: ViewTab; label: string; icon: ReactNode }> = [
    { key: 'routines', label: 'Weekly View', icon: <Calendar size={14} className="mr-1.5 inline" /> },
    { key: 'reset', label: 'Reset', icon: <CalendarCheck size={14} className="mr-1.5 inline" /> },
    { key: 'insights', label: 'Insights', icon: <BarChart3 size={14} className="mr-1.5 inline" /> },
  ];
  const weeklyGroups = [
    { title: 'Daily Routines', routines: dailyRoutines },
    { title: 'Specific Days', routines: specificDaysRoutines },
  ].filter((group) => group.routines.length > 0);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-semibold text-[var(--text-primary)]"><Repeat size={20} className="text-[var(--accent-400)]" />Routines & Habits</h2>
            <p className="mt-1 text-sm text-[var(--text-tertiary)]">Track patterns at your own pace. Missing a day is normal — data helps you adjust, not judge.</p>
          </div>
          <div className="flex gap-1 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-1 self-start overflow-x-auto">
            {tabs.map((tab) => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={cn('rounded-[var(--radius-md)] px-3 py-1.5 text-sm font-medium transition-colors duration-[var(--transition-fast)]', activeTab === tab.key ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]')}>
                {tab.icon}{tab.label}
              </button>
            ))}
          </div>
        </div>

        {activeTab === 'routines' && (
          <div className="flex items-center justify-center gap-3">
            <button onClick={() => navigateWeek(-1)} className="rounded-[var(--radius-md)] p-2 text-[var(--text-secondary)] transition-colors duration-[var(--transition-fast)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"><ChevronLeft size={16} /></button>
            <span className="min-w-[14rem] text-center text-sm font-medium tabular-nums text-[var(--text-primary)]">{formatWeekRange(weekMonday)}</span>
            <button onClick={() => navigateWeek(1)} className="rounded-[var(--radius-md)] p-2 text-[var(--text-secondary)] transition-colors duration-[var(--transition-fast)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"><ChevronRight size={16} /></button>
          </div>
        )}

        <AnimatePresence mode="wait">
          {activeTab === 'routines' && (
            <motion.div key="routines" variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
              {weeklyGroups.map((group) => (
                <motion.div key={group.title} variants={fadeSlideUp}>
                  <WeeklyGrid title={group.title} routines={group.routines} weekDates={weekDates} today={today} onToggle={toggleCompletion} onDelete={deleteRoutine} />
                </motion.div>
              ))}
              {flexibleRoutines.length > 0 && (
                <motion.div variants={fadeSlideUp}>
                  <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)]">
                    <div className="border-b border-[var(--border)] px-5 py-3"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">Flexible / Target-Based</p></div>
                    <div className="space-y-3 p-4">{flexibleRoutines.map((routine) => <FlexibleRoutineCard key={routine.id} routine={routine} today={today} weekDates={weekDates} onToggle={toggleCompletion} onDelete={deleteRoutine} />)}</div>
                  </div>
                </motion.div>
              )}
              {routinesList.length === 0 && <motion.div variants={fadeSlideUp} className="py-16 text-center"><Repeat size={40} className="mx-auto mb-4 text-[var(--text-muted)]" /><p className="text-sm text-[var(--text-secondary)]">No routines yet. Add your first one below.</p></motion.div>}
              <motion.div variants={fadeSlideUp}>
                {!showAddForm ? <Button variant="outline" onClick={() => setShowAddForm(true)} className="w-full border-dashed"><Plus size={16} /> Add Routine</Button> : <AddRoutineForm onClose={() => setShowAddForm(false)} onCreated={() => { setShowAddForm(false); fetchRoutines(); }} />}
              </motion.div>
            </motion.div>
          )}
          {activeTab === 'reset' && <motion.div key="reset" variants={staggerContainer} initial="hidden" animate="show" className="space-y-6"><ResetView /></motion.div>}
          {activeTab === 'insights' && <motion.div key="insights" variants={staggerContainer} initial="hidden" animate="show" className="space-y-6"><CadenceInsightsView routines={routinesList} /><BehaviorHeatmap routines={routinesList} completions={heatmapData} today={today} /><OverCompletionLog routines={routinesList} completions={heatmapData} /></motion.div>}
        </AnimatePresence>
      </div>

      <ConfirmDialog open={confirmDialog.open} title={confirmDialog.title} message={confirmDialog.message} confirmLabel={confirmDialog.confirmLabel} confirmVariant={confirmDialog.variant} onConfirm={confirmDialog.onConfirm} onCancel={() => setConfirmDialog((dialog) => ({ ...dialog, open: false }))} />
    </div>
  );
}
