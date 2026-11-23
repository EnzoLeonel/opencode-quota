/**
 * The sidebar's "Best value" ranking: the paid OpenCode Go chat models that give the most work
 * per point of the shared monthly allowance, read from the public Go model list. The rank is by
 * the blended token price normalized by each model's monthly limit: 75% input and 25% output
 * (the LiteLLM "blended" mix), as `% of the monthly limit per 1M blended tokens`, lower first.
 * The per-token input, output and cache percentages are shown beside it, so a workload with
 * another mix can compare the same models on the token kinds it uses most.
 *
 * Only `type: "chat"` models are ranked: `/model` does not offer the list's embedding or
 * decision models, even though Go gives them a monthly limit.
 *
 * Nothing here is saved: the fetch is repeated every 15 minutes while the sidebar shows, and a
 * failed read keeps the last ranking in memory.
 */
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import { asRecord, finiteNumber } from "../lib/json-guards.js";
import { columnsOf, sliceColumns } from "../view/columns.js";
import { fit } from "../view/format.js";
import type { Line, Segment } from "../view/text.js";

export type ValueRankingPlan = "go" | "go-plus" | "go-teams";

export type ValueRankingModel = {
  /** The Go model id, for example "deepseek-v4.1-flash". */
  modelID: string;
  /** The Go model list's name, or the id when it has none. */
  name: string;
  /** The plan's monthly limit for this model, in USD. */
  monthlyLimitUsd: number;
  /** Percentage points of the monthly limit a 1M-token input costs. */
  inputPercent: number;
  /** Percentage points of the monthly limit a 1M-token output costs. */
  outputPercent: number;
  /** Percentage points of the monthly limit a 1M-token cache read costs. */
  cachePercent: number;
  /**
   * Percentage points of the monthly limit a 1M-token blend costs: 75% input and 25% output,
   * the LiteLLM "blended" price, over this model's limit. The rank uses it.
   */
  blendPercent: number;
  /** Peak-hour or long-context pricing makes the real cost higher than these base prices. */
  variablePricing: boolean;
};

export type ValueRanking = {
  plan: ValueRankingPlan;
  /** When the ranking was read (epoch ms); in memory only. */
  generatedAtMs: number;
  models: ValueRankingModel[];
};

/** The public Go model list: monthly limits per plan and token prices. */
export const VALUE_RANKING_URL = "https://opencode.ai/inference/go/v1/models";
/** How often the sidebar asks for the list again. */
export const VALUE_RANKING_REFRESH_MS = 15 * 60_000;
/** The models the section lists. */
export const VALUE_RANKING_LIMIT = 20;
const MODEL_LABEL_MAX_CODE_POINTS = 80;

const PLAN_LABELS: Readonly<Record<ValueRankingPlan, string>> = {
  go: "Go",
  "go-plus": "Go Plus",
  "go-teams": "Go Teams",
};

/** A model's display name, scrubbed and cut to the row label limit. */
function modelName(text: string, fallback: string): string {
  const clean = sanitizeDisplayText(text).replace(/\s+/gu, " ").trim();
  const name = clean || fallback;
  return Array.from(name).slice(0, MODEL_LABEL_MAX_CODE_POINTS).join("");
}

/** A model's base prices and its monthly limit; undefined for a free or unreadable model. */
function readModel(item: unknown, plan: ValueRankingPlan): ValueRankingModel | undefined {
  const model = asRecord(item);
  const modelID = typeof model?.id === "string" ? model.id.trim() : "";
  if (!modelID) return undefined;

  // `/model` only offers chat models. Embeddings and decision models carry a Go limit and
  // prices, but the TUI cannot select them, so they do not belong in the ranking.
  if (model?.type !== "chat") return undefined;

  const limit = finiteNumber(asRecord(asRecord(model?.go)?.monthly_usage)?.[plan]);
  if (limit === undefined || limit <= 0) return undefined;

  const cost = asRecord(model?.cost);
  const text = asRecord(cost?.text);
  const input = asRecord(text?.input);
  const output = asRecord(text?.output);
  const inputPrice = finiteNumber(input?.price);
  const outputPrice = finiteNumber(output?.price);
  if (inputPrice === undefined || outputPrice === undefined) return undefined;

  // A model without a cache-read price bills cache reads as plain input.
  const cachePrice = finiteNumber(asRecord(input?.cache)?.read) ?? inputPrice;
  const variablePricing =
    (Array.isArray(cost?.multipliers) && cost.multipliers.length > 0) ||
    (Array.isArray(input?.overrides) && input.overrides.length > 0) ||
    (Array.isArray(output?.overrides) && output.overrides.length > 0);

  return {
    modelID,
    name: modelName(typeof model?.name === "string" ? model.name : "", modelID),
    monthlyLimitUsd: limit,
    inputPercent: (inputPrice / limit) * 100,
    outputPercent: (outputPrice / limit) * 100,
    cachePercent: (cachePrice / limit) * 100,
    // The LiteLLM blended price: 75% of input and 25% of output, per 1M tokens.
    blendPercent: ((3 * inputPrice + outputPrice) / 4 / limit) * 100,
    variablePricing,
  };
}

/**
 * The paid chat models of `plan`, lowest blended price over the monthly limit first: the public
 * Go model list's `data`, its `go.monthly_usage[plan]` limits and its base token prices. Models
 * the TUI cannot select (`type` other than `chat`, such as embeddings and decisions), free models
 * (no limit for the plan) and models without prices are left out. Undefined when the reply is not
 * a model list with at least one priced model.
 */
export function parseValueRanking(
  json: unknown,
  plan: ValueRankingPlan = "go",
  nowMs: number = Date.now(),
  limit: number = VALUE_RANKING_LIMIT,
): ValueRanking | undefined {
  const data = asRecord(json)?.data;
  if (!Array.isArray(data)) return undefined;

  const models: ValueRankingModel[] = [];
  for (const item of data) {
    const model = readModel(item, plan);
    if (model) models.push(model);
  }
  if (models.length === 0) return undefined;

  models.sort(
    (a, b) =>
      a.blendPercent - b.blendPercent ||
      a.outputPercent - b.outputPercent ||
      a.name.localeCompare(b.name),
  );
  return { plan, generatedAtMs: nowMs, models: models.slice(0, limit) };
}

/** The Go model list's ranking for `plan`; throws when the list cannot be read. */
export async function fetchValueRanking(
  options: {
    plan?: ValueRankingPlan;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** How many ranked models to keep; the Value tab asks for them all. */
    limit?: number;
  } = {},
): Promise<ValueRanking> {
  const { plan = "go", signal, timeoutMs = 10_000, limit = VALUE_RANKING_LIMIT } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);

  try {
    const response = await fetch(VALUE_RANKING_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Go model list error ${response.status}`);
    const ranking = parseValueRanking(await response.json(), plan, Date.now(), limit);
    if (!ranking) throw new Error("Go model list has no priced models");
    return ranking;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** A percentage of the monthly limit per 1M tokens, two decimals below 10 and one above. */
function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0.00";
  return value < 10 ? value.toFixed(2) : value.toFixed(1);
}

/** A cache-read percentage: cache prices are often a fraction of a percent, so three decimals. */
function formatCachePercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0.000";
  return value < 0.1 ? value.toFixed(3) : value.toFixed(2);
}

function clipLine(line: Line, width: number): Line {
  let room = width;
  const segments: Segment[] = [];
  for (const segment of line.segments) {
    const text = sliceColumns(segment.text, Math.max(0, room));
    if (!text) continue;
    segments.push({ ...segment, text });
    room -= columnsOf(text);
  }
  return { id: line.id, segments };
}

/**
 * The section's lines: a blank spacer, the header, and one line per ranked model. The blended
 * percentage decides the order; input, output and cache follow. When the sidebar is narrow the
 * cache column gives way first, then the names shorten; the sum stays inside `width`.
 */
export function valueRankingLines(ranking: ValueRanking | undefined, width: number): Line[] {
  if (!ranking || ranking.models.length === 0 || width <= 0) return [];

  const models = ranking.models;
  const blendTexts = models.map(
    (model) => `${formatPercent(model.blendPercent)}${model.variablePricing ? "*" : ""}`,
  );
  const inputTexts = models.map((model) => formatPercent(model.inputPercent));
  const outputTexts = models.map((model) => formatPercent(model.outputPercent));
  const cacheTexts = models.map((model) => formatCachePercent(model.cachePercent));

  const valuesFor = (index: number, withCache: boolean): string => {
    const cache = withCache ? ` c${cacheTexts[index]}` : "";
    return ` v${blendTexts[index]} i${inputTexts[index]} o${outputTexts[index]}${cache}`;
  };

  const withCacheWidth = Math.max(...models.map((_, index) => valuesFor(index, true).length));
  // The rank is two digits and a space; the rest is the name and the values. The cache column
  // only shows when the name keeps enough room to be recognized.
  const roomWithCache = width - 3 - withCacheWidth;
  const showCache = roomWithCache >= 10;
  const valuesWidth = showCache
    ? withCacheWidth
    : Math.max(...models.map((_, index) => valuesFor(index, false).length));
  const modelWidth = Math.max(4, Math.min(16, width - 3 - valuesWidth));

  const title = `Best value · ${PLAN_LABELS[ranking.plan]}`;
  const lines: Line[] = [
    { id: "", segments: [] },
    clipLine(
      {
        id: "value_ranking",
        segments: [{ text: `${title}  v %/1M`, role: "provider", bold: true }],
      },
      width,
    ),
  ];

  models.forEach((model, index) => {
    const rank = `${String(index + 1).padStart(2)} `;
    const line: Line = {
      id: `value.${model.modelID}`,
      segments: [
        { text: rank, role: "value" },
        { text: fit(model.name, modelWidth), role: "label" },
        { text: valuesFor(index, showCache), role: "value" },
      ],
    };
    lines.push(clipLine(line, width));
  });
  return lines;
}

/** A monthly limit in USD, without trailing zeros ("$60", "$2.5"). */
function formatLimitUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$?";
  return `$${String(Math.round(value * 100) / 100)}`;
}

/**
 * The Value tab's table: every ranked model with its blended percentage and its monthly limit
 * in USD, so a shrinking balance can be read against what each model allows. Same order and
 * numbers as the sidebar section; the header names the columns and the last line explains the
 * `*` and the units. `nowMs` dates the "updated" line; without a ranking there is nothing.
 */
export function valueRankingTableLines(
  ranking: ValueRanking | undefined,
  width: number,
  nowMs: number = Date.now(),
): Line[] {
  if (!ranking || ranking.models.length === 0 || width <= 0) return [];

  const models = ranking.models;
  const blendTexts = models.map(
    (model) => `${formatPercent(model.blendPercent)}${model.variablePricing ? "*" : ""}`,
  );
  const inputTexts = models.map((model) => formatPercent(model.inputPercent));
  const outputTexts = models.map((model) => formatPercent(model.outputPercent));
  const cacheTexts = models.map((model) => formatCachePercent(model.cachePercent));
  const limitTexts = models.map((model) => formatLimitUsd(model.monthlyLimitUsd));

  const valuesFor = (index: number, withCache: boolean): string => {
    const cache = withCache ? ` c${cacheTexts[index]}` : "";
    return `v${blendTexts[index]} i${inputTexts[index]} o${outputTexts[index]}${cache} ${limitTexts[index]}`;
  };

  const withCacheWidth = Math.max(...models.map((_, index) => valuesFor(index, true).length));
  // The rank is two digits and a space; the rest is the name and the values. The cache column
  // only shows when the name keeps enough room to be recognized.
  const roomWithCache = width - 3 - withCacheWidth;
  const showCache = roomWithCache >= 16;
  const valuesWidth = showCache
    ? withCacheWidth
    : Math.max(...models.map((_, index) => valuesFor(index, false).length));
  const modelWidth = Math.max(8, Math.min(32, width - 3 - valuesWidth));

  const ageMin = Math.max(0, Math.floor((nowMs - ranking.generatedAtMs) / 60_000));
  const updated = ageMin < 1 ? "updated just now" : `updated ${ageMin} min ago`;
  const lines: Line[] = [
    clipLine(
      {
        id: "value_ranking",
        segments: [
          {
            text: `Best value · ${PLAN_LABELS[ranking.plan]} — v %/1M blended (75% in + 25% out), lowest first`,
            role: "provider",
            bold: true,
          },
        ],
      },
      width,
    ),
    clipLine(
      {
        id: "value_ranking_updated",
        segments: [
          {
            text: `#  Model v i o${showCache ? " c" : ""} limit · ${updated} · refreshes every 15 min`,
            role: "value",
          },
        ],
      },
      width,
    ),
  ];

  models.forEach((model, index) => {
    const rank = `${String(index + 1).padStart(2)} `;
    const line: Line = {
      id: `value.${model.modelID}`,
      segments: [
        { text: rank, role: "value" },
        { text: fit(model.name, modelWidth), role: "label" },
        { text: valuesFor(index, showCache), role: "value" },
      ],
    };
    lines.push(clipLine(line, width));
  });

  lines.push(
    clipLine(
      {
        id: "value_ranking_legend",
        segments: [
          {
            text: "* peak-hour or long-context pricing can cost more · free, non-chat and unlimited models are left out",
            role: "value",
          },
        ],
      },
      width,
    ),
  );
  return lines;
}
