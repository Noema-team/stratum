import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { formatAppRoute, parseAppRoute } from './routing.js';
import { agentEventElementId, agentFindingDraftKey, createAgentFindingDraft, updateAgentFindingDraft, type AgentFindingDraft } from './agent-session-finding.js';
import { clearPendingAgentPrompt, readPendingAgentPrompt, savePendingAgentPrompt, type PendingAgentPrompt } from './agent-session-prompt.js';

type Project = { id: string; name: string; description?: string; status: string };
type Objective = { id: string; title: string; status: string };
type Repository = { id: string; provider: string; remote: string; defaultBranch: string; status: string; localWorkspace?: string };
type AgentSession = { id: string; projectId: string; processId?: string; repositoryId?: string; repositoryRemote?: string; repositoryCommit?: string; explorationLabel?: string; workspaceMode: 'repository_snapshot'|'empty'; lifecycle: string; errorMessage?: string; createdAt: string; updatedAt: string; lastEventSeq: number };
type AgentEvent = { seq: number; eventType: string; payload: Record<string, unknown>; createdAt: string };
type AgentPermission = { id: string; operation: Record<string, unknown>; status: string };
type AgentOperation = { id: string; idempotencyKey: string; kind: string; promptText: string; status: string };
type Process = { id: string; projectId: string; objectiveId?: string; title: string; intent: string; desiredOutcomes: string[]; constraints: string[]; lifecycle: 'active'|'paused'|'completed'|'cancelled'; currentFocus: string; repositoryIds: string[]; attention?: string; nextAction?: string; unresolvedCount: number; lastActivity?: Activity; createdAt: string; updatedAt: string };
type Activity = { id: string; processId: string; processTitle?: string; kind: string; title: string; body: string; outcome?: string; proposalId?: string; amendmentId?: string; definitionVersion?: number; sourceAgentSessionId?: string; sourceEventSeq?: number; createdAt: string };
type PendingProposal = { id: string; title: string; createdAt: string };
type Proposal = { id: string; title: string; body: string; status: string; createdAt: string };
type Amendment = { id: string; processId: string; baseVersion: number; definition: { title: string; intent: string; desiredOutcomes: string[]; constraints: string[]; objectiveId?: string | null; repositoryIds: string[] }; reason: string; status: 'proposed'|'accepted'|'rejected'; proposedBy: string; proposedAt: string; decidedBy?: string; decidedAt?: string };
type DefinitionVersion = Amendment['definition'] & { version: number; reason: string; authorizedBy: string; acceptedAt: string; amendmentId?: string };
type Envelope<T> = { ok: true; data: T } | { ok: false; error: { message: string } };

function explorationTitle(session: AgentSession): string {
  const question = session.explorationLabel?.replace(/\s+/g, ' ').trim();
  if (!question) return `New exploration · ${session.id.slice(0, 8)}`;
  const excerpt = question.length > 62 ? `${question.slice(0, 59).trimEnd()}…` : question;
  return `${excerpt} · ${session.id.slice(0, 6)}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('stratum_token');
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers } });
  const result = await response.json() as Envelope<T>;
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [route, setRoute] = useState(() => parseAppRoute(window.location.hash));
  const projectId = route.projectId;
  const selectedId = route.processId ?? '';
  const [processes, setProcesses] = useState<Process[]>([]);
  const [activityFeed, setActivityFeed] = useState<Activity[]>([]);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [explorations, setExplorations] = useState<AgentSession[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [showExplorationCreate, setShowExplorationCreate] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const projectLoadGeneration = useRef(0);
  const loadedProjectId = useRef('');
  const [pendingProposals, setPendingProposals] = useState<PendingProposal[]>([]);
  const [deferredProposals, setDeferredProposals] = useState<Proposal[]>([]);
  const [allProposals, setAllProposals] = useState<Proposal[]>([]);
  const [amendments, setAmendments] = useState<Amendment[]>([]);
  const [definitionVersions, setDefinitionVersions] = useState<DefinitionVersion[]>([]);
  const selectedProject = projects.find(project => project.id === projectId);
  const selected = processes.find(process => process.id === selectedId);
  const attention = useMemo(() => processes.filter(process => process.lifecycle === 'active').length, [processes]);

  function navigate(nextProjectId: string, nextProcessId?: string, nextProposalId?: string, nextExplorationId?: string) {
    const url = formatAppRoute({ projectId: nextProjectId, processId: nextProcessId || undefined, proposalId: nextProposalId || undefined, explorationId: nextExplorationId || undefined });
    if (`${window.location.pathname}${window.location.hash}` !== url) window.history.pushState({}, '', url);
    setRoute(parseAppRoute(window.location.hash));
  }
  function setProjectId(id: string) { navigate(id); }
  function setSelectedId(id: string) { navigate(projectId, id || undefined); }

  async function loadProjects() {
    setLoading(true); setError('');
    try {
      const rows = await api<Project[]>('/projects'); setProjects(rows);
      const next = rows.some(project => project.id === projectId) ? projectId : rows[0]?.id ?? '';
      if (next !== projectId) navigate(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load projects'); }
    finally { setLoading(false); }
  }
  async function loadProject(id: string) {
    const generation = ++projectLoadGeneration.current;
    setLoading(true);
    if (!id) { setProcesses([]); setObjectives([]); setRepositories([]); setActivityFeed([]); setExplorations([]); loadedProjectId.current = ''; setLoading(false); return; }
    if (loadedProjectId.current !== id) { setProcesses([]); setObjectives([]); setRepositories([]); setActivityFeed([]); setExplorations([]); }
    try {
      const [nextProcesses, nextObjectives, nextRepositories, nextActivity, nextExplorations] = await Promise.all([api<Process[]>(`/projects/${id}/processes`), api<Objective[]>(`/projects/${id}/objectives`), api<Repository[]>(`/projects/${id}/repositories`), api<Activity[]>(`/projects/${id}/activity?limit=12`), api<{ sessions: AgentSession[] }>(`/projects/${id}/explorations`)]);
      if (generation !== projectLoadGeneration.current) return;
      setProcesses(nextProcesses); setObjectives(nextObjectives); setRepositories(nextRepositories); setActivityFeed(nextActivity); setExplorations(nextExplorations.sessions);
      loadedProjectId.current = id;
      if (selectedId && !nextProcesses.some(process => process.id === selectedId)) setSelectedId('');
    } catch (cause) { if (generation === projectLoadGeneration.current) { setError(cause instanceof Error ? cause.message : 'Could not load project'); if (projectId) navigate(''); } }
    finally { if (generation === projectLoadGeneration.current) setLoading(false); }
  }
  async function refreshExplorations(id: string) {
    if (!id) return;
    const result = await api<{ sessions: AgentSession[] }>(`/projects/${id}/explorations`);
    setExplorations(result.sessions);
  }
  useEffect(() => { const onPopState = () => setRoute(parseAppRoute(window.location.hash)); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState); }, []);
  useEffect(() => { void loadProjects(); }, []);
  useEffect(() => { void loadProject(projectId); return () => { projectLoadGeneration.current++; }; }, [projectId]);
  useEffect(() => {
    if (!selectedId) { setActivity([]); setPendingProposals([]); setDeferredProposals([]); setAllProposals([]); setAmendments([]); setDefinitionVersions([]); return; }
    let current = true;
    api<{ process: Process; activity: Activity[]; pendingProposals: PendingProposal[]; deferredProposals: Proposal[]; proposals: Proposal[]; amendments: Amendment[]; definitionVersions: DefinitionVersion[] }>(`/processes/${selectedId}`).then(data => { if (current) { setActivity(data.activity); setPendingProposals(data.pendingProposals); setDeferredProposals(data.deferredProposals); setAllProposals(data.proposals); setAmendments(data.amendments); setDefinitionVersions(data.definitionVersions); } }).catch(cause => { if (current) { setError(cause.message); setSelectedId(''); } });
    return () => { current = false; };
  }, [selectedId, processes]);

  async function createProcess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      const process = await api<Process>(`/projects/${projectId}/processes`, { method: 'POST', body: JSON.stringify({ title: form.get('title'), intent: form.get('intent'), objectiveId: form.get('objectiveId') || undefined, repositoryIds: form.getAll('repositoryIds').map(String), desiredOutcomes: String(form.get('outcomes') || '').split('\n').map(s => s.trim()).filter(Boolean), constraints: String(form.get('constraints') || '').split('\n').map(s => s.trim()).filter(Boolean) }) });
      setShowCreate(false); await loadProject(projectId); setSelectedId(process.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create Process'); }
  }
  async function createExploration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const repositoryId = String(new FormData(event.currentTarget).get('repositoryId') || '');
    try {
      const result = await api<{ session: AgentSession }>(`/projects/${projectId}/explorations`, { method: 'POST', body: JSON.stringify({ repositoryId: repositoryId || undefined }) });
      setShowExplorationCreate(false); await loadProject(projectId); navigate(projectId, undefined, undefined, result.session.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start exploration'); }
  }
  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      const project = await api<Project>('/projects', { method: 'POST', body: JSON.stringify({ name: form.get('name'), description: form.get('description') }) });
      setProjects(current => [...current, project]); navigate(project.id); setShowProjectCreate(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create project'); }
  }
  async function addReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const kind = String(form.get('kind'));
      await api(`/processes/${selected.id}/activity`, { method: 'POST', body: JSON.stringify({ kind, title: form.get('title'), body: form.get('body'), outcome: form.get('outcome') || undefined, proposalId: kind === 'review' ? form.get('proposalId') : undefined }) });
      formElement.reset(); await loadProject(projectId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save update'); }
  }
  async function recordAgentFinding(kind: 'update'|'proposal', title: string, body: string, source: { sessionId: string; eventSeq: number }) {
    if (!selected) throw new Error('The Process is no longer available');
    try {
      await api(`/processes/${selected.id}/activity`, { method: 'POST', body: JSON.stringify({ kind, title, body: `Agent claim from Goose AgentSession. Human-recorded for review; not independently verified.\n\n${body}`, sourceAgentSessionId: source.sessionId, sourceEventSeq: source.eventSeq }) });
      const data = await api<{ process: Process; activity: Activity[]; pendingProposals: PendingProposal[]; deferredProposals: Proposal[]; proposals: Proposal[]; amendments: Amendment[]; definitionVersions: DefinitionVersion[] }>(`/processes/${selected.id}`);
      setActivity(data.activity); setPendingProposals(data.pendingProposals); setDeferredProposals(data.deferredProposals); setAllProposals(data.proposals); setAmendments(data.amendments); setDefinitionVersions(data.definitionVersions);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not record agent finding'); throw cause; }
  }

  async function reviewProposal(proposalId: string, outcome: string, body: string) {
    if (!selected) throw new Error('The Process is no longer available');
    await api(`/processes/${selected.id}/activity`, { method: 'POST', body: JSON.stringify({ kind: 'review', title: ({ accepted: 'Direction accepted', revise: 'Revision requested', deferred: 'Proposal deferred', rejected: 'Proposal rejected' } as Record<string, string>)[outcome], body, outcome, proposalId }) });
    await loadProject(projectId);
  }
  async function setLifecycle(lifecycle: Process['lifecycle'], outcome?: string, acknowledgeUnresolved = false) {
    if (!selected) return;
    try { await api(`/processes/${selected.id}/lifecycle`, { method: 'PATCH', body: JSON.stringify({ lifecycle, outcome, acknowledgeUnresolved }) }); await loadProject(projectId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update Process'); }
  }

  async function submitAmendment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    const form = new FormData(event.currentTarget);
    try {
      await api(`/processes/${selected.id}/amendments`, { method: 'POST', body: JSON.stringify({ reason: form.get('reason'), definition: {
        title: form.get('title'), intent: form.get('intent'), objectiveId: String(form.get('objectiveId') || '') || null, repositoryIds: form.getAll('repositoryIds').map(String), desiredOutcomes: String(form.get('outcomes') || '').split('\n').map(value => value.trim()).filter(Boolean),
        constraints: String(form.get('constraints') || '').split('\n').map(value => value.trim()).filter(Boolean),
      } }) });
      event.currentTarget.reset(); await loadProject(projectId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not propose amendment'); }
  }

  async function decideAmendment(amendmentId: string, decision: 'accept'|'reject') {
    if (!selected) return;
    try { await api(`/processes/${selected.id}/amendments/${amendmentId}/decision`, { method: 'POST', body: JSON.stringify({ decision }) }); await loadProject(projectId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not decide amendment'); }
  }

  async function reopenProposal(proposalId: string) {
    if (!selected) return;
    try { await api(`/processes/${selected.id}/proposals/${proposalId}/reopen`, { method: 'POST' }); await loadProject(projectId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reopen proposal'); }
  }

  return <div className="shell">
    <aside className="rail"><a className="brand" href="/app/" aria-label="Stratum home"><span className="brand-mark">S</span><span>stratum</span></a>
      <div className="rail-label">WORKSPACE</div><div className="project-select-row"><label className="project-picker"><span className="sr-only">Project</span><select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Select project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button className="project-add" title="Create project" onClick={() => setShowProjectCreate(true)}>＋</button></div>
      <div className="rail-label rail-section">PROJECT</div><button className={`rail-link ${!selected && !route.explorationId ? 'active' : ''}`} onClick={() => setSelectedId('')}><span>◫</span> Overview</button>
      {explorations.length > 0 && <><div className="rail-label rail-section row-label">EXPLORATIONS <span>{explorations.length}</span></div><div className="process-nav">{explorations.slice(0, 5).map(item => <button key={item.id} title={`AgentSession ${item.id}`} className={`rail-link process-link ${route.explorationId === item.id ? 'active' : ''}`} onClick={() => navigate(projectId, undefined, undefined, item.id)}><i className={`dot ${item.lifecycle}`}/><span className="exploration-nav-copy"><span className="clip">{explorationTitle(item)}</span><small className="clip">{item.repositoryRemote ? `${item.repositoryRemote.split('/').slice(-2).join('/')} · ${item.repositoryCommit?.slice(0,12) || 'commit unavailable'}` : 'No repository · empty workspace'}</small></span></button>)}</div></>}
      <div className="rail-label rail-section row-label">PROCESSES <span>{processes.length}</span></div>
      <div className="process-nav">{processes.map(process => <button key={process.id} className={`rail-link process-link ${selectedId === process.id ? 'active' : ''}`} onClick={() => setSelectedId(process.id)}><i className={`dot ${process.lifecycle}`}/><span className="clip">{process.title}</span></button>)}
        {!processes.length && <div className="rail-empty">No processes yet</div>}</div>
      <button className="rail-new" onClick={() => setShowCreate(true)} disabled={!projectId}>＋ <span>New process</span></button>
      <div className="rail-bottom"><div className="avatar">{selectedProject?.name.slice(0,1).toUpperCase() || 'S'}</div><div><strong>{selectedProject?.name || 'No project'}</strong><small>Local workspace</small></div><span className="more">···</span></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="breadcrumbs"><span>{selectedProject?.name || 'Projects'}</span>{selected && <><b>/</b><span>{selected.title}</span></>}{route.explorationId && <><b>/</b><span>Exploration</span></>}</div><div className="top-actions"><span className="live-dot"/> Conversation history is saved <button className="icon-button" title="Refresh" onClick={() => void loadProject(projectId)}>↻</button></div></header>
      {error && <div className="toast-error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
      {loading || (projectId && loadedProjectId.current !== projectId) ? <div className="loading">Loading your workspace…</div> : !projectId ? <section className="empty-state"><div className="empty-icon">⌂</div><h1>Your projects live here</h1><p>Create or connect a project to begin tracking ongoing work.</p></section> : selected ? <ProcessDetail process={selected} activity={activity} pendingProposals={pendingProposals} deferredProposals={deferredProposals} proposals={allProposals} amendments={amendments} definitionVersions={definitionVersions} objectives={objectives} repositories={repositories} proposalTargetId={route.proposalId} onNavigateProposal={proposalId => navigate(projectId, selected.id, proposalId)} onBack={() => setSelectedId('')} onReview={addReview} onReviewProposal={reviewProposal} onLifecycle={setLifecycle} onAmendment={submitAmendment} onAmendmentDecision={decideAmendment} onReopenProposal={reopenProposal} onRecordAgentFinding={recordAgentFinding}/> : route.explorationId ? <ProjectExplorationDetail key={route.explorationId} projectId={projectId} explorationId={route.explorationId} repositories={repositories} onBack={() => navigate(projectId)} onExplorationsChanged={() => void refreshExplorations(projectId)}/> : route.proposalId ? <section className="empty-state"><h1>Proposal unavailable</h1><p>This proposal is not part of the selected Process or Project.</p><button className="button secondary" onClick={() => setSelectedId('')}>Return to Project</button></section> : <section className="overview">
        <div className="page-heading"><div><div className="eyebrow">PROJECT OVERVIEW</div><h1>{selectedProject?.name}</h1><p>{selectedProject?.description || 'A clear view of the work, decisions, and next steps moving this project forward.'}</p></div><div className="heading-actions"><button className="button secondary" onClick={() => setShowExplorationCreate(true)}>＋ Start exploration</button><button className="button primary" onClick={() => setShowCreate(true)}>＋ New process</button></div></div>
        <div className="summary-grid"><div className="summary-card"><span className="summary-icon violet">◫</span><div><strong>{attention}</strong><span>Active processes</span></div></div><div className="summary-card"><span className="summary-icon amber">◇</span><div><strong>{processes.filter(process => process.lifecycle === 'paused').length}</strong><span>Paused</span></div></div><div className="summary-card"><span className="summary-icon green">✓</span><div><strong>{processes.filter(process => process.lifecycle === 'completed').length}</strong><span>Completed</span></div></div></div>
        {processes.some(process => process.nextAction && process.attention && !['completed','cancelled'].includes(process.lifecycle)) && <div className="attention-panel"><div className="attention-heading"><span>◇</span><div><strong>Needs your attention</strong><small>Actions are derived from recorded decisions and lifecycle.</small></div><b>{processes.filter(process => process.nextAction && process.attention && !['completed','cancelled'].includes(process.lifecycle)).length}</b></div><div className="attention-items">{processes.filter(process => process.nextAction && process.attention && !['completed','cancelled'].includes(process.lifecycle)).map(process => <button key={process.id} onClick={() => setSelectedId(process.id)}><span><strong>{process.title}</strong><small>{process.nextAction}</small></span><span>Open →</span></button>)}</div></div>}
        <div className="section-head"><div><h2>Explorations</h2><p>Persistent conversations for questions and investigation. Agent findings remain claims, not accepted Project knowledge.</p></div><button className="text-button" onClick={() => setShowExplorationCreate(true)}>＋ Start exploration</button></div>
        {explorations.length ? <div className="process-list exploration-list">{explorations.map(item => <button className="process-card exploration-card" key={item.id} title={`AgentSession ${item.id}`} onClick={() => navigate(projectId, undefined, undefined, item.id)}><div className="card-top"><span className={`status ${item.lifecycle}`}><i/> {item.lifecycle.replaceAll('_',' ')}</span><span className="card-time">Updated {new Date(item.updatedAt).toLocaleDateString()}</span></div><h3>{explorationTitle(item)}</h3><p>{item.repositoryRemote ? `${item.repositoryRemote} · ${item.repositoryCommit ? `pinned read-only snapshot ${item.repositoryCommit.slice(0,12)}` : 'repository identity'}` : 'No repository · private empty read-only workspace'}</p><div className="card-bottom"><span className="focus-chip">Exploration · persistent conversation</span></div></button>)}</div> : <div className="first-process exploration-empty"><div className="empty-icon">⌕</div><h3>Start with a question</h3><p>Explore an idea in this Project without creating a Process. Choose no repository or one linked repository; findings remain unverified claims.</p><button className="button secondary" onClick={() => setShowExplorationCreate(true)}>Start an exploration</button></div>}
        <div className="section-head"><div><h2>Ongoing processes</h2><p>Intentions that persist across conversations, decisions, and iterations.</p></div><button className="text-button" onClick={() => setShowCreate(true)}>＋ Add process</button></div>
        {processes.length ? <div className="process-list">{processes.map(process => <button className="process-card" key={process.id} onClick={() => setSelectedId(process.id)}><div className="card-top"><span className={`status ${process.lifecycle}`}><i/> {process.lifecycle}</span><span className="card-time">Updated {new Date(process.updatedAt).toLocaleDateString()}</span></div><h3>{process.title}</h3><p>{process.intent}</p><div className="card-bottom"><span className="focus-chip">Lifecycle · {process.lifecycle}</span>{process.nextAction && <span className="next-action-chip">Next: {process.nextAction}</span>}{process.unresolvedCount > 0 && <span className="attention-chip">{process.unresolvedCount} unresolved</span>}{process.objectiveId && <span className="objective-chip">Linked objective</span>}</div></button>)}</div> : <div className="first-process"><div className="empty-icon">✳</div><h3>Start with what you want to move forward</h3><p>A Process keeps the intent, decisions, and outcome together, even when the work takes more than one session.</p><button className="button primary" onClick={() => setShowCreate(true)}>Create your first process</button></div>}
        {activityFeed.length > 0 && <div className="recent-changes"><div className="section-head"><div><h2>Recent changes</h2><p>Project activity in chronological order.</p></div></div>{activityFeed.map(item => <button key={item.id} onClick={() => setSelectedId(item.processId)}><span><strong>{item.title}</strong><small>{item.processTitle} · {item.body}</small></span><time>{new Date(item.createdAt).toLocaleDateString()}</time></button>)}</div>}
        <div className="lower-grid"><div className="lower-card"><div className="lower-title"><span className="small-icon">◎</span><h3>Project context</h3></div><p>Objectives describe outcomes. Processes capture the ongoing effort toward them. WorkItems remain separately authorized execution.</p><button className="text-button" onClick={() => window.location.href='/'}>Open execution control plane ↗</button></div><div className="lower-card"><div className="lower-title"><span className="small-icon blue-text">⌁</span><h3>Repository connections</h3></div><p>Repositories are project-linked code resources. A shared repository keeps each project’s process history separate.</p><span className="muted-note">{repositories.length} linked repositories</span><form className="repo-link-form" onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api(`/projects/${projectId}/repositories`, { method: 'POST', body: JSON.stringify({ remote: form.get('remote'), defaultBranch: form.get('defaultBranch') || 'main', localWorkspace: form.get('localWorkspace') || undefined }) }); event.currentTarget.reset(); await loadProject(projectId); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not link repository'); } }}><input name="remote" required placeholder="https://github.com/owner/repository"/><input name="defaultBranch" placeholder="Default branch · main"/><input name="localWorkspace" placeholder="Absolute local checkout path (optional)"/><button className="text-button">＋ Link repository</button></form>{repositories.map(repo => <div className="repo-row" key={repo.id}><span>⌁</span><strong>{repo.remote.split('/').slice(-2).join('/')}</strong><small>{repo.localWorkspace ? 'Local checkout ready' : repo.defaultBranch}</small></div>)}</div></div>
      </section>}
    </main>
    {showExplorationCreate && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowExplorationCreate(false); }}><form className="modal project-modal" onSubmit={createExploration}><div className="modal-head"><div><div className="eyebrow">PROJECT EXPLORATION</div><h2>Choose repository context</h2></div><button type="button" className="icon-button" onClick={() => setShowExplorationCreate(false)}>×</button></div><label>Repository context<select name="repositoryId" defaultValue=""><option value="">No repository · private empty workspace</option>{repositories.map(repository => <option key={repository.id} value={repository.id} disabled={!repository.localWorkspace || repository.status !== 'active'}>{repository.remote} · {repository.localWorkspace && repository.status === 'active' ? 'read-only snapshot' : 'local active checkout required'}</option>)}</select></label><div className="claim-note">No Process will be created. The conversation is Project-owned. With no repository, Goose receives an empty workspace. A selected repository is pinned to its current commit and mounted read-only. You can ask your first question after the session starts.</div><div className="modal-foot"><span>Goose availability is checked when the session starts.</span><button type="button" className="button secondary" onClick={() => setShowExplorationCreate(false)}>Cancel</button><button className="button primary">Start exploration</button></div></form></div>}
    {showCreate && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowCreate(false); }}><form className="modal" onSubmit={createProcess}><div className="modal-head"><div><div className="eyebrow">NEW PROCESS</div><h2>What do you want to move forward?</h2></div><button type="button" className="icon-button" onClick={() => setShowCreate(false)}>×</button></div><label>Process name<input name="title" required maxLength={160} placeholder="e.g. Improve NPC movement" autoFocus/></label><label>Intent<textarea name="intent" required maxLength={10000} placeholder="Why does this matter, and what should change?"/></label><label>Related objective <select name="objectiveId"><option value="">None for now</option>{objectives.map(objective => <option key={objective.id} value={objective.id}>{objective.title} · {objective.status}</option>)}</select></label>{repositories.length > 0 && <fieldset className="repo-checks"><legend>Repositories involved</legend>{repositories.map(repository => <label key={repository.id}><input type="checkbox" name="repositoryIds" value={repository.id}/><span>{repository.remote.split('/').slice(-2).join('/')}</span><small>{repository.defaultBranch}</small></label>)}</fieldset>}<div className="form-columns"><label>Desired outcomes<textarea name="outcomes" placeholder="One outcome per line"/></label><label>Constraints<textarea name="constraints" placeholder="One constraint per line"/></label></div><div className="modal-foot"><span>Starts active · You can pause or finish it any time</span><button type="button" className="button secondary" onClick={() => setShowCreate(false)}>Cancel</button><button className="button primary">Create process</button></div></form></div>}
    {showProjectCreate && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowProjectCreate(false); }}><form className="modal project-modal" onSubmit={createProject}><div className="modal-head"><div><div className="eyebrow">NEW PROJECT</div><h2>What are you working on?</h2></div><button type="button" className="icon-button" onClick={() => setShowProjectCreate(false)}>×</button></div><label>Project name<input name="name" required maxLength={120} placeholder="e.g. Evershift" autoFocus/></label><label>Purpose<textarea name="description" maxLength={2000} placeholder="A short description of this project."/></label><div className="modal-foot"><button type="button" className="button secondary" onClick={() => setShowProjectCreate(false)}>Cancel</button><button className="button primary">Create project</button></div></form></div>}
  </div>;
}

function ProcessDetail({ process, activity, pendingProposals, deferredProposals, proposals, amendments, definitionVersions, objectives, repositories, proposalTargetId, onNavigateProposal, onBack, onReview, onReviewProposal, onLifecycle, onAmendment, onAmendmentDecision, onReopenProposal, onRecordAgentFinding }: { process: Process; activity: Activity[]; pendingProposals: PendingProposal[]; deferredProposals: Proposal[]; proposals: Proposal[]; amendments: Amendment[]; definitionVersions: DefinitionVersion[]; objectives: Objective[]; repositories: Repository[]; proposalTargetId?: string; onNavigateProposal: (id: string) => void; onBack: () => void; onReview: (event: FormEvent<HTMLFormElement>) => void; onReviewProposal: (id: string, outcome: string, body: string) => Promise<void>; onLifecycle: (lifecycle: Process['lifecycle'], outcome?: string, acknowledgeUnresolved?: boolean) => void; onAmendment: (event: FormEvent<HTMLFormElement>) => void; onAmendmentDecision: (id: string, decision: 'accept'|'reject') => void; onReopenProposal: (id: string) => void; onRecordAgentFinding: (kind: 'update'|'proposal', title: string, body: string, source: { sessionId: string; eventSeq: number }) => Promise<void> }) {
  const [completionOpen, setCompletionOpen] = useState(false);
  const [sourceNotice, setSourceNotice] = useState('');
  function openAgentSource(sessionId: string, eventSeq: number) {
    const event = document.getElementById(agentEventElementId(sessionId, eventSeq));
    if (event) { setSourceNotice(''); event.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    else setSourceNotice(`AgentSession ${sessionId.slice(0,8)} event #${eventSeq} is not in the current transcript. Its source identity remains recorded in Process history.`);
  }
  function complete(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); const outcome = String(form.get('outcome') || '').trim(); const acknowledged = form.get('acknowledgeUnresolved') === 'on'; if (!outcome || (unresolved.length > 0 && !acknowledged)) return; onLifecycle('completed', outcome, acknowledged); setCompletionOpen(false); }
  const objective = objectives.find(item => item.id === process.objectiveId);
  const latestActivity = activity[0];
  const targetProposal = proposalTargetId ? proposals.find(item => item.id === proposalTargetId) : undefined;
  useEffect(() => { if (targetProposal) document.getElementById(`proposal-${targetProposal.id}`)?.scrollIntoView({ block: 'start' }); }, [targetProposal?.id]);
  const unresolved = [...proposals.filter(proposal => ['pending', 'deferred', 'revise'].includes(proposal.status)), ...amendments.filter(amendment => amendment.status === 'proposed').map(amendment => ({ id: amendment.id, title: `Definition amendment: ${amendment.reason}`, body: amendment.definition.intent, status: 'proposed amendment', createdAt: amendment.proposedAt }))];
  return <section className="detail"><button className="back-link" onClick={onBack}>← Project overview</button><div className="detail-heading"><div><span className={`status ${process.lifecycle}`}><i/> {process.lifecycle}</span><h1>{process.title}</h1><p>{process.intent}</p></div><div className="detail-buttons">{process.lifecycle === 'active' && <button className="button secondary" onClick={() => onLifecycle('paused')}>Pause</button>}{process.lifecycle === 'paused' && <button className="button secondary" onClick={() => onLifecycle('active')}>Resume</button>}{(process.lifecycle === 'active' || process.lifecycle === 'paused') && <button className="button primary" onClick={() => setCompletionOpen(true)}>Complete process</button>}</div></div>
    <div className="detail-layout"><div className="detail-main"><div className="detail-panel"><div className="panel-title"><div><h2>Accepted definition · v{definitionVersions[0]?.version ?? 1}</h2><p>This is the current accepted Process definition.</p></div><span className="focus-chip">◷ {process.currentFocus}</span></div><div className="intent-copy">{process.intent}</div>{process.desiredOutcomes.length > 0 && <><h3 className="subheading">Desired outcomes</h3><ul className="outcome-list">{process.desiredOutcomes.map((outcome, index) => <li key={index}><span>✓</span>{outcome}</li>)}</ul></>}{process.constraints.length > 0 && <><h3 className="subheading">Constraints</h3><ul className="constraint-list">{process.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></>}{objective && <div className="linked-objective"><span>◎</span><div><small>OBJECTIVE</small><strong>{objective.title}</strong></div></div>}<details className="definition-history"><summary>Accepted definition history ({definitionVersions.length} versions)</summary>{definitionVersions.map(version => <article key={version.version}><strong>Version {version.version} · {new Date(version.acceptedAt).toLocaleString()}</strong><p>{version.reason} · Authorized by {version.authorizedBy}</p><div className="version-definition"><strong>Intent</strong><p>{version.intent}</p><strong>Desired outcomes</strong><ul>{version.desiredOutcomes.map((item, index) => <li key={index}>{item}</li>)}</ul><strong>Constraints</strong><ul>{version.constraints.map((item, index) => <li key={index}>{item}</li>)}</ul></div></article>)}</details></div>
      {sourceNotice && <div className="unavailable-state source-notice" role="status">{sourceNotice}</div>}
      {latestActivity && <div className="detail-panel situation-panel"><div className="panel-title"><div><h2>Current situation · from Process records</h2><p>Recorded focus: {process.currentFocus}</p></div></div><strong>{latestActivity.title}</strong><time>{new Date(latestActivity.createdAt).toLocaleString()}</time><p>{latestActivity.body}</p>{latestActivity.sourceAgentSessionId && latestActivity.sourceEventSeq && <button className="agent-source-link" onClick={() => openAgentSource(latestActivity.sourceAgentSessionId!, latestActivity.sourceEventSeq!)}>Source: AgentSession {latestActivity.sourceAgentSessionId.slice(0,8)} · event #{latestActivity.sourceEventSeq}</button>}</div>}
      {proposalTargetId && !targetProposal && <div className="detail-panel unavailable-state" role="status"><h2>Proposal unavailable</h2><p>This exact proposal is not part of this Process. Its contents are not shown.</p><button className="button secondary" onClick={() => onNavigateProposal('')}>Return to Process</button></div>}
      {targetProposal && <ProposalDecisionCard process={process} proposal={targetProposal} source={activity.find(item => item.kind === 'proposal' && item.proposalId === targetProposal.id)} isPending={pendingProposals.some(item => item.id === targetProposal.id)} onReview={onReviewProposal} onSource={openAgentSource} onReturn={() => onNavigateProposal('')}/>}
      {!proposalTargetId && pendingProposals.map(pending => { const proposal = proposals.find(item => item.id === pending.id); return proposal && <button key={proposal.id} className="proposal-queue-item" onClick={() => onNavigateProposal(proposal.id)}><span><strong>{proposal.title}</strong><small>Awaiting your decision · {proposal.id.slice(0,8)}</small></span><span>Review →</span></button>; })}
      <AgentSessionPanel key={process.id} process={process} repositories={repositories} onRecordFinding={onRecordAgentFinding}/>
      {(process.lifecycle === 'active' || process.lifecycle === 'paused') && !amendments.some(amendment => amendment.status === 'proposed') && <form className="detail-panel update-form amendment-form" onSubmit={onAmendment}><div className="panel-title"><div><h2>Propose a definition amendment</h2><p>Proposing does not change the accepted Process. A human must accept it.</p></div></div><label>Process title<input name="title" required maxLength={160} defaultValue={process.title}/></label><label>Revised intent<textarea name="intent" required maxLength={10000} defaultValue={process.intent}/></label><label>Related objective<select name="objectiveId" defaultValue={process.objectiveId || ''}><option value="">None</option>{objectives.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>{repositories.length > 0 && <fieldset className="repo-checks"><legend>Repositories involved</legend>{repositories.map(repository => <label key={repository.id}><input type="checkbox" name="repositoryIds" value={repository.id} defaultChecked={process.repositoryIds.includes(repository.id)}/><span>{repository.remote.split('/').slice(-2).join('/')}</span></label>)}</fieldset>}<div className="form-columns"><label>Desired outcomes<textarea name="outcomes" defaultValue={process.desiredOutcomes.join('\n')} placeholder="One per line"/></label><label>Constraints<textarea name="constraints" defaultValue={process.constraints.join('\n')} placeholder="One per line"/></label></div><label>Why should this change?<textarea name="reason" required maxLength={4000}/></label><button className="button secondary">Propose amendment</button></form>}
      {amendments.some(amendment => amendment.status === 'proposed') && <div className="detail-panel amendment-pending"><h2>Proposed definition changes</h2>{amendments.filter(amendment => amendment.status === 'proposed').map(amendment => <article key={amendment.id}><strong>{amendment.reason}</strong><p>{amendment.definition.intent}</p><div className="button-row"><button type="button" className="button primary" onClick={() => onAmendmentDecision(amendment.id, 'accept')}>Accept definition</button><button type="button" className="button secondary" onClick={() => onAmendmentDecision(amendment.id, 'reject')}>Reject</button></div></article>)}</div>}
      <div className="detail-panel"><div className="panel-title"><div><h2>History and reviews</h2><p>Each entry records the accepted definition version it was made under.</p></div></div><div className="timeline">{activity.map(item => <article className="timeline-item" key={item.id}><span className={`timeline-mark ${item.kind}`}>{item.kind === 'decision' ? '✓' : item.kind === 'review' ? '⌕' : item.kind === 'proposal' ? '◇' : '·'}</span><div className="timeline-body"><div className="timeline-meta"><strong>{item.title}</strong><time>{new Date(item.createdAt).toLocaleString()}</time></div><p>{item.body}</p><small className="version-ref">Under accepted definition v{item.definitionVersion ?? 1}</small>{item.sourceAgentSessionId && item.sourceEventSeq && <button className="agent-source-link" onClick={() => openAgentSource(item.sourceAgentSessionId!, item.sourceEventSeq!)}>Goose AgentSession {item.sourceAgentSessionId.slice(0,8)} · event #{item.sourceEventSeq}</button>}{item.outcome && <span className={`outcome-tag ${item.outcome}`}>{item.outcome}</span>}</div></article>)}</div></div>
      {deferredProposals.length > 0 && <div className="detail-panel deferred-panel"><h2>Deferred proposals</h2><p>These proposals are not awaiting review, but remain available to reconsider.</p>{deferredProposals.map(proposal => <article key={proposal.id}><div><strong>{proposal.title}</strong><p>{proposal.body}</p></div>{process.lifecycle === 'active' && <button className="button secondary" onClick={() => onReopenProposal(proposal.id)}>Reopen for review</button>}</article>)}</div>}
      {process.lifecycle === 'active' && <form className="detail-panel update-form" onSubmit={onReview}><div className="panel-title"><div><h2>Record progress or a proposal</h2><p>Use the proposal card above to record a review decision.</p></div></div><div className="form-columns"><label>Entry type<select name="kind"><option value="update">Progress update</option><option value="proposal">Proposal</option><option value="decision">Decision</option></select></label></div><label>Title<input name="title" required placeholder="e.g. First navigation approach"/></label><label>What happened?<textarea name="body" required placeholder="Record findings, rationale, or requested changes."/></label><button className="button primary">Add to history</button></form>}</div>
    <aside className="detail-side"><div className="side-card"><div className="side-title">PROCESS DETAILS</div><div className="side-row"><span>Lifecycle</span><strong>{process.lifecycle}</strong></div><div className="side-row"><span>Recorded focus</span><strong>{process.currentFocus}</strong></div><div className="side-row"><span>Unresolved items</span><strong>{unresolved.length}</strong></div><div className="side-row"><span>Related objective</span><strong>{objective?.title || 'None'}</strong></div><div className="side-row"><span>Repositories</span><strong>{process.repositoryIds.map(id => repositories.find(repository => repository.id === id)?.remote.split('/').slice(-2).join('/')).filter(Boolean).join(', ') || 'None'}</strong></div></div><div className="side-note"><span>✳</span><div><strong>Human decisions do not grant execution authority</strong><p>Accepting a proposal records a Process decision only; it does not authorize or change a kernel WorkItem or WorkflowRun.</p></div></div></aside></div>{completionOpen && <div className="modal-backdrop"><form className="modal project-modal" onSubmit={complete}><div className="modal-head"><div><div className="eyebrow">ACCEPT OUTCOME</div><h2>What did this Process accomplish?</h2></div><button type="button" className="icon-button" onClick={() => setCompletionOpen(false)}>×</button></div>{unresolved.length > 0 && <div className="unresolved-warning"><strong>Outstanding work or decisions remain</strong><ul>{unresolved.map(item => <li key={item.id}>{item.title} · {item.status}</li>)}</ul><label className="acknowledge-row"><input type="checkbox" name="acknowledgeUnresolved" required/> I understand and accept that these items remain unresolved.</label></div>}<label>Outcome summary<textarea name="outcome" required maxLength={10000} placeholder="Explain how the result meets the intent, or why this is the accepted outcome." autoFocus/></label><div className="modal-foot"><span>Completion does not affect kernel execution state.</span><button type="button" className="button secondary" onClick={() => setCompletionOpen(false)}>Cancel</button><button className="button primary">Accept and complete</button></div></form></div>}</section>;
}

function ProposalDecisionCard({ process, proposal, source, isPending, onReview, onSource, onReturn }: { process: Process; proposal: Proposal; source?: Activity; isPending: boolean; onReview: (id: string, outcome: string, body: string) => Promise<void>; onSource: (sessionId: string, eventSeq: number) => void; onReturn: () => void }) {
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const outcome = String((event.nativeEvent as SubmitEvent).submitter && ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement).value || form.get('outcome') || ''); const body = String(form.get('body') || '').trim();
    if (!outcome || !body) return;
    setError('');
    try { await onReview(proposal.id, outcome, body); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not record this decision'); }
  }
  return <article className="detail-panel proposal-decision" id={`proposal-${proposal.id}`}><div className="panel-title"><div><div className="eyebrow">PROPOSAL · {proposal.id}</div><h2>{proposal.title}</h2><p>Status: {proposal.status} · Recorded {new Date(proposal.createdAt).toLocaleString()}</p></div><div className="proposal-header-actions">{isPending && <span className="status">Awaiting decision</span>}<button type="button" className="button secondary" onClick={onReturn}>Back to Process</button></div></div><p className="proposal-body">{proposal.body}</p><div className="claim-note">A proposal is a recorded direction. Acceptance is a human decision and does not independently verify its claims or authorize execution.</div>{source?.sourceAgentSessionId && source.sourceEventSeq ? <div className="proposal-source"><strong>Source AgentSession event</strong><span>{source.sourceAgentSessionId.slice(0,8)} · event #{source.sourceEventSeq}</span><button type="button" className="text-button" onClick={() => onSource(source.sourceAgentSessionId!, source.sourceEventSeq!)}>Go to completed message</button></div> : <p className="muted-note">No completed AgentSession source event is linked to this proposal.</p>}{isPending && process.lifecycle === 'active' && <form className="update-form proposal-review-form" onSubmit={submit}><label>Your rationale<textarea name="body" required maxLength={4000} placeholder="Record why you accept, reject, defer, or request a revision."/></label><div className="proposal-actions"><button className="button primary" name="outcome" value="accepted">Accept direction</button><button className="button secondary" name="outcome" value="revise">Request revision</button><button className="button secondary" name="outcome" value="deferred">Defer</button><button className="button secondary" name="outcome" value="rejected">Reject</button></div>{error && <p className="inline-error" role="alert">{error}</p>}</form>}</article>;
}

function ProjectExplorationDetail({ projectId, explorationId, repositories, onBack, onExplorationsChanged }: { projectId: string; explorationId: string; repositories: Repository[]; onBack: () => void; onExplorationsChanged: () => void }) {
  return <section className="detail"><div className="detail-heading"><div><div className="eyebrow">PROJECT EXPLORATION</div><h1>Investigation conversation</h1><p>Recorded activity and agent claims for this Project. No Process intent or Project knowledge is created here.</p></div><button className="button secondary" onClick={onBack}>← Project overview</button></div><AgentSessionPanel key={explorationId} projectId={projectId} explorationId={explorationId} repositories={repositories} onExplorationsChanged={onExplorationsChanged}/></section>;
}

function AgentSessionPanel({ process, projectId, explorationId, repositories, onRecordFinding, onExplorationsChanged }: { process?: Process; projectId?: string; explorationId?: string; repositories: Repository[]; onRecordFinding?: (kind: 'update'|'proposal', title: string, body: string, source: { sessionId: string; eventSeq: number }) => Promise<void>; onExplorationsChanged?: () => void }) {
  const [session, setSession] = useState<AgentSession | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [permissions, setPermissions] = useState<AgentPermission[]>([]);
  const [operations, setOperations] = useState<AgentOperation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [repoId, setRepoId] = useState(process?.repositoryIds.find(id => repositories.some(repo => repo.id === id && repo.localWorkspace)) ?? '');
  const [pendingPrompt, setPendingPrompt] = useState<PendingAgentPrompt | null>(null);
  const [draftPrompt, setDraftPrompt] = useState('');
  const [findingDraft, setFindingDraft] = useState<AgentFindingDraft | null>(null);
  const [savingFinding, setSavingFinding] = useState(false);
  const [findingError, setFindingError] = useState('');
  const [findingNotice, setFindingNotice] = useState('');
  const eventCursor = useRef(0);
  const currentSessionId = useRef('');
  const inFlight = useRef(false);
  const generation = useRef(0);
  const usable = process ? repositories.filter(repo => process.repositoryIds.includes(repo.id) && repo.localWorkspace) : [];
  const projectExploration = !process && Boolean(projectId && explorationId);
  const resourcePath = (id: string) => projectExploration
    ? `/projects/${projectId}/explorations/${explorationId}`
    : `/agent-sessions/${id}`;

  async function refresh(ticket = generation.current) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
    const result = process
      ? await api<{ session: AgentSession | null }>(`/processes/${process.id}/agent-session`)
      : await api<{ session: AgentSession }>(`/projects/${projectId}/explorations/${explorationId}`);
    if (ticket !== generation.current) return;
    setSession(result.session);
    if (!result.session) { setEvents([]); setPermissions([]); setOperations([]); eventCursor.current = 0; currentSessionId.current = ''; setPendingPrompt(null); return; }
    if (currentSessionId.current !== result.session.id) {
      currentSessionId.current = result.session.id;
      eventCursor.current = 0;
      setEvents([]);
      setPendingPrompt(readPendingAgentPrompt(sessionStorage, result.session.id));
      setDraftPrompt('');
    }
    const root = resourcePath(result.session.id);
    const [nextEvents, nextPermissions, nextOperations] = await Promise.all([
      api<AgentEvent[]>(`${root}/events?after=${eventCursor.current}&limit=200`),
      api<AgentPermission[]>(`${root}/permissions`),
      api<AgentOperation[]>(`${root}/operations`),
    ]);
    if (ticket !== generation.current || currentSessionId.current !== result.session.id) return;
    if (nextEvents.length) { setEvents(current => [...current, ...nextEvents]); eventCursor.current = nextEvents[nextEvents.length - 1]!.seq; }
    setPermissions(nextPermissions); setOperations(nextOperations);
    const pending = readPendingAgentPrompt(sessionStorage, result.session.id);
    const operation = pending && nextOperations.find(item => item.idempotencyKey === pending.key);
    if (operation && ['completed','cancelled','failed','reconciled'].includes(operation.status)) {
      clearPendingAgentPrompt(sessionStorage, result.session.id);
      setPendingPrompt(null); setDraftPrompt('');
    } else if (pending) setPendingPrompt(current => current?.key === pending.key ? current : pending);
    } finally { inFlight.current = false; }
  }
  useEffect(() => {
    const ticket = ++generation.current;
    let mounted = true;
    void refresh(ticket).catch(cause => { if (mounted && ticket === generation.current) setError(cause instanceof Error ? cause.message : 'Could not load AgentSession'); });
    const timer = window.setInterval(() => { if (mounted) void refresh(ticket).catch(() => undefined); }, 1500);
    return () => { mounted = false; window.clearInterval(timer); if (generation.current === ticket) generation.current++; };
  }, [process?.id, projectId, explorationId]);
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'AgentSession operation failed'); }
    finally { setBusy(false); }
  }
  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!process) return;
    const chosen = new FormData(event.currentTarget).get('repositoryId');
    if (typeof chosen !== 'string') return;
    await act(async () => { await api(`/processes/${process.id}/agent-sessions`, { method: 'POST', body: JSON.stringify({ repositoryId: chosen }) }); });
  }
  async function prompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const text = String(new FormData(form).get('text') || '').trim(); if (!text) return;
    const pending = pendingPrompt?.sessionId === session!.id ? pendingPrompt : { sessionId: session!.id, key: crypto.randomUUID(), text };
    setPendingPrompt(pending);
    savePendingAgentPrompt(sessionStorage, pending);
    setBusy(true); setError('');
    try {
      const operation = await api<AgentOperation>(`${resourcePath(session!.id)}/prompts`, { method: 'POST', body: JSON.stringify({ idempotencyKey: pending.key, text: pending.text }) });
      if (projectExploration) onExplorationsChanged?.();
      await refresh();
      if (['completed','cancelled','failed','reconciled'].includes(operation.status)) {
        clearPendingAgentPrompt(sessionStorage, session!.id); setPendingPrompt(null); setDraftPrompt('');
      }
    } catch (cause) {
      setError(cause instanceof Error ? `${cause.message}. Retry keeps the same prompt key and text.` : 'Prompt response was not confirmed. Retry keeps the same prompt key and text.');
    } finally { setBusy(false); }
  }
  async function permissionDecision(id: string, decision: 'allow_once'|'reject_once') {
    await act(async () => { await api(`${resourcePath(session!.id)}/permissions/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) }); });
  }
  const action = (suffix: string) => `${resourcePath(session!.id)}${suffix}`;
  async function submitFinding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!findingDraft || !session) return;
    setSavingFinding(true); setFindingError(''); setFindingNotice('');
    try {
      if (onRecordFinding) {
        await onRecordFinding(findingDraft.kind, findingDraft.title.trim(), findingDraft.body.trim(), findingDraft.source);
        setFindingNotice('Recorded in this Process with its source event.'); setFindingDraft(null);
      } else {
        await navigator.clipboard.writeText(`${findingDraft.title.trim()}\n\n${findingDraft.body.trim()}\n\nSource: AgentSession ${findingDraft.source.sessionId}, completed event ${findingDraft.source.eventSeq}. Agent claim; not independently verified.`);
        setFindingNotice('Copied with exact source identity. This draft is not stored as Project knowledge.');
      }
    } catch (cause) { setFindingError(cause instanceof Error ? cause.message : 'Could not complete finding draft'); }
    finally { setSavingFinding(false); }
  }
  const active = session && !['stopped','failed'].includes(session.lifecycle);
  return <section className="detail-panel agent-panel"><div className="panel-title"><div><h2>{projectExploration ? 'Exploration conversation' : 'Goose AgentSession'}</h2><p>{projectExploration ? 'One durable conversation owned by this Project. Agent messages are claims; recorded events show what happened. Runtime access stays read-only.' : 'Persistent conversation attached to this Process. Repository access is a pinned, read-only snapshot; terminal and writes are disabled.'}</p></div>{session && <span className={`status ${session.lifecycle}`}><i/>{session.lifecycle.replaceAll('_',' ')}</span>}</div>
    {error && <div className="inline-error" role="status"><strong>AgentSession unavailable or action not completed</strong><br/>{error}. The recorded conversation remains available; retry when ready.</div>}
    {!session ? process ? <>{usable.length ? <form className="agent-start" onSubmit={start}><label>Repository snapshot<select name="repositoryId" value={repoId} onChange={event => setRepoId(event.target.value)} required>{usable.map(repo => <option key={repo.id} value={repo.id}>{repo.remote}</option>)}</select></label><button className="button primary" disabled={busy || process.lifecycle !== 'active'}>{busy ? 'Starting…' : 'Start read-only session'}</button></form> : <p className="muted-note">Link a local checkout to a Process repository before starting an AgentSession.</p>}</> : <p className="muted-note">Loading this Project-owned exploration…</p> : <>
      <div className="agent-meta">{session.repositoryRemote ? <><span>{session.repositoryRemote}</span><code>{session.repositoryCommit?.slice(0,12)}</code><span>pinned snapshot · read only</span></> : <span>No repository selected · private empty workspace · read only</span>}</div>
      {session.errorMessage && <div className="inline-error">{session.errorMessage}</div>}
      {session.lifecycle === 'starting' && <div className="unresolved-warning"><strong>Starting isolated Goose session</strong><p>No simulated response is shown. If Goose or its provider is unavailable, this session will report that state explicitly.</p></div>}
      {session.lifecycle === 'failed' && <div className="unresolved-warning"><strong>Goose session unavailable</strong><p>No simulated response was created. Check the local Goose runtime/provider configuration, then review this failed session or start a new exploration.</p></div>}
      {session.lifecycle === 'stopped' && <div className="muted-note">This session is stopped. Its identity and recorded history remain available; start a new exploration to continue with a new session.</div>}
      {session.lifecycle === 'outcome_unknown' && <div className="unresolved-warning"><strong>A prompt may have reached Goose before the connection ended.</strong><p>Restore the conversation, inspect the recorded activity, and acknowledge each uncertain prompt before continuing. Stratum will not resend it.</p></div>}
      {session.lifecycle === 'interrupted' && <button className="button secondary" disabled={busy} onClick={() => void act(() => api(action('/reconcile'), { method: 'POST' }))}>Reconnect and restore history</button>}
      {session.lifecycle === 'outcome_unknown' && <button className="button secondary" disabled={busy} onClick={() => void act(() => api(action('/reconcile'), { method: 'POST' }))}>Restore conversation to inspect</button>}
      {session.lifecycle === 'outcome_unknown' && operations.filter(operation => operation.status === 'outcome_unknown').map(operation => <div className="unknown-operation" key={operation.id}><p>Uncertain prompt: {operation.promptText}</p><button className="button secondary" disabled={busy || !session} onClick={() => void act(() => api(action(`/operations/${operation.id}/acknowledge-unknown`), { method: 'POST' }))}>I reviewed history; continue without resending</button></div>)}
      {permissions.filter(permission => permission.status === 'pending').map(permission => { const input = permission.operation.input && typeof permission.operation.input === 'object' ? permission.operation.input as Record<string, unknown> : {}; return <div className="permission-card" key={permission.id}><div><strong>Goose requests one-time file read</strong><p>{String(permission.operation.path ?? input.path ?? 'Unsupported request')}</p><small>Approval applies once to this normalized repository path only.</small></div><button className="button secondary" disabled={busy} onClick={() => void permissionDecision(permission.id,'reject_once')}>Deny</button><button className="button primary" disabled={busy || typeof (permission.operation.path ?? input.path) !== 'string'} onClick={() => void permissionDecision(permission.id,'allow_once')}>Allow this read once</button></div>; })}
      <div className="agent-transcript" aria-live="polite">{events.filter(item => item.eventType !== 'agent_message_chunk').map(item => { const content = String(item.payload.text ?? item.payload.message ?? item.payload.path ?? item.payload.name ?? item.payload.repositoryCommit ?? ''); const label = item.eventType === 'agent_message_complete' ? 'Agent claim · not independently verified' : item.eventType === 'user_prompt' ? 'User prompt · recorded event' : `${item.eventType.replaceAll('_',' ')} · recorded event`; return <article id={agentEventElementId(session.id, item.seq)} key={`${session.id}:${item.seq}`} className="agent-event"><small>{label} · {new Date(item.createdAt).toLocaleTimeString()}</small><p>{content}</p>{item.eventType === 'agent_message_complete' && content.trim() && <div className="agent-finding-actions">{onRecordFinding ? <><button className="text-button" onClick={() => { setFindingError(''); setFindingNotice(''); setFindingDraft(createAgentFindingDraft('update','Goose finding',content,{ sessionId: session.id, eventSeq: item.seq })); }}>Record as Process update</button><button className="text-button" onClick={() => { setFindingError(''); setFindingNotice(''); setFindingDraft(createAgentFindingDraft('proposal','Goose proposed approach',content,{ sessionId: session.id, eventSeq: item.seq })); }}>Draft proposal for review</button></> : <button className="text-button" onClick={() => { setFindingError(''); setFindingNotice(''); setFindingDraft(createAgentFindingDraft('update','Finding draft',content,{ sessionId: session.id, eventSeq: item.seq })); }}>Draft finding from this message</button>}</div>}</article>; })}</div>
      {findingDraft && <form key={agentFindingDraftKey(findingDraft)} className="update-form finding-draft" onSubmit={submitFinding}><div className="panel-title"><div><h3>{onRecordFinding ? `Draft ${findingDraft.kind === 'proposal' ? 'proposal' : 'Process update'}` : 'Editable finding draft'}</h3><p>Source: AgentSession {findingDraft.source.sessionId} · completed event #{findingDraft.source.eventSeq}. This is an agent claim, not independently verified.{!onRecordFinding && ' Draft is local to this browser view; it is not Project knowledge.'}</p></div></div><label>Title<input name="title" required maxLength={160} value={findingDraft.title} onChange={event => setFindingDraft(current => current && updateAgentFindingDraft(current, { title: event.target.value, body: current.body }))}/></label><label>Finding<textarea name="body" required maxLength={10000} value={findingDraft.body} onChange={event => setFindingDraft(current => current && updateAgentFindingDraft(current, { title: current.title, body: event.target.value }))}/></label>{findingError && <div className="inline-error" role="alert">{findingError}</div>}{findingNotice && <div className="muted-note" role="status">{findingNotice}</div>}<div className="proposal-actions"><button className="button primary" disabled={savingFinding}>{savingFinding ? 'Working…' : onRecordFinding ? findingDraft.kind === 'proposal' ? 'Create proposal' : 'Record update' : 'Copy draft with source'}</button><button type="button" className="button secondary" disabled={savingFinding} onClick={() => setFindingDraft(null)}>Cancel</button></div></form>}
      {session.lifecycle === 'idle' && <form className="agent-prompt" onSubmit={prompt}><label htmlFor={`agent-prompt-${session.id}`}>{pendingPrompt?.sessionId === session.id ? 'Prompt awaiting confirmation' : projectExploration ? 'Ask a question' : 'Message Goose'}</label><textarea id={`agent-prompt-${session.id}`} name="text" value={pendingPrompt?.sessionId === session.id ? pendingPrompt.text : draftPrompt} onChange={event => setDraftPrompt(event.target.value)} required maxLength={10000} readOnly={pendingPrompt?.sessionId === session.id} placeholder={session.repositoryRemote ? 'Ask Goose to investigate the pinned repository snapshot. It can read files, but cannot modify them or run commands.' : 'Ask Goose a question. No repository or Project files are available in this empty workspace.'}/><button className="button primary" disabled={busy}>{pendingPrompt?.sessionId === session.id ? 'Retry same prompt' : 'Send prompt'}</button></form>}
      {session.lifecycle === 'running' || session.lifecycle === 'awaiting_permission' ? <button className="button secondary" disabled={busy} onClick={() => void act(() => api(action('/cancel'), { method: 'POST' }))}>Cancel current response</button> : null}
      {active && <button className="button secondary agent-stop" disabled={busy} onClick={() => void act(() => api(action('/stop'), { method: 'POST' }))}>Stop AgentSession</button>}
    </>}
  </section>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
