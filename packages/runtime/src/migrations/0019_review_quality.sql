-- Review v4 quality numbers computed in code. `reviewer_prompt` and `verifier_prompt` are the first 12 hex characters of
-- the sha256 of the reviewer and verifier agent files read at prepare (null: unreadable). `line_valid` and `anchored`
-- are decided at submit: the finding's line exists in the job worktree's file, and lies within 3 lines of a changed
-- line of the job's diff (null: no line, or the worktree or diff was unreadable). `ceiling` is the caller's quota
-- reading at prepare (`ok`: a reading, `unknown`: none, `unjudged`: no account given) with the two windows in percent;
-- it is recorded, never a reason to hold a job. Expand-only: nullable columns, nothing outside the review module reads
-- them.
alter table {{schema}}.review_jobs add column reviewer_prompt text;
alter table {{schema}}.review_jobs add column verifier_prompt text;
alter table {{schema}}.review_findings add column line_valid boolean;
alter table {{schema}}.review_findings add column anchored boolean;
alter table {{schema}}.review_jobs add column ceiling text;
alter table {{schema}}.review_jobs add column quota_five_hour double precision;
alter table {{schema}}.review_jobs add column quota_seven_day double precision;
