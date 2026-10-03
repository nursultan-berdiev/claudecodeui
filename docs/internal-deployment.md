# Internal CloudCLI deployment

This fork runs one CloudCLI server for a trusted team. Staff use separate local
CloudCLI accounts. Projects, sessions, the coding-agent runtime, and its Claude
Code/Codex credentials are shared by everyone who can use the service.

## Run with Docker Compose

The production image builds this checkout and includes both CLI programs. It
does not install the upstream published CloudCLI package. Docker Engine and
Compose v2 are required.

```bash
cp .env.docker.example .env.docker
docker compose --env-file .env.docker build
docker compose --env-file .env.docker up -d
curl -fsS http://127.0.0.1:3001/health
```

The initial port bind is loopback only. Open `http://127.0.0.1:3001` locally and
create the initial administrator before allowing other clients to reach the
service. In Settings → Users, that administrator creates staff accounts and can
disable accounts or reset local passwords. Staff can use the shared projects
and agent sessions. Only administrators can open the raw shell or change shared
provider configuration and plugins.

To serve a LAN, put an HTTPS reverse proxy in front of `127.0.0.1:3001`, or set
`CLOUDCLI_BIND_ADDRESS` to a trusted LAN address in `.env.docker` and restart
Compose. Direct HTTP carries the CloudCLI password and session token without
transport encryption, so HTTPS is the preferred team setup. Keep the Docker
port and any reverse proxy restricted to the intended internal network.

`cloudcli_home` persists the CloudCLI database, settings, and the `.claude` and
`.codex` homes. `cloudcli_workspaces` persists projects under `/workspace`.
Back up both volumes and protect the home volume as a credential store. Do not
copy OAuth files or API keys into the image, repository, or Compose file.

```bash
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs --tail=100 cloudcli
docker compose --env-file .env.docker exec cloudcli codex --version
docker compose --env-file .env.docker exec cloudcli claude --version
```

The initial administrator can sign the CLIs in from Settings → Agents. For a
headless Codex container, device-code login or a workspace service-account
access token may be more suitable when available. The provider login belongs
to the container's shared service user, not to a browser client. Provider usage
and limits are therefore shared too.

## Identity design and Active Directory integration

The existing login now accepts multiple local users. The first user is an
administrator; later users are created by an administrator. The user table has
`identity_provider` and `identity_subject` fields reserved for a directory
connector. `createLocalIdentityProvider` is the current credential verifier;
an AD verifier can replace or augment that boundary while continuing to issue
the application's own session token. Local password login must reject accounts
whose `identity_provider` is not `local`.

For on-premises AD DS, use LDAPS with certificate validation and map each user
by an immutable directory identifier such as `objectGUID`. For Microsoft Entra
ID, use OIDC authorization-code flow and map `issuer` plus `subject`. A later
connector must map approved groups to `admin` or `member`, handle removal from
the directory, and keep directory passwords out of the CloudCLI database. The
choice between LDAPS and OIDC needs the actual directory topology and group
names; neither connector is enabled in this release.

Browser users share one process and filesystem. Hiding another user's project
in the UI would not isolate it from coding agents that can run commands. A
private-workspace version needs separate user runners or containers, not only
project filters in HTTP routes. The current authorization model deliberately
keeps projects and sessions shared.

## Validation

Run `npm run typecheck`, the focused auth/database tests, `npm run build`, and
`docker compose --env-file .env.docker build`. In a disposable instance, verify
bootstrap, staff login, admin-only API/terminal access, password-reset token
revocation, account disable, audit events, and `/health`. Audit entries store
the actor, action path, result status, and timestamp; they never store request
bodies or credentials.
