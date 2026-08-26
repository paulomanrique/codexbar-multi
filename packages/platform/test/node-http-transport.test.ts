import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { makeFetchHttpTransport } from "../src/node.ts";

describe("Node HTTP transport redirect policy", () => {
  it("rejects redirects before any provider can follow them across origins", async () => {
    let redirectPolicy: RequestRedirect | undefined;
    const redirectFailure = new TypeError("fetch failed because redirect mode is error");
    const transport = makeFetchHttpTransport((async (_input, init) => {
      redirectPolicy = init?.redirect;
      throw redirectFailure;
    }) as typeof fetch);

    const failure = await Effect.runPromise(
      Effect.flip(
        transport.execute({
          method: "GET",
          url: "http://127.0.0.1:8088/healthz",
        }),
      ),
    );

    expect(redirectPolicy).toBe("error");
    expect(failure.name).toBe("InfrastructureError");
    expect(failure.message).toBe("Provider HTTP request failed");
  });
});
