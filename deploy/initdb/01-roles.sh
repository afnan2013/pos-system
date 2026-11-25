#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"
: "${MIGRATOR_PASSWORD:?MIGRATOR_PASSWORD must be set}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"

psql --no-psqlrc --single-transaction -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
-- Keeps the password-bearing statements out of the server log and psql's error excerpt.
SET log_min_error_statement = panic;
\set VERBOSITY terse

\getenv migrator_password MIGRATOR_PASSWORD
\getenv app_password APP_DB_PASSWORD

CREATE ROLE migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'migrator_password';
CREATE ROLE pos_app  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';

\unset migrator_password
\unset app_password

REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO migrator, pos_app;
GRANT CREATE ON DATABASE :"DBNAME" TO migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA pos AUTHORIZATION migrator;
GRANT USAGE ON SCHEMA pos TO pos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA pos
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA pos
  GRANT USAGE ON SEQUENCES TO pos_app;

ALTER ROLE pos_app SET statement_timeout = '5s';
ALTER ROLE pos_app SET lock_timeout = '2s';
ALTER ROLE pos_app SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE migrator SET lock_timeout = '5s';
SQL
