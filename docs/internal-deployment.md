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
mode has been saved; Codex runs it in its sandbox with a permissions profile
that reads anything and writes only under `/tmp` (see "Codex sandbox" below).
Auto runs shell
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
commands in its sandbox. A Bash prefix rule never approves a command
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

### Codex sandbox

Codex runs every shell command of a sandboxed turn through bubblewrap, which
needs an unprivileged user namespace. Docker's default seccomp profile blocks
that, so in Plan every Codex command failed with `bwrap: No permissions to
create a new namespace`: Codex could not read attached `.docx`, `.xlsx`,
`.doc`, `.xls`, `.pdf` or even `.txt` files (images still worked, they reach
Codex as image input). Auto has no sandbox and was not affected.

`compose.yaml` therefore starts the container with
`docker/seccomp-codex-sandbox.json`: Docker's default profile
(moby/profiles@4b8214fc `seccomp/default.json`) unchanged, plus three rules:

- `clone` and `unshare` that create namespaces, but only together with a new
  user namespace (`CLONE_NEWUSER`); namespaces in the container's own user
  namespace stay blocked;
- `mount`, `pivot_root` and `umount2`, which bubblewrap needs inside that user
  namespace. Outside one the kernel still refuses them, since the container
  has no `CAP_SYS_ADMIN`.

The cost is a larger kernel surface: processes in the container may create
unprivileged user namespaces, which the default profile forbids.
`no-new-privileges` stays on. A deployment that overrides `security_opt` (for
example with `!reset` in a `compose.override.yaml`) must keep the seccomp entry,
or Codex Plan is back to reading no files.

Codex's built-in `read-only` sandbox forbids writes even to `/tmp`, so the
`.doc`/`.xls` recipe (a converted copy in a temporary folder) cannot run there.
When Codex honours it, Plan therefore passes no sandbox mode and instead
selects the named permissions profile `cloudcli-plan` by config
(`server/modules/providers/list/codex/codex-plan-profile.ts`):

- write only under `/tmp` (`:slash_tmp`); the project and `$HOME` stay
  read-only;
- network on: Codex's network-off sandbox refuses AF_INET sockets and
  LibreOffice then converts nothing;
- `$HOME` closed by default (an allow-list, not a deny-list): every entry of
  `$HOME` is denied, shell and git dotfiles included (`.profile`, `.bashrc`,
  `.gitconfig` can hold tokens), except three folders opened only in part:
  Codex's folder (`CODEX_HOME`, else `~/.codex`) keeps `skills` and `plugins`,
  `~/.agents` keeps `skills`, `~/.cloudcli` keeps `assets` (uploaded
  attachments), `skill-exports` and `session-skills`. Everything else there,
  including Codex's sign-in, every user's chats, CloudCLI's database and
  backups and browser-use profiles, is denied. A denied folder cannot re-allow
  a child, so these folders are denied entry by entry. Outside Docker, where
  projects can live in `$HOME`, a visible entry that holds the workspaces root
  or the chat's folder stays open. Hidden entries never do, listed or not
  (`.ssh`, `.aws`, `.config`, `.cargo`, `.vault-token`, ...): a chat working
  inside one cannot read its own folder, so the turn is refused. The chat's folder, the
  workspaces root and every entry are judged by where they lead after
  symlinks, so a link such as `~/work -> ~/.ssh` counts as hidden;
- Codex's secret files are also denied by name (`auth.json`, `sessions`,
  `archived_sessions`, `history.jsonl`, `log`), so these are covered even when
  Codex creates them during a turn. There are no glob rules inside Codex's
  folder: Codex expands a glob into every match below it, and a match inside
  an already denied folder (a chat transcript in `sessions`) stops bubblewrap
  from starting;
- the user database is denied wherever `DATABASE_PATH` puts it (resolved to an
  absolute path), with its `-wal`/`-shm` files and the `backups` folder next to
  it;
- `.env*` files anywhere under the workspaces root and the chat's folder are
  denied by a glob rule. A root that holds an existing denied folder or lies
  inside one gets no rule, for the same reason (the database files do not
  count, they are files). Outside Docker the workspaces root is
  `$HOME`, which holds denied paths, so there the chat's folder carries the
  rule. A root that itself contains glob syntax cannot carry the rule, so
  the turn is refused (see below);
- `allow_login_shell = false`: commands run in a plain shell, since a login
  shell would trip over the denied `~/.profile` on every command.

The folders are listed when a turn starts. Apart from the Codex files named
above, an entry created in `$HOME` during the turn (a new versioned state
database, say) is readable until the next turn. A folder that exists but
cannot be listed (anything but "does not exist") fails the run instead of
running Plan with fewer denials.

Before a Plan turn runs, the server checks the real profile on a throwaway
layout in Codex's sandbox (`codex-plan-check.ts`): a chat folder inside the
layout's home (next to a key folder, as outside Docker) and a workspaces root
outside it (as in Docker); a file in each, a skill and an attachment must
read; Codex's sign-in, a chat transcript deep in a denied folder, a history
file created after the rules were built, the key folder, a shell rc file and
`.env` files in both folders must be refused; `/tmp` must take a write and
the chat folder must not.

Until the profile passes, Plan turns are refused with an error in the chat
("Plan is unavailable: ..." with the reason). There is deliberately no
fallback to Codex's own `read-only` sandbox: it reads all of `$HOME`, so a
prompt injected through an attachment could print Codex's sign-in or the
user database into the reply even without network. Whether Plan gets network
when the profile does pass is the owner's decision; the profile keeps it on
for LibreOffice (see above). How long each answer holds:

- the profile is honoured: until the server restarts;
- Codex gets a rule wrong, or bubblewrap fails to start (recognised by the
  `bwrap: ...` line it prints, also behind a prefix, not by keywords):
  10 minutes, then the check runs again, so a fixed host recovers without a
  restart;
- the check cannot lay out its throwaway folder in the server's home
  (read-only or full disk): 1 minute, with its own message in the chat;
- the check cannot run for another reason (timeout, spawn failure): 1 minute,
  so turns do not each wait up to 20 seconds for it.

Turns that arrive while a check runs share it. The chat error holds a fixed
reason only; the check's detail (command line, absolute paths, bubblewrap
output) goes to the server log (`[Codex] Plan sandbox check ...`).

Plan also refuses a single turn, with a reason, when its profile cannot
protect that chat instead of running with a gap: the chat's folder (or the
workspaces root) has glob characters in its path (`* ? [ ] { } !`), so the
`.env` rule cannot match it literally; or the chat's folder lies in a part of
`$HOME` that Plan keeps closed, such as `~/.local/share/proj`. Rename the
folder, open the chat elsewhere, or use another mode.

The app-server transport sends the config as JSON; exec sends it as raw
`--config` overrides, because the SDK's own `config` flattens nested keys into
dotted paths and would split the file paths. Both were checked with Codex
CLI and SDK 0.156.1, which `package.json` pins exactly.

Remaining risk, accepted: an attachment can carry a prompt injection, and
Codex in Plan runs commands without approval and with network. What it can
still read and send out:

- every project under the workspaces root except `.env*` files, including
  other users' projects and any secret kept there under another name
  (`*.pem`, `*.key`, `.npmrc`, `config.json`, ...); a symlink or hard link to
  a `.env` file under another name is not caught either;
- the folders shared by all users: every uploaded attachment in
  `~/.cloudcli/assets` (not only the chat's own), the skills in
  `~/.cloudcli/skill-exports` and `~/.cloudcli/session-skills` (other users'
  chats' skills included), and `~/.codex/plugins` and `~/.agents/skills`,
  where a plugin's own config could hold a key;
- the rest of the file system outside `$HOME` (`/app`, `/etc`, `/opt`), which
  holds the application, not user secrets;
- entries created in `$HOME` during the running turn, other than Codex's
  files named above;
- outside Docker, where projects live in `$HOME`: the whole visible `$HOME`
  entry that holds the chat's folder (all of `~/code`, say, with every other
  project in it), and `.env*` files in other projects there (only the chat's
  own folder gets the rule); a chat whose folder is `$HOME` itself gets no
  `.env` rule at all. Secrets kept in a visible entry (`~/keys`, say) are
  readable when the chat works inside that entry: only hidden entries are
  closed regardless.

It can write to `/tmp`, which all sessions (Auto included) share. Plan is a
guard against accidental edits and against reading sign-ins and chat
histories, not an isolation boundary between users. In practice Codex also
declines to run commands that touch the denied paths, citing the policy, but
the denials do not depend on that.

Host requirements for the seccomp profile:

- Linux with unprivileged user namespaces enabled. On Debian kernels
  `kernel.unprivileged_userns_clone` must be 1; on Ubuntu 24.04 and later
  AppArmor restricts them (`kernel.apparmor_restrict_unprivileged_userns=1`),
  so Docker's AppArmor profile or that sysctl has to allow them. Checked on
  the WSL2 kernel 5.15 with Docker 24.0.7.
- Inside the sandbox bubblewrap mounts a fresh `/proc` for its own PID
  namespace, and Docker's `maskedPaths` do not apply to it. Checked: root-only
  files such as `/proc/kcore` and `/proc/timer_list` stay unreadable,
  `/proc/keys` lists only the `node` user's own keys, and the CloudCLI server
  process (with its environment) is not visible, since the sandbox has its own
  PID namespace.
- Docker Compose resolves `seccomp=./docker/...` against the project folder and
  inlines the JSON; checked with Compose 2.21.
- Snap-packaged Docker (crmtest) confines the daemon with its own AppArmor
  profile; check the profile there before relying on it.

Smoke check after a deploy (no output other than the host name means the
sandbox works; `bwrap: No permissions to create a new namespace` means the
profile is missing or the host forbids user namespaces):

```bash
docker exec -u node keydev-cloudcli-cloudcli-1 sh -c 'cd /tmp && codex sandbox -- cat /etc/hostname'
```

To update the profile from upstream, take `seccomp/default.json` from
moby/profiles, append the three rules marked `KeyDev addition` in their
`comment` field, and repeat the smoke check.

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
