'use client';

import { useState, useEffect } from 'react';
import { IconPicker } from '@/components/ui/icon-picker/IconPicker';
import { IconPickerButton } from '@/components/ui/icon-picker/IconPickerButton';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';

const DEMO_VALUES = [
  '🚀',
  'lucide:rocket',
  'mdi:home',
  'ph:star',
  'dash:github',
  'si:react',
  'lucide:code',
  'mdi:palette',
  '🎯',
  'lucide:zap',
];

export default function IconPickerDemo() {
  const [selectedIcon, setSelectedIcon] = useState<string | null>(null);
  const [iconColor, setIconColor] = useState<string>('#ffffff');
  const [inlineIcon, setInlineIcon] = useState<string | null>('🚀');
  const [inlineColor, setInlineColor] = useState<string>('#3b82f6');

  // Override AppShell's overflow-hidden on the main element
  useEffect(() => {
    const main = document.getElementById('main-content');
    if (main) {
      main.style.overflow = 'auto';
      return () => { main.style.overflow = ''; };
    }
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white p-8">
      <div className="max-w-4xl mx-auto space-y-10">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold mb-2">🎨 Icon Picker Component</h1>
          <p className="text-gray-400 text-sm">
            Universal icon picker supporting Emoji, Lucide, Material Design, Phosphor, Dashboard Icons, and Simple Icons.
          </p>
        </div>

        {/* Section 1: IconPickerButton */}
        <section className="rounded-2xl border border-[#1e1e2e] bg-[#111118] p-6 space-y-4">
          <h2 className="text-xl font-semibold">IconPickerButton</h2>
          <p className="text-gray-400 text-sm">Click the button to open the full icon picker. This is the drop-in component for forms.</p>

          <div className="flex items-center gap-6">
            <div className="space-y-2">
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider">Small</label>
              <IconPickerButton
                value={inlineIcon}
                onChange={setInlineIcon}
                size="sm"
                color={inlineColor}
                onColorChange={setInlineColor}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider">Medium (default)</label>
              <IconPickerButton
                value={inlineIcon}
                onChange={setInlineIcon}
                size="md"
                color={inlineColor}
                onColorChange={setInlineColor}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider">Large</label>
              <IconPickerButton
                value={inlineIcon}
                onChange={setInlineIcon}
                size="lg"
                color={inlineColor}
                onColorChange={setInlineColor}
              />
            </div>

            {inlineIcon && (
              <div className="ml-8 space-y-1">
                <div className="text-xs text-gray-500 uppercase tracking-wider font-medium">Selected Value</div>
                <code className="block text-sm bg-[#1a1a2e] px-3 py-1.5 rounded-lg text-blue-300 font-mono">
                  {inlineIcon}
                </code>
              </div>
            )}
          </div>
        </section>

        {/* Section 2: Full Picker (always visible) */}
        <section className="rounded-2xl border border-[#1e1e2e] bg-[#111118] p-6 space-y-4">
          <h2 className="text-xl font-semibold">Full IconPicker (inline)</h2>
          <p className="text-gray-400 text-sm">The picker rendered inline — try each tab, search, and pick colors.</p>

          <div className="flex gap-6">
            <IconPicker
              value={selectedIcon}
              onChange={(v) => setSelectedIcon(v)}
              color={iconColor}
              onColorChange={setIconColor}
            />

            <div className="flex-1 space-y-4">
              {selectedIcon && (
                <div className="rounded-xl border border-[#1e1e2e] bg-[#0d0d14] p-4 space-y-3">
                  <div className="text-xs text-gray-500 uppercase tracking-wider font-medium">Selected</div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center justify-center w-16 h-16 rounded-xl bg-[#1a1a2e] border border-[#2a2a3e]">
                      <IconRenderer value={selectedIcon} size={36} color={iconColor} />
                    </div>
                    <div className="space-y-1">
                      <code className="block text-sm text-blue-300 font-mono">{selectedIcon}</code>
                      <div className="text-xs text-gray-500">Color: {iconColor}</div>
                    </div>
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-[#1e1e2e] bg-[#0d0d14] p-4 space-y-3">
                <div className="text-xs text-gray-500 uppercase tracking-wider font-medium">Render Sizes</div>
                <div className="flex items-end gap-4">
                  {[16, 20, 24, 32, 40, 48].map((size) => (
                    <div key={size} className="flex flex-col items-center gap-1">
                      <IconRenderer
                        value={selectedIcon || 'lucide:rocket'}
                        size={size}
                        color={iconColor}
                      />
                      <span className="text-[10px] text-gray-600">{size}px</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Section 3: IconRenderer gallery */}
        <section className="rounded-2xl border border-[#1e1e2e] bg-[#111118] p-6 space-y-4">
          <h2 className="text-xl font-semibold">IconRenderer Gallery</h2>
          <p className="text-gray-400 text-sm">How different icon values render. All from a single {"<IconRenderer>"} component.</p>

          <div className="grid grid-cols-5 gap-3">
            {DEMO_VALUES.map((val) => (
              <div
                key={val}
                className="flex flex-col items-center gap-2 p-3 rounded-xl border border-[#1e1e2e] bg-[#0d0d14] hover:border-blue-500/30 transition-colors cursor-pointer"
                onClick={() => setSelectedIcon(val)}
              >
                <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-[#1a1a2e]">
                  <IconRenderer value={val} size={28} color="#94a3b8" />
                </div>
                <code className="text-[10px] text-gray-500 font-mono truncate w-full text-center">
                  {val}
                </code>
              </div>
            ))}
          </div>
        </section>

        {/* Section 4: Real-world example */}
        <section className="rounded-2xl border border-[#1e1e2e] bg-[#111118] p-6 space-y-4">
          <h2 className="text-xl font-semibold">Real-World: Project Card</h2>
          <p className="text-gray-400 text-sm">How it looks in context — a project card with an icon picker.</p>

          <div className="flex gap-4">
            {[
              { name: 'Mission Control', icon: 'lucide:rocket', color: '#3b82f6' },
              { name: 'Design System', icon: 'lucide:palette', color: '#8b5cf6' },
              { name: 'Home Lab', icon: 'dash:home-assistant', color: '#10b981' },
            ].map((project) => (
              <div
                key={project.name}
                className="flex-1 rounded-xl border border-[#1e1e2e] bg-[#0d0d14] p-4 hover:border-blue-500/20 transition-colors"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className="flex items-center justify-center w-10 h-10 rounded-lg"
                    style={{ backgroundColor: `${project.color}20` }}
                  >
                    <IconRenderer value={project.icon} size={22} color={project.color} />
                  </div>
                  <div>
                    <div className="font-medium text-sm">{project.name}</div>
                    <div className="text-xs text-gray-500">3 tasks remaining</div>
                  </div>
                </div>
                <div className="w-full h-1.5 rounded-full bg-[#1a1a2e]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: '60%', backgroundColor: project.color }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
