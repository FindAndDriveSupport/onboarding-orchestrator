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

// D1 database that backs the analytics dashboard (postal-codes-db).
const ANALYTICS_D1_DATABASE_ID = 'a518623c-f74b-4889-98da-d9ddda0ff632';

// KV namespace that backs the leads-api Worker's dealer config (LEADS_SYNC_CONFIG binding).
const LEADS_SYNC_CONFIG_KV_ID = '352dc4a8e9244b88b315a12590fd6a1a';

const ghToken     = process.env.GH_PAT;
const cfToken     = process.env.CF_API_TOKEN;
const cfAccountId = process.env.CF_ACCOUNT_ID;
const resendApiKey = process.env.RESEND_API_KEY; // for D1-based analytics invite email
const payload     = JSON.parse(process.env.DEALER_PAYLOAD);

// NOTE: client_payload is nested (not flat) because GitHub's repository_dispatch
// API caps client_payload at 10 top-level properties. This destructures the
// ACTUAL shape onboarding-ui.html's startDeploy() sends — 4 top-level keys:
// dealer (bundles most fields), seriti (credentials), leadDestinations,
// showVehicleSelection.
const {
  dealer: {
    key, name, branch, branches, setupType,
    groupKey, groupName, hasWebsite,
    domains, primary, financeType, billingType, contactEmail,
  } = {},
  seriti: { seritiKey, seritiSecret, seritiDealershipId } = {},
  leadDestinations,
  showVehicleSelection,
  // Optional — only relevant if the UI exposes a Kredo toggle for this dealer.
  // Not currently sent by onboarding-ui.html; harmless if absent.
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

// createUsingTemplate() copies the ENTIRE template repo, .github/workflows/
// included — there's no API option to exclude specific paths. Two of those
// workflows (sync-template-to-dealer.yml, sync-from-dev.yml) orchestrate
// ACROSS repos and only make sense running in the template repo itself; if
// left in a dealer repo they'd either fail outright (missing GH_PAT secret —
// "Input required and not supplied: token") or, worse, silently no-op every
// time they're accidentally triggered. Deleted here, right after creation,
// rather than relying solely on the `if: github.repository == ...` guards
// those files carry — belt and suspenders, and this way dealer repos don't
// carry dead files or generate phantom skipped Action runs at all.
// deploy.yml / audit-vehicle.yml / restore-dev.yml are deliberately left in
// place — those are dealer-specific operational workflows each repo needs.
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

/**
 * Runs a SQL statement against the analytics D1 database via the REST API.
 * onboard.js runs in GitHub Actions, outside the Worker, so it can't use
 * the D1 binding directly — the HTTP query API is the equivalent.
 */
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
 */
async function syncAnalyticsAccess() {
  if (!cfAccountId || !cfToken) {
    console.log('⚠️  CF_ACCOUNT_ID or CF_API_TOKEN not set — skipping analytics D1 sync');
    return;
  }

  console.log('🗂️  Syncing dealer into analytics access model (D1)...');

  try {
    // 1. Ensure the group exists, if this dealer belongs to one
    if (groupKey) {
      await d1Query(
        `INSERT OR IGNORE INTO groups (id, name) VALUES (?, ?)`,
        [groupKey, groupName || groupKey]
      );
      console.log(`✅ Group ensured: ${groupKey}`);
    }

    // 2. Insert dealer row(s)
    const websiteFlag  = hasWebsite ? 1 : 0;
    // Comma-separated list — tracked Mixpanel URLs reflect the dealer's own
    // domain(s) (custom domain + seritifinance.findndrive.co.za subdomain),
    // not a Seriti branch code, so this is what engagement filtering matches on.
    // Include both www and non-www variants since we can't know upfront
    // which the dealer's site actually redirects to/tracks with.
    const domainVariants = (domains || []).flatMap(d => {
      const bare = d.replace(/^www\./, '');
      return [bare, `www.${bare}`];
    });
    const domainList = [...domainVariants, `${key}.seritifinance.findndrive.co.za`].join(',');

    if (branches && branches.length > 0) {
      for (const b of branches) {
        const branchDealerId = `${key}__${b.code}`;
        await d1Query(
          `INSERT INTO dealers (id, name, group_id, finance_type, has_website, branch_code, domain)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             group_id = excluded.group_id,
             finance_type = excluded.finance_type,
             has_website = excluded.has_website,
             branch_code = excluded.branch_code,
             domain = excluded.domain`,
          [branchDealerId, b.name, groupKey || null, financeType || 'vehicle', websiteFlag, b.code, domainList]
        );
        console.log(`✅ Dealer branch synced: ${branchDealerId} (${b.name}, branch_code=${b.code}, domain=${domainList})`);
      }
    } else {
      await d1Query(
        `INSERT INTO dealers (id, name, group_id, finance_type, has_website, branch_code, domain)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           group_id = excluded.group_id,
           finance_type = excluded.finance_type,
           has_website = excluded.has_website,
           branch_code = excluded.branch_code,
           domain = excluded.domain`,
        [key, name, groupKey || null, financeType || 'vehicle', websiteFlag, branch, domainList]
      );
      console.log(`✅ Dealer synced: ${key} (${name}, branch_code=${branch}, domain=${domainList})`);
    }
  } catch (err) {
    console.log(`⚠️  Analytics D1 sync failed: ${err.message}`);
    console.log(`   You can add this dealer manually via the admin dashboard invite flow`);
  }
}

// ── Lead Sync Destination Config ──────────────────────────────────────────────

const REQUIRED_DEST_FIELDS = {
  hubspot: ['hubspotToken'],
  vmg:     ['dealerId'],
  cms:     ['dealerRef'],
  email:   ['recipientEmail'],
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
    // Reuses the same Edith branch code already collected for the widget —
    // doubles as the access code for the "email" digest destination's
    // /digest/view page (see leads-api-worker.js).
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
// Creates the user row directly in the analytics D1 database and sends the
// magic-link invite email via Resend — mirrors exactly what admin.js's
// POST /api/admin/invite endpoint does, just run from onboard.js's own D1
// access instead of round-tripping through the backend API (which would
// otherwise need a way to authenticate as an admin).

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

    // Check for an existing account first — same email-uniqueness rule as admin.js
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

  // 1. Update backend dealers.config.js
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
    branchCode: '${branch}',
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

  // 2. Create frontend repo from template
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

  // 2b. Remove template-only orchestration workflows — see
  // removeTemplateOnlyWorkflows() above for why this is needed.
  await removeTemplateOnlyWorkflows(repoName);

  // 3. Commit dealerConfig.ts
  console.log('⚙️  Committing dealerConfig.ts...');
  const configSha = await getFileSha(repoName, 'src/config/dealerConfig.ts');
  await commitFile(repoName, 'src/config/dealerConfig.ts', buildDealerConfig(), `chore: configure dealer ${key}`, configSha);

  // 4. Commit DealerContext.tsx
  console.log('⚙️  Committing DealerContext.tsx...');
  const dealerContextSha = await getFileSha(repoName, 'src/contexts/DealerContext.tsx');
  await commitFile(repoName, 'src/contexts/DealerContext.tsx', buildDe

  // ⚠️ NOTE: the file you pasted was truncated at exactly this point
  // ("buildDe") — everything below this line in the original main()
  // function (steps 5 onward, plus the closing of main() itself) is NOT
  // included here because I don't have that content. Paste the rest of
  // the file and I'll merge it back in properly rather than guessing at
  // what it contains.
