-- Review v4's ledger (host `src/review/`): every job `agw review prepare` hands to a reviewer agent and every finding
-- `agw review submit` keeps. Threads and rounds, convergence (prior findings and their dispositions), the deep cap per
-- account and day, and `agw review covered` (which commits sit under a submitted review at their required tier) all
-- read it. No LLM writes here: prepare and submit are code. Expand-only; nothing outside the review module reads it.
create table {{schema}}.review_jobs (
  -- `rv_` + 20 random base32 characters.
  id text primary key,
  -- The repo identity: origin normalized to host/owner/name, else the realpath of the main worktree's toplevel.
  repo text not null,
  -- The caller's toplevel at prepare (a linked worktree's own path).
  root text not null,
  thread text not null,
  round int not null,
  -- What was asked: { scope } | { pr } | { branch }, plus thread and context.
  scope jsonb not null,
  -- The thread's base; `diff_base` is where this round's diff starts (round >= 2: the last reviewed head).
  base text not null,
  diff_base text not null,
  -- The commit reviewed (a snapshot commit for uncommitted changes) and its tree.
  head text not null,
  head_tree text not null,
  tier text not null,
  seat jsonb,
  rule text not null,
  decided_by text not null,
  -- The full route decision, facts included.
  route jsonb not null,
  account text,
  intent text not null default '',
  -- The REVIEW.md frontmatter read at `base`.
  review_config jsonb not null,
  -- The stat paths of diff_base..head: the reviewer's reply must echo exactly these.
  files jsonb not null,
  job_dir text not null,
  -- The reviewer's checkout: `<job_dir>/tree`, or a review clone for pr/branch scopes.
  worktree text not null,
  state text not null default 'prepared' check (state in ('prepared', 'submitted', 'abandoned')),
  attempt int,
  -- REVIEW_OUTPUT v4, as submit returned it.
  output jsonb,
  created_at timestamptz not null default now(),
  submitted_at timestamptz
);

create index review_jobs_thread on {{schema}}.review_jobs (repo, thread, round);
create index review_jobs_account on {{schema}}.review_jobs (account, tier, created_at);
create index review_jobs_state on {{schema}}.review_jobs (repo, state, created_at);

create table {{schema}}.review_findings (
  -- Stable across rounds: `<thread>-<n>`.
  id text primary key,
  repo text not null,
  thread text not null,
  -- The job that first reported it, and the latest round's job that reported it (a stillOpen re-report included).
  job_id text not null references {{schema}}.review_jobs (id),
  last_job_id text not null references {{schema}}.review_jobs (id),
  round int not null,
  tag text not null check (tag in ('important', 'nit', 'pre-existing')),
  class text not null check (class in ('intent', 'domain', 'duplication', 'architecture', 'bug', 'security')),
  file text not null,
  line int,
  existing text,
  message text not null,
  failure_scenario text not null default '',
  fix text,
  other_instances jsonb not null default '[]',
  votes text,
  disposition text not null default 'open'
    check (disposition in ('open', 'fixed', 'wrong', 'intentional', 'irrelevant')),
  reason text,
  disposed_at timestamptz,
  created_at timestamptz not null default now()
);

create index review_findings_file on {{schema}}.review_findings (repo, file);
create index review_findings_thread on {{schema}}.review_findings (thread);
