import type { ProviderInstanceId, UsageSnapshot } from "@codexbar/contracts";
import {
  visibleSpendPublicationInputs,
  type SpendPublication,
  type SpendPublicationInput,
} from "@codexbar/core";

/**
 * Desktop-only composition seam for the overview card. The UI gets a
 * provider-scoped, already-published view; loading and source discovery stay
 * in the backend producer.
 */
export interface DesktopSpendOverviewInput extends SpendPublicationInput {
  readonly snapshot: UsageSnapshot;
}

export const publishedSpendOverviewInputs = (
  publication: SpendPublication<DesktopSpendOverviewInput> | undefined,
  ownershipFingerprint: string,
  providerIds: ReadonlySet<ProviderInstanceId>,
): ReadonlyArray<DesktopSpendOverviewInput> => {
  if (publication?.configuration?.ownershipFingerprint !== ownershipFingerprint) return [];
  return visibleSpendPublicationInputs(publication, providerIds);
};
