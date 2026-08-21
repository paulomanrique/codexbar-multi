import { describe, expect, it } from "vite-plus/test";

import {
  createSpendPublication,
  SpendPublicationCoordinator,
  visibleSpendPublicationInputs,
  type SpendPublicationInput,
} from "../src/spend-publication.ts";

interface Input extends SpendPublicationInput {
  readonly costUsd: number;
}

const loadedAt = "2026-08-20T00:00:00.000Z";

const input = (id: string, providerId: Input["providerId"], costUsd: number): Input => ({
  id,
  providerId,
  displayName: `${providerId} source`,
  costUsd,
});

describe("spend publication (Swift #3067 parity)", () => {
  it("atomically publishes canonical input and source truth states", () => {
    const publication = createSpendPublication({
      revision: 1,
      generation: 1,
      configuration: { ownershipFingerprint: "settings-a" },
      loadedAt,
      isRefreshing: false,
      roster: [
        { id: "openai", providerId: "openai", displayName: "OpenAI" },
        { id: "claude", providerId: "claude", displayName: "Claude" },
        { id: "gemini", providerId: "gemini", displayName: "Gemini" },
        { id: "codex:first", providerId: "codex", displayName: "Codex · #1" },
        { id: "codex:second", providerId: "codex", displayName: "Codex · #2" },
      ],
      inputs: [
        input("openai", "openai", 7),
        input("codex:first", "codex", 2),
        input("codex:second", "codex", 3),
      ],
      confirmedEmptySourceIds: new Set(["claude"]),
      failedSourceIds: new Set(["gemini"]),
    });

    expect(publication.sources).toEqual([
      expect.objectContaining({ id: "openai", state: "available" }),
      expect.objectContaining({ id: "claude", state: "confirmed-empty" }),
      expect.objectContaining({ id: "gemini", state: "unavailable" }),
      expect.objectContaining({ id: "codex:first", state: "available" }),
      expect.objectContaining({ id: "codex:second", state: "available" }),
    ]);
    expect(visibleSpendPublicationInputs(publication).map(({ id }) => id)).toEqual([
      "openai",
      "codex:first",
      "codex:second",
    ]);
  });

  it("keeps a failed retained source stale and out of overview projection", () => {
    const publication = createSpendPublication({
      revision: 2,
      generation: 2,
      loadedAt,
      isRefreshing: false,
      roster: [{ id: "claude", providerId: "claude", displayName: "Claude" }],
      inputs: [input("claude", "claude", 3)],
      failedSourceIds: new Set(["claude"]),
    });

    expect(publication.sources).toEqual([
      expect.objectContaining({ id: "claude", state: "stale-last-known" }),
    ]);
    expect(publication.inputs).toEqual([]);
    expect(visibleSpendPublicationInputs(publication)).toEqual([]);
  });

  it("uses explicit ownership and never lets a source cross provider silos", () => {
    expect(() =>
      createSpendPublication({
        revision: 1,
        generation: 1,
        loadedAt,
        isRefreshing: false,
        roster: [{ id: "shared-source", providerId: "codex", displayName: "Codex" }],
        inputs: [input("shared-source", "claude", 1)],
      }),
    ).toThrow("does not belong to its roster provider");

    const publication = createSpendPublication({
      revision: 1,
      generation: 1,
      loadedAt,
      isRefreshing: true,
      roster: [
        { id: "codex:work", providerId: "codex", displayName: "Codex work" },
        { id: "claude", providerId: "claude", displayName: "Claude" },
      ],
      inputs: [input("claude", "claude", 4)],
    });
    expect(visibleSpendPublicationInputs(publication, new Set(["codex"]))).toEqual([]);
    expect(visibleSpendPublicationInputs(publication, new Set(["claude"]))).toEqual([
      input("claude", "claude", 4),
    ]);
    expect(publication.sources[0]).toMatchObject({ id: "codex:work", state: "loading" });
  });

  it("does not create phantom sources from unowned failed or empty IDs", () => {
    const publication = createSpendPublication({
      revision: 1,
      generation: 1,
      loadedAt,
      isRefreshing: false,
      roster: [],
      inputs: [],
      failedSourceIds: new Set(["ghost"]),
      confirmedEmptySourceIds: new Set(["other-ghost"]),
    });
    expect(publication.sources).toEqual([]);
  });

  it("preserves an input's enrichment role without changing provider ownership", () => {
    const publication = createSpendPublication({
      revision: 1,
      generation: 1,
      loadedAt,
      isRefreshing: false,
      roster: [{ id: "codex:local", providerId: "codex", displayName: "Codex" }],
      inputs: [{ ...input("codex:local", "codex", 1), role: "enrichment" }],
    });
    expect(publication.sources).toEqual([
      expect.objectContaining({ providerId: "codex", role: "enrichment", state: "available" }),
    ]);
  });

  it("rejects malformed timestamps before any source state is created", () => {
    expect(() =>
      createSpendPublication({
        revision: 1,
        generation: 1,
        loadedAt: "tomorrow",
        isRefreshing: false,
        roster: [],
        inputs: [],
      }),
    ).toThrow("ISO-8601");
  });

  it("rejects replaced and cancelled generation results before publication", () => {
    const coordinator = new SpendPublicationCoordinator<Input>();
    const first = coordinator.begin();
    const second = coordinator.begin();
    expect(first.signal.aborted).toBe(true);

    const request = {
      loadedAt,
      isRefreshing: false,
      roster: [{ id: "openai", providerId: "openai" as const, displayName: "OpenAI" }],
      inputs: [input("openai", "openai", 1)],
    };
    expect(coordinator.publish(first, request)).toBeUndefined();
    const published = coordinator.publish(second, request);
    expect(published).toMatchObject({ revision: 1, generation: second.generation });
    coordinator.cancel();
    expect(second.signal.aborted).toBe(true);
    expect(coordinator.publish(second, request)).toBeUndefined();
    expect(coordinator.current()).toBe(published);
  });
});
