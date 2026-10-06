"use client";

import { forwardRef, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";

/**
 * The shared control vocabulary. Every page composes these rather than restyling a bare element,
 * so spacing, focus rings, and disabled treatment stay identical across the product.
 */

const focus = "outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2";

/* ------------------------------------------------------------------------- Button */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
};

const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-[#111c38] text-white hover:bg-[#1b2a52]",
  secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  danger: "bg-rose-600 text-white hover:bg-rose-700",
  ghost: "text-slate-600 hover:bg-slate-100",
};

/** `loading` also disables the button, so a double submit is impossible by construction. */
export function Button({ variant = "primary", size = "md", loading = false, icon, children, className = "", disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${size === "sm" ? "px-3 py-2 text-xs" : "px-4 py-2.5 text-sm"} ${variants[variant]} ${focus} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 size={size === "sm" ? 13 : 16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------------- Field */

/**
 * Wraps a control with its label, hint, and error. The error is rendered in an assertive live
 * region so a screen reader announces a validation failure rather than leaving it purely visual.
 */
export function Field({ label, htmlFor, error, hint, required, children }: { label: string; htmlFor: string; error?: string | null; hint?: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-slate-800">
        {label}
        {required && <span className="ml-1 text-rose-600" aria-hidden="true">*</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
      <p role="alert" className={`text-xs font-medium text-rose-600 ${error ? "" : "hidden"}`}>
        {error}
      </p>
    </div>
  );
}

const controlBase = "w-full rounded-lg border bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 disabled:bg-slate-50 disabled:text-slate-500";
const controlState = (invalid?: boolean) => (invalid ? "border-rose-400" : "border-slate-300 hover:border-slate-400");

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ invalid, className = "", ...rest }, ref) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={`${controlBase} ${controlState(invalid)} ${focus} ${className}`} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ invalid, className = "", ...rest }, ref) {
  return <textarea ref={ref} aria-invalid={invalid || undefined} className={`${controlBase} ${controlState(invalid)} ${focus} ${className}`} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select({ invalid, className = "", children, ...rest }, ref) {
  return (
    <select ref={ref} aria-invalid={invalid || undefined} className={`${controlBase} ${controlState(invalid)} ${focus} ${className}`} {...rest}>
      {children}
    </select>
  );
});

/**
 * Password input with a visibility toggle.
 *
 * Toggling only swaps the input `type`; the value is never mirrored into another element, copied to
 * the DOM, or logged. The control is a real button so it is reachable by keyboard, and it is
 * excluded from the tab order of the form's happy path only when explicitly asked.
 */
export function PasswordInput({ invalid, className = "", ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        aria-invalid={invalid || undefined}
        className={`${controlBase} ${controlState(invalid)} ${focus} pr-11 ${className}`}
        {...rest}
      />
      <button
        type="button"
        onClick={() => setVisible(value => !value)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className={`absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-lg text-slate-500 hover:text-slate-800 ${focus}`}
      >
        {visible ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </div>
  );
}

/** Generates the id/label wiring for a field so callers do not have to invent unique ids. */
export function useFieldId(prefix: string) {
  const id = useId();
  return `${prefix}-${id}`;
}

/* ------------------------------------------------------------------------- Layout */

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-slate-200 bg-white ${className}`}>{children}</section>;
}

export function SectionTitle({ title, action, description }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="font-display text-lg font-bold text-slate-900">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Horizontal tabs that navigate, used where a resource has several real sub-views. */
export function Tabs({ items, current }: { items: { href: string; label: string; count?: number }[]; current: string }) {
  return (
    <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-200" aria-label="Sections">
      {items.map(item => {
        const active = item.href === current;
        return (
          <a
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold ${active ? "border-violet-600 text-violet-700" : "border-transparent text-slate-500 hover:text-slate-800"} ${focus}`}
          >
            {item.label}
            {typeof item.count === "number" && <span className="ml-1.5 text-xs text-slate-400">{item.count}</span>}
          </a>
        );
      })}
    </nav>
  );
}
