/**
 * Resume/cover-letter tailoring engine.
 *
 * Design constraint: the model is only allowed to SELECT and REPHRASE real
 * content from the bullet bank — never invent new employers, skills, or
 * numbers. Selection (which bullets to use) is deterministic and happens
 * before the LLM ever sees the job description; the LLM's job is narrower
 * than it looks — emphasis and phrasing only. A fidelity check after the
 * call reverts any bullet where a number/metric got dropped or altered.
 */

export interface ResumeBullet {
  id: string;
  employer: string;
  role: string;
  start_date: string | null;
  end_date: string | null;
  project_context: string | null;
  text: string;
  tags: string[];
  impact_metric: string | null;
  sort_order: number;
}

export interface ResumeProfile {
  full_name: string;
  headline: string | null;
  contact: Record<string, string>;
  summary: string | null;
  certifications: { name: string; issued?: string; expires?: string; verify_url?: string }[];
  education: { degree: string; school: string; year?: number }[];
  publications?: { title: string; detail?: string }[];
}

export interface TailoredBullet {
  bulletId: string;
  text: string;
  fellBackToOriginal: boolean; // true if the fidelity check rejected the model's rewrite
}

export interface TailoredEmployerBlock {
  employer: string;
  role: string;
  start_date: string | null;
  end_date: string | null;
  project_context: string | null;
  bullets: TailoredBullet[];
}

export interface TailoredContent {
  headline: string;
  summary: string;
  employerBlocks: TailoredEmployerBlock[];
  coverLetterParagraph: string;
}

export interface JobForTailoring {
  title: string;
  company: string;
  summary: string;
  categoryScores: Record<string, number>;
}

// A short stoplist for the keyword-overlap tie-breaker below. Doesn't need
// to be exhaustive — it's only there so common words like "and"/"with"
// don't inflate the relevance score.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you",
  "are", "was", "were", "our", "their", "will", "have", "has", "had", "not",
  "but", "all", "any", "can", "who", "job", "role", "work", "team", "years",
  "including", "such", "across", "using", "based", "over", "per",
]);

function tokenize(text: string): string[] {
  return Array.from(new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9+.#-]{2,}/g) ?? [])
    .filter((w) => !STOPWORDS.has(w))));
}

function scoreBulletRelevance(
  bullet: ResumeBullet,
  jobTokens: string[],
  categoryScores: Record<string, number>
): number {
  // Use the bullet's single best-matching category rather than an average
  // across its tags — averaging unfairly penalizes bullets that legitimately
  // span multiple skill areas (a bullet tagged AWS+Compliance+Architecture
  // shouldn't score worse than a single-tag bullet just because one of its
  // three tags happens to be less relevant to this particular posting).
  const catScore = bullet.tags.length
    ? Math.max(...bullet.tags.map((tag) => categoryScores[tag] ?? 0))
    : 0;
  const bulletTokens = tokenize(bullet.text);
  const keywordHits = bulletTokens.filter((t) => jobTokens.includes(t)).length;
  // Keyword overlap is a light tie-breaker only — weighted low enough that
  // a couple of incidental word matches (e.g. a bullet that happens to say
  // "AWS" and "security" in an unrelated context) can't outrank a bullet
  // whose actual tagged skill category is the strong match.
  return catScore + keywordHits * 3;
}

/**
 * Deterministic, cheap first pass: ranks every bullet against a job and
 * returns a generous candidate pool (wider than what will actually appear
 * on the tailored resume). This step can't hallucinate anything — it only
 * ever reorders bullets that already exist. The *final* choice of which
 * candidates to actually use is left to the LLM step below, which has
 * enough context (the full job description, not just category scores) to
 * make the judgment call a keyword heuristic can't — e.g. recognizing that
 * an origin-story bullet matters less than a directly relevant achievement
 * even if the origin-story bullet happens to share more literal words with
 * the posting. That selection is still safe: the model can only choose
 * among the ids it's given, never invent one.
 */
export function rankCandidateBullets(
  bullets: ResumeBullet[],
  job: Pick<JobForTailoring, "title" | "summary" | "categoryScores">,
  opts: { maxPerEmployer?: number; maxCandidates?: number } = {}
): ResumeBullet[] {
  const { maxPerEmployer = 6, maxCandidates = 20 } = opts;
  const jobTokens = tokenize(`${job.title} ${job.summary}`);

  const ranked = bullets
    .map((bullet) => ({ bullet, score: scoreBulletRelevance(bullet, jobTokens, job.categoryScores) }))
    .sort((a, b) => b.score - a.score || a.bullet.sort_order - b.bullet.sort_order);

  const perEmployerCount = new Map<string, number>();
  const candidates: ResumeBullet[] = [];
  for (const { bullet } of ranked) {
    const count = perEmployerCount.get(bullet.employer) ?? 0;
    if (count >= maxPerEmployer) continue;
    candidates.push(bullet);
    perEmployerCount.set(bullet.employer, count + 1);
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}

/**
 * @deprecated kept for callers that want pure deterministic selection with
 * no LLM involved at all (e.g. a quick preview). Prefer `tailorApplication`,
 * which lets the model pick the best subset from a wider candidate pool.
 */
export function selectBullets(
  bullets: ResumeBullet[],
  job: Pick<JobForTailoring, "title" | "summary" | "categoryScores">,
  opts: { maxPerEmployer?: number; maxTotal?: number } = {}
): ResumeBullet[] {
  const { maxPerEmployer = 4, maxTotal = 12 } = opts;
  const candidates = rankCandidateBullets(bullets, job, { maxPerEmployer, maxCandidates: maxTotal });
  return orderForDisplay(candidates.slice(0, maxTotal), bullets);
}

function orderForDisplay(selected: ResumeBullet[], allBullets: ResumeBullet[]): ResumeBullet[] {
  const employerOrder: string[] = [];
  for (const b of allBullets) {
    if (!employerOrder.includes(b.employer)) employerOrder.push(b.employer);
  }
  return [...selected].sort((a, b) => {
    const employerDiff = employerOrder.indexOf(a.employer) - employerOrder.indexOf(b.employer);
    return employerDiff !== 0 ? employerDiff : a.sort_order - b.sort_order;
  });
}

function sortPairsForDisplay(
  pairs: { bullet: ResumeBullet; tailored: TailoredBullet }[],
  allBullets: ResumeBullet[]
): { bullet: ResumeBullet; tailored: TailoredBullet }[] {
  const employerOrder: string[] = [];
  for (const b of allBullets) {
    if (!employerOrder.includes(b.employer)) employerOrder.push(b.employer);
  }
  return [...pairs].sort((a, b) => {
    const employerDiff = employerOrder.indexOf(a.bullet.employer) - employerOrder.indexOf(b.bullet.employer);
    return employerDiff !== 0 ? employerDiff : a.bullet.sort_order - b.bullet.sort_order;
  });
}

function buildEmployerBlocks(
  pairs: { bullet: ResumeBullet; tailored: TailoredBullet }[]
): TailoredEmployerBlock[] {
  const blocks: TailoredEmployerBlock[] = [];
  for (const { bullet, tailored } of pairs) {
    let block = blocks.find((b) => b.employer === bullet.employer && b.role === bullet.role);
    if (!block) {
      block = {
        employer: bullet.employer,
        role: bullet.role,
        start_date: bullet.start_date,
        end_date: bullet.end_date,
        project_context: bullet.project_context,
        bullets: [],
      };
      blocks.push(block);
    }
    block.bullets.push(tailored);
  }
  return blocks;
}

/** Best-matching bullet for an employer, searched across the FULL bank (not
 * just the candidate pool) — used only as a last-resort backstop so an
 * employer never disappears from the resume entirely. */
function topBulletForEmployer(
  bullets: ResumeBullet[],
  employer: string,
  job: Pick<JobForTailoring, "title" | "summary" | "categoryScores">
): ResumeBullet | null {
  const jobTokens = tokenize(`${job.title} ${job.summary}`);
  const forEmployer = bullets.filter((b) => b.employer === employer);
  if (forEmployer.length === 0) return null;
  return forEmployer
    .map((bullet) => ({ bullet, score: scoreBulletRelevance(bullet, jobTokens, job.categoryScores) }))
    .sort((a, b) => b.score - a.score || a.bullet.sort_order - b.bullet.sort_order)[0].bullet;
}

/** Numbers/percentages/dollar figures that must survive a rewrite untouched. */
function extractNumbers(text: string): string[] {
  return text.match(/\d[\d,.]*\+?%?/g) ?? [];
}

function preservesNumbers(original: string, rewritten: string): boolean {
  return extractNumbers(original).every((n) => rewritten.includes(n));
}

interface DeepSeekTailorResponse {
  headline?: unknown;
  summary?: unknown;
  bullets?: unknown; // { id: string; text: string }[]
  coverLetterParagraph?: unknown;
}

async function callDeepSeekForTailoring(
  job: Pick<JobForTailoring, "title" | "company" | "summary">,
  profile: ResumeProfile,
  candidates: ResumeBullet[],
  maxTotal: number
): Promise<DeepSeekTailorResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured");
  }

  const systemPrompt = [
    "You tailor a job applicant's resume content and draft one cover-letter paragraph for a specific job posting.",
    "You are given a pool of candidate resume bullets — real, already-verified achievements. Your task has two parts.",
    "PART A — SELECTION: choose the bullets that genuinely best fit this specific job description. Prioritize real relevance to what the posting actually asks for over surface keyword overlap (e.g. a bullet that merely happens to contain the same words as the posting is not automatically a good match). You do not need to use every bullet given to you, and employers don't need equal representation — but don't drop an employer entirely if it has anything relevant to offer.",
    `Choose at most ${maxTotal} bullets in total, across all employers.`,
    "PART B — REWRITING, under STRICT RULES:",
    "1. You may ONLY reorder emphasis and rephrase wording of bullets you selected. Never invent, exaggerate, or add any fact, number, employer, tool, or skill that is not already present in that bullet's original text.",
    "2. Every number, percentage, and metric in a bullet must appear unchanged in your rewritten version of that bullet.",
    "3. Only return ids for the bullets you're keeping — omit ids for ones you decide not to use. Do not invent new ids.",
    "4. The cover-letter paragraph must reference at least one specific detail from the job description (a named skill, tool, or requirement it mentions), and must not claim anything about the candidate beyond what your selected bullets support.",
    "5. Mirror the job posting's terminology where it genuinely matches existing bullet content (e.g. if a bullet already covers IAM and the posting says \"identity governance\", you may use that phrase for that bullet) — but do not relabel unrelated work to sound like a match.",
    "Respond with ONLY a JSON object with keys: \"headline\" (string), \"summary\" (string, 2-4 sentences), \"bullets\" (array of { \"id\": string, \"text\": string } — ONLY for the bullets you selected), \"coverLetterParagraph\" (string, one paragraph).",
  ].join("\n");

  const userPrompt = [
    `Job title: ${job.title}`,
    `Company: ${job.company}`,
    `Job description:\n${job.summary}`,
    "",
    `Candidate current headline: ${profile.headline ?? ""}`,
    `Candidate current summary: ${profile.summary ?? ""}`,
    "",
    "Candidate resume bullets available (id | employer | role | text):",
    ...candidates.map((b) => `${b.id} | ${b.employer} | ${b.role} | ${b.text}`),
  ].join("\n");

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
      max_tokens: 4000,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`DeepSeek tailoring call failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
  const choice = data.choices?.[0];
  const text = choice?.message?.content ?? "";

  if (choice?.finish_reason === "length") {
    console.error("DeepSeek tailoring response was truncated (hit max_tokens). Raw response:", text);
    throw new Error("DeepSeek tailoring response was cut off — the reply was too long for the token limit");
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error("DeepSeek tailoring call returned no JSON object. Raw response:", text);
    throw new Error("DeepSeek tailoring call returned no JSON object");
  }

  try {
    return JSON.parse(match[0]) as DeepSeekTailorResponse;
  } catch {
    console.error("DeepSeek tailoring call returned invalid JSON. Raw response:", text);
    throw new Error("DeepSeek tailoring call returned invalid JSON");
  }
}

/**
 * Reconciles the model's output against the candidate pool: drops any
 * bullet id the model invented, and reverts individual bullets that failed
 * the number-fidelity check back to their original (untouched) wording.
 * Candidates the model chose not to use are simply absent from the
 * returned map — that's an intentional selection, not something to patch.
 */
function reconcile(raw: DeepSeekTailorResponse, candidates: ResumeBullet[]): {
  headline: string;
  summary: string;
  bulletTextById: Map<string, TailoredBullet>;
} {
  const byId = new Map(candidates.map((b) => [b.id, b]));
  const rawBullets = Array.isArray(raw.bullets) ? raw.bullets : [];

  const bulletTextById = new Map<string, TailoredBullet>();
  for (const entry of rawBullets) {
    if (
      typeof entry !== "object" || entry === null ||
      typeof (entry as { id?: unknown }).id !== "string" ||
      typeof (entry as { text?: unknown }).text !== "string"
    ) {
      continue;
    }
    const { id, text } = entry as { id: string; text: string };
    const original = byId.get(id);
    if (!original) continue; // model invented an id we never sent — drop it
    const ok = preservesNumbers(original.text, text) && text.trim().length > 0;
    bulletTextById.set(id, {
      bulletId: id,
      text: ok ? text.trim() : original.text,
      fellBackToOriginal: !ok,
    });
  }

  const headline = typeof raw.headline === "string" && raw.headline.trim() ? raw.headline.trim() : "";
  const summary = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "";

  return { headline, summary, bulletTextById };
}

/**
 * Full pipeline: build a wide, cheap candidate pool; let the model pick the
 * best subset and rewrite phrasing under strict guardrails; reconcile so
 * nothing gets invented; then guarantee no employer vanishes from the
 * resume entirely, even if the model's selection skipped it.
 */
export async function tailorApplication(params: {
  job: JobForTailoring;
  profile: ResumeProfile;
  bullets: ResumeBullet[];
  maxPerEmployer?: number;
  maxCandidates?: number;
  maxTotal?: number;
}): Promise<TailoredContent> {
  const maxTotal = params.maxTotal ?? 12;
  const candidates = rankCandidateBullets(params.bullets, params.job, {
    maxPerEmployer: params.maxPerEmployer ?? 6,
    maxCandidates: params.maxCandidates ?? 20,
  });

  if (candidates.length === 0) {
    throw new Error("No resume bullets matched this job — nothing to tailor.");
  }

  const raw = await callDeepSeekForTailoring(
    { title: params.job.title, company: params.job.company, summary: params.job.summary },
    params.profile,
    candidates,
    maxTotal
  );

  const { headline, summary, bulletTextById } = reconcile(raw, candidates);

  // Keep the model's chosen bullets in candidate-rank order, capped at
  // maxTotal in case it returned more than asked for.
  const chosen = candidates.filter((b) => bulletTextById.has(b.id)).slice(0, maxTotal);
  const chosenPairs = chosen.map((bullet) => ({ bullet, tailored: bulletTextById.get(bullet.id)! }));

  // Safety net: an employer missing entirely reads as an unexplained gap.
  // If the model's selection dropped one, add its single best-matching
  // bullet back in untouched — it was never sent for rewriting, so there's
  // nothing to fidelity-check.
  const chosenEmployers = new Set(chosen.map((b) => b.employer));
  const allEmployers: string[] = [];
  for (const b of params.bullets) {
    if (!allEmployers.includes(b.employer)) allEmployers.push(b.employer);
  }
  const backstopPairs: { bullet: ResumeBullet; tailored: TailoredBullet }[] = [];
  for (const employer of allEmployers) {
    if (chosenEmployers.has(employer)) continue;
    const top = topBulletForEmployer(params.bullets, employer, params.job);
    if (top) {
      backstopPairs.push({ bullet: top, tailored: { bulletId: top.id, text: top.text, fellBackToOriginal: true } });
    }
  }

  const employerBlocks = buildEmployerBlocks(
    sortPairsForDisplay([...chosenPairs, ...backstopPairs], params.bullets)
  );

  const coverLetterParagraph =
    typeof raw.coverLetterParagraph === "string" && raw.coverLetterParagraph.trim()
      ? raw.coverLetterParagraph.trim()
      : "";
  if (!coverLetterParagraph) {
    throw new Error("DeepSeek tailoring call did not return a cover letter paragraph");
  }

  return {
    headline: headline || params.profile.headline || "",
    summary: summary || params.profile.summary || "",
    employerBlocks,
    coverLetterParagraph,
  };
}