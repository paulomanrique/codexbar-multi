import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { PersistedCodexBarConfig } from "@codexbar/core";
import type { ProviderId } from "@codexbar/contracts";
import { makePersistedFirstPartySettings } from "../src/persisted-provider-settings.ts";

const fallback = (values: Readonly<Record<string, string>> = {}, reads: string[] = []) => ({
  read: (providerId: ProviderId, setting: string) => {
    reads.push(`${providerId}:${setting}`);
    return Effect.succeed(values[`${providerId}:${setting}`]);
  },
});

const read = (
  settings: ReturnType<typeof makePersistedFirstPartySettings>,
  providerId: ProviderId,
  setting: string,
) => Effect.runPromise(settings.read(providerId, setting));

describe("persisted first-party provider settings", () => {
  it("projects only the requested provider's allowlisted fields over ambient values", async () => {
    const fallbackReads: string[] = [];
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        {
          id: "moonshot",
          apiKey: "  'moonshot-persisted'  ",
          region: " china ",
          extensions: { apiKeyRegion: " china ", ignored: "must-not-project" },
        },
        {
          id: "fireworks",
          apiKey: ' "fireworks-persisted" ',
          extensions: { accountSlug: " 'account-1' ", ignored: "must-not-project" },
        },
      ],
    };
    const ambientValues = {
      "moonshot:MOONSHOT_REGION": "international",
      "fireworks:FIREWORKS_API_KEY": "native-fallback",
      "fireworks:IGNORED": "ambient-ignored",
    };
    const moonshotSettings = makePersistedFirstPartySettings(
      config,
      "moonshot",
      fallback(ambientValues, fallbackReads),
    );
    const fireworksSettings = makePersistedFirstPartySettings(
      config,
      "fireworks",
      fallback(ambientValues, fallbackReads),
    );

    await expect(read(moonshotSettings, "moonshot", "MOONSHOT_REGION")).resolves.toBe("china");
    await expect(read(moonshotSettings, "moonshot", "CODEXBAR_MOONSHOT_API_KEY")).resolves.toBe(
      "moonshot-persisted",
    );
    await expect(
      read(moonshotSettings, "moonshot", "CODEXBAR_MOONSHOT_API_KEY_REGION"),
    ).resolves.toBe("china");
    await expect(read(fireworksSettings, "fireworks", "CODEXBAR_FIREWORKS_API_KEY")).resolves.toBe(
      "fireworks-persisted",
    );
    await expect(
      read(fireworksSettings, "fireworks", "CODEXBAR_FIREWORKS_ACCOUNT_SLUG"),
    ).resolves.toBe("account-1");
    await expect(read(fireworksSettings, "fireworks", "IGNORED")).resolves.toBe("ambient-ignored");
    await expect(
      read(moonshotSettings, "fireworks", "CODEXBAR_FIREWORKS_API_KEY"),
    ).resolves.toBeUndefined();
    expect(fallbackReads).toEqual(["fireworks:IGNORED", "fireworks:CODEXBAR_FIREWORKS_API_KEY"]);
  });

  it("fails the Moonshot key pair closed and lets blank legacy fields fall through", async () => {
    const config: PersistedCodexBarConfig = {
      version: 1,
      providers: [
        { id: "moonshot", apiKey: "orphaned", extensions: {} },
        { id: "fireworks", apiKey: " '' ", extensions: { accountSlug: "  " } },
      ],
    };
    const ambientValues = {
      "moonshot:CODEXBAR_MOONSHOT_API_KEY": "ambient-moonshot",
      "moonshot:CODEXBAR_MOONSHOT_API_KEY_REGION": "ambient-region",
      "fireworks:CODEXBAR_FIREWORKS_API_KEY": "ambient-fireworks",
      "fireworks:CODEXBAR_FIREWORKS_ACCOUNT_SLUG": "ambient-account",
    };
    const moonshotSettings = makePersistedFirstPartySettings(
      config,
      "moonshot",
      fallback(ambientValues),
    );
    const fireworksSettings = makePersistedFirstPartySettings(
      config,
      "fireworks",
      fallback(ambientValues),
    );

    await expect(read(moonshotSettings, "moonshot", "CODEXBAR_MOONSHOT_API_KEY")).resolves.toBe(
      "ambient-moonshot",
    );
    await expect(
      read(moonshotSettings, "moonshot", "CODEXBAR_MOONSHOT_API_KEY_REGION"),
    ).resolves.toBe("ambient-region");
    await expect(read(fireworksSettings, "fireworks", "CODEXBAR_FIREWORKS_API_KEY")).resolves.toBe(
      "ambient-fireworks",
    );
    await expect(
      read(fireworksSettings, "fireworks", "CODEXBAR_FIREWORKS_ACCOUNT_SLUG"),
    ).resolves.toBe("ambient-account");
  });

  it("captures an immutable projection and never flattens provider extensions", async () => {
    const mutable = {
      id: "fireworks",
      apiKey: "generation-one",
      extensions: { accountSlug: "account-one", CODEXBAR_FIREWORKS_API_KEY: "injected" },
    };
    const config: PersistedCodexBarConfig = { version: 1, providers: [mutable] };
    const settings = makePersistedFirstPartySettings(config, "fireworks", fallback());
    mutable.apiKey = "generation-two";
    mutable.extensions.accountSlug = "account-two";

    await expect(read(settings, "fireworks", "CODEXBAR_FIREWORKS_API_KEY")).resolves.toBe(
      "generation-one",
    );
    await expect(read(settings, "fireworks", "CODEXBAR_FIREWORKS_ACCOUNT_SLUG")).resolves.toBe(
      "account-one",
    );
    await expect(read(settings, "openai", "CODEXBAR_FIREWORKS_API_KEY")).resolves.toBeUndefined();
  });
});
