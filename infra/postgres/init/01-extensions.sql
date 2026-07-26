-- Extensions Ledger depends on. Created at first container boot so that migrations
-- (which run as the app user) never need superuser rights.
--
-- pg_trgm  : trigram similarity for merchant-name matching (brief §4.2, threshold 0.82)
-- citext   : case-insensitive email column for auth
-- pgcrypto : gen_random_uuid()

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
