import { describe, expect, it } from "vite-plus/test";

import {
  extractMiniMaxNextDataPayload,
  looksMiniMaxHTMLSignedOut,
  maximumMiniMaxHTMLBytes,
  parseMiniMaxHTML,
  parseMiniMaxHTMLTextFallback,
} from "../src/providers/minimax-html.ts";

describe("MiniMax HTML parser", () => {
  it("checks signed-out copy only in visible HTML", () => {
    const signedInHTML = `
      <html>
        <head>
          <script id="__NEXT_DATA__" type="application/json">
            {"props":{"pageProps":{"_nextI18Next":{"initialI18nStore":{"zh":{"common":{"login":"Log in","landing_common_login":"登录"}}}}}}}
          </script>
          <style>.login::before { content: "sign in"; }</style>
          <!-- Log in -->
        </head>
        <body><div id="__next">Coding Plan</div></body>
      </html>
    `;
    const signedOutHTML = `
      <html>
        <head><script>{"landing_common_login":"登录"}</script></head>
        <body><main><a>Log in</a></main></body>
      </html>
    `;

    expect(looksMiniMaxHTMLSignedOut(signedInHTML)).toBe(false);
    expect(looksMiniMaxHTMLSignedOut(signedOutHTML)).toBe(true);
  });

  it("extracts and normalizes coding-plan payloads from bounded __NEXT_DATA__", () => {
    const start = 1_700_000_000_000;
    const end = start + 5 * 60 * 60 * 1000;
    const json = {
      props: {
        pageProps: {
          data: {
            baseResp: { statusCode: 0 },
            currentSubscribeTitle: "Max",
            modelRemains: [
              {
                modelName: "abab6.5",
                currentIntervalTotalCount: 1000,
                currentIntervalUsageCount: 250,
                startTime: start,
                endTime: end,
                remainsTime: 240000,
              },
            ],
          },
        },
      },
    };
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(json)}</script></html>`;

    const payload = extractMiniMaxNextDataPayload(html);

    expect(payload).toEqual({
      base_resp: { status_code: 0 },
      current_subscribe_title: "Max",
      model_remains: [
        {
          model_name: "abab6.5",
          current_interval_total_count: 1000,
          current_interval_usage_count: 250,
          start_time: start,
          end_time: end,
          remains_time: 240000,
        },
      ],
    });
    expect(parseMiniMaxHTML(html)?.source).toBe("next-data");
  });

  it("parses Swift fallback HTML for plan, available prompts, percent used, and reset duration", () => {
    const now = 1_700_000_000_000;
    const html = `
      <div>Coding Plan</div>
      <div>Max</div>
      <div>Available usage: 1,000 prompts / 5 hours</div>
      <div>Current Usage</div>
      <div>0% Used</div>
      <div>Resets in 4 min</div>
    `;

    expect(parseMiniMaxHTMLTextFallback(html, { now })).toEqual({
      plan_name: "Max",
      available_prompts: 1000,
      window_minutes: 300,
      used_percent: 0,
      reset_in_seconds: 240,
      resets_at_epoch_ms: now + 240_000,
    });
    expect(parseMiniMaxHTML(html, { now })).toEqual({
      source: "text",
      signedOut: false,
      fallback: {
        plan_name: "Max",
        available_prompts: 1000,
        window_minutes: 300,
        used_percent: 0,
        reset_in_seconds: 240,
        resets_at_epoch_ms: now + 240_000,
      },
    });
  });

  it("parses used-prefix fallback HTML and UTC reset times", () => {
    const now = Date.UTC(2025, 0, 1, 10, 0);
    const expectedReset = Date.UTC(2025, 0, 1, 23, 30);
    const html = `
      <div>Coding Plan Pro</div>
      <div>Available usage: 1,500 prompts / 1.5 hours</div>
      <div>Used 75%</div>
      <div>Resets at 23:30 (UTC)</div>
    `;

    expect(parseMiniMaxHTMLTextFallback(html, { now })).toEqual({
      plan_name: "Pro",
      available_prompts: 1500,
      window_minutes: 90,
      used_percent: 75,
      resets_at_epoch_ms: expectedReset,
    });
  });

  it("caps total HTML and __NEXT_DATA__ extraction", () => {
    const payload = {
      props: { pageProps: { data: { model_remains: [{ model_name: "abab6.5" }] } } },
    };
    const oversizedHTML = `${" ".repeat(maximumMiniMaxHTMLBytes)}<div>Available usage: 1 prompts / 1 hour</div>`;
    const oversizedScript = `<script id="__NEXT_DATA__" type="application/json">${" ".repeat(300 * 1024)}${JSON.stringify(payload)}</script>`;

    expect(parseMiniMaxHTML(oversizedHTML)).toBeUndefined();
    expect(extractMiniMaxNextDataPayload(oversizedScript)).toBeUndefined();
  });

  it("bounds recursive payload lookup by depth and node count", () => {
    let deeplyNested: unknown = { model_remains: [{ model_name: "too-deep" }] };
    for (let index = 0; index < 60; index += 1) {
      deeplyNested = { child: deeplyNested };
    }

    const manyNodes = {
      props: {
        pageProps: {
          before: Array.from({ length: 5100 }, (_, index) => ({ index })),
          data: { model_remains: [{ model_name: "too-late" }] },
        },
      },
    };

    expect(
      extractMiniMaxNextDataPayload(
        `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(deeplyNested)}</script>`,
      ),
    ).toBeUndefined();
    expect(
      extractMiniMaxNextDataPayload(
        `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(manyNodes)}</script>`,
      ),
    ).toBeUndefined();
  });
});
