/**
 * onboard.js — Dealer onboarding script
 * Runs inside GitHub Actions with access to CF and GH secrets.
 */

import { Octokit } from '@octokit/rest';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');

const GH_ORG       = 'FindAndDriveSupport';
const TEMPLATE_REPO = 'e-fficient-ui';
const BACKEND_REPO  = 'efficient-finance-widget';
const BACKEND_FILE  = 'workers/dealers/dealers.config.js';

const ANALYTICS_D1_DATABASE_ID = 'a518623c-f74b-4889-98da-d9ddda0ff632';
const LEADS_SYNC_CONFIG_KV_ID = '352dc4a8e9244b88b315a12590fd6a1a';

const ghToken     = process.env.GH_PAT;
const cfToken     = process.env.CF_API_TOKEN;
const cfAccountId = process.env.CF_ACCOUNT_ID;
const resendApiKey = process.env.RESEND_API_KEY;
const payload     = JSON.parse(process.env.DEALER_PAYLOAD);

const {
  dealer: {
    key, name, branch, branches, setupType,
    groupKey, groupName, hasWebsite,
    domains, primary, financeType, billingType, contactEmail,
  } = {},
  seriti: { seritiKey, seritiSecret, seritiDealershipId } = {},
  leadDestinations,
  showVehicleSelection,
  kredoEnabled, kredoUsername, kredoPassword, kredoXApiKey,
} = payload;

const SITE_URL = 'https://analytics.findndrive.co.za';
const showDeposit = true, showFinance = true, showParams = true;
const vehicleSelectionEnabled = !!showVehicleSelection;

const octokit = new Octokit({ auth: ghToken });

async function encryptSecret(value, b64Key) {
  await sodium.ready;
  const keyBytes = sodium.from_base64(b64Key, sodium.base64_variants.ORIGINAL);
  const valBytes = sodium.from_string(value);
  const encrypted = sodium.crypto_box_seal(valBytes, keyBytes);
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
}

async function setSecret(repo, secretName, secretValue) {
  const { data: pk } = await octokit.actions.getRepoPublicKey({ owner: GH_ORG, repo });
  const encrypted = await encryptSecret(secretValue, pk.key);
  await octokit.actions.createOrUpdateRepoSecret({
    owner: GH_ORG, repo,
    secret_name: secretName,
    encrypted_value: encrypted,
    key_id: pk.key_id,
  });
  console.log(`✅ Set secret ${secretName} on ${repo}`);
}

async function getFileSha(repo, path) {
  try {
    const { data } = await octokit.repos.getContent({ owner: GH_ORG, repo, path });
    return data.sha;
  } catch { return undefined; }
}

async function commitFile(repo, path, content, message, sha) {
  await octokit.repos.createOrUpdateFileContents({
    owner: GH_ORG, repo, path,
    message, content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {}),
  });
  console.log(`✅ Committed ${path} to ${repo}`);
}

async function getFileShaAndDelete(repo, path, message) {
  const sha = await getFileSha(repo, path);
  if (!sha) {
    console.log(`ℹ️  ${path} not found in ${repo} — nothing to delete (already absent).`);
    return;
  }
  await octokit.repos.deleteFile({
    owner: GH_ORG, repo, path, message, sha,
  });
  console.log(`🗑️  Deleted ${path} from ${repo}`);
}

async function removeTemplateOnlyWorkflows(repo) {
  console.log('🧹 Removing template-only workflows from new dealer repo...');
  const templateOnlyWorkflows = [
    '.github/workflows/sync-template-to-dealer.yml',
    '.github/workflows/sync-from-dev.yml',
  ];
  for (const path of templateOnlyWorkflows) {
    try {
      await getFileShaAndDelete(repo, path, `chore: remove template-only workflow (${path.split('/').pop()})`);
    } catch (err) {
      console.log(`⚠️  Failed to delete ${path} from ${repo}: ${err.message} — remove it manually if needed.`);
    }
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── D1 sync (analytics access control) ────────────────────────────────────────

async function d1Query(sql, params = []) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/d1/database/${ANALYTICS_D1_DATABASE_ID}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors || data)}`);
  }
  return data.result;
}

/**
 * Syncs this dealer (and its branches, if any) into the analytics D1 database
 * so they appear correctly in the dealer access model — without any manual
 * admin-side data entry.
 *
 * NOTE: For multi-branch dealers, each branch gets its own `dealers` row
 * (id = "{key}__{branchCode}") sharing one `group_id`. This lets branch users
 * log in and see only their branch, and group admins switch between branches.
 * policy_events still stores one shared `dealer_key` + a separate `branch_code`
 * column — report.js / mixpanel.js / dealers.js queries don't yet filter by
 * branch_code, so branch-level policy data isn't split out yet. Flagging this
 * as a follow-up rather than guessing at the right filtering logic here.
 *
 * seriti_dealership_id: written from the top-level payload's
 * seritiDealershipId — already collected by the onboarding UI and already
 * used by configureLeadSync() below for leads_sync_config, just never
 * previously persisted to D1. This is what report.js/dealers.js actually
 * use for the GUID-based dealer identification (see splitByClient in
 * seritiApiService.js) — without this, every new dealer needs the same
 * manual SQL backfill Alpine Motors/Yonda/etc. all needed.
 *
 * For multi-branch dealers: each branch object doesn't currently carry its
 * own dealershipId from the onboarding UI (only code + name are collected
 * per branch row today) — b.dealershipId is threaded through here in case
 * that field gets added later, but will be null for now, same as before.
 */
async function syncAnalyticsAccess() {
  if (!cfAccountId || !cfToken) {
    console.log('⚠️  CF_ACCOUNT_ID or CF_API_TOKEN not set — skipping analytics D1 sync');
    return;
  }

  console.log('🗂️  Syncing dealer into analytics access model (D1)...');

  try {
    if (groupKey) {
      await d1Query(
        `INSERT OR IGNORE INTO groups (id, name) VALUES (?, ?)`,
        [groupKey, groupName || groupKey]
      );
      console.log(`✅ Group ensured: ${groupKey}`);
    }

    const websiteFlag  = hasWebsite ? 1 : 0;
    const domainVariants = (domains || []).flatMap(d => {
      const bare = d.replace(/^www\./, '');
      return [bare, `www.${bare}`];
    });
    const domainList = [...domainVariants, `${key}.seritifinance.findndrive.co.za`].join(',');

    if (branches && branches.length > 0) {
      for (const b of branches) {
        const branchDealerId = `${key}__${b.code}`;
        await d1Query(
          `INSERT INTO dealers (id, name, group_id, finance_type, has_website, branch_code, domain, seriti_dealership_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             group_id = excluded.group_id,
             finance_type = excluded.finance_type,
             has_website = excluded.has_website,
             branch_code = excluded.branch_code,
             domain = excluded.domain,
             seriti_dealership_id = COALESCE(excluded.seriti_dealership_id, dealers.seriti_dealership_id)`,
          [branchDealerId, b.name, groupKey || null, financeType || 'vehicle', websiteFlag, b.code, domainList, b.dealershipId || null]
        );
        console.log(`✅ Dealer branch synced: ${branchDealerId} (${b.name}, branch_code=${b.code}, domain=${domainList}, seriti_dealership_id=${b.dealershipId || 'not provided'})`);
      }
    } else {
      await d1Query(
        `INSERT INTO dealers (id, name, group_id, finance_type, has_website, branch_code, domain, seriti_dealership_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           group_id = excluded.group_id,
           finance_type = excluded.finance_type,
           has_website = excluded.has_website,
           branch_code = excluded.branch_code,
           domain = excluded.domain,
           seriti_dealership_id = COALESCE(excluded.seriti_dealership_id, dealers.seriti_dealership_id)`,
        [key, name, groupKey || null, financeType || 'vehicle', websiteFlag, branch, domainList, seritiDealershipId || null]
      );
      console.log(`✅ Dealer synced: ${key} (${name}, branch_code=${branch}, domain=${domainList}, seriti_dealership_id=${seritiDealershipId || 'not provided'})`);
    }
  } catch (err) {
    console.log(`⚠️  Analytics D1 sync failed: ${err.message}`);
    console.log(`   You can add this dealer manually via the admin dashboard invite flow`);
  }
}

// ── Lead Sync Destination Config ──────────────────────────────────────────────

const REQUIRED_DEST_FIELDS = {
  hubspot:  ['hubspotToken'],
  vmg:      ['dealerId'],
  cms:      ['dealerRef'],
  dealeros: ['dealerosToken', 'dealershipId'],
  email:    ['recipientEmail'],
};

function validateDestinations(destinations) {
  for (const dest of destinations) {
    const required = REQUIRED_DEST_FIELDS[dest.type];
    if (!required) {
      console.log(`⚠️  Unknown destination type '${dest.type}' — leads-api-worker will reject this at runtime`);
      continue;
    }
    const missing = required.filter(f => !dest[f]);
    if (missing.length) {
      console.log(`⚠️  Destination '${dest.type}' is missing: ${missing.join(', ')} — fix this in KV before leads flow`);
    }
  }
}

async function configureLeadSync() {
  if (!leadDestinations || leadDestinations.length === 0) {
    console.log('ℹ️  No lead destinations selected — skipping lead-sync config');
    return;
  }

  if (!seritiKey || !seritiSecret || !seritiDealershipId) {
    console.log('⚠️  Missing Seriti key/secret/dealershipId in payload — cannot configure lead sync, skipping');
    return;
  }

  if (LEADS_SYNC_CONFIG_KV_ID.startsWith('<FILL_IN')) {
    console.log('⚠️  LEADS_SYNC_CONFIG_KV_ID is not set in onboard.js — skipping lead-sync config');
    return;
  }

  console.log(`🔀 Configuring lead sync → ${leadDestinations.map(d => d.type).join(', ')}`);
  validateDestinations(leadDestinations);

  const leadsSyncConfig = {
    key,
    groupKey: groupKey || '',
    branchCode: branch || '',
    seritiApiKey: seritiKey,
    seritiApiSecret: seritiSecret,
    seritiDealershipId,
    startDate: new Date().toISOString().slice(0, 10),
    kredoEnabled: !!kredoEnabled,
    kredoUsername: kredoUsername || '',
    kredoPassword: kredoPassword || '',
    kredoXApiKey: kredoXApiKey || '',
    destinations: leadDestinations,
  };

  if (leadDestinations.some(d => d.type === 'email') && !branch) {
    console.log('⚠️  Email digest destination selected but no branch code available — digest sends will be skipped until a branchCode is set on this LEADS_SYNC_CONFIG entry.');
  }

  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/storage/kv/namespaces/${LEADS_SYNC_CONFIG_KV_ID}/values/${key}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(leadsSyncConfig),
    });
    const data = await res.json();
    if (!data.success) throw new Error(JSON.stringify(data.errors || data));
    console.log(`✅ Lead sync config written for ${key} (${leadDestinations.length} destination(s))`);
  } catch (err) {
    console.log(`⚠️  Lead sync config write failed: ${err.message}`);
    console.log(`   Set it manually: npx wrangler kv key put --binding=LEADS_SYNC_CONFIG "${key}" '<config json>'`);
  }
}

// ── Analytics Invite (D1 + Resend) ─────────────────────────────────────────────

function generateInviteToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

async function sendAnalyticsInviteEmail({ email, token, dealerName }) {
  if (!resendApiKey) {
    console.log('⚠️  RESEND_API_KEY not set — skipping invite email (user row still created in D1)');
    return;
  }

  const link = `${SITE_URL}/auth/verify?token=${token}`;
  const greeting = dealerName || 'there';

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; margin: 0; padding: 40px 20px;">
      <div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 24px; padding: 40px; border: 1px solid #e2e8f0;">
        <div style="text-align: center; margin-bottom: 32px;">
          <table role="presentation" style="margin: 0 auto 12px; border-collapse: collapse;">
            <tr>
              <td style="width: 48px; height: 48px; background: #0f766e; border-radius: 16px; text-align: center; vertical-align: middle;">
                <span style="color: white; font-size: 20px; font-weight: 900; line-height: 48px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">E</span>
              </td>
            </tr>
          </table>
          <p style="margin: 0; font-size: 13px; font-weight: 600; color: #475569; letter-spacing: 0.05em;">E-FFICIENT ANALYTICS</p>
        </div>

        <h1 style="font-size: 22px; font-weight: 700; color: #0f172a; margin: 0 0 8px;">You've been invited</h1>
        <p style="font-size: 15px; color: #64748b; margin: 0 0 32px;">
          Hi ${greeting}, you've been given access to your E-fficient Analytics dashboard.
          Click below to set up your account — this link expires in 7 days.
        </p>

        <a href="${link}" style="display: block; text-align: center; background: #0f766e; color: white; text-decoration: none; padding: 14px 24px; border-radius: 12px; font-size: 15px; font-weight: 600; margin-bottom: 24px;">
          Access your dashboard
        </a>

        <p style="font-size: 13px; color: #94a3b8; margin: 0; text-align: center;">
          If you didn't expect this invitation, you can safely ignore this email.
        </p>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="font-size: 12px; color: #cbd5e1; margin: 0; text-align: center;">
          Find &amp; Drive Group (Pty) Ltd · ${SITE_URL}
        </p>
      </div>
    </body>
    </html>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    'E-fficient Analytics <noreply@findndrive.co.za>',
      to:      [email],
      subject: `You've been invited to E-fficient Analytics`,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to send invite email: ${body}`);
  }
}

async function inviteDealerToAnalytics() {
  if (!contactEmail) {
    console.log('⚠️  No contactEmail in payload — skipping analytics invite');
    return;
  }

  console.log(`📧 Inviting ${contactEmail} to E-fficient Analytics...`);

  try {
    const normalizedEmail = contactEmail.toLowerCase().trim();

    const existingResult = await d1Query(
      `SELECT id FROM users WHERE email = ?`,
      [normalizedEmail]
    );
    const existingRows = existingResult?.[0]?.results || [];
    if (existingRows.length > 0) {
      console.log(`ℹ️  ${contactEmail} already has an account — skipping invite`);
      return;
    }

    const userId    = crypto.randomUUID();
    const token     = generateInviteToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await d1Query(
      `INSERT INTO users (id, email, dealer_id, dealer_name, finance_type, is_admin, invite_token, invite_expires_at, status)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'invited')`,
      [userId, normalizedEmail, key, name, financeType || 'vehicle', token, expiresAt]
    );

    await sendAnalyticsInviteEmail({ email: normalizedEmail, token, dealerName: name });

    console.log(`✅ Analytics invite sent to ${contactEmail}`);
    console.log(`   Dashboard: ${SITE_URL}`);

  } catch (err) {
    console.log(`⚠️  Analytics invite failed: ${err.message}`);
    console.log(`   You can manually invite them later from the admin dashboard`);
  }
}

async function main() {
  console.log(`\n🚀 Onboarding dealer: ${name} (${key})\n`);
  console.log(`📋 Setup type: ${setupType}`);
  if (branches) console.log(`🔀 Branches: ${branches.map(b => `${b.name} (${b.code})`).join(', ')}`);
  if (vehicleSelectionEnabled) console.log(`🚗 Vehicle selection page: enabled`);
  if (leadDestinations && leadDestinations.length) {
    console.log(`📬 Lead destinations: ${leadDestinations.map(d => d.type).join(', ')}`);
  }
  if (groupKey) console.log(`🏢 Dealer group: ${groupKey}`);
  if (hasWebsite) console.log(`🌐 Dealer website hosting: enabled (Stock nav will show)`);

  console.log('📝 Updating backend config...');
  const { data: fileData } = await octokit.repos.getContent({
    owner: GH_ORG, repo: BACKEND_REPO, path: BACKEND_FILE,
  });
  const currentContent = Buffer.from(fileData.content, 'base64').toString('utf8');

  if (currentContent.includes(`'${key}': {`)) {
    console.log(`ℹ️  Dealer entry '${key}' already exists in dealers.config.js — skipping backend config update`);
  } else {
    const domainsStr = domains.map(d => `'${d}'`).join(',\n      ');

    const branchesStr = branches && branches.length > 0
      ? `    branches: [\n${branches.map(b => `      { code: '${b.code}', name: '${b.name}' },`).join('\n')}\n    ],`
      : '';
    const newEntry = `
  '${key}': {
    name: '${name}',
    branchCode: '${branch}',${seritiDealershipId ? `\n    dealershipID: '${seritiDealershipId}',` : ''}
    financeType: '${financeType || "vehicle"}',
    edithEnv: 'prod',
    contactEmail: '${contactEmail || ""}',
    billingType: '${billingType || "transaction"}',
    groupKey: '${groupKey || ""}',${branchesStr ? '\n' + branchesStr : ''}
    allowedDomains: [
      ${domainsStr},
      '${key}.seritifinance.findndrive.co.za',
      'seritifinance.findndrive.co.za',
    ],
    theme: {
      primary: '${primary}',
      gradient: 'linear-gradient(135deg, ${primary} 0%, ${primary} 100%)',
      fontFamily: "'Inter', sans-serif",
      borderRadius: '12px',
    },
    features: {
      showDeposit: ${showDeposit},
      showCurrentFinance: ${showFinance},
      vehicleQueryParams: ${showParams},${vehicleSelectionEnabled ? '\n      showVehicleSelection: true,' : ''}
    },
  },
`;

    const updatedContent = currentContent.replace(
      /(  \/\/ ─+\n  \/\/ ADD MORE DEALERS BELOW[^\n]*\n  \/\/ ─+\n};)/,
      newEntry + '$1'
    );

    if (updatedContent === currentContent) {
      throw new Error('Could not find insertion point in dealers.config.js — check the ADD MORE DEALERS comment block is present');
    }

    await commitFile(BACKEND_REPO, BACKEND_FILE, updatedContent, `feat: add dealer ${key}`, fileData.sha);
  }

  console.log('📦 Creating frontend repo...');
  const repoName = `e-fficient-ui-${key}`;
  try {
    await octokit.repos.createUsingTemplate({
      template_owner: GH_ORG,
      template_repo: TEMPLATE_REPO,
      owner: GH_ORG,
      name: repoName,
      description: `E-fficient Finance Widget — ${name}`,
      private: true,
      include_all_branches: false,
    });
    console.log(`✅ Created repo ${repoName}`);
    await sleep(5000);
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log(`ℹ️  Repo ${repoName} already exists — continuing`);
    } else throw e;
  }

  await removeTemplateOnlyWorkflows(repoName);

  console.log('⚙️  Committing dealerConfig.ts...');
  const configSha = await getFileSha(repoName, 'src/config/dealerConfig.ts');
  await commitFile(repoName, 'src/config/dealerConfig.ts', buildDealerConfig(), `chore: configure dealer ${key}`, configSha);

  console.log('⚙️  Committing DealerContext.tsx...');
  const dealerContextSha = await getFileSha(repoName, 'src/contexts/DealerContext.tsx');
  await commitFile(repoName, 'src/contexts/DealerContext.tsx', buildDealerContext(), `chore: update DealerContext to read from dealerConfig`, dealerContextSha);

  console.log('⚙️  Committing wrangler.toml...');
  const wranglerSha = await getFileSha(repoName, 'wrangler.toml');
  const wranglerContent = `name       = "e-fficient-ui-${key}"\nmain       = "dist/server/server.js"\ncompatibility_date = "2024-01-01"\ncompatibility_flags = ["nodejs_compat"]\nassets = { directory = "dist/client" }\ntail_consumers = [{ service = "alert-worker" }]\n\n[vars]\nNODE_ENV = "production"\n\n[observability.logs]\nenabled = true\ninvocation_logs = true\n`;
  await commitFile(repoName, 'wrangler.toml', wranglerContent, `chore: set wrangler name for ${key}`, wranglerSha);

  console.log('⚙️  Committing .env...');
  const envSha = await getFileSha(repoName, '.env');
  const envContent = `VITE_WORKER_URL=https://seritifinance.findndrive.co.za\nVITE_DEFAULT_DEALER=${key}\n`;
  await commitFile(repoName, '.env', envContent, `chore: set env vars for ${key}`, envSha);

  console.log('🔍 Committing SEO route...');
  const routeSha = await getFileSha(repoName, 'src/routes/index.tsx');
  await commitFile(repoName, 'src/routes/index.tsx', buildRouteIndex(), `seo: add dealer meta tags for ${key}`, routeSha);

  console.log('⚙️  Committing deploy workflow...');
  const workflowSha = await getFileSha(repoName, '.github/workflows/deploy.yml');
  await commitFile(repoName, '.github/workflows/deploy.yml', buildWorkflow(), `ci: add Cloudflare Workers deploy workflow`, workflowSha);

  console.log('🔐 Setting GitHub secrets...');
  await setSecret(repoName, 'CLOUDFLARE_API_TOKEN', cfToken);
  await setSecret(repoName, 'CLOUDFLARE_ACCOUNT_ID', cfAccountId);

  console.log('🔐 Storing Seriti credentials in KV...');
  if (seritiKey && seritiSecret) {
    const kvNamespaceId = '16c7bf807bc0445ab0420a16f2352c0d';
    const cfBase = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/storage/kv/namespaces/${kvNamespaceId}/values`;
    await fetch(`${cfBase}/SERITI_KEY_${key}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'text/plain' },
      body: seritiKey,
    });
    await fetch(`${cfBase}/SERITI_SECRET_${key}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'text/plain' },
      body: seritiSecret,
    });
    console.log('✅ Seriti credentials stored in KV');
  }

  console.log('🚀 Triggering first deployment...');
  await sleep(2000);
  try {
    await octokit.actions.createWorkflowDispatch({
      owner: GH_ORG, repo: repoName,
      workflow_id: 'deploy.yml',
      ref: 'main',
    });
    console.log('✅ Deployment triggered');
  } catch (e) {
    console.log('⚠️  Could not trigger workflow dispatch — it will run on next push');
  }

  console.log('⏳ Waiting for deployment to complete before binding custom domain...');
  await sleep(90000);

  console.log('🌐 Adding Cloudflare Custom Domain...');
  try {
    const zoneRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=findndrive.co.za`,
      { headers: { Authorization: `Bearer ${cfToken}` } }
    );
    const zoneData = await zoneRes.json();
    const zoneId = zoneData.result?.[0]?.id;
    if (zoneId) {
      const hostname = `${key}.seritifinance.findndrive.co.za`;
      const domainRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/domains`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hostname,
            zone_id: zoneId,
            service: `e-fficient-ui-${key}`,
          }),
        }
      );
      const domainData = await domainRes.json();
      if (domainData.success) {
        console.log(`✅ Custom domain added: ${hostname}`);
      } else {
        console.log(`⚠️  Custom domain response:`, JSON.stringify(domainData.errors || domainData));
      }
    }
  } catch (e) {
    console.log('⚠️  Could not add custom domain automatically:', e.message);
  }

  console.log('📊 Inviting dealer to analytics dashboard...');
  await inviteDealerToAnalytics();

  console.log('🔀 Configuring lead sync destinations...');
  await configureLeadSync();

  await syncAnalyticsAccess();

  console.log(`\n✅ Dealer ${name} onboarded successfully!\n`);
  console.log(`Repo: https://github.com/${GH_ORG}/${repoName}`);
  console.log(`Analytics: ${SITE_URL}`);
  if (vehicleSelectionEnabled) console.log(`🚗 Vehicle selection page enabled for this dealer`);
  if (leadDestinations && leadDestinations.length) {
    console.log(`📬 Leads will sync to: ${leadDestinations.map(d => d.type).join(', ')}`);
  }
  if (setupType === 'multi-branch') {
    console.log(`🔀 Multi-branch setup — ${branches.length} branches configured`);
    console.log(`   Branch selector will be shown to users on the application form`);
    console.log(`   Each branch also has its own analytics dealer row (id = "${key}__<branchCode>")`);
  }
  if (setupType === 'multi-site') {
    console.log(`ℹ️  Multi-site setup — run onboarding again for each additional branch`);
  }
}

function buildRouteIndex() {
  const isBike = financeType === 'bike';
  const assetType = isBike ? 'bike' : 'vehicle';
  const canonicalUrl = `https://${key}.seritifinance.findndrive.co.za`;
  const title = `${name} — ${isBike ? 'Bike' : 'Vehicle'} Finance`;
  const description = `Check your ${assetType} finance affordability with ${name} in 60 seconds. No credit impact. Get an instant estimate powered by FindAndDrive.`;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FinancialProduct",
    "name": `${name} ${isBike ? 'Bike' : 'Vehicle'} Finance`,
    "description": description,
    "url": canonicalUrl,
    "provider": {
      "@type": "Organization",
      "name": name,
      "url": domains[0] ? `https://${domains[0]}` : canonicalUrl,
    },
    "feesAndCommissionsSpecification": "No application fee. No credit impact.",
    "areaServed": {
      "@type": "Country",
      "name": "South Africa",
    },
  });

  return `import { createFileRoute } from "@tanstack/react-router";
import { Wizard } from "@/components/wizard/Wizard";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "${title}" },
      { name: "description", content: "${description}" },
      { name: "robots", content: "index, follow" },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "${canonicalUrl}" },
      { property: "og:title", content: "${title}" },
      { property: "og:description", content: "${description}" },
      { property: "og:site_name", content: "${name}" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "${title}" },
      { name: "twitter:description", content: "${description}" },
      { name: "theme-color", content: "${primary}" },
    ],
    links: [
      { rel: "canonical", href: "${canonicalUrl}" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: \`${jsonLd}\`,
      },
    ],
  }),
  component: Index,
});

function Index() {
  return <Wizard />;
}
`;
}

function buildDealerConfig() {
  return `export interface DealerTheme {
  primary?: string;
  primaryLight?: string;
  primaryDark?: string;
  gradient?: string;
  fontFamily?: string;
  borderRadius?: string;
  logoUrl?: string;
}

export interface DealerFeatures {
  showDeposit: boolean;
  showCurrentFinance: boolean;
  vehicleQueryParams: boolean;
  showVehicleSelection?: boolean;
}

export interface DealerBranch {
  code: string;
  name: string;
}

export interface DealerEntry {
  name: string;
  branchCode: string;
  financeType: string;
  allowedDomains: string[];
  theme: DealerTheme;
  features: DealerFeatures;
  branches?: DealerBranch[];
}

export interface DealerConfig {
  key: string;
  name: string;
  branchCode: string;
  financeType: string;
  allowedDomains: string[];
  theme: DealerTheme;
  features: DealerFeatures;
  branches?: DealerBranch[];
}

export const DEALERS: Record<string, DealerEntry> = {
  '${key}': {
    name: '${name}',
    branchCode: '${branch}',
    financeType: '${financeType || "vehicle"}',
    allowedDomains: [${domains.map(d => `'${d}'`).join(', ')}, '${key}.seritifinance.findndrive.co.za'],${branches && branches.length > 0 ? `
    branches: [${branches.map(b => `\n      { code: '${b.code}', name: '${b.name}' },`).join('')}
    ],` : ''}
    theme: {
      primary: '${primary}',
      gradient: 'linear-gradient(135deg, ${primary} 0%, ${primary} 100%)',
      fontFamily: "'Inter', sans-serif",
      borderRadius: '12px',
    },
    features: {
      showDeposit: ${showDeposit},
      showCurrentFinance: ${showFinance},
      vehicleQueryParams: ${showParams},${vehicleSelectionEnabled ? '\n      showVehicleSelection: true,' : ''}
    },
  },
};

export const DEFAULT_DEALER_KEY = '${key}';

export function getDealerConfig(key?: string): DealerConfig {
  const resolved = key && DEALERS[key] ? key : DEFAULT_DEALER_KEY;
  const entry = DEALERS[resolved] ?? DEALERS[DEFAULT_DEALER_KEY];
  return { key: resolved, ...entry };
}
`;
}

function buildWorkflow() {
  return `name: Deploy to Cloudflare Workers

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --ignore-scripts

      - name: Build
        run: bun run build
        env:
          VITE_WORKER_URL: https://seritifinance.findndrive.co.za
          VITE_DEFAULT_DEALER: ${key}

      - name: Deploy to Cloudflare Workers
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`;
}

function buildDealerContext() {
  return `import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useEmbed } from "./EmbedContext";
import { getDealerConfig } from "@/config/dealerConfig";

export interface DealerTheme {
  primary?: string;
  primaryLight?: string;
  primaryDark?: string;
  gradient?: string;
  fontFamily?: string;
  borderRadius?: string;
  logoUrl?: string;
}

export interface DealerFeatures {
  showDeposit: boolean;
  showCurrentFinance: boolean;
  vehicleQueryParams: boolean;
  showVehicleSelection?: boolean;
}

export interface DealerBranch {
  code: string;
  name: string;
}

export interface DealerConfig {
  key: string;
  name: string;
  branchCode: string;
  financeType: string;
  theme: DealerTheme;
  features: DealerFeatures;
  branches?: DealerBranch[];
}

const DEFAULT_CONFIG: DealerConfig = {
  key: "default",
  name: "Vehicle Finance",
  branchCode: "",
  financeType: "vehicle",
  theme: {},
  features: { showDeposit: true, showCurrentFinance: true, vehicleQueryParams: true },
};

const DealerContext = createContext<DealerConfig>(DEFAULT_CONFIG);

export function DealerProvider({ children }: { children: ReactNode }) {
  const { dealer } = useEmbed();
  const [config, setConfig] = useState<DealerConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    const dealerConfig = getDealerConfig(dealer);
    setConfig(dealerConfig);

    const t = dealerConfig.theme || {};
    const root = document.documentElement;
    if (t.primary)      root.style.setProperty("--dealer-primary", t.primary);
    if (t.gradient)     root.style.setProperty("--gradient-primary", t.gradient);
    if (t.borderRadius) root.style.setProperty("--radius", t.borderRadius);
    if (t.fontFamily)   root.style.setProperty("--font-family", t.fontFamily);
  }, [dealer]);

  const value = useMemo(() => config, [config]);

  return <DealerContext.Provider value={value}>{children}</DealerContext.Provider>;
}

export function useDealer() {
  return useContext(DealerContext);
}
`;
}

main().catch(e => { console.error('❌ Onboarding failed:', e.message); process.exit(1); });
