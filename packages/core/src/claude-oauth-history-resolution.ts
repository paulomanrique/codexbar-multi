export type ClaudeOAuthActiveAccountObservation =
  | { readonly kind: "stable"; readonly identity?: string }
  | { readonly kind: "changed" };

export interface ClaudeOAuthAccountBindingCandidate {
  readonly identity: string;
  readonly observedAt: Date;
}

export interface ClaudeOAuthHistoryEvidence {
  readonly owner: string;
  readonly persistentRefHash?: string;
  readonly keychainCredentialMismatch: boolean;
  readonly keychainCredentialAbsent: boolean;
  readonly keychainCredentialUnavailable: boolean;
  readonly activeAccountObservation: ClaudeOAuthActiveAccountObservation;
  readonly observedAt: Date;
}

export interface ClaudeOAuthHistoryBindingState {
  readonly bindings: Readonly<Record<string, string>>;
  readonly candidates: Readonly<Record<string, ClaudeOAuthAccountBindingCandidate>>;
}

export interface ClaudeRefreshAuthState {
  readonly fingerprintToken: string;
  readonly keychainPersistentRefHash?: string;
  readonly activeAccountIdentity?: string;
  readonly accountStateWasStable: boolean;
}

export interface ClaudeHistoryAccountState {
  readonly fingerprintToken: string;
  readonly keychainPersistentRefHash?: string;
  readonly activeAccountIdentity?: string;
  readonly wasStable: boolean;
}

export interface ResolveClaudeOAuthHistoryOwnerResult extends ClaudeOAuthHistoryBindingState {
  readonly owner?: string;
}

const emptyBindingState = (): ClaudeOAuthHistoryBindingState => ({
  bindings: {},
  candidates: {},
});

const cloneBindings = (bindings: Readonly<Record<string, string>>): Record<string, string> => ({
  ...bindings,
});

const cloneCandidates = (
  candidates: Readonly<Record<string, ClaudeOAuthAccountBindingCandidate>>,
): Record<string, ClaudeOAuthAccountBindingCandidate> =>
  Object.fromEntries(
    Object.entries(candidates).map(([owner, candidate]) => [
      owner,
      { identity: candidate.identity, observedAt: new Date(candidate.observedAt.getTime()) },
    ]),
  );

const stableIdentity = (observation: ClaudeOAuthActiveAccountObservation): string | undefined =>
  observation.kind === "stable" ? observation.identity : undefined;

const confirmClaudeOAuthAccountBindingCandidate = (
  state: ClaudeOAuthHistoryBindingState,
  owner: string,
  identity: string,
  observedAt: Date,
): { readonly confirmed: boolean; readonly state: ClaudeOAuthHistoryBindingState } => {
  const bindings = cloneBindings(state.bindings);
  const candidates = cloneCandidates(state.candidates);
  const candidate = candidates[owner];
  if (
    candidate !== undefined &&
    candidate.identity === identity &&
    candidate.observedAt.getTime() < observedAt.getTime()
  ) {
    delete candidates[owner];
    return { confirmed: true, state: { bindings, candidates } };
  }
  candidates[owner] = { identity, observedAt: new Date(observedAt.getTime()) };
  return { confirmed: false, state: { bindings, candidates } };
};

export const resolveClaudeOAuthHistoryOwner = (
  evidence: ClaudeOAuthHistoryEvidence,
  state: ClaudeOAuthHistoryBindingState = emptyBindingState(),
): ResolveClaudeOAuthHistoryOwnerResult => {
  const requiresClaudeCodeCorroboration =
    evidence.persistentRefHash !== undefined ||
    evidence.keychainCredentialMismatch ||
    evidence.keychainCredentialAbsent ||
    evidence.keychainCredentialUnavailable;
  if (!requiresClaudeCodeCorroboration) return { ...state, owner: evidence.owner };
  if (evidence.activeAccountObservation.kind !== "stable") return { ...state };

  const currentAccountIdentity = stableIdentity(evidence.activeAccountObservation);
  const mappedIdentity = state.bindings[evidence.owner];
  if (mappedIdentity !== undefined) {
    if (currentAccountIdentity === undefined) {
      return evidence.keychainCredentialMismatch || evidence.keychainCredentialUnavailable
        ? { ...state }
        : { ...state, owner: evidence.owner };
    }
    if (mappedIdentity === currentAccountIdentity) {
      const bindings = cloneBindings(state.bindings);
      const candidates = cloneCandidates(state.candidates);
      delete candidates[evidence.owner];
      return { bindings, candidates, owner: evidence.owner };
    }
    if (evidence.persistentRefHash === undefined) return { ...state };
    const confirmation = confirmClaudeOAuthAccountBindingCandidate(
      state,
      evidence.owner,
      currentAccountIdentity,
      evidence.observedAt,
    );
    if (!confirmation.confirmed) return confirmation.state;
    const bindings = cloneBindings(confirmation.state.bindings);
    bindings[evidence.owner] = currentAccountIdentity;
    return { bindings, candidates: confirmation.state.candidates, owner: evidence.owner };
  }

  if (evidence.keychainCredentialUnavailable && !evidence.keychainCredentialMismatch)
    return { ...state, owner: evidence.owner };
  if (evidence.keychainCredentialAbsent) return { ...state, owner: evidence.owner };
  if (currentAccountIdentity === undefined)
    return evidence.keychainCredentialMismatch || evidence.keychainCredentialUnavailable
      ? { ...state }
      : { ...state, owner: evidence.owner };
  if (evidence.persistentRefHash === undefined) return { ...state };

  const confirmation = confirmClaudeOAuthAccountBindingCandidate(
    state,
    evidence.owner,
    currentAccountIdentity,
    evidence.observedAt,
  );
  if (!confirmation.confirmed) return { ...confirmation.state, owner: evidence.owner };
  const bindings = cloneBindings(confirmation.state.bindings);
  bindings[evidence.owner] = currentAccountIdentity;
  return { bindings, candidates: confirmation.state.candidates, owner: evidence.owner };
};

export const claudeOAuthActiveAccountObservation = (
  beforeFetch: ClaudeRefreshAuthState | undefined,
  afterFetch: ClaudeHistoryAccountState | undefined,
): ClaudeOAuthActiveAccountObservation => {
  if (
    beforeFetch === undefined ||
    beforeFetch.accountStateWasStable !== true ||
    afterFetch === undefined ||
    afterFetch.wasStable !== true ||
    beforeFetch.activeAccountIdentity !== afterFetch.activeAccountIdentity
  ) {
    return { kind: "changed" };
  }
  return {
    kind: "stable",
    ...(afterFetch.activeAccountIdentity === undefined
      ? {}
      : { identity: afterFetch.activeAccountIdentity }),
  };
};

export const stableClaudeKeychainPersistentRefHash = (
  beforeFetch: ClaudeRefreshAuthState | undefined,
  afterFetchFingerprintToken: string | undefined,
  afterFetchPersistentRefHash: string | undefined,
  accountStateWasStable: boolean,
): string | undefined => {
  if (
    accountStateWasStable !== true ||
    beforeFetch === undefined ||
    beforeFetch.accountStateWasStable !== true ||
    beforeFetch.fingerprintToken !== afterFetchFingerprintToken ||
    beforeFetch.keychainPersistentRefHash === undefined ||
    beforeFetch.keychainPersistentRefHash !== afterFetchPersistentRefHash
  ) {
    return undefined;
  }
  return beforeFetch.keychainPersistentRefHash;
};
