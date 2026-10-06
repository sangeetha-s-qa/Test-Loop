import type { AutomationLocator } from "../automation/program";
import type { HealingOutput } from "./prompt";

/**
 * Ranking and safety rules for self-healing candidates.
 *
 * The roadmap requires that "candidates that can match multiple elements are rejected". The DOM
 * evidence captured at failure time is the only ground truth available, so uniqueness is decided
 * against that snapshot rather than trusting the model's own confidence value.
 */

export type DomCandidate = {
  tag?: string | null;
  role?: string | null;
  testId?: string | null;
  id?: string | null;
  name?: string | null;
  type?: string | null;
  placeholder?: string | null;
  ariaLabel?: string | null;
  text?: string | null;
  visible?: boolean;
};

export type RankedCandidate = AutomationLocator & { confidence: number; rationale: string; matchCount: number };

/** How many elements in the evidence snapshot a proposed locator would match. */
export function countMatches(candidates: DomCandidate[], locator: { strategy: string; value: string; name?: string }): number {
  return candidates.filter(candidate => {
    switch (locator.strategy) {
      case "testId": return candidate.testId === locator.value;
      case "role": {
        const role = candidate.role ?? (candidate.tag === "button" ? "button" : candidate.tag === "a" ? "link" : candidate.tag === "input" && candidate.type === "checkbox" ? "checkbox" : null);
        if (role !== locator.value) return false;
        if (!locator.name) return true;
        const accessibleName = (candidate.ariaLabel ?? candidate.text ?? "").trim();
        return accessibleName.toLowerCase() === locator.name.trim().toLowerCase();
      }
      case "label": return (candidate.ariaLabel ?? "").trim().toLowerCase() === locator.value.trim().toLowerCase();
      case "placeholder": return candidate.placeholder === locator.value;
      case "text": return (candidate.text ?? "").includes(locator.value);
      case "altText":
      case "title": return (candidate.text ?? "") === locator.value;
      case "css": {
        // Only the two selector shapes the evidence can actually answer are checked; anything
        // else is treated as unverifiable and rejected below.
        const byId = /^#([A-Za-z0-9_-]+)$/.exec(locator.value);
        if (byId) return candidate.id === byId[1];
        const byName = /^\[name=["']?([^"'\]]+)["']?\]$/.exec(locator.value);
        if (byName) return candidate.name === byName[1];
        return false;
      }
      default: return false;
    }
  }).length;
}

/** Strategies ordered by resilience; used to break ties between equally confident candidates. */
const strategyRank: Record<string, number> = { testId: 0, role: 1, label: 2, placeholder: 3, altText: 4, title: 5, text: 6, css: 7 };

export type RankingResult = { accepted: RankedCandidate[]; rejected: { locator: unknown; reason: string }[] };

/**
 * Keeps only candidates that resolve to exactly one element in the evidence, then orders them by
 * strategy resilience and model confidence. An empty `accepted` list means no proposal is made —
 * the platform never guesses.
 */
export function rankHealingCandidates(output: HealingOutput, domCandidates: DomCandidate[], failedLocator: AutomationLocator): RankingResult {
  const accepted: RankedCandidate[] = [];
  const rejected: { locator: unknown; reason: string }[] = [];
  const seen = new Set<string>();

  for (const candidate of output.candidates) {
    const key = `${candidate.strategy}|${candidate.value}|${candidate.name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (candidate.strategy === failedLocator.strategy && candidate.value === failedLocator.value && (candidate.name ?? null) === (failedLocator.name ?? null)) {
      rejected.push({ locator: candidate, reason: "IDENTICAL_TO_FAILED_LOCATOR" });
      continue;
    }
    if (candidate.strategy === "role" && !candidate.name) {
      rejected.push({ locator: candidate, reason: "ROLE_WITHOUT_ACCESSIBLE_NAME" });
      continue;
    }
    const matchCount = countMatches(domCandidates, candidate);
    if (matchCount === 0) {
      rejected.push({ locator: candidate, reason: "NOT_PRESENT_IN_EVIDENCE" });
      continue;
    }
    if (matchCount > 1) {
      rejected.push({ locator: candidate, reason: "AMBIGUOUS_MATCHES_MULTIPLE_ELEMENTS" });
      continue;
    }
    accepted.push({
      strategy: candidate.strategy,
      value: candidate.value,
      ...(candidate.name ? { name: candidate.name } : {}),
      sourceElementId: failedLocator.sourceElementId ?? null,
      confidence: candidate.confidence,
      rationale: candidate.rationale,
      matchCount,
    });
  }

  accepted.sort((left, right) => strategyRank[left.strategy] - strategyRank[right.strategy] || right.confidence - left.confidence);
  return { accepted, rejected };
}
