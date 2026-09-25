/**
 * GlobalFloatingNav — 全画面共通の浮遊 top bar (UI v2 §1)。
 * wordmark / Overview / Explore / Calendar / Agent / Dashboard / 対応 chain icons /
 * Settings (gear) / Wallet。1100–1439px では Agent と Dashboard を More に畳む。
 */
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { SUPPORTED_CHAINS } from "@workspace/lib/config/chains";
import { IconChevronDown, IconGear } from "../ui/icons";
import { ChainIcon } from "../ui/ChainIcon";
import { WalletControl } from "./WalletControl";

const PRIMARY = [
  { to: "/", label: "Overview", end: true },
  { to: "/explore", label: "Explore" },
  { to: "/calendar", label: "Calendar" },
] as const;
const SECONDARY = [
  { to: "/agent", label: "Agent" },
  { to: "/dashboard", label: "Dashboard" },
] as const;

const linkClass = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? " is-active" : ""}`;

export function GlobalFloatingNav() {
  const { pathname } = useLocation();
  const secondaryActive = SECONDARY.some((s) => pathname.startsWith(s.to));
  return (
    <header className="global-nav" data-water-quiet="nav">
      <Link to="/" className="wordmark" aria-label="Seasonals — Overview">
        Seasonals
      </Link>
      <nav aria-label="Primary" className="nav-links">
        {PRIMARY.map((l) => (
          <NavLink key={l.to} to={l.to} end={"end" in l ? l.end : false} className={linkClass}>
            {l.label}
          </NavLink>
        ))}
        {SECONDARY.map((l) => (
          <NavLink key={l.to} to={l.to} className={(s) => `${linkClass(s)} nav-link--wide`}>
            {l.label}
          </NavLink>
        ))}
        <MoreMenu active={secondaryActive} />
      </nav>
      <div className="nav-right">
        <ul className="chain-icons" aria-label="Supported chains">
          {SUPPORTED_CHAINS.map((c) => (
            <li key={c.id} className="chain-icon tip" data-tip={c.name} aria-label={c.name} tabIndex={0}>
              <ChainIcon chain={c.id} size={18} />
            </li>
          ))}
        </ul>
        <NavLink to="/settings" className={({ isActive }) => `icon-button tip${isActive ? " is-active" : ""}`} aria-label="Settings" data-tip="Settings">
          <IconGear size={20} />
        </NavLink>
        <WalletControl />
      </div>
    </header>
  );
}

function MoreMenu({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="nav-more" ref={ref}>
      <button
        type="button"
        className={`nav-link${active ? " is-active" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        More <IconChevronDown size={14} />
      </button>
      {open && (
        <div className="popover nav-more-menu">
          {SECONDARY.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => `menu-item${isActive ? " is-active" : ""}`}>
              {l.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
