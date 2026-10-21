import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Project = { id: string; name: string; description?: string; status: string };
type Objective = { id: string; title: string; status: string };
type Repository = { id: string; provider: string; remote: string; defaultBranch: string; status: string };
type Process = { id: string; projectId: string; objectiveId?: string; title: string; intent: string; desiredOutcomes: string[]; constraints: string[]; lifecycle: 'active'|'paused'|'completed'|'cancelled'; currentFocus: string; repositoryIds: string[]; attention?: 'Review required'|'Revision requested'; lastActivity?: Activity; createdAt: string; updatedAt: string };
type Activity = { id: string; kind: string; title: string; body: string; outcome?: string; createdAt: string };
type Envelope<T> = { ok: true; data: T } | { ok: false; error: { message: string } };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('stratum_token');
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers } });
  const result = await response.json() as Envelope<T>;
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [processes, setProcesses] = useState<Process[]>([]);
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [activity, setActivity] = useState<Activity[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const selectedProject = projects.find(project => project.id === projectId);
  const selected = processes.find(process => process.id === selectedId);
  const attention = useMemo(() => processes.filter(process => process.lifecycle === 'active').length, [processes]);

  async function loadProjects() {
    setLoading(true); setError('');
    try {
      const rows = await api<Project[]>('/projects'); setProjects(rows);
      const next = rows.some(project => project.id === projectId) ? projectId : rows[0]?.id ?? '';
      setProjectId(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load projects'); }
    finally { setLoading(false); }
  }
  async function loadProject(id: string) {
    if (!id) { setProcesses([]); setObjectives([]); setRepositories([]); setSelectedId(''); return; }
    try {
      const [nextProcesses, nextObjectives, nextRepositories] = await Promise.all([api<Process[]>(`/projects/${id}/processes`), api<Objective[]>(`/projects/${id}/objectives`), api<Repository[]>(`/projects/${id}/repositories`)]);
      setProcesses(nextProcesses); setObjectives(nextObjectives); setRepositories(nextRepositories);
      if (!nextProcesses.some(process => process.id === selectedId)) setSelectedId('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load project'); }
  }
  useEffect(() => { void loadProjects(); }, []);
  useEffect(() => { void loadProject(projectId); }, [projectId]);
  useEffect(() => {
    if (!selectedId) { setActivity([]); return; }
    api<{ process: Process; activity: Activity[] }>(`/processes/${selectedId}`).then(data => setActivity(data.activity)).catch(cause => setError(cause.message));
  }, [selectedId, processes]);

  async function createProcess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      const process = await api<Process>(`/projects/${projectId}/processes`, { method: 'POST', body: JSON.stringify({ title: form.get('title'), intent: form.get('intent'), objectiveId: form.get('objectiveId') || undefined, repositoryIds: form.getAll('repositoryIds'), desiredOutcomes: String(form.get('outcomes') || '').split('\n').map(s => s.trim()).filter(Boolean), constraints: String(form.get('constraints') || '').split('\n').map(s => s.trim()).filter(Boolean) }) });
      setShowCreate(false); await loadProject(projectId); setSelectedId(process.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create Process'); }
  }
  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      const project = await api<Project>('/projects', { method: 'POST', body: JSON.stringify({ name: form.get('name'), description: form.get('description') }) });
      setProjects(current => [...current, project]); setProjectId(project.id); setSelectedId(''); setShowProjectCreate(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create project'); }
  }
  async function addReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api(`/processes/${selected.id}/activity`, { method: 'POST', body: JSON.stringify({ kind: form.get('kind'), title: form.get('title'), body: form.get('body'), outcome: form.get('outcome') || undefined }) });
      formElement.reset(); await loadProject(projectId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save update'); }
  }
  async function setLifecycle(lifecycle: Process['lifecycle'], outcome?: string) {
    if (!selected) return;
    try { await api(`/processes/${selected.id}/lifecycle`, { method: 'PATCH', body: JSON.stringify({ lifecycle, outcome }) }); await loadProject(projectId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update Process'); }
  }

  return <div className="shell">
    <aside className="rail"><a className="brand" href="/app/" aria-label="Stratum home"><span className="brand-mark">S</span><span>stratum</span></a>
      <div className="rail-label">WORKSPACE</div><div className="project-select-row"><label className="project-picker"><span className="sr-only">Project</span><select value={projectId} onChange={event => { setProjectId(event.target.value); setSelectedId(''); }}><option value="">Select project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button className="project-add" title="Create project" onClick={() => setShowProjectCreate(true)}>＋</button></div>
      <div className="rail-label rail-section">PROJECT</div><button className={`rail-link ${!selected ? 'active' : ''}`} onClick={() => setSelectedId('')}><span>◫</span> Overview</button>
      <div className="rail-label rail-section row-label">PROCESSES <span>{processes.length}</span></div>
      <div className="process-nav">{processes.map(process => <button key={process.id} className={`rail-link process-link ${selectedId === process.id ? 'active' : ''}`} onClick={() => setSelectedId(process.id)}><i className={`dot ${process.lifecycle}`}/><span className="clip">{process.title}</span></button>)}
        {!processes.length && <div className="rail-empty">No processes yet</div>}</div>
      <button className="rail-new" onClick={() => setShowCreate(true)} disabled={!projectId}>＋ <span>New process</span></button>
      <div className="rail-bottom"><div className="avatar">{selectedProject?.name.slice(0,1).toUpperCase() || 'S'}</div><div><strong>{selectedProject?.name || 'No project'}</strong><small>Local workspace</small></div><span className="more">···</span></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="breadcrumbs"><span>{selectedProject?.name || 'Projects'}</span>{selected && <><b>/</b><span>{selected.title}</span></>}</div><div className="top-actions"><span className="live-dot"/> All changes saved <button className="icon-button" title="Refresh" onClick={() => void loadProject(projectId)}>↻</button></div></header>
      {error && <div className="toast-error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
      {loading ? <div className="loading">Loading your workspace…</div> : !projectId ? <section className="empty-state"><div className="empty-icon">⌂</div><h1>Your projects live here</h1><p>Create or connect a project to begin tracking ongoing work.</p></section> : selected ? <ProcessDetail process={selected} activity={activity} objectives={objectives} repositories={repositories} onBack={() => setSelectedId('')} onReview={addReview} onLifecycle={setLifecycle}/> : <section className="overview">
        <div className="page-heading"><div><div className="eyebrow">PROJECT OVERVIEW</div><h1>{selectedProject?.name}</h1><p>{selectedProject?.description || 'A clear view of the work, decisions, and next steps moving this project forward.'}</p></div><button className="button primary" onClick={() => setShowCreate(true)}>＋ New process</button></div>
        <div className="summary-grid"><div className="summary-card"><span className="summary-icon violet">◫</span><div><strong>{attention}</strong><span>Active processes</span></div></div><div className="summary-card"><span className="summary-icon amber">◇</span><div><strong>{processes.filter(process => process.lifecycle === 'paused').length}</strong><span>Paused</span></div></div><div className="summary-card"><span className="summary-icon green">✓</span><div><strong>{processes.filter(process => process.lifecycle === 'completed').length}</strong><span>Completed</span></div></div><div className="summary-card quiet"><span className="summary-icon blue">↗</span><div><strong>—</strong><span>Agent sessions</span></div></div></div>
        {processes.some(process => process.attention && process.lifecycle === 'active') && <div className="attention-panel"><div className="attention-heading"><span>◇</span><div><strong>Needs your attention</strong><small>Review a proposal or respond to a requested revision.</small></div><b>{processes.filter(process => process.attention && process.lifecycle === 'active').length}</b></div><div className="attention-items">{processes.filter(process => process.attention && process.lifecycle === 'active').map(process => <button key={process.id} onClick={() => setSelectedId(process.id)}><span><strong>{process.title}</strong><small>{process.attention}</small></span><span>Review →</span></button>)}</div></div>}
        <div className="section-head"><div><h2>Ongoing processes</h2><p>Intentions that persist across conversations, decisions, and iterations.</p></div><button className="text-button" onClick={() => setShowCreate(true)}>＋ Add process</button></div>
        {processes.length ? <div className="process-list">{processes.map(process => <button className="process-card" key={process.id} onClick={() => setSelectedId(process.id)}><div className="card-top"><span className={`status ${process.lifecycle}`}><i/> {process.lifecycle}</span><span className="card-time">Updated {new Date(process.updatedAt).toLocaleDateString()}</span></div><h3>{process.title}</h3><p>{process.intent}</p><div className="card-bottom"><span className="focus-chip">◷ {process.currentFocus}</span>{process.attention && process.lifecycle === 'active' && <span className="attention-chip">◇ {process.attention}</span>}{process.objectiveId && <span className="objective-chip">Linked objective</span>}<span className="open-arrow">↗</span></div></button>)}</div> : <div className="first-process"><div className="empty-icon">✳</div><h3>Start with what you want to move forward</h3><p>A Process keeps the intent, decisions, and outcome together, even when the work takes more than one session.</p><button className="button primary" onClick={() => setShowCreate(true)}>Create your first process</button></div>}
        <div className="lower-grid"><div className="lower-card"><div className="lower-title"><span className="small-icon">◎</span><h3>Project context</h3></div><p>Objectives describe outcomes. Processes capture the ongoing effort toward them. WorkItems remain separately authorized execution.</p><button className="text-button" onClick={() => window.location.href='/'}>Open execution control plane ↗</button></div><div className="lower-card"><div className="lower-title"><span className="small-icon blue-text">⌁</span><h3>Repository connections</h3></div><p>Repositories are project-linked code resources. A shared repository keeps each project’s process history separate.</p><span className="muted-note">{repositories.length} linked repositories</span><form className="repo-link-form" onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api(`/projects/${projectId}/repositories`, { method: 'POST', body: JSON.stringify({ remote: form.get('remote'), defaultBranch: form.get('defaultBranch') || 'main' }) }); event.currentTarget.reset(); await loadProject(projectId); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not link repository'); } }}><input name="remote" required placeholder="https://github.com/owner/repository"/><input name="defaultBranch" placeholder="Default branch · main"/><button className="text-button">＋ Link repository</button></form>{repositories.map(repo => <div className="repo-row" key={repo.id}><span>⌁</span><strong>{repo.remote.split('/').slice(-2).join('/')}</strong><small>{repo.defaultBranch}</small></div>)}</div></div>
      </section>}
    </main>
    {showCreate && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowCreate(false); }}><form className="modal" onSubmit={createProcess}><div className="modal-head"><div><div className="eyebrow">NEW PROCESS</div><h2>What do you want to move forward?</h2></div><button type="button" className="icon-button" onClick={() => setShowCreate(false)}>×</button></div><label>Process name<input name="title" required maxLength={160} placeholder="e.g. Improve NPC movement" autoFocus/></label><label>Intent<textarea name="intent" required maxLength={10000} placeholder="Why does this matter, and what should change?"/></label><label>Related objective <select name="objectiveId"><option value="">None for now</option>{objectives.map(objective => <option key={objective.id} value={objective.id}>{objective.title} · {objective.status}</option>)}</select></label>{repositories.length > 0 && <fieldset className="repo-checks"><legend>Repositories involved</legend>{repositories.map(repository => <label key={repository.id}><input type="checkbox" name="repositoryIds" value={repository.id}/><span>{repository.remote.split('/').slice(-2).join('/')}</span><small>{repository.defaultBranch}</small></label>)}</fieldset>}<div className="form-columns"><label>Desired outcomes<textarea name="outcomes" placeholder="One outcome per line"/></label><label>Constraints<textarea name="constraints" placeholder="One constraint per line"/></label></div><div className="modal-foot"><span>Starts active · You can pause or finish it any time</span><button type="button" className="button secondary" onClick={() => setShowCreate(false)}>Cancel</button><button className="button primary">Create process</button></div></form></div>}
    {showProjectCreate && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowProjectCreate(false); }}><form className="modal project-modal" onSubmit={createProject}><div className="modal-head"><div><div className="eyebrow">NEW PROJECT</div><h2>What are you working on?</h2></div><button type="button" className="icon-button" onClick={() => setShowProjectCreate(false)}>×</button></div><label>Project name<input name="name" required maxLength={120} placeholder="e.g. Evershift" autoFocus/></label><label>Purpose<textarea name="description" maxLength={2000} placeholder="A short description of this project."/></label><div className="modal-foot"><button type="button" className="button secondary" onClick={() => setShowProjectCreate(false)}>Cancel</button><button className="button primary">Create project</button></div></form></div>}
  </div>;
}

function ProcessDetail({ process, activity, objectives, repositories, onBack, onReview, onLifecycle }: { process: Process; activity: Activity[]; objectives: Objective[]; repositories: Repository[]; onBack: () => void; onReview: (event: FormEvent<HTMLFormElement>) => void; onLifecycle: (lifecycle: Process['lifecycle'], outcome?: string) => void }) {
  const [completionOpen, setCompletionOpen] = useState(false);
  function complete(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const outcome = String(new FormData(event.currentTarget).get('outcome') || '').trim(); if (!outcome) return; onLifecycle('completed', outcome); setCompletionOpen(false); }
  const objective = objectives.find(item => item.id === process.objectiveId);
  return <section className="detail"><button className="back-link" onClick={onBack}>← Project overview</button><div className="detail-heading"><div><span className={`status ${process.lifecycle}`}><i/> {process.lifecycle}</span><h1>{process.title}</h1><p>{process.intent}</p></div><div className="detail-buttons">{process.lifecycle === 'active' && <button className="button secondary" onClick={() => onLifecycle('paused')}>Pause</button>}{process.lifecycle === 'paused' && <button className="button secondary" onClick={() => onLifecycle('active')}>Resume</button>}{process.lifecycle === 'active' && <button className="button primary" onClick={() => setCompletionOpen(true)}>Complete process</button>}</div></div>
    <div className="detail-layout"><div className="detail-main"><div className="detail-panel"><div className="panel-title"><h2>Intent and outcomes</h2><span className="focus-chip">◷ {process.currentFocus}</span></div><div className="intent-copy">{process.intent}</div>{process.desiredOutcomes.length > 0 && <><h3 className="subheading">Desired outcomes</h3><ul className="outcome-list">{process.desiredOutcomes.map((outcome, index) => <li key={index}><span>✓</span>{outcome}</li>)}</ul></>}{process.constraints.length > 0 && <><h3 className="subheading">Constraints</h3><ul className="constraint-list">{process.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></>}{objective && <div className="linked-objective"><span>◎</span><div><small>OBJECTIVE</small><strong>{objective.title}</strong></div></div>}</div>
      <div className="detail-panel"><div className="panel-title"><div><h2>History and reviews</h2><p>Decisions and updates stay with the Process.</p></div></div><div className="timeline">{activity.map(item => <article className="timeline-item" key={item.id}><span className={`timeline-mark ${item.kind}`}>{item.kind === 'decision' ? '✓' : item.kind === 'review' ? '⌕' : item.kind === 'proposal' ? '◇' : '·'}</span><div className="timeline-body"><div className="timeline-meta"><strong>{item.title}</strong><time>{new Date(item.createdAt).toLocaleString()}</time></div><p>{item.body}</p>{item.outcome && <span className={`outcome-tag ${item.outcome}`}>{item.outcome}</span>}</div></article>)}</div></div>
      {process.lifecycle === 'active' && <form className="detail-panel update-form" onSubmit={onReview}><div className="panel-title"><div><h2>Record progress or review</h2><p>Keep proposals separate from accepted decisions.</p></div></div><div className="form-columns"><label>Entry type<select name="kind"><option value="update">Progress update</option><option value="proposal">Proposal</option><option value="review">Review</option><option value="decision">Decision</option></select></label><label>Decision outcome<select name="outcome"><option value="">Not a decision</option><option value="accepted">Accept</option><option value="revise">Request revision</option><option value="rejected">Reject</option><option value="deferred">Defer</option></select></label></div><label>Title<input name="title" required placeholder="e.g. First navigation approach"/></label><label>What happened?<textarea name="body" required placeholder="Record findings, rationale, or requested changes."/></label><button className="button primary">Add to history</button></form>}</div>
    <aside className="detail-side"><div className="side-card"><div className="side-title">PROCESS DETAILS</div><div className="side-row"><span>Lifecycle</span><strong>{process.lifecycle}</strong></div><div className="side-row"><span>Current focus</span><strong>{process.currentFocus}</strong></div><div className="side-row"><span>Iteration history</span><strong>{activity.filter(item => item.kind === 'review' || item.kind === 'proposal').length} entries</strong></div><div className="side-row"><span>Related objective</span><strong>{objective?.title || 'None'}</strong></div><div className="side-row"><span>Repositories</span><strong>{process.repositoryIds.map(id => repositories.find(repository => repository.id === id)?.remote.split('/').slice(-2).join('/')).filter(Boolean).join(', ') || 'None'}</strong></div><div className="side-row"><span>Agent sessions</span><strong className="muted-note">Not connected yet</strong></div></div><div className="side-note"><span>✳</span><div><strong>Work stays in your control</strong><p>Completing this Process records your outcome. It does not change a WorkItem or trigger execution.</p></div></div></aside></div>{completionOpen && <div className="modal-backdrop"><form className="modal project-modal" onSubmit={complete}><div className="modal-head"><div><div className="eyebrow">ACCEPT OUTCOME</div><h2>What did this Process accomplish?</h2></div><button type="button" className="icon-button" onClick={() => setCompletionOpen(false)}>×</button></div><label>Outcome summary<textarea name="outcome" required maxLength={10000} placeholder="Explain how the result meets the intent, or why this is the accepted outcome." autoFocus/></label><div className="modal-foot"><span>This records an application decision only.</span><button type="button" className="button secondary" onClick={() => setCompletionOpen(false)}>Cancel</button><button className="button primary">Accept and complete</button></div></form></div>}</section>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
