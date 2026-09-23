import { useState } from 'react';

export type TableView = 'table' | 'card';

const STORAGE_KEY = 'dashboardTableView';

function readStoredView(): TableView {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'card' ? 'card' : 'table';
}

export function useTableView(): [TableView, (view: TableView) => void] {
  const [view, setViewState] = useState<TableView>(readStoredView);

  const setView = (next: TableView) => {
    setViewState(next);
    localStorage.setItem(STORAGE_KEY, next);
  };

  return [view, setView];
}
