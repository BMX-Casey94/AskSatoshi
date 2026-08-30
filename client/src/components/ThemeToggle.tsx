import { MoonIcon, SunIcon } from './icons';

interface Props {
  theme: 'light' | 'dark';
  onToggle: () => void;
}

export function ThemeToggle({ theme, onToggle }: Props) {
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      onClick={onToggle}
      aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
    >
      {theme === 'light' ? <MoonIcon size={18} /> : <SunIcon size={18} />}
    </button>
  );
}
