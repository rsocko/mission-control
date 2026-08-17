'use client';

import { Modal } from '@/components/ui/Modal';

interface TodayScheduleModalProps {
  taskId: string | null;
  scheduleTime: string;
  scheduleDuration: number;
  onClose: () => void;
  onSetScheduleTime: (value: string) => void;
  onSetScheduleDuration: (value: number) => void;
  onSchedule: (taskId: string) => void;
}

export function TodayScheduleModal({
  taskId,
  scheduleTime,
  scheduleDuration,
  onClose,
  onSetScheduleTime,
  onSetScheduleDuration,
  onSchedule,
}: TodayScheduleModalProps) {
  return (
    <Modal
      isOpen={taskId !== null}
      onClose={onClose}
      ariaLabel="Time Block"
      size="sm"
      className="w-80 rounded-xl p-5"
      overlayClassName="items-center pt-0"
    >
        <h3 id="schedule-modal-title" className="font-semibold text-[var(--text-primary)] mb-4">Time Block</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Time</label>
            <input type="time" value={scheduleTime} onChange={(e) => onSetScheduleTime(e.target.value)} className="w-full border border-[var(--border)] rounded-md px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Duration</label>
            <div className="flex gap-2">
              {[15, 30, 45, 60, 90, 120].map((duration) => (
                <button
                  key={duration}
                  onClick={() => onSetScheduleDuration(duration)}
                  className={`px-2 py-1 text-xs rounded border ${scheduleDuration === duration ? 'bg-purple-100 border-purple-300 text-purple-300' : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-0)]'}`}
                >
                  {duration}m
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <button
              onClick={() => {
                if (taskId) onSchedule(taskId);
              }}
              className="flex-1 px-3 py-2 bg-purple-600 text-white text-sm rounded-md hover:bg-purple-700 font-medium"
            >
              Block Time
            </button>
            <button onClick={onClose} className="px-3 py-2 border border-[var(--border)] text-[var(--text-secondary)] text-sm rounded-md hover:bg-[var(--surface-0)]">Cancel</button>
          </div>
        </div>
    </Modal>
  );
}
