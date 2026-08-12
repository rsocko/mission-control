'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, Loader2, Check, ChevronDown, ChevronUp, Wand2, ArrowRight, Sparkles } from 'lucide-react';
import dynamic from 'next/dynamic';
import type { EmojiClickData } from 'emoji-picker-react';

const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false });

interface AffectedList {
  id: string;
  sourceId: string;
  name: string;
  emoji: string;
  codepoint: string;
  taskCount: number | null;
  connectorInstanceId: string;
}

interface HealthData {
  healthy: boolean;
  graphApiEmojiIssue: {
    affected: boolean;
    affectedLists: AffectedList[];
    totalLists: number;
    graphVisibleLists: number;
    substrateOnlyLists: number;
    description: string;
  };
}

type FixStrategy = 'replace-emoji' | 'strip-emoji' | 'migrate';

interface FixResult {
  success: boolean;
  strategy: FixStrategy;
  originalName: string;
  newName: string;
  message: string;
  errors?: string[];
}

interface MigrateProgress {
  phase: string;
  message: string;
  current?: number;
  total?: number;
  percent?: number;
  currentTask?: string;
  moved?: number;
  failed?: number;
}

const SAFE_BMP_EMOJI_OPTIONS = [
  '✅', '⚡', '☀️', '⭐', '❤️', '♻️', '☑️', '⚙️', '✏️', '✂️',
  '☎️', '⌚', '⚠️', '♨️', '☘️', '♦️', '♠️', '♣️', '♥️', '✉️', '✒️', '⌂',
] as const;

// Suggested BMP replacements for common SMP emoji categories
const SUGGESTED_REPLACEMENTS: Record<string, string> = {
  '📘': '☐', '📕': '☐', '📗': '☐', '📙': '☐', '📚': '☐', '📖': '☐',  // books → checkbox
  '🛠️': '⚙️', '🔧': '⚙️', '⛏️': '⚙️',  // tools → gear
  '🧹': '✦', '🧽': '✦',  // cleaning → star
  '🔥': '☀️', '💡': '☀️',  // fire/light → sun
  '🏠': '⌂', '🏡': '⌂', '🛏️': '⌂', '🚿': '⌂',  // house/rooms → house symbol
  '🚘': '⚡', '🚗': '⚡', '🚙': '⚡',  // car → lightning
  '🛒': '☑️', '🛍': '☑️', '👚': '☑️',  // shopping → checkbox
  '💰': '♦️', '💲': '♦️', '💵': '♦️', '💳': '♦️',  // money → diamond
  '📱': '☎️', '💻': '☎️', '🖥️': '☎️',  // tech → phone
  '🎮': '♠️', '🕹️': '♠️',  // games → spade
  '🐕': '♥️', '🐶': '♥️', '🐱': '♥️',  // pets → heart
  '👶': '♥️', '👨‍👩‍👧': '♥️',  // family → heart
  '💼': '✏️', '📊': '✏️',  // work → pencil
  '🏋️': '⚡', '🧘': '⚡',  // fitness → lightning
  '💊': '✚',  // health → cross
  '🌱': '☘️', '🌿': '☘️',  // plants → shamrock
  '📺': '⌚', '🎬': '⌚',  // entertainment → watch
  '✈️': '⭐', '🗺️': '⭐',  // travel → star
};

function getSuggestedReplacement(emoji: string): string {
  return SUGGESTED_REPLACEMENTS[emoji] || SAFE_BMP_EMOJI_OPTIONS[0];
}

export function SyncHealthBanner({ onRefresh }: { onRefresh?: () => void }) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [fixingList, setFixingList] = useState<string | null>(null);
  const [fixResults, setFixResults] = useState<Record<string, FixResult>>({});
  const [migrateProgress, setMigrateProgress] = useState<Record<string, MigrateProgress>>({});
  const [confirmFix, setConfirmFix] = useState<{ listId: string; strategy: FixStrategy; name: string } | null>(null);
  const [selectedSafeEmoji, setSelectedSafeEmoji] = useState<string>(SAFE_BMP_EMOJI_OPTIONS[0]);
  const [showFullPicker, setShowFullPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/sync/health');
      if (res.ok) {
        const data = await res.json();
        setHealth(data);
      }
    } catch {
      // Non-critical — don't show banner if check fails
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  const handleFix = async (listId: string, strategy: FixStrategy, newName?: string) => {
    setFixingList(listId);
    setConfirmFix(null);

    if (strategy !== 'migrate') {
      // Simple JSON response for in-place rename strategies
      try {
        const res = await fetch(`/api/source-lists/${encodeURIComponent(listId)}/fix-emoji`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strategy: 'strip-emoji', newName }),
        });
        const result = await res.json();
        const normalizedResult: FixResult = res.ok
          ? { ...result, strategy }
          : {
              success: false,
              strategy,
              originalName: '',
              newName: '',
              message: result.error || result.message || 'Fix failed',
            };
        setFixResults(prev => ({ ...prev, [listId]: normalizedResult }));
        if (normalizedResult.success) {
          setTimeout(() => { fetchHealth(); onRefresh?.(); }, 1000);
        }
      } catch (err) {
        setFixResults(prev => ({
          ...prev,
          [listId]: { success: false, strategy, originalName: '', newName: '', message: `Fix failed: ${err instanceof Error ? err.message : String(err)}` },
        }));
      } finally {
        setFixingList(null);
      }
    } else {
      // SSE stream for migrate
      try {
        const res = await fetch(`/api/source-lists/${encodeURIComponent(listId)}/fix-emoji`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strategy }),
        });

        if (!res.body) throw new Error('No response body');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          let eventType = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ') && eventType) {
              try {
                const data = JSON.parse(line.slice(6));
                if (eventType === 'phase' || eventType === 'progress') {
                  setMigrateProgress(prev => ({ ...prev, [listId]: { phase: eventType === 'progress' ? 'moving' : data.phase, ...data } }));
                } else if (eventType === 'complete') {
                  setFixResults(prev => ({ ...prev, [listId]: { success: data.success, strategy: 'migrate', originalName: data.originalName, newName: data.newName, message: data.message } }));
                  setMigrateProgress(prev => { const next = { ...prev }; delete next[listId]; return next; });
                  if (data.success) {
                    setTimeout(() => { fetchHealth(); onRefresh?.(); }, 1000);
                  }
                } else if (eventType === 'error') {
                  setFixResults(prev => ({ ...prev, [listId]: { success: false, strategy: 'migrate', originalName: '', newName: '', message: data.message } }));
                  setMigrateProgress(prev => { const next = { ...prev }; delete next[listId]; return next; });
                }
              } catch { /* skip malformed JSON */ }
              eventType = '';
            }
          }
        }
      } catch (err) {
        setFixResults(prev => ({
          ...prev,
          [listId]: { success: false, strategy: 'migrate', originalName: '', newName: '', message: `Migrate failed: ${err instanceof Error ? err.message : String(err)}` },
        }));
        setMigrateProgress(prev => { const next = { ...prev }; delete next[listId]; return next; });
      } finally {
        setFixingList(null);
      }
    }
  };

  if (loading || !health || !health.graphApiEmojiIssue.affected) return null;

  const { graphApiEmojiIssue } = health;
  const unfixedLists = graphApiEmojiIssue.affectedLists.filter(l => !fixResults[l.id]?.success);

  if (unfixedLists.length === 0 && Object.keys(fixResults).length > 0) {
    // All fixed — show success state briefly
    return (
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        className="mb-4 p-4 rounded-xl border border-emerald-500/30 bg-emerald-900/10"
      >
        <div className="flex items-center gap-2 text-emerald-400">
          <Check size={16} />
          <span className="text-sm font-medium">All affected lists have been fixed!</span>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-4 rounded-xl border border-amber-500/30 bg-amber-900/10 overflow-hidden"
    >
      {/* Banner header */}
      <div
        className="px-4 py-3 flex items-start gap-3 cursor-pointer hover:bg-amber-900/5 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <AlertTriangle size={18} className="text-amber-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-amber-300">
              Microsoft Graph API Compatibility Issue
            </h3>
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-800/40 text-amber-300 font-mono">
              {graphApiEmojiIssue.substrateOnlyLists} list{graphApiEmojiIssue.substrateOnlyLists !== 1 ? 's' : ''}
            </span>
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
            {unfixedLists.length} list{unfixedLists.length !== 1 ? 's have' : ' has'} names starting with SMP emoji that are invisible to the official Microsoft Graph API.
            {' '}These sync via an <span className="text-amber-400/80">unofficial fallback API</span> which may break without notice.
          </p>
        </div>
        <button className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] mt-0.5">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {/* Expanded detail */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-1 border-t border-amber-500/10">
              {/* Explanation */}
              <div className="mb-3 p-3 rounded-lg bg-[var(--surface-1)] border border-[var(--border)] text-xs text-[var(--text-tertiary)] leading-relaxed">
                <strong className="text-[var(--text-secondary)]">Known bug:</strong> The Microsoft Graph API <code className="px-1 py-0.5 bg-[var(--surface-2)] rounded text-xs">/me/todo/lists</code> endpoint
                silently excludes lists whose names start with supplementary-plane emoji (U+10000+). BMP emoji like ✅ and ⚡ stay visible, but surrogate-pair emoji like 💯 and 📘 disappear from enumeration. This strongly points to a UTF-16 surrogate-pair bug in Microsoft&apos;s backend — the lists work fine individually but don&apos;t appear in the listing.
                <br /><br />
                <strong className="text-[var(--text-secondary)]">Current workaround:</strong> Mission Control uses an unofficial Substrate API to discover these lists. This works but relies on an undocumented endpoint.
                <br /><br />
                <strong className="text-[var(--text-secondary)]">Recommended fixes:</strong>
                <ul className="mt-1 ml-4 space-y-0.5 list-disc">
                  <li><strong>Replace with safe emoji</strong> — Swaps the leading emoji for a BMP-safe symbol. Best option: list stays in place, keeps all tasks, and still has an icon.</li>
                  <li><strong>Remove emoji</strong> — Strips the leading emoji entirely. Quick and safe, but removes the visual icon.</li>
                  <li><strong>Migrate to new list</strong> — Creates a new list, moves all tasks, deletes the old one. Most disruptive; keep as a last resort.</li>
                </ul>
              </div>

              {/* Affected lists */}
              <div className="space-y-2">
                {graphApiEmojiIssue.affectedLists.map(list => {
                  const result = fixResults[list.id];
                  const isFixing = fixingList === list.id;

                  if (result?.success) {
                    return (
                      <div key={list.id} className="flex items-center gap-2 p-2 rounded-lg bg-emerald-900/10 border border-emerald-500/20">
                        <Check size={14} className="text-emerald-400" />
                        <span className="text-xs text-emerald-300">
                          {result.originalName} → {result.newName}
                        </span>
                      </div>
                    );
                  }

                  return (
                    <div key={list.id} className="flex flex-col gap-2 p-2.5 rounded-lg bg-[var(--surface-1)] border border-[var(--border)] group">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-[var(--text-primary)] truncate">{list.name}</span>
                            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--surface-2)] text-[var(--text-muted)] font-mono">
                              {list.codepoint}
                            </span>
                          </div>
                          <div className="text-xs text-[var(--text-muted)] mt-0.5">
                            {list.taskCount != null ? `${list.taskCount} task${list.taskCount !== 1 ? 's' : ''}` : 'Tasks unknown'} • Synced via Substrate fallback
                          </div>
                          {result && !result.success && (
                            <div className="text-xs text-red-400 mt-1">{result.message}</div>
                          )}
                        </div>

                        {isFixing ? (
                          <Loader2 size={14} className="animate-spin text-blue-400" />
                        ) : (
                          <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex-wrap justify-end">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedSafeEmoji(getSuggestedReplacement(list.emoji));
                                setShowFullPicker(false);
                                setConfirmFix({ listId: list.id, strategy: 'replace-emoji', name: list.name });
                              }}
                              className="px-2.5 py-1.5 text-xs rounded-md bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 border border-emerald-500/30 whitespace-nowrap transition-colors"
                              title={`Replace ${list.emoji} with a safe emoji (suggested: ${getSuggestedReplacement(list.emoji)})`}
                            >
                              <span className="flex items-center gap-1"><Sparkles size={11} /> {getSuggestedReplacement(list.emoji)} Replace</span>
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmFix({ listId: list.id, strategy: 'strip-emoji', name: list.name }); }}
                              className="px-2.5 py-1.5 text-xs rounded-md bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 border border-blue-500/30 whitespace-nowrap transition-colors"
                              title="Remove the leading emoji from the list name"
                            >
                              <span className="flex items-center gap-1"><Wand2 size={11} /> Remove emoji</span>
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmFix({ listId: list.id, strategy: 'migrate', name: list.name }); }}
                              className="px-2.5 py-1.5 text-xs rounded-md bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 border border-purple-500/30 whitespace-nowrap transition-colors"
                              title="Create a new list and migrate all tasks"
                            >
                              <span className="flex items-center gap-1"><ArrowRight size={11} /> Migrate</span>
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Migrate progress bar */}
                      {migrateProgress[list.id] && (
                        <div className="px-1">
                          <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
                            <span className="truncate max-w-[200px]">
                              {migrateProgress[list.id].currentTask
                                ? `Moving: ${migrateProgress[list.id].currentTask}`
                                : migrateProgress[list.id].message}
                            </span>
                            {migrateProgress[list.id].total != null && (
                              <span className="font-mono ml-2 shrink-0">
                                {migrateProgress[list.id].current}/{migrateProgress[list.id].total}
                              </span>
                            )}
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-[var(--surface-2)] overflow-hidden">
                            <motion.div
                              className="h-full rounded-full bg-purple-500"
                              initial={{ width: 0 }}
                              animate={{ width: `${migrateProgress[list.id].percent || 0}%` }}
                              transition={{ duration: 0.3, ease: 'easeOut' }}
                            />
                          </div>
                          {migrateProgress[list.id].failed != null && migrateProgress[list.id].failed! > 0 && (
                            <div className="text-xs text-red-400 mt-0.5">
                              {migrateProgress[list.id].failed} failed
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Stats */}
              <div className="mt-3 flex items-center gap-4 text-xs text-[var(--text-muted)]">
                <span>{graphApiEmojiIssue.totalLists} total lists</span>
                <span>{graphApiEmojiIssue.graphVisibleLists} Graph API visible</span>
                <span className="text-amber-400">{graphApiEmojiIssue.substrateOnlyLists} Substrate-only</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Confirmation dialog */}
      <AnimatePresence>
        {confirmFix && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={() => setConfirmFix(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              onClick={e => e.stopPropagation()}
              className="bg-[var(--surface-1)] border border-[var(--border-strong)] rounded-xl p-5 max-w-md w-full mx-4 shadow-xl"
            >
              <h3 className="text-base font-semibold text-[var(--text-primary)] mb-2">
                {confirmFix.strategy === 'replace-emoji'
                  ? 'Replace with Safe Emoji'
                  : confirmFix.strategy === 'strip-emoji'
                    ? 'Remove Emoji Prefix'
                    : 'Migrate to New List'}
              </h3>
              <p className="text-sm text-[var(--text-tertiary)] mb-4 leading-relaxed">
                {confirmFix.strategy === 'replace-emoji' ? (
                  <>
                    This will rename <strong className="text-[var(--text-secondary)]">&ldquo;{confirmFix.name}&rdquo;</strong> to
                    <strong className="text-[var(--text-secondary)]"> &ldquo;{buildSafeEmojiName(confirmFix.name, selectedSafeEmoji)}&rdquo;</strong> in Microsoft To Do.
                    All tasks stay in place, and the list becomes Graph-visible because the new prefix stays within the BMP (single UTF-16 code unit).
                  </>
                ) : confirmFix.strategy === 'strip-emoji' ? (
                  <>
                    This will rename <strong className="text-[var(--text-secondary)]">&ldquo;{confirmFix.name}&rdquo;</strong> to
                    <strong className="text-[var(--text-secondary)]"> &ldquo;{stripEmojiPrefix(confirmFix.name)}&rdquo;</strong> in Microsoft To Do.
                    All tasks stay in place. The list will become visible to the official Graph API.
                  </>
                ) : (
                  <>
                    This will create a new list <strong className="text-[var(--text-secondary)]">&ldquo;{stripEmojiPrefix(confirmFix.name)}&rdquo;</strong>,
                    move all tasks from <strong className="text-[var(--text-secondary)]">&ldquo;{confirmFix.name}&rdquo;</strong> to it,
                    then delete the old list. This is more disruptive but creates a clean list.
                  </>
                )}
              </p>
              {confirmFix.strategy === 'replace-emoji' && (
                <div className="mb-4">
                  <div className="text-xs text-[var(--text-muted)] mb-1">
                    Suggested: <strong className="text-emerald-400">{getSuggestedReplacement(getEmojiFromName(confirmFix.name))}</strong> for {getEmojiFromName(confirmFix.name)}
                  </div>
                  <div className="text-xs text-[var(--text-muted)] mb-2">
                    Pick a safe emoji (BMP range, single UTF-16 code unit):
                  </div>
                  <div className="grid grid-cols-8 gap-1.5">
                    {SAFE_BMP_EMOJI_OPTIONS.map((emoji) => {
                      const selected = emoji === selectedSafeEmoji;
                      return (
                        <button
                          key={emoji}
                          onClick={() => { setSelectedSafeEmoji(emoji); setShowFullPicker(false); }}
                          className={`h-9 rounded-lg border text-lg transition-colors ${
                            selected
                              ? 'border-emerald-400 bg-emerald-500/15 text-emerald-200'
                              : 'border-[var(--border)] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text-primary)]'
                          }`}
                          aria-label={`Use ${emoji}`}
                          title={`Use ${emoji}`}
                        >
                          {emoji}
                        </button>
                      );
                    })}
                    <button
                      onClick={() => setShowFullPicker(!showFullPicker)}
                      className={`h-9 rounded-lg border text-xs transition-colors ${
                        showFullPicker
                          ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                          : 'border-[var(--border)] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text-muted)]'
                      }`}
                      title="Pick any emoji (warning: SMP emoji will also be hidden)"
                    >
                      …
                    </button>
                  </div>
                  {showFullPicker && (
                    <div className="mt-2" ref={pickerRef}>
                      <div className="text-xs text-amber-400 mb-1 flex items-center gap-1">
                        <AlertTriangle size={10} /> SMP emoji (💰📎🔥 etc.) will also be hidden by Graph API
                      </div>
                      <EmojiPicker
                        onEmojiClick={(emojiData: EmojiClickData) => {
                          const cp = emojiData.emoji.codePointAt(0) || 0;
                          setSelectedSafeEmoji(emojiData.emoji);
                          setShowFullPicker(false);
                          if (cp >= 0x10000) {
                            // User picked an unsafe emoji — warn but allow
                          }
                        }}
                        theme={"dark" as import('emoji-picker-react').Theme}
                        height={280}
                        width={320}
                        searchPlaceHolder="Search emoji…"
                        previewConfig={{ showPreview: false }}
                      />
                    </div>
                  )}
                  {selectedSafeEmoji && (selectedSafeEmoji.codePointAt(0) || 0) >= 0x10000 && (
                    <div className="mt-2 text-xs text-amber-400 flex items-center gap-1">
                      <AlertTriangle size={11} /> Warning: {selectedSafeEmoji} is in the SMP range and will also be hidden by Graph API
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirmFix(null)}
                  className="px-3 py-1.5 text-sm rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleFix(
                    confirmFix.listId,
                    confirmFix.strategy,
                    confirmFix.strategy === 'replace-emoji'
                      ? buildSafeEmojiName(confirmFix.name, selectedSafeEmoji)
                      : undefined,
                  )}
                  className={`px-4 py-1.5 text-sm rounded-lg font-medium text-white transition-colors ${
                    confirmFix.strategy === 'replace-emoji'
                      ? 'bg-emerald-600 hover:bg-emerald-500'
                      : confirmFix.strategy === 'strip-emoji'
                        ? 'bg-blue-600 hover:bg-blue-500'
                        : 'bg-purple-600 hover:bg-purple-500'
                  }`}
                >
                  {confirmFix.strategy === 'replace-emoji'
                    ? 'Replace Emoji'
                    : confirmFix.strategy === 'strip-emoji'
                      ? 'Remove Emoji'
                      : 'Migrate Tasks'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function stripEmojiPrefix(name: string): string {
  if (!name) return name;
  const cp = name.codePointAt(0) || 0;
  if (cp > 0x2600) {
    const charLen = cp > 0xFFFF ? 2 : 1;
    return name.substring(charLen).trim();
  }
  return name;
}

function getEmojiFromName(name: string): string {
  if (!name) return '';
  const cp = name.codePointAt(0) || 0;
  if (cp > 0x2600) {
    const charLen = cp > 0xFFFF ? 2 : 1;
    return name.substring(0, charLen);
  }
  return '';
}

function buildSafeEmojiName(name: string, safeEmoji: string): string {
  const stripped = stripEmojiPrefix(name);
  return stripped ? `${safeEmoji} ${stripped}` : safeEmoji;
}