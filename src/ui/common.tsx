import { useEffect, useRef, useState, type ReactNode } from 'react';

type Variant = 'default' | 'primary' | 'danger' | 'ghost' | 'good';

interface ActionButtonProps {
  onClick: () => void;
  /** When set, the button is disabled and this explains why (tooltip, and inline if showReason). */
  disabledReason?: string | null;
  variant?: Variant;
  small?: boolean;
  showReason?: boolean;
  title?: string;
  children: ReactNode;
  className?: string;
}

export function ActionButton({
  onClick,
  disabledReason,
  variant = 'default',
  small,
  showReason,
  title,
  children,
  className,
}: ActionButtonProps) {
  const disabled = !!disabledReason;
  const btn = (
    <button
      type="button"
      className={`btn btn-${variant}${small ? ' btn-sm' : ''}${className ? ' ' + className : ''}`}
      disabled={disabled}
      title={disabledReason ?? title}
      onClick={onClick}
    >
      {children}
    </button>
  );
  if (showReason && disabled) {
    return (
      <span className="btn-with-reason">
        {btn}
        <span className="reason">{disabledReason}</span>
      </span>
    );
  }
  return btn;
}

export function Bar({
  value,
  max = 1,
  color,
  height = 6,
  label,
}: {
  value: number;
  max?: number;
  color?: string;
  height?: number;
  label?: string;
}) {
  const f = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div className="bar" style={{ height }} title={label} role="meter" aria-valuenow={value} aria-valuemax={max}>
      <div className="bar-fill" style={{ width: `${f * 100}%`, background: color }} />
    </div>
  );
}

export function Section({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h3>{title}</h3>
        {right && <div className="section-right">{right}</div>}
      </header>
      {children}
    </section>
  );
}

export function KV({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: 'good' | 'bad' | 'warn' | 'muted' }) {
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className={`kv-v num${tone ? ' tone-' + tone : ''}`}>{v}</span>
    </div>
  );
}

export function Pill({ tone, children }: { tone: 'good' | 'bad' | 'warn' | 'info' | 'muted' | 'accent'; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Swatch({ hex, size = 10 }: { hex: string; size?: number }) {
  return <span className="swatch" style={{ background: hex, width: size, height: size }} />;
}

/**
 * Text/number input that keeps a local draft while focused and commits on blur or Enter.
 * Escape reverts. External value changes are shown whenever the field is not being edited.
 */
export function CommitInput({
  value,
  onCommit,
  type = 'text',
  className,
  ariaLabel,
  maxLength,
  min,
  step,
}: {
  value: string;
  onCommit: (v: string) => void;
  type?: 'text' | 'number';
  className?: string;
  ariaLabel?: string;
  maxLength?: number;
  min?: number;
  step?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const skipCommit = useRef(false);
  return (
    <input
      className={`input${className ? ' ' + className : ''}`}
      type={type}
      aria-label={ariaLabel}
      maxLength={maxLength}
      min={min}
      step={step}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          skipCommit.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
      onBlur={() => {
        const d = draft;
        setDraft(null);
        if (skipCommit.current) {
          skipCommit.current = false;
          return;
        }
        if (d !== null && d !== value) onCommit(d);
      }}
    />
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first =
      ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>('button');
    first?.focus();
    return () => prev?.focus?.();
  }, []);
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          {onClose && (
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          )}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} data-autofocus>
            {confirmLabel}
          </button>
        </>
      }
    >
      {message}
    </Modal>
  );
}
