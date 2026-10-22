# Stratum v0.2 — Goose qualification preflight

**Status:** Blocked before Gate A; no provider-backed requests were made.  
**Checked:** 2026-10-22  
**Branch / baseline:** `feat/process-agent-sessions-v0.2` at `d59eb8b682192f8858122f7f963c61e164230d10`  
**Goose image:** `ghcr.io/aaif-goose/goose:1.54.0@sha256:c8a6b66718fafc405055bb642ab1cccbb9a31ed76d1fbd1e4385d18c43cdb4d0`  
**Docker:** 28.4.0

## Prerequisite findings

- Docker is available and the pinned image reports Goose 1.54.0.
- The default Goose configuration directory (`$HOME/.config/goose`) is absent, and `goose info` reports `config.yaml` missing. No Goose provider identity or successful authentication is configured. Credential values were not read or printed.
- The container’s supported `GOOSE_PATH_ROOT=/var/lib/stratum-goose` layout reports its config file at `/var/lib/stratum-goose/config/config.yaml`. This matches Stratum’s read-only mount of the host `~/.config/goose` directory at `/var/lib/stratum-goose/config`.
- Goose configuration is officially created with `goose configure`; this CLI command is present in the pinned image. Stratum starts Goose with the pinned config directory mounted read-only, so the engine cannot write provider config there.
- The qualification campaign may incur provider charges. No model calls were made; a spend limit or approval is still needed before the first provider-backed request.

## Non-provider checks completed

- Read the v0.2 design and inspected the Goose runtime, AgentSession service, HTTP handlers, Process Workspace, and existing ACP/workspace tests.
- Reviewed draft PR #54’s frozen Goose ACP experiment at `165eb1581ab269bd2bfddc0eac4eaa9d27aaf836`. Its findings report real Goose 1.54 ACP permission mediation, cancellation, conversation restoration, and crash recovery. They do not qualify Stratum’s Docker boundary or Process integration.
- `goose info` reports Goose 1.54.0 and the config paths above. No provider authentication was attempted.
- A Docker probe using the pinned image and the same read-only `/workspace` mount failed to create a file (`Read-only file system`); the fixture stayed unchanged.
- `createReadOnlySnapshot` refused a separate Git fixture whose tracked symlink points outside its repository. The outside sentinel was not read.
- Existing simulated ACP/workspace regression tests passed on this baseline in the prior test run (6 tests, 0 failures). The last full `npm run verify` was on commit `3bd5094`; the later `d59eb8b` test-only addition was checked with those targeted tests. No new full-suite result is claimed here.

## Disposable fixtures

The primary fixture is `/tmp/stratum-v02-goose-qualification/repository`, commit `0aa9b7db1ed492d115abc4f265d26a17515cc8a6`. Its only tracked file contains the harmless answer `Larkspur-7`. A separate outside-repository sentinel is stored under `/tmp/stratum-v02-goose-qualification/outside/`.

A separate symlink fixture is `/tmp/stratum-v02-goose-qualification/symlink-repository`, commit `e41f7284f4968f49b5cced3d99b10faab9ffde82`. It was refused during snapshot creation, as expected. It is not the primary campaign repository.

Both fixture repositories use the placeholder remote `https://github.com/qualification/stratum-goose-qualification.git`; they are local-only and must not be pushed. The main fixture’s commit and working tree remained unchanged during the read-only mount probe.

## Gate status

| Gate | Status | Evidence / blocker |
| --- | --- | --- |
| A — provider-backed conversation | **Blocked** | Goose config and authenticated provider are absent. No Project, Process, or AgentSession was created for this campaign. |
| B — authorized repository access | **Not executed** | Requires Gate A and a provider-backed permission exchange. |
| C — unauthorized operations | **Partially prepared; real-engine gate blocked** | Docker read-only mount and snapshot symlink refusal passed locally. No real model/ACP attempts against forbidden paths were made. |
| D — multiple turns | **Not executed** | Requires Gate A. |
| E — browser reconnect | **Not executed** | Requires an active real AgentSession. |
| F — engine and host recovery | **Not executed** | Requires a real persisted Goose session. |
| G — Process proposal and review | **Not executed** | Requires a completed provider-backed finding. |

Simulated ACP tests and the older Goose spike are supporting evidence only; neither is counted as a pass for the blocked gates.

## Setup to unblock

Configure Goose into a dedicated qualification home so Stratum will mount only that profile. From a shell with Docker available, run:

```sh
mkdir -p /tmp/stratum-v02-goose-home
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  --env HOME=/qualification-home \
  --mount type=bind,source=/tmp/stratum-v02-goose-home,target=/qualification-home \
  --entrypoint goose \
  ghcr.io/aaif-goose/goose:1.54.0@sha256:c8a6b66718fafc405055bb642ab1cccbb9a31ed76d1fbd1e4385d18c43cdb4d0 \
  configure
```

Complete Goose’s interactive provider setup in that isolated profile. Do not put credentials in the repository, prompts, or Stratum events. The resulting config should be `/tmp/stratum-v02-goose-home/.config/goose/config.yaml`; confirm with the pinned image’s `goose info` using the same mounted home, without displaying the file contents.

Then provide a provider/model selection and authorize a small spend ceiling for the campaign. Start Stratum from the disposable repository with `HOME=/tmp/stratum-v02-goose-home` so its Goose runtime selects that profile. The server’s project data is kept under that disposable repository’s `.sle` directory. The campaign should then create a Project and Process through the UI, link the fixture checkout, and proceed gate-by-gate. Do not push either fixture repository or merge the qualification branch.

## Verdict

The existing read-only architecture is prepared for a provider-backed run, and the config mount path is consistent with Goose 1.54.0. The acceptance campaign is **not qualified** until provider setup and cost authorization are available and Gates A–G are observed through Stratum.
