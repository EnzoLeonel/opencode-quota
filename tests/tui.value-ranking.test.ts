import { describe, expect, it, vi } from "vite-plus/test";

import {
  fetchValueRanking,
  parseValueRanking,
  VALUE_RANKING_REFRESH_MS,
  VALUE_RANKING_URL,
  valueRankingLines,
  valueRankingTableLines,
} from "../src/tui/value-ranking.js";
import { windowHint } from "../src/tui/window/shell.js";
import { columnsOf } from "../src/view/columns.js";
import { lineText } from "../src/view/text.js";

function model(
  id: string,
  name: string,
  limit: number | undefined,
  input: number,
  output: number,
  cache?: number,
  extras: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    type: "chat",
    go: { monthly_usage: limit === undefined ? {} : { go: limit, "go-plus": limit * 2 } },
    cost: {
      text: {
        input: {
          price: input,
          ...(cache === undefined ? {} : { cache: { read: cache } }),
        },
        output: { price: output },
      },
      ...extras,
    },
  };
}

const MODELS = [
  model("beta", "Beta Model", 60, 0.15, 0.3),
  model("alpha", "Alpha Model", 100, 0.1, 0.5),
  model("gamma", "Gamma Model", 500, 1.4, 4.4, 0.26),
  model("free", "Free Model", undefined, 0, 0),
  model("cacheless", "No Cache", 60, 0.15, 0.9),
];

describe("Go value ranking", () => {
  it("ranks paid models by blended input/output price over the monthly limit", () => {
    const ranking = parseValueRanking({ data: MODELS }, "go", 1000);

    expect(ranking).toBeDefined();
    expect(ranking?.plan).toBe("go");
    expect(ranking?.generatedAtMs).toBe(1000);
    expect(ranking?.models.map((item) => item.modelID)).toEqual([
      "alpha",
      "beta",
      "gamma",
      "cacheless",
    ]);
    const [alpha, beta] = ranking?.models ?? [];
    expect(alpha).toMatchObject({
      name: "Alpha Model",
      monthlyLimitUsd: 100,
      variablePricing: false,
    });
    expect(alpha?.inputPercent).toBeCloseTo(0.1);
    expect(alpha?.outputPercent).toBeCloseTo(0.5);
    expect(alpha?.cachePercent).toBeCloseTo(0.1);
    // (3 × 0.1 + 0.5) / 4 = 0.2 per 1M, over the $100 limit.
    expect(alpha?.blendPercent).toBeCloseTo(0.2);
    // (3 × 0.25 + 0.5) / 4 = 0.3125 per 1M, over the $60 limit.
    expect(beta?.blendPercent).toBeCloseTo(0.3125);
    // A model without a cache price bills cache reads as input.
    expect(ranking?.models.find((item) => item.modelID === "cacheless")?.cachePercent).toBeCloseTo(
      0.25,
    );
  });

  it("lets a larger monthly limit beat the same token prices", () => {
    const models = [
      model("small", "Small Limit", 30, 0.1, 0.2),
      model("large", "Large Limit", 60, 0.1, 0.2),
    ];
    const ranking = parseValueRanking({ data: models });

    expect(ranking?.models.map((item) => item.modelID)).toEqual(["large", "small"]);
    expect(ranking?.models[0]?.blendPercent).toBeCloseTo(0.2083, 3);
    expect(ranking?.models[1]?.blendPercent).toBeCloseTo(0.4167, 3);
  });

  it("uses the chosen plan's limits and leaves free models out", () => {
    const ranking = parseValueRanking({ data: MODELS }, "go-plus");
    expect(ranking?.plan).toBe("go-plus");
    expect(ranking?.models.find((item) => item.modelID === "alpha")?.monthlyLimitUsd).toBe(200);
    expect(ranking?.models.find((item) => item.modelID === "free")).toBeUndefined();
  });

  it("leaves out models that /model cannot select", () => {
    const nonChat = [
      { ...model("embed", "Embedding Model", 15, 0.01, 0), type: "embedding" },
      { ...model("decision", "Decision Model", 15, 0.1, 0), type: "decision" },
      { ...model("image", "Image Model", 15, 0.1, 0), type: "image" },
      { ...model("untyped", "Untyped Model", 15, 0.1, 0), type: undefined },
    ];
    const ranking = parseValueRanking({ data: [...MODELS, ...nonChat] });

    expect(ranking?.models.map((item) => item.modelID)).toEqual([
      "alpha",
      "beta",
      "gamma",
      "cacheless",
    ]);
  });

  it("marks models whose peak-hour or long-context pricing can raise the base cost", () => {
    const models = [
      model("peak", "Peak Model", 100, 0.1, 0.5, 0.01, { multipliers: [{}] }),
      {
        ...model("long", "Long Context", 100, 0.1, 0.5, 0.01),
        cost: {
          text: {
            input: { price: 0.1, cache: { read: 0.01 }, overrides: [{ when: {}, price: 0.2 }] },
            output: { price: 0.5 },
          },
        },
      },
    ];
    const ranking = parseValueRanking({ data: models });
    expect(ranking?.models.find((item) => item.modelID === "peak")?.variablePricing).toBe(true);
    expect(ranking?.models.find((item) => item.modelID === "long")?.variablePricing).toBe(true);
  });

  it("keeps the 20 best paid models", () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      model(`model-${index}`, `Model ${index}`, 100, 0.1, 0.5 + index / 10),
    );
    const ranking = parseValueRanking({ data: many });
    expect(ranking?.models).toHaveLength(20);
    expect(ranking?.models[0]?.modelID).toBe("model-0");
    expect(ranking?.models.at(-1)?.modelID).toBe("model-19");
  });

  it("answers undefined for a reply without priced models", () => {
    expect(parseValueRanking(null)).toBeUndefined();
    expect(parseValueRanking({ data: [] })).toBeUndefined();
    expect(parseValueRanking({ data: [{ id: "free", go: {} }] })).toBeUndefined();
  });

  it("reads the list with the JSON Accept header", async () => {
    const http = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: MODELS }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", http);
    try {
      const ranking = await fetchValueRanking({ plan: "go" });
      expect(ranking.models[0]?.modelID).toBe("alpha");
      expect(http).toHaveBeenCalledOnce();
      const [url, init] = http.mock.calls[0] ?? [];
      expect(String(url)).toBe(VALUE_RANKING_URL);
      expect(init?.headers).toEqual({ Accept: "application/json" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws when the list cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 })),
    );
    try {
      await expect(fetchValueRanking()).rejects.toThrow("Go model list error 503");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Go value ranking lines", () => {
  const ranking = parseValueRanking({ data: MODELS });
  if (!ranking) throw new Error("fixture must parse");

  it("writes a spacer, a header and one line per model inside the width", () => {
    const lines = valueRankingLines(ranking, 36);
    expect(lines[0]).toEqual({ id: "", segments: [] });
    expect(lineText(lines[1]!)).toContain("Best value · Go");
    expect(lineText(lines[1]!)).toContain("v %/1M");
    expect(lines).toHaveLength(2 + ranking.models.length);
    for (const line of lines) expect(columnsOf(lineText(line))).toBeLessThanOrEqual(36);
    expect(lineText(lines[2]!)).toContain("Alpha Model");
    expect(lineText(lines[2]!)).toContain("v0.20");
    expect(lineText(lines[2]!)).toContain("i0.10");
    expect(lineText(lines[2]!)).toContain("o0.50");
    // The cache column needs room for a recognizable name, so it waits for a wider sidebar.
    expect(lineText(lines[2]!)).not.toContain(" c");
  });

  it("shows the cache column when the sidebar is wide", () => {
    const lines = valueRankingLines(ranking, 48);
    const row = lineText(lines[2]!);
    expect(row).toContain("v0.20");
    expect(row).toContain("c0.10");
    for (const line of lines) expect(columnsOf(lineText(line))).toBeLessThanOrEqual(48);
  });

  it("adds * to the blend of a model whose real price can rise", () => {
    const peak = parseValueRanking({
      data: [model("peak", "Peak Model", 100, 0.1, 0.5, 0.01, { multipliers: [{}] })],
    });
    expect(valueRankingLines(peak, 40).some((line) => lineText(line).includes("v0.20*"))).toBe(
      true,
    );
  });

  it("drops the cache column when the sidebar is narrow", () => {
    const lines = valueRankingLines(ranking, 26);
    const row = lineText(lines[2]!);
    expect(row).toContain("i0.10");
    expect(row).toContain("o0.50");
    expect(row).not.toContain(" c");
    for (const line of lines) expect(columnsOf(lineText(line))).toBeLessThanOrEqual(26);
  });

  it("writes nothing without a ranking or a width", () => {
    expect(valueRankingLines(undefined, 36)).toEqual([]);
    expect(valueRankingLines(ranking, 0)).toEqual([]);
  });

  it("refreshes every 15 minutes", () => {
    expect(VALUE_RANKING_REFRESH_MS).toBe(15 * 60_000);
  });

  it("keeps every paid model when the Value tab asks for them all", () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      model(`model-${index}`, `Model ${index}`, 100, 0.1, 0.5 + index / 10),
    );
    const all = parseValueRanking({ data: many }, "go", 1000, Number.MAX_SAFE_INTEGER);
    expect(all?.models).toHaveLength(25);
    expect(all?.models[0]?.modelID).toBe("model-0");
    expect(all?.models.at(-1)?.modelID).toBe("model-24");
  });

  it("passes the limit through to the fetch", async () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      model(`model-${index}`, `Model ${index}`, 100, 0.1, 0.5),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: many }))),
    );
    try {
      const all = await fetchValueRanking({ limit: Number.MAX_SAFE_INTEGER });
      expect(all.models).toHaveLength(25);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Go value ranking table", () => {
  const ranking = parseValueRanking({ data: MODELS });
  if (!ranking) throw new Error("fixture must parse");

  it("lists every ranked model with its monthly limit in USD", () => {
    const lines = valueRankingTableLines(ranking, 80, 1000);
    expect(lineText(lines[0]!)).toContain("Best value · Go");
    expect(lineText(lines[1]!)).toContain("limit");
    expect(lineText(lines[1]!)).toContain("updated just now");
    // Title + updated + 4 models + legend.
    expect(lines).toHaveLength(2 + ranking.models.length + 1);
    expect(lineText(lines[2]!)).toContain("Alpha Model");
    expect(lineText(lines[2]!)).toContain("v0.20");
    expect(lineText(lines[2]!)).toContain("$100");
    expect(lineText(lines.at(-1)!)).toContain("free, non-chat");
    for (const line of lines) expect(columnsOf(lineText(line))).toBeLessThanOrEqual(80);
  });

  it("dates the updated line and marks variable pricing on the blend", () => {
    const peak = parseValueRanking(
      {
        data: [model("peak", "Peak Model", 100, 0.1, 0.5, 0.01, { multipliers: [{}] })],
      },
      "go",
      1000,
    );
    const lines = valueRankingTableLines(peak, 80, 1000 + 16 * 60_000);
    expect(lineText(lines[1]!)).toContain("updated 16 min ago");
    expect(lines.some((line) => lineText(line).includes("v0.20*"))).toBe(true);
  });

  it("writes nothing without a ranking or a width", () => {
    expect(valueRankingTableLines(undefined, 80)).toEqual([]);
    expect(valueRankingTableLines(ranking, 0)).toEqual([]);
  });

  it("hints the Value tab as scroll-only", () => {
    expect(windowHint("value", false)).toBe("↑↓ scroll · tab next tab · esc close");
  });
});
