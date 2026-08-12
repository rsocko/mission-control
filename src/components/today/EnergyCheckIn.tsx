'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Battery, BatteryLow, BatteryMedium, BatteryFull, X } from 'lucide-react';

type EnergyLevel = 'high' | 'medium' | 'low';

interface EnergyCheckInProps {
  onEnergySet: (level: EnergyLevel) => void;
  currentLevel: EnergyLevel | null;
}

const ENERGY_OPTIONS: { level: EnergyLevel; label: string; icon: typeof BatteryFull; color: string; bgColor: string }[] = [
  { level: 'high', label: 'High', icon: BatteryFull, color: 'text-emerald-400', bgColor: 'hover:bg-emerald-900/30 border-emerald-800/40' },
  { level: 'medium', label: 'Medium', icon: BatteryMedium, color: 'text-amber-400', bgColor: 'hover:bg-amber-900/30 border-amber-800/40' },
  { level: 'low', label: 'Low', icon: BatteryLow, color: 'text-red-400', bgColor: 'hover:bg-red-900/30 border-red-800/40' },
];

export function EnergyCheckIn({ onEnergySet, currentLevel }: EnergyCheckInProps) {
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);

  if (dismissed || currentLevel) return null;

  async function handleSelect(level: EnergyLevel) {
    setSaving(true);
    try {
      await fetch('/api/energy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      });
      onEnergySet(level);
    } catch {
      // Still set locally even if save fails
      onEnergySet(level);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.2 }}
        className="mb-4 p-3 bg-[var(--surface-0)] rounded-lg border border-[var(--border)]"
      >
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-[var(--text-secondary)] flex items-center gap-1.5">
            <Battery size={12} className="text-[var(--text-tertiary)]" />
            How&apos;s your energy today?
          </p>
          <button
            onClick={() => setDismissed(true)}
            className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            aria-label="Dismiss energy check-in"
          >
            <X size={12} />
          </button>
        </div>
        <div className="flex gap-2">
          {ENERGY_OPTIONS.map(({ level, label, icon: Icon, color, bgColor }) => (
            <button
              key={level}
              onClick={() => handleSelect(level)}
              disabled={saving}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--surface-1)] ${bgColor} transition-colors disabled:opacity-50`}
            >
              <Icon size={14} className={color} />
              <span className={color}>{label}</span>
            </button>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * Compact energy indicator shown after check-in is complete.
 * Allows changing energy level by clicking.
 */
export function EnergyIndicator({ level, onChange }: { level: EnergyLevel; onChange: (level: EnergyLevel) => void }) {
  const [showPicker, setShowPicker] = useState(false);

  const config = ENERGY_OPTIONS.find(o => o.level === level)!;
  const Icon = config.icon;

  return (
    <div className="relative">
      <button
        onClick={() => setShowPicker(!showPicker)}
        className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-[var(--border)] bg-[var(--surface-0)] hover:bg-[var(--surface-1)] transition-colors ${config.color}`}
        title={`Energy: ${config.label} (click to change)`}
      >
        <Icon size={12} />
        <span className="text-[var(--text-tertiary)]">{config.label}</span>
      </button>
      {showPicker && (
        <div className="absolute top-full mt-1 left-0 z-50 flex gap-1 p-1 bg-[var(--surface-2)] border border-[var(--border)] rounded-md shadow-lg">
          {ENERGY_OPTIONS.map(({ level: l, label, icon: I, color }) => (
            <button
              key={l}
              onClick={() => { onChange(l); setShowPicker(false); }}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${l === level ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-1)]'} ${color}`}
            >
              <I size={12} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
