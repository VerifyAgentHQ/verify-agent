import { createHash } from "node:crypto";
import {
  brandId,
  type RequirementEvidence,
  type RequirementEvidenceLocation,
  type RequirementEvidenceSource,
} from "@verify-agent/domain";

export type RequirementResult = {
  readonly text: string;
  readonly status: "passed" | "failed" | "unknown";
  readonly finding?: string;
  readonly evidence?: RequirementEvidence;
};

export type RequirementSourceText = {
  readonly source: RequirementEvidenceSource;
  readonly text: string;
};

export type PullRequestReviewInput = {
  readonly description: string;
  readonly requirementSources?: readonly RequirementSourceText[];
  readonly changedFiles: readonly string[];
  readonly patches: Readonly<Record<string, string>>;
};

const clean = (value: string): string => value.replace(/[`*_]/g, "").trim();

function fallbackSource(): RequirementEvidenceSource {
  return {
    kind: "pull_request",
    owner: "unknown",
    repository: "unknown",
    number: 1,
    field: "body",
  };
}

function requirementLines(
  input: PullRequestReviewInput,
): RequirementSourceText[] {
  const sources = input.requirementSources ?? [
    { source: fallbackSource(), text: input.description },
  ];
  const output: RequirementSourceText[] = [];
  for (const item of sources) {
    for (const line of item.text
      .split(/\r?\n/)
      .map((value) => value.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim())
      .filter((value) =>
        /^(?:add|remove|change|modify|do not modify|don't modify|pin|disable|include|must|ensure|write|update)\b/i.test(
          value,
        ),
      )) {
      const cleaned = clean(line);
      if (
        /pin\s+ci\s+actions.*disable\s+persisted\s+checkout\s+credentials/i.test(
          cleaned,
        )
      ) {
        output.push(
          {
            source: item.source,
            text: "Pin CI actions to verified immutable commits",
          },
          {
            source: item.source,
            text: "Disable persisted checkout credentials",
          },
        );
      } else if (cleaned.length > 0) {
        output.push({ source: item.source, text: cleaned });
      }
    }
  }
  return output.filter(
    (item, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.text === item.text &&
          candidate.source.kind === item.source.kind &&
          candidate.source.number === item.source.number &&
          candidate.source.field === item.source.field,
      ) === index,
  );
}

function workflowFiles(input: PullRequestReviewInput): string[] {
  return input.changedFiles
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(file));
}

function patchLocation(
  file: string,
  patch: string,
): RequirementEvidenceLocation {
  const hunk = patch.match(/^@@[^\r\n]*/m)?.[0];
  return { file, ...(hunk === undefined ? {} : { patchHunk: hunk }) };
}

function evidence(
  source: RequirementEvidenceSource,
  text: string,
  rule: RequirementEvidence["rule"],
  status: RequirementEvidence["status"],
  explanation: string,
  matchedFiles: readonly string[],
  locations: readonly RequirementEvidenceLocation[],
  observedText: readonly string[],
): RequirementEvidence {
  const boundedObserved = observedText
    .slice(0, 100)
    .map((value) => value.slice(0, 500));
  const boundedExplanation = explanation.slice(0, 1000);
  const payload = JSON.stringify({
    source,
    text,
    rule,
    status,
    boundedObserved,
    matchedFiles,
    locations,
  });
  const hash = createHash("sha256").update(payload).digest("hex");
  return {
    id: brandId<"RequirementEvidenceId">(
      `requirement-evidence-${hash.slice(0, 24)}`,
    ),
    source,
    requirementText: text,
    rule,
    status,
    explanation: boundedExplanation,
    matchedFiles: matchedFiles.slice(0, 50),
    locations: locations.slice(0, 100),
    observedText: boundedObserved,
    evidenceHash: hash,
  };
}

function actionEvidence(
  input: PullRequestReviewInput,
  source: RequirementEvidenceSource,
  text: string,
): RequirementResult {
  const files = workflowFiles(input);
  if (files.length === 0 || files.some((file) => !input.patches[file])) {
    const item = evidence(
      source,
      text,
      "github-action-pinned",
      "unknown",
      "Workflow patch evidence was unavailable or incomplete.",
      files,
      files.map((file) => patchLocation(file, input.patches[file] ?? "")),
      [],
    );
    return {
      text,
      status: "unknown",
      finding: item.explanation,
      evidence: item,
    };
  }
  const locations: RequirementEvidenceLocation[] = [];
  const observed: string[] = [];
  let unpinned: string | undefined;
  for (const file of files) {
    const patch = input.patches[file]!;
    for (const line of patch.split(/\r?\n/)) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      const match = line.match(/uses:\s*([^\s@]+)@([^\s#]+)/i);
      if (!match) continue;
      const reference = `${match[1]}@${match[2]}`;
      observed.push(reference);
      locations.push(patchLocation(file, patch));
      if (!/^[0-9a-f]{40}$/i.test(match[2]!)) unpinned ??= reference;
    }
  }
  const status = unpinned === undefined ? "passed" : "failed";
  const explanation =
    unpinned === undefined
      ? `All ${observed.length} relevant changed uses: references are pinned to full commit SHAs.`
      : `${unpinned} is not pinned to a full 40-character commit SHA.`;
  const item = evidence(
    source,
    text,
    "github-action-pinned",
    status,
    explanation,
    files,
    locations,
    observed,
  );
  return {
    text,
    status,
    ...(status === "failed" ? { finding: explanation } : {}),
    evidence: item,
  };
}

function checkoutEvidence(
  input: PullRequestReviewInput,
  source: RequirementEvidenceSource,
  text: string,
): RequirementResult {
  const files = workflowFiles(input);
  if (files.length === 0 || files.some((file) => !input.patches[file])) {
    const item = evidence(
      source,
      text,
      "checkout-persist-credentials-disabled",
      "unknown",
      "Workflow patch evidence was unavailable or incomplete.",
      files,
      files.map((file) => patchLocation(file, input.patches[file] ?? "")),
      [],
    );
    return {
      text,
      status: "unknown",
      finding: item.explanation,
      evidence: item,
    };
  }
  const locations: RequirementEvidenceLocation[] = [];
  const observed: string[] = [];
  let checkoutCount = 0;
  let missing = false;
  for (const file of files) {
    const lines = input.patches[file]!.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!/\+\s*-?\s*uses:\s*actions\/checkout@/i.test(lines[index]!))
        continue;
      checkoutCount += 1;
      const block = lines.slice(index, Math.min(lines.length, index + 12));
      const setting = block.find((line) =>
        /persist-credentials\s*:/i.test(line),
      );
      locations.push(patchLocation(file, input.patches[file]!));
      if (setting && /persist-credentials\s*:\s*false\b/i.test(setting))
        observed.push("persist-credentials: false");
      else {
        missing = true;
        if (setting) observed.push(setting.replace(/^\+\s*/, "").trim());
      }
    }
  }
  if (checkoutCount === 0) missing = true;
  const status = checkoutCount > 0 && !missing ? "passed" : "failed";
  const explanation =
    status === "passed"
      ? `All ${checkoutCount} actions/checkout steps set persist-credentials: false.`
      : checkoutCount === 0
        ? "No actions/checkout step could be proven from the workflow patch."
        : "At least one actions/checkout step does not set persist-credentials: false.";
  const item = evidence(
    source,
    text,
    "checkout-persist-credentials-disabled",
    status,
    explanation,
    files,
    locations,
    observed,
  );
  return {
    text,
    status,
    ...(status === "failed" ? { finding: explanation } : {}),
    evidence: item,
  };
}

export function evaluatePullRequestRequirements(
  input: PullRequestReviewInput,
): readonly RequirementResult[] {
  const results: RequirementResult[] = [];
  for (const item of requirementLines(input)) {
    const lower = item.text.toLowerCase();
    if (lower.includes("pin") && lower.includes("action"))
      results.push(actionEvidence(input, item.source, item.text));
    else if (
      lower.includes("persisted credential") ||
      lower.includes("persisted checkout credential") ||
      lower.includes("persist-credentials")
    )
      results.push(checkoutEvidence(input, item.source, item.text));
    else {
      const unknown = evidence(
        item.source,
        item.text,
        "github-action-pinned",
        "unknown",
        "This requirement kind is not supported by the current deterministic evaluator.",
        [],
        [],
        [],
      );
      results.push({
        text: item.text,
        status: "unknown",
        finding: unknown.explanation,
        evidence: unknown,
      });
    }
  }
  return results;
}
