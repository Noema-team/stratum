// D.3d — shared fixture repositories + Objective intents for the three
// define-work behavioral-maturity scenarios (early/partial/mature). Used
// by BOTH Layer A (tests/d3d-behavioral-qualification.test.ts, a scripted
// deterministic regression) and Layer B (scripts/eval-define-work.ts, the
// live-provider qualification runner) so both layers exercise identical
// inputs — the only thing that differs between them is which LLM answers
// the questions.
//
// Every fixture is a REAL Git-tracked working tree (tools.ts's read_file
// authority boundary only exposes `git ls-files`-tracked content — see
// path-safety.ts / tools.ts), never files merely present on disk.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface FixtureFile {
  path: string;
  content: string;
}

export type ConstraintType = 'must' | 'must_not' | 'prefer' | 'prefer_not';

export interface ObjectiveIntent {
  title: string;
  description: string;
  constraints: Array<{ description: string; type?: ConstraintType }>;
  successCriteria: Array<{ description: string; met?: boolean }>;
}

export async function materializeFixtureRepo(root: string, files: FixtureFile[]): Promise<void> {
  for (const file of files) {
    const abs = path.join(root, file.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content, 'utf-8');
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
}

// ============================================================================
// Scenario A — EARLY: Evershift multiplayer
// ============================================================================

export const EARLY_OBJECTIVE: ObjectiveIntent = {
  title: 'Make Evershift multiplayer-capable',
  description:
    'Two players should be able to share a real-time Evershift session together. Whether ' +
    'cross-platform support belongs in this increment is genuinely undecided — that is a real ' +
    'open product/architecture question, not yet a constraint. Client-side prediction with ' +
    'server reconciliation is a candidate synchronization approach, but whether that approach ' +
    'can actually meet the required latency/frame budget for real-time play has not been ' +
    'measured.',
  constraints: [],
  successCriteria: [{ description: 'Two players can join and play a shared real-time session together' }],
};

// The fixture makes "does this repository already have a networking layer?"
// answerable by reading exactly one tracked file — the model must discover
// this by repository inspection, never because the Objective states it.
export const EARLY_FIXTURE_FILES: FixtureFile[] = [
  {
    path: 'docs/architecture.md',
    content: `# Evershift Architecture

Evershift is a single-player game today. Current systems, each self-contained:

- rendering (src/render/)
- input handling (src/input/)
- physics (src/physics/)
- save/load (src/persistence/)
- inventory (src/inventory/)
- AI-controlled NPCs (src/ai/)

There is no network transport, session management, or multiplayer synchronization code
anywhere in this repository. Every system above assumes a single local player and a single
local simulation tick — there is no concept of a remote peer, a server authority, or state
replication of any kind.
`,
  },
  {
    path: 'src/physics/tick.ts',
    content: `// Fixed-timestep local simulation tick — no network awareness.
export function step(dtMs: number): void {
  // local-only simulation advance
}
`,
  },
  {
    path: 'README.md',
    content: `# Evershift

A single-player action game. See docs/architecture.md for current systems.
`,
  },
];

// ============================================================================
// Scenario B — PARTIAL: faction/loyalty/dialogue/trade
// ============================================================================

export const PARTIAL_OBJECTIVE: ObjectiveIntent = {
  title: 'Factions affect NPC dialogue and trade',
  description:
    'Settlements have factions. NPCs have loyalty. Faction relations affect dialogue and ' +
    'trade. Combat is explicitly out of scope for this increment.',
  constraints: [{ description: 'Combat is out of scope for this increment', type: 'must_not' as const }],
  successCriteria: [{ description: 'An NPC\'s dialogue and trade prices reflect their faction\'s relation to the player' }],
};

export const PARTIAL_FIXTURE_FILES: FixtureFile[] = [
  {
    path: 'docs/architecture.md',
    content: `# Evershift Architecture — Settlements

Settlements each belong to one Faction (src/npc/faction.ts). NPCs (src/npc/npc.ts) each carry
a loyalty value toward their home Faction. The dialogue engine (src/dialogue/dialogue-engine.ts)
already selects dialogue lines by NPC disposition; faction relation is not yet one of its
inputs. The trade post (src/trade/trade-post.ts) already applies a price multiplier; faction
relation is not yet one of its inputs either.

Combat (src/combat/) is a separate, self-contained system with no dependency on faction or
dialogue state, and is not touched by this change.
`,
  },
  {
    path: 'src/npc/faction.ts',
    content: `export interface Faction {
  id: string;
  name: string;
  // Relation to the player, from -100 (hostile) to 100 (allied).
  playerRelation: number;
}
`,
  },
  {
    path: 'src/npc/npc.ts',
    content: `import type { Faction } from './faction.js';

export interface Npc {
  id: string;
  name: string;
  factionId: string;
  // Loyalty to their own faction, 0-100.
  loyalty: number;
}

export function npcFaction(npc: Npc, factions: Faction[]): Faction | undefined {
  return factions.find((f) => f.id === npc.factionId);
}
`,
  },
  {
    path: 'src/dialogue/dialogue-engine.ts',
    content: `import type { Npc } from '../npc/npc.js';

export type Disposition = 'friendly' | 'neutral' | 'wary' | 'hostile';

// Selects a dialogue line by NPC disposition. Faction relation is NOT yet
// one of the inputs here — this is exactly what the current bounded scope
// needs to change.
export function selectDialogueLine(npc: Npc, disposition: Disposition): string {
  return \`[\${disposition}] \${npc.name} has nothing more to say.\`;
}
`,
  },
  {
    path: 'src/trade/trade-post.ts',
    content: `import type { Npc } from '../npc/npc.js';

// Applies a price multiplier at this NPC's trade post. Faction relation is
// NOT yet one of the inputs here — this is exactly what the current
// bounded scope needs to change.
export function priceMultiplier(npc: Npc): number {
  return 1.0;
}
`,
  },
  {
    path: 'src/combat/combat.ts',
    content: `// Self-contained combat resolution — no dependency on faction or dialogue
// state. Out of scope for the current bounded increment.
export function resolveHit(): void {}
`,
  },
];

// ============================================================================
// Scenario C — MATURE: GET /objectives/:id/history
// ============================================================================

export const MATURE_OBJECTIVE: ObjectiveIntent = {
  title: 'Add GET /objectives/:id/history',
  description:
    'Add GET /objectives/:id/history. It returns the Objective\'s recorded status transitions. ' +
    'Follow the existing GET /objectives/:id route pattern and workspace guard. Do not add a ' +
    'new entity or event type. 404 when the Objective is absent/inaccessible. Acceptance: the ' +
    'request returns the ordered transition history for an accessible Objective.',
  constraints: [
    { description: 'Do not add a new entity or event type', type: 'must_not' as const },
    { description: 'Follow the existing GET /objectives/:id route pattern and workspace guard', type: 'must' as const },
  ],
  successCriteria: [{ description: 'Request returns the ordered transition history for an accessible Objective; 404 when absent/inaccessible' }],
};

export const MATURE_FIXTURE_FILES: FixtureFile[] = [
  {
    path: 'src/api/routes/objectives.ts',
    content: `import { Router } from './router-types.js';
import { objectiveRepo } from '../../storage/objective-repo.js';
import { requireWorkspaceAccess } from '../guards/workspace-guard.js';

export const router = new Router();

router.get('/objectives/:id', requireWorkspaceAccess, async (req, res) => {
  const objective = await objectiveRepo.findById(req.params.id);
  if (!objective || objective.workspaceId !== req.workspace.id) {
    return res.status(404).end();
  }
  res.json(objective);
});
`,
  },
  {
    path: 'src/api/guards/workspace-guard.ts',
    content: `import type { Request, Response, NextFunction } from './router-types.js';

// Attaches req.workspace from the authenticated session, or responds 401/403.
// Every route that reads workspace-scoped data uses this guard.
export function requireWorkspaceAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.workspaceId) {
    res.status(401).end();
    return;
  }
  req.workspace = { id: req.session.workspaceId };
  next();
}
`,
  },
  {
    path: 'src/domain/objective-events.ts',
    content: `// The existing event/history source: every Objective status transition is
// already recorded here as it happens. GET /objectives/:id/history reads
// from this — no new entity or event type is needed.
export interface ObjectiveStatusEvent {
  id: string;
  objectiveId: string;
  fromStatus: string;
  toStatus: string;
  occurredAt: string;
}

export interface ObjectiveEventRepository {
  listByObjective(objectiveId: string): Promise<ObjectiveStatusEvent[]>; // ordered by occurredAt ascending
}
`,
  },
  {
    path: 'src/api/routes/router-types.ts',
    content: `export class Router {
  get(_path: string, ..._handlers: unknown[]): void {}
}
export interface Request { params: Record<string, string>; session?: { workspaceId?: string }; workspace?: { id: string } }
export interface Response { status(code: number): Response; json(body: unknown): void; end(): void }
export type NextFunction = () => void;
`,
  },
];

// ============================================================================
// Decision resolution policy — used identically by Layer A (which controls
// the exact option ids it scripts) and Layer B (which does not, and must
// choose among whatever options the live model actually offers). Matching
// by keyword rather than a fixed id is the point: neither layer may key to
// one exact option id the workflow does not itself guarantee (see D.3d
// spec item 4).
// ============================================================================

const SAME_PLATFORM_KEYWORDS = ['same-platform', 'same platform', 'single-platform', 'single platform', 'one platform'];

export function findSamePlatformOnlyOption<T extends { id: string; label: string; description?: string }>(
  options: T[],
): T | undefined {
  return options.find((o) => {
    const text = `${o.id} ${o.label} ${o.description ?? ''}`.toLowerCase();
    return SAME_PLATFORM_KEYWORDS.some((kw) => text.includes(kw));
  });
}
