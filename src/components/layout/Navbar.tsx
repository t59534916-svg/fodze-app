"use client";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Logo from "@/components/shared/Logo";

const IconHome = ({ active }: { active: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? "#d4b86a" : "#8a7560"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);

const IconAnalyse = ({ active }: { active: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? "#d4b86a" : "#8a7560"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
  </svg>
);

const IconKombis = ({ active }: { active: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? "#d4b86a" : "#8a7560"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

const IconSimulator = ({ active }: { active: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? "#d4b86a" : "#8a7560"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

const IconStats = ({ active }: { active: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? "#d4b86a" : "#8a7560"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" />
  </svg>
);

const IconValue = ({ active }: { active: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? "#d4b86a" : "#8a7560"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" fill={active ? "#d4b86a" : "#8a7560"} />
  </svg>
);

const tabs = [
  { href: "/", label: "Home", Icon: IconHome },
  { href: "/matchday", label: "Analyse", Icon: IconAnalyse },
  { href: "/goldilocks", label: "Value", Icon: IconValue },
  { href: "/matchday/combos", label: "Kombis", Icon: IconKombis },
  { href: "/simulator", label: "Simulator", Icon: IconSimulator },
  { href: "/performance", label: "Stats", Icon: IconStats },
];

export default function Navbar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <>
      <style>{`
        .nav-bottom {
          position: fixed; bottom: 0; left: 0; right: 0; z-index: 100;
          height: 60px;
          background: linear-gradient(to top, #0d0705 0%, #1a0f0a 100%);
          border-top: 1px solid #c4a26518;
          display: flex; align-items: stretch; justify-content: center;
          max-width: 480px; margin: 0 auto;
        }
        .nav-sidebar { display: none; }
        @media (min-width: 1024px) {
          .nav-bottom { display: none; }
          .nav-sidebar {
            display: flex; flex-direction: column;
            position: fixed; left: 0; top: 0; bottom: 0;
            width: 220px; z-index: 100;
            background: linear-gradient(to right, #0d0705 0%, #1a0f0a 100%);
            border-right: 1px solid #c4a26518;
            padding: 24px 12px;
          }
        }
      `}</style>

      {/* Mobile: Bottom Bar */}
      <nav className="nav-bottom" aria-label="Hauptnavigation">
        {tabs.map(({ href, label, Icon }) => {
          const active = isActive(href);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined} style={{
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
              padding: "6px 0", fontSize: 10, fontWeight: active ? 600 : 500,
              letterSpacing: "0.3px", color: active ? "#d4b86a" : "#8a7560",
              minHeight: 60, // WCAG 2.5.5: full nav height as touch target
              textDecoration: "none", flex: 1, position: "relative", transition: "color 0.2s ease",
            }}>
              {active && (
                <div style={{ position: "absolute", top: 0, left: "20%", right: "20%", height: 2, borderRadius: 1,
                  background: "linear-gradient(90deg, transparent, #d4b86a, transparent)" }} />
              )}
              <Icon active={active} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Desktop: Sidebar */}
      <nav className="nav-sidebar" aria-label="Desktop-Navigation">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 32, padding: "0 8px" }}>
          <Logo size={32} />
          <span style={{
            fontSize: 14, fontWeight: 700, letterSpacing: 2, fontFamily: "Georgia, serif",
            background: "linear-gradient(135deg, #a68940, #e8d5a0, #f5e6b8, #d4b86a)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
          }}>FODZE</span>
        </div>
        {tabs.map(({ href, label, Icon }) => {
          const active = isActive(href);
          return (
            <Link key={href} href={href} style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "10px 12px", marginBottom: 4, borderRadius: 8,
              fontSize: 13, fontWeight: active ? 600 : 400,
              color: active ? "#d4b86a" : "#8a7560",
              background: active ? "#c4a26510" : "transparent",
              textDecoration: "none", transition: "all 0.2s ease",
              borderLeft: active ? "3px solid #d4b86a" : "3px solid transparent",
            }}>
              <Icon active={active} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
