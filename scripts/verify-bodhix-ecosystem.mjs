import process from 'node:process';
import pg from 'pg';

const { Pool } = pg;

export async function verifyBodhiXEcosystem(connectionString) {
  if (!connectionString?.trim()) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, application_name: 'bodhix-ecosystem-verify' });
  try {
    const required = ['player_accounts','bodhix_apps','bodhix_wallets','bodhix_reward_definitions','bodhix_entitlements','bodhix_xp_events','bodhix_campaigns','bodhix_admin_audit','bodhix_commerce_quotes','bodhix_auth_codes'];
    const tables = await pool.query('select table_name from information_schema.tables where table_schema=current_schema() and table_name=any($1::text[])', [required]);
    const found = new Set(tables.rows.map((row) => row.table_name)); const missing = required.filter((name) => !found.has(name));
    if (missing.length) throw new Error(`Missing BodhiX tables: ${missing.join(', ')}`);
    const [accounts, duplicateNames, duplicateWallets, duplicatePrimary, orphanWallets, apps, conflicts, leakedCommerce] = await Promise.all([
      pool.query('select count(*)::int count from player_accounts'),
      pool.query('select name_key,count(*)::int count from player_accounts group by name_key having count(*)>1'),
      pool.query("select lower(address) address,count(*)::int count from bodhix_wallets where revoked_at is null group by lower(address) having count(*)>1"),
      pool.query("select account_id,count(*)::int count from bodhix_wallets where revoked_at is null and is_primary group by account_id having count(*)>1"),
      pool.query('select count(*)::int count from bodhix_wallets wallet left join player_accounts account on account.id=wallet.account_id where account.id is null'),
      pool.query('select id,name,status from bodhix_apps order by id'),
      pool.query('select count(*)::int count from bodhix_wallet_import_conflicts'),
      pool.query("select count(*)::int count from bodhix_seasons where id<>'beta-0' or private_config<>'{}'::jsonb"),
    ]);
    const report = {
      ok: duplicateNames.rowCount === 0 && duplicateWallets.rowCount === 0 && duplicatePrimary.rowCount === 0 && Number(orphanWallets.rows[0]?.count ?? 0) === 0 && Number(leakedCommerce.rows[0]?.count ?? 0) === 0,
      accountCount: Number(accounts.rows[0]?.count ?? 0), apps: apps.rows, walletImportConflicts: Number(conflicts.rows[0]?.count ?? 0),
      duplicateNames: duplicateNames.rows, duplicateWallets: duplicateWallets.rows, duplicatePrimaryWallets: duplicatePrimary.rows,
      orphanWallets: Number(orphanWallets.rows[0]?.count ?? 0), futureCommerceRows: Number(leakedCommerce.rows[0]?.count ?? 0), checkedAt: new Date().toISOString(),
    };
    if (!report.ok) throw new Error(`BodhiX ecosystem verification failed: ${JSON.stringify(report)}`);
    return report;
  } finally { await pool.end(); }
}

if (process.argv[1]?.endsWith('verify-bodhix-ecosystem.mjs')) verifyBodhiXEcosystem(process.env.DATABASE_URL).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
