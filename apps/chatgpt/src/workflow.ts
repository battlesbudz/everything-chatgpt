export type WorkflowStep = { id: string; action: string; skillIds: string[]; requiresApproval: boolean; reason: string };

const rules: Array<{ terms: string[]; skills: string[]; action: string; reason: string }> = [
  { terms: ["test", "testing", "bug", "regression"], skills: ["skills/tdd-workflow", "skills/e2e-testing"], action: "Inspect the repository and establish a reproducible test", reason: "Testing requests benefit from a test-first workflow and an end-to-end check." },
  { terms: ["review", "pull request", "pr", "diff"], skills: ["skills/code-review"], action: "Inspect history, diff, review findings, and affected files", reason: "Review work should begin with evidence from the PR and its diff." },
  { terms: ["security", "auth", "permission", "token"], skills: ["skills/security-review"], action: "Perform a security and authorization review before changes", reason: "Security-sensitive work needs least-privilege and threat-model checks." },
  { terms: ["refactor", "architecture", "modular"], skills: ["skills/refactoring"], action: "Map dependencies and propose a bounded refactor", reason: "Refactors need dependency mapping before editing." },
];

export function planWorkflow(goal: string, language?: string): { headline: string; steps: WorkflowStep[]; notes: string[] } {
  const normalized = goal.toLowerCase();
  const matched = rules.filter((rule) => rule.terms.some((term) => normalized.includes(term)));
  const steps: WorkflowStep[] = [
    { id: "inspect", action: "Inspect repository metadata, relevant files, and current branch state", skillIds: [], requiresApproval: false, reason: "Every workflow starts with repository evidence." },
    ...matched.map((rule, index) => ({ id: `guided-${index + 1}`, action: rule.action, skillIds: rule.skills, requiresApproval: false, reason: rule.reason })),
    { id: "implement", action: "Prepare a bounded patch proposal and run relevant checks", skillIds: matched.flatMap((rule) => rule.skills), requiresApproval: true, reason: "Code changes require explicit approval before GitHub writes." },
    { id: "report", action: "Summarize tests, risks, files changed, and next action", skillIds: [], requiresApproval: false, reason: "The final report records what was actually verified." },
  ];
  return { headline: `Workflow plan${language ? ` for ${language}` : ""}`, steps, notes: ["Skills are recommendations selected from the ECG catalog; ChatGPT reads the selected guide before acting.", "Writing branches, comments, or pull requests always remains approval-gated."] };
}
