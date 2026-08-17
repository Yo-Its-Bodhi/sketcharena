# Sketch Arena immutable release checklist

Every public deployment must be traceable to a reviewed Git commit. Never build a release from an uncommitted working tree.

## Before deployment

1. Confirm `git status --short` is empty.
2. Confirm the GitHub `Release gates` workflow passes for the exact commit.
3. Record the full commit SHA and set it as `RELEASE_SHA` in the server environment.
4. Before the first PostgreSQL cutover, run `npm run ops:backup` against the stopped legacy JSON files and preserve its verified manifest off-host.
5. Run `npm run ops:backup:postgres`, verify the custom-format dump with `pg_restore --list`, and record the off-host/PITR checkpoint.
6. Run `npm run db:migrate` with the release environment. The runner must verify every applied migration checksum without drift.
7. For the first database cutover only, run `npm run db:import:legacy` while the old service is stopped. Preserve its per-source hashes; a changed previously imported source must be rejected.
8. Run another `npm run ops:backup:postgres` after import and verify representative account, artwork, progression, mint, promotion and report counts.
9. Build with `npm ci` followed by `npm run check`, `npm run qa:load` and `npm run contract:compile`.
10. If contract code changed, also run `npm run contract:test:ci`; never deploy a contract from this checklist.

## Deployment

1. Create a new versioned release directory instead of overwriting the active release.
2. Install production packages from `package-lock.json` and copy the already-tested web/server build output.
3. Point the service symlink or working directory to the new release.
4. Restart the supervised service and leave the previous release intact for rollback.

## Required smoke evidence

1. `/health/live` and `/health/ready` return the expected `RELEASE_SHA`.
2. The landing page loads over HTTPS without console errors.
3. Two fresh browser sessions complete room creation, joining, drawing, guessing, all configured rounds and the afterparty.
4. The Vault saves and reloads the drawer's trophy.
5. `/api/mint/status` is either deliberately locked or reports the reviewed address and expected chain. Never accept a partially configured mint service.
6. Backstage remains inaccessible without an authorized named credential.
7. An existing recovery-key Vault migrates to the same player UUID, adds a passkey, signs in on a second physical device and revokes that device without losing Vault/progression data.
8. Run the Socket.IO load harness against the staging host only with explicit authorization (`ALLOW_REMOTE_LOAD_TEST=true`), record client count/error rate/p95, and compare it with the final hosting capacity target. Never aim the harness at public production traffic.

## Rollback

Restore the prior release target, restart the service, and verify its recorded `RELEASE_SHA`. Do not roll back persistent data blindly; use the repository-specific recovery procedure and the pre-deployment backup.
