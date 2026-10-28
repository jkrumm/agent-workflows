-- The issues the daily friction job filed, so it never scans a repository to find its own again. A row is written as an
-- intent (number null) before `gh issue create` and completed after it: a crash between the two leaves a row without a
-- number, which the next tick resolves by the issue's exact title before it files anything. `closed_at` is when the
-- issue was last seen closed (or, for a deleted one, when it was filed); only runs that finished after it are evidence
-- for a new issue. Holds a workflow id, an issue number and its URL, never run content.
create table {{schema}}.friction_issues (
  id bigserial primary key,
  repo text not null,
  workflow text not null,
  number integer,
  url text,
  filed_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (repo, number)
);

-- At most one unfinished intent per workflow: two ticks (a deploy overlap) cannot both file the same breach. The second
-- insert fails with a unique violation and the job treats it as "someone else is filing".
create unique index friction_issues_one_intent on {{schema}}.friction_issues (repo, workflow) where number is null;

create index friction_issues_workflow on {{schema}}.friction_issues (repo, workflow, filed_at desc);
