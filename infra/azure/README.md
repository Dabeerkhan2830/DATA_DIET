# Azure infrastructure (Bicep scaffolding)

Design target for a future Azure deployment of DataDiet: Static Web Apps for the
React/Vite frontend, App Service Linux/Python for the FastAPI backend, MySQL
Flexible Server, Key Vault, optional Application Insights.

> **Status: written, never deployed, never compiled.**
>
> No Azure subscription, tenant, CLI or Bicep toolchain was available while this
> was authored (`az`, `bicep`, and the Bicep download were all unavailable from
> this environment), so **these templates have not been parsed by a Bicep
> compiler and have not been what-if validated**. Treat every resource shape
> below as a reviewed proposal, not a verified deployment. The commands in
> [Validation](#validation-what-to-run-before-any-deployment) are the gate.
>
> Nothing here creates cloud resources. Read
> [docs/azure-architecture.md](../../docs/azure-architecture.md) for the design
> and [docs/azure-deployment.md](../../docs/azure-deployment.md) for the runbook.

## Layout

| File | Contents |
| --- | --- |
| `main.bicep` | Resource-group entry point: parameters, naming, tags, module wiring, Key Vault role assignment, outputs |
| `modules/backend.bicep` | Linux App Service plan, site, managed identity, application settings (Key Vault references), startup command, health probe |
| `modules/frontend.bicep` | Static Web Apps site, optional build-from-source, optional custom domain |
| `modules/mysql.bicep` | MySQL Flexible Server, application database, TLS/charset parameters, firewall rules, private endpoint |
| `modules/keyvault.bicep` | Vault with RBAC, soft delete and purge protection, optional private endpoint, role assignments |
| `modules/network.bicep` | VNet, private-endpoint subnet, MySQL-delegated subnet, private DNS zones and links |
| `modules/monitoring.bicep` | Workspace-based Application Insights component (only with an existing workspace) |
| `modules/private-link.bicep` | Reusable private endpoint + DNS zone group |
| `params/dev.parameters.json` | Development-shaped parameter file with placeholders |
| `params/prod.parameters.json` | Production-shaped parameter file; `DECIDE:` values are open decisions |

## Naming

Names are derived, never hardcoded to one deployment:

`<namePrefix>-<environment>-<role>[-<nameToken>]`

| Resource | Pattern | Globally unique? |
| --- | --- | --- |
| Backend site | `datadiet-dev-api-<nameToken>` | yes — `*.azurewebsites.net` |
| App Service plan | `datadiet-dev-plan` | no, resource-group scoped |
| Managed identity | `datadiet-dev-api-id` | no |
| Static Web App | `datadiet-dev-web-<nameToken>` | yes — `*.azurestaticapps.net` |
| Key Vault | `datadietdevkv<nameToken>` | yes, and capped at 24 characters — keep `namePrefix` short |
| MySQL server | `datadietdevmysql<nameToken>` | yes |
| Application Insights | `datadiet-dev-ai` | no |

`nameToken` (3–10 lowercase alphanumerics) is the only field an operator must
invent. Dev and prod are separated by the `environment` segment **and** should be
placed in separate resource groups (and, for real separation, separate
subscriptions). Tags `project`, `environment`, `managedBy` are always applied;
`owner` and `costCenter` come from the `tags` parameter.

## What is parameterised

Region (`location`), all names (`namePrefix`, `nameToken`, `environment`), every
SKU and tier, MySQL version/storage/backup/HA, the three MySQL network modes,
vault public-access and IP allowlist, private DNS zone names, CORS origins,
feature gates (`demoDataEnabled`, `authDevProviderEnabled`), token TTL/issuer/
audience, secret *names* (never values), and whether monitoring exists at all.

Enum-typed ARM properties (`sku.tier`, `version`, `publicNetworkAccess`,
`highAvailability.mode`, `ftpsState`, ...) are written as literals or
literal-valued conditionals rather than raw string parameters: assigning a
`string` parameter to a Bicep union type is a compile error. To change one of
those, edit the conditional — it is one line in one place.

## Secrets and identity

- The vault is created **empty**. No template, parameter file or workflow in this
  repository contains a secret value.
- The runtime reads `DATABASE_URL` and `AUTH_JWT_SECRET` through App Service Key
  Vault references (`@Microsoft.KeyVault(SecretUri=...)`, unversioned so a secret
  rotation is picked up within 24 hours).
- The backend's user-assigned managed identity is granted **Key Vault Secrets
  User** (`4633458b-17de-408a-b874-0445c86b69e6`) scoped to that vault —
  read-only secret access, nothing else.
- `mysqlAdministratorLoginPassword` is the one secret needed *at deploy time*,
  before the vault exists. It is supplied through the parameter file's
  `reference.keyVault` block pointing at a **bootstrap vault** an operator
  already controls; the deploying identity needs
  `Microsoft.KeyVault/vaults/deploy/action` on it.
- Application authentication is still fail-closed (ADR-0014): with
  `ENVIRONMENT=production` and no real signing secret, every protected endpoint
  answers 503 and `dev-login` is disabled by code, not by configuration.

## Networking decisions

| `mysqlNetworkMode` | What you get | Trade-off |
| --- | --- | --- |
| `public` | Server reachable from the internet, restricted by `mysqlFirewallRules`, TLS enforced | Cheapest and works today. Rules must be pinned to the App Service plan's outbound addresses — which are shared and can change — so this is "firewalled", not "private" |
| `private-endpoint` | A NIC in your VNet + `privatelink.mysql.database.azure.com` zone | Properly private, but **the backend cannot reach it until the App Service plan has VNet integration**, which these templates deliberately do not create (see below). Costs a private endpoint per month |
| `delegated` | Server injected into a `/28` subnet delegated to `Microsoft.DBforMySQL/flexibleServers` | Also private; same VNet-integration gap; the mode is immutable once created |

`keyVaultPrivateAccess` follows the same rule: a private vault only works for Key
Vault *references* once the backend has a network path to it.

App Service VNet integration is not templated because the shape of the
`Microsoft.Web/sites/config` virtual-network child resource was not verifiable
here. Do it deliberately, then re-check the firewall/private-path story:

```powershell
az webapp vnet-integration create --name <site> --resource-group <rg> `
  --vnet <vnet> --subnet <subnet>
```

## Cost categories (check live prices before choosing a tier)

Nothing in this directory asserts a price. Prices move, differ by region and
offer, and are not something a template can pin down. Budget by category, then
price it with the Azure calculator or `az` against your own agreement:

- App Service plan — driven by SKU and instance count; `B1` has no Always On and
  no scaling, so a "cheap dev" choice is not a production choice.
- MySQL Flexible Server — compute SKU, storage size, **backup retention days**,
  and geo-redundant backup (roughly doubles backup storage), and zone-redundant
  HA (roughly doubles compute). All three are parameters and all default to the
  cheap option.
- Static Web Apps — `Free` (no SLA, no private endpoints, limited custom
  domains) versus `Standard`. The Dedicated plan was retired 2025-10-31; only
  these two remain.
- Private endpoints + private DNS zones — per endpoint per month, plus
  processing; they are created **only** when a private mode is selected.
- VNet/subnets are free; a VNet peering or NAT gateway (not templated) is not.
- Application Insights + Log Analytics — billed mainly on **data ingested and
  retained**, not on the number of resources. This is the item most likely to
  surprise a budget, so the whole module stays off unless
  `logAnalyticsWorkspaceResourceId` names an existing workspace.
- Outbound data transfer and egress from the backend to external connectors.

The deliberate defaults are: no monitoring, no HA, no geo-redundant backup, no
private endpoints, `B1`/`Burstable_B2s`/`Free` SKUs. Those are
development-shaped, not production-shaped; `params/prod.parameters.json` marks
each one `DECIDE` instead of silently choosing a paid tier for you.

## What these templates do NOT do

1. Create any secret. Populate them per docs/azure-deployment.md section 4.
2. Run Alembic. Never wire a pipeline to migrate production automatically
   (ADR-0018).
3. Grant the *deploying* identity permission to create resources — that role
   assignment is an Azure-side step; see the OIDC setup in the deployment doc.
4. Create a DNS record for a custom domain, or an App Environment for the VNet.
5. Provision a Log Analytics workspace, Container Registry, or bastion.
6. Configure Entra ID authentication on the MySQL server
   (`flexibleServers/administrators`) — database auth stays username/password.
7. Configure the identity provider. Bearer verification is HS256 only today;
   RS256/JWKS is unimplemented, so no Azure AD/Entra OIDC claim is made here.

## Validation: what to run before any deployment

Offline, no credentials needed — run these first, they are the exact steps that
could not run in the authoring environment:

```powershell
az bicep install                      # or: download bicep CLI for your OS
az bicep build --file infra/azure/main.bicep --outdir build/   # parse + type-check
az bicep lint  --file infra/azure/main.bicep
# Repeat build/lint for every file under infra/azure/modules/.
# Parameter files are plain JSON: parse-check them, then let ARM validate them
# with `az deployment group validate` below. (`az bicep build-params` *generates*
# a parameter file from a Bicep file — it does not check one.)
python -c "import json,sys; json.load(open(sys.argv[1], encoding='utf-8'))" infra/azure/params/dev.parameters.json
```

Online, needs a subscription (a scratch one is fine, nothing is created by
`validate`/`what-if`):

```powershell
az deployment group what-if --resource-group <rg> `
  --template-file infra/azure/main.bicep --parameters @infra/azure/params/dev.parameters.json
az deployment group validate --resource-group <rg> `
  --template-file infra/azure/main.bicep --parameters @infra/azure/params/dev.parameters.json
```

`az bicep build` also verifies the region-independent API/type assumptions below.

## Unverified items (resolve with Azure access)

Every one of these is plausible-but-uncompiled. `az bicep build` catches the type
errors; `what-if` catches the provider/region errors; the first real deployment
catches the rest.

| Item | Where | Why it is open | How to verify |
| --- | --- | --- | --- |
| MySQL `version: '8.4'` | `modules/mysql.bicep` | Only preview api-version `2025-06-01-preview` accepts 8.4; stable `2024-12-30` accepts `'5.7' \| '8.0.21'` | `az bicep build`, then `az mysql flexible-server ... --version 8.4` availability in the region |
| MySQL private-link `groupIds` value (`mysqlServer`) | `modules/mysql.bicep` (param) | Group id not confirmable offline; parameterised on purpose | `az network private-endpoint ...` / `az provider show` |
| `privatelink.mysql.database.azure.com` zone name | `modules/network.bicep` | Sovereign/regional clouds use a different suffix | `az network private-dns zone` + MySQL docs for the cloud |
| `PYTHON\|3.12` and `kind: 'linux'` | `modules/backend.bicep` | Exact supported patch strings and the Linux plan marker string need the live provider | `az webapp list-runtimes --os linux`; `az provider show --namespace Microsoft.Web` |
| `Microsoft.Web/staticSites` created without a repository (`provider: 'External'`) | `modules/frontend.bicep` | Prebuilt-artifact upload is the intended flow but the offline schema does not confirm which properties are required | `az bicep build` + `az staticwebapp create` comparison |
| `keyVaultReferenceIdentity` on the site | `modules/backend.bicep` | Property exists in newer API versions; not verified here | `az bicep build`; check `az webapp config accessor`/site JSON |
| VNet/subnet + private DNS api-versions (`2026-03-01`, `2024-06-01`) | `modules/network.bicep` | Latest stable per the template reference pages at authoring time | `az bicep build` (unknown version = hard error) |
| Subnet delegation string `Microsoft.DBforMySQL/flexibleServers` | `modules/network.bicep` | Delegation name not confirmable offline | `az network vnet subnet` + MySQL networking docs |
| `Microsoft.Insights/components@2020-02-02` workspace-based shape | `modules/monitoring.bicep` | Old but still the version the official Bicep guidance uses | `az bicep build`; `az monitor app-insights component create` |
| Key Vault `publicNetworkAccess` values | `modules/keyvault.bicep` | `Enabled \| Disabled` per the vault reference; the "AzureServices only" nuance is expressed with `networkAcls` | `az bicep build`; `az keyvault update` |
| Role definition id for "Key Vault Secrets User" | `main.bicep` | GUID verified against the built-in-roles page; GUIDs can differ per cloud | `az role definition list --name "Key Vault Secrets User"` |

## GitHub Actions side

`.github/workflows/azure-deploy.yml` deploys this shape (build → validate →
deploy, OIDC, protected environments). It is scaffolding too: it has never run,
and its Actions are pinned to version tags rather than commit SHAs, which
violates the repository's own convention (ADR-0019 /
docs/production-readiness.md section 9) and must be fixed before it is enabled.
