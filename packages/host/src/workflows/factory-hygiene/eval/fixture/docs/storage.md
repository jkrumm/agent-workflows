# Storage

Jobs are persisted by the `SqliteStore` in `src/sqlite-store.js`, which keeps one row per job in a local database file.

The store exposes `insert`, `update`, `remove` and `all`.
