-- Review v4's hidden transport: which way a job's reviewer runs. `in-session` is the caller's own Claude Code session
-- (prepare, Agent(reviewer), submit); `hidden` is a factory reviewer session started by `agw review request`, whose
-- account the factory picks and reports on submit. Expand-only: a default for every existing row, nothing reads it but
-- the review module.
alter table {{schema}}.review_jobs add column transport text not null default 'in-session';
