---
name: sql-migration-with-rollback
description: Write a safe, reversible SQL schema migration (up + down) using the project's migration tool, tested both ways.
version: 1.0.0
category: Back end
---
# SQL migration with rollback

Goal: a migration that applies cleanly, can be rolled back without data loss where possible, is safe
for a live database, and matches the project's migration tooling.

## Steps

1. **Detect the tool and conventions.** `search`/`find_files` for: Prisma (`schema.prisma`),
   Knex (`knexfile`), TypeORM, Sequelize, Drizzle (`drizzle.config`), Alembic (`alembic.ini`),
   Django (`migrations/`), Rails (`db/migrate`), Flyway (`V1__*.sql`), golang-migrate
   (`*.up.sql`/`*.down.sql`), sqlx, Diesel. Read the latest 2 migrations to copy style and naming.
2. **Identify the database** (PostgreSQL, MySQL, SQLite, SQL Server) from config; syntax and locking
   behaviour differ.
3. **Design the change** and write it in `update_plan`. Prefer expand/contract for live systems:
   - Add column: nullable or with a constant default first; backfill in batches; add `NOT NULL` later.
   - Rename column/table: add new, dual-write, backfill, switch reads, drop old in a later release.
   - Indexes on big Postgres tables: `CREATE INDEX CONCURRENTLY` (outside a transaction).
   - Foreign keys: add `NOT VALID` then `VALIDATE CONSTRAINT` separately (Postgres).
   - Never drop a column/table in the same release that stops using it.
4. **Generate the migration with the tool** when it has a generator
   (`npx prisma migrate dev --create-only --name add_x`, `alembic revision -m "add x"`,
   `npx knex migrate:make add_x`, `migrate create -ext sql -dir db/migrations add_x`,
   `python manage.py makemigrations`), then edit it.
5. **Write `up` and `down`:**
   - `down` exactly reverses `up` (drop what was added, re-create what was dropped with the same type,
     default, constraints and indexes).
   - If a step is destructive and cannot be reversed (dropping data), make `down` raise a clear error
     or document it, and tell the user.
   - Wrap in a transaction when the database supports transactional DDL (Postgres, SQLite), except
     operations that cannot run in one (`CONCURRENTLY`).
   - Data backfills: batched (`UPDATE ... WHERE id BETWEEN ...`), idempotent.
6. **Test both directions** against a local/dev database only (never production):
   up, then down, then up again (e.g. `npx knex migrate:latest && npx knex migrate:rollback && npx knex migrate:latest`,
   `alembic upgrade head && alembic downgrade -1 && alembic upgrade head`,
   `npx prisma migrate reset` for Prisma dev). Check the schema after each step.
7. Update ORM models/types and seed data; run the test suite.

## Done when

- [ ] Migration created with the project's tool and naming convention.
- [ ] `up` and `down` both written; irreversible parts clearly flagged.
- [ ] Live-safety considered: locking, defaults, batching, concurrent index creation.
- [ ] Applied, rolled back and re-applied successfully on a dev database.
- [ ] Models/types updated; tests pass.
