# smoke-review fixture

`scripts/verify.sh` builds a throwaway git repo from this tree: `base/` committed, then `change/` copied over it as an
uncommitted change, and runs `agw review` on that. The change plants two obvious bugs so the review has a finding to
report: an unkeyed list with `dangerouslySetInnerHTML` in the React component (react-doctor scans it, as on a real
frontend diff) and an off-by-one average in the `.ts` file.
