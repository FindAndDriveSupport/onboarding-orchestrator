/**
 * onboard.js — Dealer onboarding script
 * Runs inside GitHub Actions with access to CF and GH secrets.
 */

import { Octokit } from '@octokit/rest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');

const GH_ORG       = 'FindAndDriveSupport';
const TEMPLATE_REPO = 'e-fficient-ui';
const BACKEND_REPO  = 'efficient-finance-widget';
const BACKEND_FILE  = 'workers/dealers/dealers.config.js';

const ghToken     = process.env.GH_PAT;
const cfToken     = process.env.CF_API_TOKEN;
const cfAccountId = process.env.CF_ACCOUNT_ID;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const payload     = JSON.parse(process.env.DEALER_PAYLOAD);

const {
  key, name, branch, branches,
  setupType, domains, primary,
  financeType, seritiKey, seritiSecret,
  contactEmail, billingType,
  showVehicleSelection,
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

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Supabase Analytics Invite ─────────────────────────────────────────────────

async function inviteDealerToAnalytics() {
  if (!supabaseUrl || !supabaseServiceKey) {
    console.log('⚠️  SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — skipping analytics invite');
    return;
  }

  if (!contactEmail) {
    console.log('⚠️  No contactEmail in payload — skipping analytics invite');
    return;
  }

  console.log(`📧 Inviting ${contactEmail} to E-fficient Analytics...`);

  try {
    // Step 1: Send invite email (Supabase handles the email)
    const inviteRes = await fetch(`${supabaseUrl}/auth/v1/admin/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'apikey': supabaseServiceKey,
      },
      body: JSON.stringify({
        email: contactEmail,
        options: {
          redirectTo: `${SITE_URL}/auth/reset-password`,
          data: {
            dealer_id: key,
            dealer_name: name,
            finance_type: financeType || 'vehicle',
          },
        },
      }),
    });

    const inviteData = await inviteRes.json();

    if (!inviteRes.ok) {
      const msg = inviteData.message || inviteData.msg || `HTTP ${inviteRes.status}`;
      // If already registered, just update their metadata
      if (msg.toLowerCase().includes('already registered')) {
        console.log(`ℹ️  ${contactEmail} already has an account — updating metadata only`);
      } else {
        throw new Error(msg);
      }
    }

    const userId = inviteData.id;

    // Step 2: Set app_metadata so dealer_id is in the JWT
    if (userId) {
      const metaRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'apikey': supabaseServiceKey,
        },
        body: JSON.stringify({
          app_metadata: {
            dealer_id: key,
            dealer_name: name,
            finance_type: financeType || 'vehicle',
          },
        }),
      });

      if (!metaRes.ok) {
        const metaData = await metaRes.json();
        console.log(`⚠️  Could not set metadata: ${metaData.message || metaData.msg}`);
      } else {
        console.log(`✅ Metadata set for ${contactEmail} (dealer_id: ${key})`);
      }
    }

    console.log(`✅ Analytics invite sent to ${contactEmail}`);
    console.log(`   They will receive an email to set their password`);
    console.log(`   Dashboard: ${SITE_URL}`);

  } catch (err) {
    // Non-fatal — don't fail the whole onboarding if analytics invite fails
    console.log(`⚠️  Analytics invite failed: ${err.message}`);
    console.log(`   You can manually invite them later from the admin dashboard`);
  }
}

async function main() {
  console.log(`\n🚀 Onboarding dealer: ${name} (${key})\n`);
  console.log(`📋 Setup type: ${setupType}`);
  if (branches) console.log(`🔀 Branches: ${branches.map(b => `${b.name} (${b.code})`).join(', ')}`);
  if (vehicleSelectionEnabled) console.log(`🚗 Vehicle selection page: enabled`);

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
    billingType: '${billingType || "transaction"}',${branchesStr ? '\n' + branchesStr : ''}
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

  // 3. Commit dealerConfig.ts
  console.log('⚙️  Committing dealerConfig.ts...');
  const configSha = await getFileSha(repoName, 'src/config/dealerConfig.ts');
  await commitFile(repoName, 'src/config/dealerConfig.ts', buildDealerConfig(), `chore: configure dealer ${key}`, configSha);

  // 4. Commit DealerContext.tsx
  console.log('⚙️  Committing DealerContext.tsx...');
  const dealerContextSha = await getFileSha(repoName, 'src/contexts/DealerContext.tsx');
  await commitFile(repoName, 'src/contexts/DealerContext.tsx', buildDealerContext(), `chore: update DealerContext to read from dealerConfig`, dealerContextSha);

  // 5. Commit wrangler.toml
  console.log('⚙️  Committing wrangler.toml...');
  const wranglerSha = await getFileSha(repoName, 'wrangler.toml');
  const wranglerContent = `name       = "e-fficient-ui-${key}"\nmain       = "dist/server/server.js"\ncompatibility_date = "2024-01-01"\ncompatibility_flags = ["nodejs_compat"]\nassets = { directory = "dist/client" }\ntail_consumers = [{ service = "alert-worker" }]\n\n[vars]\nNODE_ENV = "production"\n\n[observability.logs]\nenabled = true\ninvocation_logs = true\n`;
  await commitFile(repoName, 'wrangler.toml', wranglerContent, `chore: set wrangler name for ${key}`, wranglerSha);

  // 6. Commit .env
  console.log('⚙️  Committing .env...');
  const envSha = await getFileSha(repoName, '.env');
  const envContent = `VITE_WORKER_URL=https://seritifinance.findndrive.co.za\nVITE_DEFAULT_DEALER=${key}\n`;
  await commitFile(repoName, '.env', envContent, `chore: set env vars for ${key}`, envSha);

  // 7. Commit route index.tsx with dealer SEO
  console.log('🔍 Committing SEO route...');
  const routeSha = await getFileSha(repoName, 'src/routes/index.tsx');
  await commitFile(repoName, 'src/routes/index.tsx', buildRouteIndex(), `seo: add dealer meta tags for ${key}`, routeSha);

  // 8. Commit GitHub Actions workflow
  console.log('⚙️  Committing deploy workflow...');
  const workflowSha = await getFileSha(repoName, '.github/workflows/deploy.yml');
  await commitFile(repoName, '.github/workflows/deploy.yml', buildWorkflow(), `ci: add Cloudflare Workers deploy workflow`, workflowSha);

  // 9. Set GitHub secrets
  console.log('🔐 Setting GitHub secrets...');
  await setSecret(repoName, 'CLOUDFLARE_API_TOKEN', cfToken);
  await setSecret(repoName, 'CLOUDFLARE_ACCOUNT_ID', cfAccountId);

  // 10. Store Seriti credentials in Cloudflare KV
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

  // 11. Trigger first deployment
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

  // 12. Add Cloudflare Custom Domain
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

  // 13. Invite dealer to E-fficient Analytics dashboard
  console.log('📊 Inviting dealer to analytics dashboard...');
  await inviteDealerToAnalytics();

  console.log(`\n✅ Dealer ${name} onboarded successfully!\n`);
  console.log(`Repo: https://github.com/${GH_ORG}/${repoName}`);
  console.log(`Analytics: ${SITE_URL}`);
  if (vehicleSelectionEnabled) console.log(`🚗 Vehicle selection page enabled for this dealer`);
  if (setupType === 'multi-branch') {
    console.log(`🔀 Multi-branch setup — ${branches.length} branches configured`);
    console.log(`   Branch selector will be shown to users on the application form`);
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
