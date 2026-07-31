import type { Domain, Tier } from './tensor';

/**
 * Edge-family registry (normative "archetype fingerprint" table).
 * Each family fixes domain, mask usage, routing tier, parameter labels,
 * and whether det_sign is forced +1 (control/registration families).
 * Hyper families project two edges (A-leg, T-leg) from one act.
 */
export interface FamilySpec {
  family: string;
  domain: Domain;
  /** Promoted families store the full (1,1,1,1) mask regardless of domain. */
  promoted: boolean;
  tier: Tier;
  /** Human labels for (p_d, p_i) in authoring UIs. */
  paramLabels: [string, string];
  signForced: boolean;
  /** Person-vouch candidate when target resolves to a Profile and folded coords are positive. */
  vouchCandidate: boolean;
}

export const FAMILIES: Record<string, FamilySpec> = {
  Opinion: {
    family: 'Opinion', domain: 'Tribal', promoted: false, tier: 'full',
    paramLabels: ['polarity p', 'reaction r'], signForced: false, vouchCandidate: true,
  },
  Affinity: {
    family: 'Affinity', domain: 'Epistemic', promoted: false, tier: 'marginal',
    paramLabels: ['association a', 'attraction t'], signForced: false, vouchCandidate: false,
  },
  Owner: {
    family: 'Owner', domain: 'Economic', promoted: true, tier: 'full',
    paramLabels: ['attachment a', '(fixed 1)'], signForced: false, vouchCandidate: false,
  },
  Publish: {
    family: 'Publish', domain: 'Economic', promoted: true, tier: 'full',
    paramLabels: ['attachment a', '(fixed 1)'], signForced: false, vouchCandidate: false,
  },
  Participant: {
    family: 'Participant', domain: 'Relational', promoted: true, tier: 'full',
    paramLabels: ['interactivity i', 'responsibility r'], signForced: false, vouchCandidate: false,
  },
  Registration: {
    family: 'Registration', domain: 'Identity', promoted: false, tier: 'full',
    paramLabels: ['(fixed 1)', '(fixed 1)'], signForced: true, vouchCandidate: false,
  },
  SelfDeclaration: {
    family: 'SelfDeclaration', domain: 'Identity', promoted: false, tier: 'full',
    paramLabels: ['(fixed 1)', 'bond p_i'], signForced: false, vouchCandidate: false,
  },
  SelfReputation: {
    family: 'SelfReputation', domain: 'Identity', promoted: false, tier: 'full',
    paramLabels: ['(fixed 1)', 'bond p_i'], signForced: false, vouchCandidate: false,
  },
  JoinRequest: {
    family: 'JoinRequest', domain: 'Relational', promoted: true, tier: 'half',
    paramLabels: ['urgency u', 'formality f'], signForced: false, vouchCandidate: false,
  },
  Accept: {
    family: 'Accept', domain: 'Relational', promoted: true, tier: 'half',
    paramLabels: ['comfort c', 'equity e'], signForced: false, vouchCandidate: true,
  },
  Ratify: {
    family: 'Ratify', domain: 'Relational', promoted: true, tier: 'half',
    paramLabels: ['comfort c', 'equity e'], signForced: false, vouchCandidate: true,
  },
  ReviewA: {
    family: 'ReviewA', domain: 'Tribal', promoted: false, tier: 'full',
    paramLabels: ['enthusiasm e', 'effort f'], signForced: false, vouchCandidate: false,
  },
  ReviewT: {
    family: 'ReviewT', domain: 'Epistemic', promoted: false, tier: 'marginal',
    paramLabels: ['effort f', 'enthusiasm e'], signForced: false, vouchCandidate: false,
  },
  TagA: {
    family: 'TagA', domain: 'Epistemic', promoted: false, tier: 'marginal',
    paramLabels: ['relevance r', 'confidence c'], signForced: false, vouchCandidate: false,
  },
  TagT: {
    family: 'TagT', domain: 'Epistemic', promoted: false, tier: 'marginal',
    paramLabels: ['confidence c', 'relevance r'], signForced: false, vouchCandidate: false,
  },
  Control: {
    // Withdraw / Rescind / Leave / De-invite: Minimal slice at p_d = p_i = 1, sign forced +1.
    family: 'Control', domain: 'Minimal', promoted: false, tier: 'marginal',
    paramLabels: ['(fixed 1)', '(fixed 1)'], signForced: true, vouchCandidate: false,
  },
};
