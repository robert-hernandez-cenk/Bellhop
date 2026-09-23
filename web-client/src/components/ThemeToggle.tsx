import { useTheme, type ThemeChoice } from '../lib/theme';
import { IconSun, IconMoon, IconSystem } from './icons';

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof IconSun }[] = [
  { value: 'light', label: 'Light theme', icon: IconSun },
  { value: 'dark', label: 'Dark theme', icon: IconMoon },
  { value: 'system', label: 'System theme', icon: IconSystem },
];

export function ThemeToggle() {
  const { choice, setChoice } = useTheme();

  return (
    <div className="theme-toggle">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`theme-toggle-option${choice === opt.value ? ' active' : ''}`}
          onClick={() => setChoice(opt.value)}
          aria-label={opt.label}
          title={opt.label}
        >
          <opt.icon />
        </button>
      ))}
    </div>
  );
}
