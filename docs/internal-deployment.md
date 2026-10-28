# Internal CloudCLI deployment

This fork runs one CloudCLI server for a trusted team. Staff use separate local
CloudCLI accounts. Project source folders and the provider credentials are
shared. New chats are private to their creator until that creator shares them.

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
disable accounts or reset local passwords. Settings → Departments manages
departments and their members; a user can belong to several departments.
Staff can use shared projects and create private chats with New chat. Only administrators can open the raw shell or change shared
provider configuration and plugins.

Settings → Appearance → Workspace tabs lets each user hide or show Files;
administrators can also hide or show Terminal. These personal choices are
saved with the user's account and apply after signing in on another device.
Hiding the current tab returns to Chat. Git navigation and the upstream
star, issue-report and community links are removed from the interface.

The chat composer exposes Plan and Auto. Plan is the initial choice when no
mode has been saved; Codex uses a read-only sandbox for it. Auto runs shell
commands and file writes without manual tool approval. The dispatcher maps
this application preset to the provider's unattended execution controls,
not to Claude's classifier-based native `auto` mode. Human questions and plan
confirmation stay interactive. Selecting Auto also resumes ordinary tool
requests already waiting in the current chat. Legacy edit/bypass selections
are restored as Auto; the other legacy choices become Plan.

The Docker runtime includes Python, python-docx, openpyxl, pdftotext and unzip
for reading DOCX, XLSX and text-based PDFs during document workflows.

Agents read and edit Word and Excel files with `docli`, the KeyDev document
CLI. It is not published, so a deployment copies its wheel
(`docli-<version>-py3-none-any.whl`) into `docker/vendor/` before
`docker compose build`; the build stops when it is missing. The image installs
it into its own virtual environment and links it as `/usr/local/bin/docli`, so
Claude, Codex and the terminal find it on `PATH`.

The image also carries LibreOffice Writer and Calc (headless, no recommended
packages). `docli` reads only `.docx`, `.xlsx` and `.xlsm`, so the agent
instructions tell agents to convert a copy of a legacy `.doc` or `.xls` with
`soffice --headless --convert-to docx|xlsx` first and read the result with
`docli`. Each conversion runs in a subshell with a throwaway profile
(`-env:UserInstallation`), `timeout -k` (soffice ignores SIGTERM when hung) and
a `trap` that removes the temporary folder; the user's original file is never
touched.

Limits of the conversion, and what is accepted:

- Macros. The converted files come from users, so
  `docker/libreoffice-hardening.xcd` disables macro execution and sets the
  highest macro security level, both finalized so no profile can relax them.
- External links. A `.docx` with an externally linked image converted with
  the stock settings made no request to the linked URL (checked on the image
  on 29.10.2026). The settings that govern link updates are left at their
  defaults.
- Plan. The conversion is not on the read-only docli list, yet a live check
  on the local copy showed Claude running it in Plan without an approval
  request. Plan therefore does not reliably stop it; this is accepted, since
  the conversion only writes inside a temporary folder.

`docker/agent-instructions.md` tells every agent to use `docli word` and
`docli excel` instead of ad-hoc scripts. The image points
`CLOUDCLI_AGENT_INSTRUCTIONS_FILE` at it; the server appends the file to the
Claude Code system prompt and passes it to Codex as `developer_instructions`.
Edit that file to change what agents are told. In Plan, Claude runs the
read-only docli commands (`word read|tables|search|info`,
`excel sheets|read|cell|search|info`) without asking; Codex Plan already runs
commands in its read-only sandbox. A Bash prefix rule never approves a command
that chains, pipes, redirects or substitutes after the prefix; such a command
asks for approval instead.

The chat owner uses Share chat to grant access to their departments or the
entire company. Recipients can read and continue the chat, while changing its
sharing, renaming, editing past prompts and deleting it remain owner actions.
Access is checked for history, search, pagination, attachments, WebSocket
subscriptions, replay and live events. Removing a grant or a department member
also removes access to subsequent live events. Chats that existed before this
migration retain their previous company-wide visibility and are assigned to
the initial administrator. Newly indexed external CLI chats are private to that
administrator.
An older chat workspace pointing at the container user's home is migrated to
`/workspace/chats`. Its existing transcript and identifiers are retained, and
an indexing alias prevents later scans from restoring the old home path.

The separate Skills library is available from the sidebar. Users create or
import private skills, edit SKILL.md and supporting files, and share them with
selected departments or the company. Shared users can read and use a skill;
its owner and an administrator can edit it. Existing provider skills are
imported once as company skills. A run exports only authorized definitions.
In a shared chat, a skill must also be shared with the chat's audience before
it can be used, so private skill instructions do not get disclosed to that
audience. Skill edits apply on the next run.

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

The image sets `ENABLE_CLAUDEAI_MCP_SERVERS=false`. Connectors added to the
signed-in claude.ai account (Gmail, Google Drive, Calendar and others) would
otherwise be available to every user's agent runs, so the mailbox and files
of the account owner would be readable by all staff. Add tools for the team
as MCP servers in Settings instead.

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

These permissions are an application access boundary. Provider processes still
run under one service user in one container, and project source folders remain
shared. Arbitrary agent shell commands or the administrative shell can inspect
the service user's filesystem, including runtime transcripts. Full isolation
against such filesystem access requires separate runners/containers and is
not provided by these application grants. Deploy this runtime only for trusted
employees; the private chat UI/API does not provide a hostile-code sandbox.

## Validation

Run `npm run typecheck`, the focused auth/database tests, `npm run build`, and
`docker compose --env-file .env.docker build`. In a disposable instance, verify
bootstrap, staff login, admin-only API/terminal access, password-reset token
revocation, account disable, department grants, private/shared chat discovery
and stream revocation, skill owner editing, audience-scoped skill use, audit
events, and `/health`. Audit entries store
the actor, action path, result status, and timestamp; they never store request
bodies or credentials.
