-- Watchtower Database Schema
-- Run this in Supabase SQL Editor

-- Games table (one row per game/developer)
CREATE TABLE IF NOT EXISTS games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL DEFAULT 'wt_' || encode(gen_random_bytes(24), 'base64'),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Saves table (player data storage)
CREATE TABLE IF NOT EXISTS saves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(game_id, player_id, key)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_saves_game_player ON saves(game_id, player_id);
CREATE INDEX IF NOT EXISTS idx_games_api_key ON games(api_key);

-- Enable Row Level Security
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE saves ENABLE ROW LEVEL SECURITY;

-- RLS Policies (allow service role full access)
CREATE POLICY "Service role has full access to games" ON games
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to saves" ON saves
  FOR ALL USING (true) WITH CHECK (true);
