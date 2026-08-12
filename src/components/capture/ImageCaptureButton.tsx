'use client';

import { useEffect, useMemo, useRef } from 'react';
import { Camera, ImagePlus, X } from 'lucide-react';

interface ImageCaptureButtonProps {
  file: File | null;
  disabled?: boolean;
  error?: string | null;
  onSelect: (file: File) => void;
  onRemove: () => void;
}

export function ImageCaptureButton({
  file,
  disabled,
  error,
  onSelect,
  onRemove,
}: ImageCaptureButtonProps) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const pickerInput = useRef<HTMLInputElement>(null);
  const previewUrl = useMemo(() => file ? URL.createObjectURL(file) : null, [file]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFile = (selected: File | undefined) => {
    if (selected) onSelect(selected);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => cameraInput.current?.click()}
          className="sm:hidden min-h-11 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-3 text-xs font-medium text-[var(--text-secondary)] disabled:opacity-50 flex items-center gap-2"
          aria-label="Take a photo"
        >
          <Camera size={16} />
          Camera
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => pickerInput.current?.click()}
          className="min-h-11 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-3 text-xs font-medium text-[var(--text-secondary)] disabled:opacity-50 flex items-center gap-2"
          aria-label="Choose an image"
        >
          <ImagePlus size={16} />
          <span className="sm:hidden">Photo library</span>
          <span className="hidden sm:inline">Choose image</span>
        </button>
      </div>

      <input
        ref={cameraInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        capture="environment"
        className="sr-only"
        onChange={(event) => handleFile(event.target.files?.[0])}
        tabIndex={-1}
      />
      <input
        ref={pickerInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        className="sr-only"
        onChange={(event) => handleFile(event.target.files?.[0])}
        tabIndex={-1}
      />

      {file && previewUrl && (
        <div className="relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt={`Preview of ${file.name}`}
            className="max-h-64 w-full object-contain"
          />
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full bg-black/70 text-white disabled:opacity-50"
            aria-label="Remove selected image"
          >
            <X size={18} />
          </button>
          <div className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--text-tertiary)]">
            {file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}
