// Human-readable batch report (data/curation/batch-N/report.md)
const pct = (x) => (x == null ? 'n/a' : `${x}%`);

function describe(p) {
  if (p.op === 'add_entry') return `+ ${p.entry_id ? p.entry_id + ' ' : ''}(trial) "${p.title}"`;
  if (p.op === 'update_entry') return `~ ${p.entry_id} updated`;
  if (p.op === 'promote') return `↑ ${p.entry_id} promoted to established`;
  if (p.op === 'deprecate') return `↓ ${p.entry_id} deprecated`;
  return `? ${p.op}`;
}

export function renderReport({ meta, metrics, errors, applied, rejected, notes, groups }) {
  const c = meta.counts;
  const dropped = Object.entries(c.dropped).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
  const ev = (p) => {
    const g = p.group_key && groups[p.group_key];
    return g ? ` · evidence ${g.n_sessions} sessions / ${g.n_distinct_callers} callers / ${Math.round(g.correction_success_rate * 100)}%` : '';
  };
  const lines = [
    `# Curation batch #${meta.batch}`,
    '',
    `- Created: ${meta.created} · proposer: ${meta.mode}`,
    `- Guide v${meta.base_version} → proposed v${meta.proposed_version}`,
    `- New sessions: ${c.new_sessions} · new observations: ${c.new_observations}`,
    `- Dropped (new data): ${dropped}`,
    `- Safety-stop observations sent to human review: ${c.safety_review}`,
    `- Training episodes exported: ${c.training_episodes} (data/episodes/batch-${meta.batch}.jsonl)`,
    '',
    '## Metrics (new sessions)',
    `- Resolution rate: ${pct(metrics.resolution_rate_pct)}`,
    `- First-try step success: ${pct(metrics.first_try_step_success_pct)}`,
    `- Referred to a professional: ${pct(metrics.referral_rate_pct)} · safety stops: ${pct(metrics.safety_stop_pct)}`,
    `- Median call: ${metrics.median_duration_s ?? 'n/a'} s`,
    `- Top errors: ${errors.map((e) => `${e.type} ${e.pct}%`).join(' · ') || 'none'}`,
    '',
    `## Accepted (${applied.length})`,
    ...(applied.length ? applied.map((p) => `- ${describe(p)}${ev(p)}${p.rationale ? ` — ${p.rationale}` : ''}`) : ['- none']),
    '',
    `## Rejected (${rejected.length})`,
    ...(rejected.length
      ? rejected.map((r) => `- ✗ ${describe(r.proposal)}${r.proposal.title && r.proposal.op !== 'add_entry' ? ` "${r.proposal.title}"` : ''}: ${r.failures.map((f) => `${f.gate} ${f.reason}`).join('; ')}`)
      : ['- none']),
    '',
    ...(notes.length ? ['## Reviewer notes', ...notes.map((n) => `- ⚠ ${n}`), ''] : []),
    '## Next step',
    `Review \`guide/GUIDE.proposed.md\` and \`diff.txt\`. To change an entry, edit \`knowledge.proposed.json\` in this folder (not the .md).`,
    `Approve with: \`npm run publish-guide -- --approve ${meta.batch}\``,
    '',
  ];
  return lines.join('\n');
}
