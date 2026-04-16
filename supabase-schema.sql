-- ═══════════════════════════════════════════════════════
-- FODZE v7 – Supabase Schema
-- Einmal im SQL-Editor ausführen
-- ═══════════════════════════════════════════════════════

-- Spieltag-Daten (xG, Kontext, von KI geladen)
CREATE TABLE IF NOT EXISTS matchdays (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  league TEXT NOT NULL,
  matchday_label TEXT,
  match_date DATE,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES auth.users(id)
);

-- Quoten-Snapshots mit Zeitstempel + User-Zuordnung
CREATE TABLE IF NOT EXISTS odds_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  league TEXT NOT NULL,
  match_key TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  odds JSONB NOT NULL,
  snapshot_time TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES auth.users(id)
);

-- User-Profile (Bankroll, Risikoprofil etc.)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'User',
  bankroll NUMERIC DEFAULT 0,
  risk_profile TEXT DEFAULT 'M' CHECK (risk_profile IN ('K', 'M', 'A')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Wett-Tracking (optional: was wurde tatsächlich gespielt?)
CREATE TABLE IF NOT EXISTS bets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  match_key TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  market TEXT NOT NULL,
  odds_placed NUMERIC NOT NULL,
  stake NUMERIC NOT NULL,
  model_prob NUMERIC,
  edge NUMERIC,
  result TEXT CHECK (result IN ('pending', 'won', 'lost', 'void')),
  closing_odds NUMERIC,
  clv NUMERIC,
  placed_at TIMESTAMPTZ DEFAULT now(),
  settled_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id)
);

-- Indizes
CREATE INDEX IF NOT EXISTS idx_odds_match ON odds_snapshots(match_key, snapshot_time);
CREATE INDEX IF NOT EXISTS idx_odds_user ON odds_snapshots(created_by, snapshot_time DESC);
CREATE INDEX IF NOT EXISTS idx_matchdays_league ON matchdays(league, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(created_by, placed_at DESC);

-- Row Level Security
ALTER TABLE matchdays ENABLE ROW LEVEL SECURITY;
ALTER TABLE odds_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE bets ENABLE ROW LEVEL SECURITY;

-- Policies: RLS — non-sensitive tables are readable by all auth users,
-- sensitive user-scoped tables (bets, profiles) are OWNER-ONLY.
-- See scripts/migration-rls-tighten.sql for the migration that fixed the
-- previous "read all" leak on bets + profiles.
CREATE POLICY "Authenticated read all" ON matchdays FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated insert" ON matchdays FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated read all" ON odds_snapshots FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated insert" ON odds_snapshots FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Authenticated delete own" ON odds_snapshots FOR DELETE USING (auth.uid() = created_by);

-- profiles + bets: user reads ONLY their own data (not "read all")
-- The "manage own" policy with FOR ALL covers SELECT/INSERT/UPDATE/DELETE
-- for the owner — no broad read policy needed.
CREATE POLICY "Authenticated manage own" ON profiles FOR ALL USING (auth.uid() = id);

CREATE POLICY "Authenticated manage own" ON bets FOR ALL USING (auth.uid() = created_by);

-- Trigger: Profil automatisch erstellen bei Signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
