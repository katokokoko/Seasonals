/**
 * WorkspaceShell — work screen の 2 段 header の 2 段目 (LocalFloatingToolbar) +
 * content 領域 (UI v2 §8)。content 全体を 1 つの quiet zone として登録する。
 */
import type { ReactNode } from "react";

export function WorkspaceShell({
  title,
  subtitle,
  toolbar,
  children,
  aside,
}: {
  title: string;
  subtitle?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="workspace" data-water-quiet="work">
      <div className="local-toolbar">
        <div className="local-toolbar-title">
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        {toolbar && <div className="local-toolbar-controls">{toolbar}</div>}
      </div>
      <div className={`workspace-body${aside ? " has-aside" : ""}`}>
        <section className="workspace-content">
          {children}
        </section>
        {aside && (
          <aside className="workspace-aside">
            {aside}
          </aside>
        )}
      </div>
    </div>
  );
}

/** 未接続 / 準備中を明示する notice (完成済みに見せない、UI v2 §11) */
export function Notice({ tone = "info", title, children }: { tone?: "info" | "warning"; title: string; children?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role="note">
      <strong>{title}</strong>
      {children && <div className="notice-body">{children}</div>}
    </div>
  );
}
