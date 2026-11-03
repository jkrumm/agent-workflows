# smoke-review fixture

`scripts/verify.sh` builds a throwaway git repo from this tree: `base/` committed, then `change/` copied over it and
committed, and asks the software factory to review that (`agw review request --scope head`, tier light). The change adds
`average` with one planted defect: it divides by `values.length - 1`, an off-by-one the reviewer can see in the diff.
