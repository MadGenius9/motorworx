export interface UiToast {
  id: number;
  text: string;
  ok: boolean;
}

/** Shows the controller's toast plus UI-raised messages (deduplicated by text). */
export function Toasts({ controllerToast, local }: { controllerToast: UiToast | null; local: UiToast[] }) {
  const list: (UiToast & { key: string })[] = [];
  for (const t of local) list.push({ ...t, key: `l${t.id}` });
  if (controllerToast && !local.some((t) => t.text === controllerToast.text)) {
    list.push({ ...controllerToast, key: `c${controllerToast.id}` });
  }
  if (list.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.key} className={`toast ${t.ok ? 'toast-ok' : 'toast-bad'}`}>
          {t.ok ? '✓ ' : '⚠ '}
          {t.text}
        </div>
      ))}
    </div>
  );
}
