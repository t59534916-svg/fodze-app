"use client";
import Corners from "@/components/shared/Corners";
import Navbar from "./Navbar";

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        .app-shell {
          max-width: 480px;
          margin: 0 auto;
          padding: 16px;
          padding-bottom: 80px;
          min-height: 100dvh;
          background: radial-gradient(ellipse at 40% 20%, #2a1810 0%, #1a0f0a 50%, #0d0705 100%);
          position: relative;
          font-family: var(--font-inter), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          color: #ede4d4;
          font-size: 16px;
          line-height: 1.5;
        }
        @media (min-width: 768px) {
          .app-shell {
            max-width: 640px;
            padding: 24px 32px;
            padding-bottom: 32px;
          }
        }
        @media (min-width: 1024px) {
          .app-shell {
            max-width: 720px;
            margin-left: 220px;
            padding: 32px 40px;
          }
        }
        /* Global focus-visible for keyboard users */
        :focus-visible {
          outline: 2px solid #d4b86a;
          outline-offset: 2px;
        }
        button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
          outline: 2px solid #d4b86a;
          outline-offset: 2px;
        }
        /* WCAG 2.3.3: Respect reduced motion preference */
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
          }
        }
        /* Skip navigation link (keyboard users) */
        .skip-nav {
          position: absolute;
          top: -100px;
          left: 16px;
          z-index: 9999;
          padding: 12px 24px;
          background: #d4b86a;
          color: #1a0f0a;
          font-weight: 700;
          border-radius: 6px;
          text-decoration: none;
          font-size: 14px;
        }
        .skip-nav:focus {
          top: 16px;
        }
      `}</style>
      <div className="app-shell">
        <a href="#main-content" className="skip-nav">Zum Inhalt springen</a>
        <Corners />
        <main id="main-content" style={{ position: "relative", zIndex: 3 }}>
          {children}
        </main>
        <Navbar />
      </div>
    </>
  );
}
