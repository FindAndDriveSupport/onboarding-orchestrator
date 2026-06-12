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
const payload     = JSON.parse(process.env.DEALER_PAYLOAD);

const {
  key, name, branch, domains,
  primary, gradEnd, label, tagline,
} = payload;

const showDeposit = true, showFinance = true, showParams = true;

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

async function main() {
  console.log(`\n🚀 Onboarding dealer: ${name} (${key})\n`);

  // 1. Update backend dealers.config.js
  console.log('📝 Updating backend config...');
  const { data: fileData } = await octokit.repos.getContent({
    owner: GH_ORG, repo: BACKEND_REPO, path: BACKEND_FILE,
  });
  const currentContent = Buffer.from(fileData.content, 'base64').toString('utf8');
  const domainsStr = domains.map(d => `'${d}'`).join(',\n      ');
  const newEntry = `
  '${key}': {
    name: '${name}',
    branchCode: '${branch}',
    allowedDomains: [
      ${domainsStr},
    ],
    mixpanelToken: '',
    theme: {
      primary: '${primary}',
      gradient: 'linear-gradient(135deg, ${primary} 0%, ${gradEnd} 100%)',
      fontFamily: "'Inter', sans-serif",
      borderRadius: '12px',
    },
    features: {
      showDeposit: ${showDeposit},
      showCurrentFinance: ${showFinance},
      vehicleQueryParams: ${showParams},
    },
  },
`;
  const updatedContent = currentContent.replace(/(\/\/ ── Lookup helpers)/, newEntry + '$1');
  await commitFile(BACKEND_REPO, BACKEND_FILE, updatedContent, `feat: add dealer ${key}`, fileData.sha);

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

  // 4. Commit wrangler.toml
  console.log('⚙️  Committing wrangler.toml...');
  const wranglerSha = await getFileSha(repoName, 'wrangler.toml');
  const wranglerContent = `name       = "e-fficient-ui-${key}"\nmain       = "dist/server/server.js"\ncompatibility_date = "2024-01-01"\ncompatibility_flags = ["nodejs_compat"]\nassets = { directory = "dist/client" }\n\n[vars]\nNODE_ENV = "production"\n`;
  await commitFile(repoName, 'wrangler.toml', wranglerContent, `chore: set wrangler name for ${key}`, wranglerSha);

  // 5. Commit .env
  console.log('⚙️  Committing .env...');
  const envSha = await getFileSha(repoName, '.env');
  const envContent = `VITE_WORKER_URL=https://efficient-finance-widget.still-fire-1c3d.workers.dev\nVITE_DEFAULT_DEALER=${key}\n`;
  await commitFile(repoName, '.env', envContent, `chore: set env vars for ${key}`, envSha);

  // 6. Commit GitHub Actions workflow
  console.log('⚙️  Committing deploy workflow...');
  const workflowSha = await getFileSha(repoName, '.github/workflows/deploy.yml');
  await commitFile(repoName, '.github/workflows/deploy.yml', buildWorkflow(), `ci: add Cloudflare Workers deploy workflow`, workflowSha);

  // 7. Set GitHub secrets
  console.log('🔐 Setting GitHub secrets...');
  await setSecret(repoName, 'CLOUDFLARE_API_TOKEN', cfToken);
  await setSecret(repoName, 'CLOUDFLARE_ACCOUNT_ID', cfAccountId);

  // 8. Trigger first deployment
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

  console.log(`\n✅ Dealer ${name} onboarded successfully!\n`);
  console.log(`Repo: https://github.com/${GH_ORG}/${repoName}`);
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
}

export interface DealerEntry {
  name: string;
  branchCode: string;
  allowedDomains: string[];
  mixpanelToken?: string;
  theme: DealerTheme;
  features: DealerFeatures;
}

export interface DealerConfig {
  key: string;
  name: string;
  branchCode: string;
  allowedDomains: string[];
  mixpanelToken?: string;
  theme: DealerTheme;
  features: DealerFeatures;
}

export const DEALERS: Record<string, DealerEntry> = {
  '${key}': {
    name: '${name}',
    branchCode: '${branch}',
    allowedDomains: [${domains.map(d => `'${d}'`).join(', ')}],
    mixpanelToken: '',
    theme: {
      primary: '${primary}',
      gradient: 'linear-gradient(135deg, ${primary} 0%, ${gradEnd} 100%)',
      fontFamily: "'Inter', sans-serif",
      borderRadius: '12px',
    },
    features: {
      showDeposit: ${showDeposit},
      showCurrentFinance: ${showFinance},
      vehicleQueryParams: ${showParams},
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
          VITE_WORKER_URL: https://efficient-finance-widget.still-fire-1c3d.workers.dev
          VITE_DEFAULT_DEALER: ${key}

      - name: Deploy to Cloudflare Workers
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`;
}

main().catch(e => { console.error('❌ Onboarding failed:', e.message); process.exit(1); });
