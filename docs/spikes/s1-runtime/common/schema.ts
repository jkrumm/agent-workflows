// The harness tables in schema `harness` of database spike_s1. See world.ts.
export const HARNESS_SCHEMA = `
create schema if not exists harness;
create table if not exists harness.probe (
  id bigserial primary key, cand text not null, run_id text not null, step text not null,
  ev text not null, pid int not null, version text not null, ts timestamptz not null default clock_timestamp());
create table if not exists harness.sessions (
  id text primary key, cand text not null, run_id text not null, step text not null,
  created_at timestamptz not null default clock_timestamp(), prompted_at timestamptz, duration_ms int not null);
create table if not exists harness.effects (
  key text primary key, cand text not null, run_id text not null, ts timestamptz not null default clock_timestamp());
create table if not exists harness.effect_attempts (
  id bigserial primary key, cand text not null, run_id text not null, key text not null, outcome text not null);
create table if not exists harness.outcomes (
  cand text not null, run_id text not null, version text not null, result jsonb not null,
  ts timestamptz not null default clock_timestamp(), primary key (cand, run_id));
`;
