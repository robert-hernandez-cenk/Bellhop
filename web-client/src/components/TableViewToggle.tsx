import type { TableView } from '../lib/table-view';
import { IconTable, IconCard } from './icons';

const OPTIONS: { value: TableView; label: string; icon: typeof IconTable }[] = [
  { value: 'table', label: 'Table view', icon: IconTable },
  { value: 'card', label: 'Card view', icon: IconCard },
];

export function TableViewToggle({
  view,
  onChange,
}: {
  view: TableView;
  onChange: (view: TableView) => void;
}) {
  return (
    <div className="view-toggle">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`view-toggle-option${view === opt.value ? ' active' : ''}`}
          onClick={() => onChange(opt.value)}
          aria-label={opt.label}
          title={opt.label}
        >
          <opt.icon />
        </button>
      ))}
    </div>
  );
}
