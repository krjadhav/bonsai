-- Bonsai: single table for captured X timeline posts.
-- Design choices to keep costs flat:
--   * No RLS tables for now — service key only hits this table via the backend.
--   * Only one unique index beyond PK (user_email, post_id) — used for dedup on upsert.
--   * media_types stored as text[] to avoid a join table for a feature we don't ship yet.

create extension if not exists "pgcrypto";

create table if not exists public.bonsai_posts (
  id              uuid primary key default gen_random_uuid(),
  user_email      text not null,
  user_sub        text not null,
  post_id         text not null,
  permalink       text,
  author_name     text,
  author_handle   text,
  content         text,
  tweeted_at      timestamptz,
  has_media       boolean not null default false,
  media_types     text[] not null default '{}',
  decision        text check (decision in ('yes','no')),
  captured_at     timestamptz not null default now(),
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  constraint bonsai_posts_user_post_unique unique (user_email, post_id)
);

comment on table public.bonsai_posts is
  'Bonsai feed filter: one row per X post seen by a signed-in user.';
